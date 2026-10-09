import path from 'node:path';
import {constants} from 'node:fs';
import {lstat,mkdir,open,realpath} from 'node:fs/promises';
/** Main-owned transaction paths only; descendants never pass through a symlink. */
export async function privateUpdateDirectory(directory:string,create=false):Promise<void>{
  let cursor=path.parse(directory).root;
  if(path.resolve(directory)!==directory)throw Error('Invalid updater directory');
  for(const part of directory.slice(cursor.length).split(path.sep)){
    cursor=path.join(cursor,part);
    if(create)await mkdir(cursor,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const stat=await lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe updater directory');
    if(cursor.includes(path.sep+'note-app-updater')&&(stat.uid!==process.geteuid?.()||(stat.mode&0o077)!==0))throw Error('Unsafe updater directory permissions');
  }
  const stat=await lstat(directory);if(await realpath(directory)!==directory||stat.uid!==process.geteuid?.()||(stat.mode&0o077)!==0)throw Error('Updater directory must be private');
}
export async function readPrivateUpdateJson(file:string):Promise<unknown>{
  await privateUpdateDirectory(path.dirname(file));const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>65536||(stat.mode&0o077)!==0||stat.uid!==process.geteuid?.())throw Error('Unsafe updater file');const buffer=Buffer.alloc(65537);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);const after=await handle.stat();if(bytesRead!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('Updater file changed');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead)));}finally{await handle.close();}
}
export async function writePrivateUpdateJson(file:string,value:unknown):Promise<void>{
  await privateUpdateDirectory(path.dirname(file));const handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
}
