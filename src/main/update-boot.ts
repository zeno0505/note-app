import path from 'node:path';
import {readPrivateUpdateJson,writePrivateUpdateJson} from './update-files';
import type {InstallationIdentity} from './install-identity';
/** Only the installed exact build can acknowledge a private, fresh installer challenge.
 * Called after trusted renderer mounted + main IPC is ready, before any source health is considered. */
export async function acknowledgeUpdateBoot(options:{argv:readonly string[];home:string;installation:InstallationIdentity;version:string}):Promise<void>{
  const prefix='--note-app-update-transaction=',noncePrefix='--note-app-update-nonce=';
  const ids=options.argv.filter(x=>x.startsWith(prefix)),nonces=options.argv.filter(x=>x.startsWith(noncePrefix));
  if(!ids.length&&!nonces.length)return;
  if(ids.length!==1||nonces.length!==1||options.installation.role!=='user')throw Error('Invalid update boot challenge');
  const transactionId=ids[0].slice(prefix.length),nonce=nonces[0].slice(noncePrefix.length);
  if(!/^[a-f0-9]{32}$/.test(transactionId)||!/^[a-f0-9]{64}$/.test(nonce))throw Error('Invalid update challenge');
  const directory=path.join(options.home,'Library','Application Support','note-app-updater','transactions',transactionId);
  const plan=await readPrivateUpdateJson(path.join(directory,'plan.json')) as Record<string,any>;
  if(plan.schemaVersion!==1||plan.transactionId!==transactionId||plan.nonce!==nonce||!plan.target||plan.target.sourceSha!==options.installation.buildSha||plan.target.buildNumber!==options.installation.buildNumber||plan.target.version!==options.version||!Number.isFinite(Date.parse(plan.expiresAt))||Date.parse(plan.expiresAt)<=Date.now())throw Error('Update boot identity mismatch or expired');
  await writePrivateUpdateJson(path.join(directory,'boot-ack.json'),{schemaVersion:1,transactionId,nonce,pid:process.pid,sourceSha:options.installation.buildSha,buildNumber:options.installation.buildNumber,version:options.version,appBooted:true});
}
