import {constants} from 'node:fs';
import {open,lstat,mkdir,realpath,link,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseLiveConfiguration} from './live-config';

async function privateDirectory(directory:string):Promise<void>{
  const absolute=path.resolve(directory);let cursor=path.parse(absolute).root;
  for(const part of absolute.slice(cursor.length).split(path.sep)){cursor=path.join(cursor,part);const stat=await lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe configuration parent');}
  const stat=await lstat(absolute);if(await realpath(absolute)!==absolute||(stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())throw Error('Configuration directory must be private');
}
async function validatedBytes(file:string):Promise<Buffer>{
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>65536||stat.uid!==process.geteuid?.()||(stat.mode&0o077)!==0)throw Error('Unsafe configuration file');
    const bytes=Buffer.alloc(65537);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);const after=await handle.stat();
    if(bytesRead!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('Configuration changed during migration');
    const result=bytes.subarray(0,bytesRead);parseLiveConfiguration(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result)));return result;
  }finally{await handle.close();}
}
/** Copy-only legacy migration. No settings transformations or added read roots/CLI rights.
 * Existing private settings win, invalid existing settings are never overwritten.
 * Source bundle/config stays intact for rollback. */
export async function persistentConfiguration(options:{userData:string;legacy?:string;explicit?:string}):Promise<string|undefined>{
  if(options.explicit)return options.explicit;
  await mkdir(options.userData,{recursive:true,mode:0o700});await privateDirectory(options.userData);
  const destination=path.join(options.userData,'live-config.json');
  try{await validatedBytes(destination);return destination;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!options.legacy)return undefined;
  let bytes:Buffer;try{bytes=await validatedBytes(options.legacy);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  const temporary=path.join(options.userData,'.config-migration-'+randomUUID());
  const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  try{await validatedBytes(temporary);await privateDirectory(options.userData);await link(temporary,destination);await validatedBytes(destination);return destination;}
  finally{await unlink(temporary);}
}
