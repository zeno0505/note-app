import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readdir,readlink,realpath} from 'node:fs/promises';
import path from 'node:path';

/** Bundle bytes, names, executable bits and internal framework symlinks are bound.
 * The digest is an integrity check, not a publisher signature or trust grant. */
export async function hashAppBundle(bundle) {
  if(!path.isAbsolute(bundle)||path.resolve(bundle)!==bundle)throw Error('Noncanonical bundle path');
  const rootStat=await lstat(bundle);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||await realpath(bundle)!==bundle)throw Error('Unsafe bundle root');
  const hash=createHash('sha256');let entries=0,totalBytes=0;
  const record=value=>hash.update(JSON.stringify(value)+'\n');
  async function walk(relative) {
    const current=path.join(bundle,relative),s=await lstat(current);
    if(++entries>100000||s.uid!==rootStat.uid||(!s.isSymbolicLink()&&(s.mode&0o022)!==0))throw Error('Unsafe bundle entry');
    if(s.isSymbolicLink()) {
      const target=await readlink(current);
      if(path.isAbsolute(target)||target.includes('\0')||target.includes('\\'))throw Error('Unsafe bundle link');
      const resolved=await realpath(current);
      if(resolved!==bundle&&!resolved.startsWith(bundle+path.sep))throw Error('Bundle link escapes root');
      record(['link',relative,target]);return;
    }
    if(s.isDirectory()) {
      record(['directory',relative,s.mode&0o777]);
      for(const name of (await readdir(current)).sort()) {
        if(name==='.'||name==='..'||name.includes('\0')||name.includes('\\'))throw Error('Unsafe bundle filename');
        await walk(relative?relative+'/'+name:name);
      }
      return;
    }
    if(!s.isFile()||s.nlink!==1)throw Error('Unsupported bundle entry');
    totalBytes+=s.size;if(totalBytes>4*1024**3)throw Error('Bundle too large');
    record(['file',relative,s.mode&0o777,s.size]);
    const file=await open(current,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const before=await file.stat();
      if(before.ino!==s.ino||before.dev!==s.dev)throw Error('Bundle changed during verification');
      for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk);
      const after=await file.stat();
      if(after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.ctimeMs!==s.ctimeMs)throw Error('Bundle changed during verification');
    }finally{await file.close();}
    hash.update('\n');
  }
  await walk('');return hash.digest('hex');
}
