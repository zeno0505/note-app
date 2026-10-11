import path from 'node:path';
import {lstat} from 'node:fs/promises';
import {privateUpdateDirectory,readPrivateUpdateJson} from './update-files';
import type {InstallationIdentity} from './install-identity';
/** Paired with updaterProtocolVersion:1 package metadata. Installer holds this
 * lock throughout replacement/recovery; a new ordinary launch must not enter. */
export async function updateStartupAllowed(options:{home:string;argv:readonly string[];installation:InstallationIdentity;version:string}):Promise<boolean>{
  if(options.installation.role!=='user')return true;
  const root=path.join(options.home,'Library','Application Support','note-app-updater'),lock=path.join(root,'install.lock');
  try{await lstat(lock);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;return false;}
  try{
    await privateUpdateDirectory(lock);
    const owner=await readPrivateUpdateJson(path.join(lock,'owner.json')) as Record<string,unknown>;
    if(Object.keys(owner).sort().join(',')!=='pid,transactionId'||!Number.isSafeInteger(owner.pid)||(owner.pid as number)<2||typeof owner.transactionId!=='string'||!/^[a-f0-9]{32}$/.test(owner.transactionId))return false;
    const modes=['update','recovery'].filter(mode=>options.argv.some(arg=>arg.startsWith(`--note-app-${mode}-transaction=`)));
    if(modes.length!==1)return false;const mode=modes[0],idPrefix=`--note-app-${mode}-transaction=`,noncePrefix=`--note-app-${mode}-nonce=`;
    const ids=options.argv.filter(arg=>arg.startsWith(idPrefix)),nonces=options.argv.filter(arg=>arg.startsWith(noncePrefix));
    if(ids.length!==1||nonces.length!==1||ids[0].slice(idPrefix.length)!==owner.transactionId)return false;
    const nonce=nonces[0].slice(noncePrefix.length);if(!/^[a-f0-9]{64}$/.test(nonce))return false;
    const directory=path.join(root,'transactions',owner.transactionId),plan=await readPrivateUpdateJson(path.join(directory,'plan.json')) as Record<string,any>;
    const journal=await readPrivateUpdateJson(path.join(directory,'journal.json')) as Record<string,unknown>;
    if(plan.schemaVersion!==1||plan.transactionId!==owner.transactionId||plan.nonce!==nonce||journal.schemaVersion!==1||journal.transactionId!==owner.transactionId)return false;
    const identity=mode==='update'?plan.target:plan.current;
    if(!identity||identity.sourceSha!==options.installation.buildSha||identity.buildNumber!==options.installation.buildNumber)return false;
    if(mode==='update'&&(identity.version!==options.version||!['installed','launched'].includes(String(journal.phase))||!Number.isFinite(Date.parse(plan.expiresAt))||Date.parse(plan.expiresAt)<=Date.now()))return false;
    if(mode==='recovery'&&journal.phase!=='rolled-back')return false;
    return true;
  }catch{return false;}
}
