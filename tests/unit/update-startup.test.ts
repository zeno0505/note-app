import {afterEach,describe,it,expect} from 'vitest';
import {realpath,mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {privateUpdateDirectory,writePrivateUpdateJson} from '../../src/main/update-files';import {updateStartupAllowed} from '../../src/main/update-startup';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(phase='installed'){
  const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'note-startup-')));roots.push(home);const id='a'.repeat(32),nonce='b'.repeat(64),old='c'.repeat(40),next='d'.repeat(40);
  const root=path.join(home,'Library','Application Support','note-app-updater'),directory=path.join(root,'transactions',id);await privateUpdateDirectory(directory,true);await privateUpdateDirectory(path.join(root,'install.lock'),true);
  await writePrivateUpdateJson(path.join(root,'install.lock/owner.json'),{pid:process.pid,transactionId:id});await writePrivateUpdateJson(path.join(directory,'plan.json'),{schemaVersion:1,transactionId:id,nonce,current:{sourceSha:old,buildNumber:'22'},target:{sourceSha:next,buildNumber:'23',version:'0.1.0'},expiresAt:new Date(Date.now()+10000).toISOString()});await writePrivateUpdateJson(path.join(directory,'journal.json'),{schemaVersion:1,transactionId:id,phase});
  const installation={role:'user' as const,currentPath:path.join(home,'Applications/note-app.app'),canonicalPath:path.join(home,'Applications/note-app.app'),buildSha:next,buildNumber:'23'};
  return {home,id,nonce,old,installation,args:[`--note-app-update-transaction=${id}`,`--note-app-update-nonce=${nonce}`]};
}
describe('updater startup interlock',()=>{
  it('blocks ordinary launches while the updater holds install lock',async()=>{const f=await fixture();expect(await updateStartupAllowed({...f,argv:[],version:'0.1.0'})).toBe(false);});
  it('admits only matching installed target challenge',async()=>{const f=await fixture();expect(await updateStartupAllowed({...f,argv:f.args,version:'0.1.0'})).toBe(true);expect(await updateStartupAllowed({...f,argv:f.args,version:'0.2.0'})).toBe(false);expect(await updateStartupAllowed({...f,argv:[...f.args,f.args[0]],version:'0.1.0'})).toBe(false);expect(await updateStartupAllowed({...f,argv:[f.args[0],'--note-app-update-nonce='+'0'.repeat(64)],version:'0.1.0'})).toBe(false);});
  it('rejects target before canonical swap and admits exact restored identity after rollback',async()=>{const f=await fixture('rolled-back');expect(await updateStartupAllowed({...f,argv:f.args,version:'0.1.0'})).toBe(false);expect(await updateStartupAllowed({...f,installation:{...f.installation,buildSha:f.old,buildNumber:'22'},argv:[`--note-app-recovery-transaction=${f.id}`,`--note-app-recovery-nonce=${f.nonce}`],version:'0.1.0'})).toBe(true);});
  it('ordinary launches remain unchanged without a transaction',async()=>{const f=await fixture();await rm(path.join(f.home,'Library/Application Support/note-app-updater/install.lock'),{recursive:true});expect(await updateStartupAllowed({...f,argv:[],version:'0.1.0'})).toBe(true);});
});
