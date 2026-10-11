import path from 'node:path';
import {createHash} from 'node:crypto';
export const BUNDLE_ID='dev.noteapp.local';
export const TX_ID=/^[a-f0-9]{32}$/;
export const SHA=/^[a-f0-9]{40}$/;
export const DIGEST=/^[a-f0-9]{64}$/;
export const VERSION=/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.-]{1,64})?$/;
export const validBuild=x=>typeof x==='string'&&/^[1-9]\d{0,3}$/.test(x)&&String(Number(x))===x;
export function exactKeys(value,keys) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw Error('Unknown or missing protocol fields');
}
export function pathsFor(home,id) {
  if(typeof home!=='string'||!path.isAbsolute(home)||path.resolve(home)!==home||!TX_ID.test(id))throw Error('Invalid transaction location');
  const root=path.join(home,'Library','Application Support','note-app-updater');
  const directory=path.join(root,'transactions',id),canonical=path.join(home,'Applications','note-app.app');
  return {root,directory,canonical,plan:path.join(directory,'plan.json'),stage:path.join(directory,'note-app.app'),
    manifest:path.join(directory,'note-app.app.manifest.json'),quit:path.join(directory,'quit-ready.json'),
    ack:path.join(directory,'boot-ack.json'),journal:path.join(directory,'journal.json'),receipt:path.join(directory,'receipt.json'),
    backup:path.join(home,'Applications',`.note-app-backup-${id}.app`),
    incoming:path.join(home,'Applications',`.note-app-incoming-${id}.app`),
    rejected:path.join(home,'Applications',`.note-app-rejected-${id}.app`),lock:path.join(root,'install.lock')};
}
export function validatePlan(value,now=Date.now(),{recovery=false}={}) {
  exactKeys(value,['schemaVersion','transactionId','createdAt','expiresAt','currentPid','current','target','nonce']);
  if(value.schemaVersion!==1||!TX_ID.test(value.transactionId)||!DIGEST.test(value.nonce)
    ||!Number.isSafeInteger(value.currentPid)||value.currentPid<2)throw Error('Invalid install plan');
  exactKeys(value.current,['sourceSha','buildNumber']);
  exactKeys(value.target,['sourceSha','sourceTree','buildNumber','version','architecture','appSha256']);
  if(!SHA.test(value.current.sourceSha)||!validBuild(value.current.buildNumber)||!SHA.test(value.target.sourceSha)
    ||!SHA.test(value.target.sourceTree)||!validBuild(value.target.buildNumber)||!VERSION.test(value.target.version)
    ||!['arm64','x64'].includes(value.target.architecture)||!DIGEST.test(value.target.appSha256)
    ||Number(value.target.buildNumber)<=Number(value.current.buildNumber)||value.current.sourceSha===value.target.sourceSha)throw Error('Invalid target identity');
  for(const field of ['createdAt','expiresAt'])if(typeof value[field]!=='string'||new Date(value[field]).toISOString()!==value[field])throw Error('Invalid plan timestamp');
  const created=Date.parse(value.createdAt),expires=Date.parse(value.expiresAt);
  if(expires<=created||expires-created>15*60*1000||created>now+5000||(!recovery&&now>=expires))throw Error('Expired or stale install plan');
  return value;
}
export function validateQuit(value,plan) {
  exactKeys(value,['schemaVersion','transactionId','nonce','currentPid','sourceSha','buildNumber','quitSettled']);
  return value.schemaVersion===1&&value.transactionId===plan.transactionId&&value.nonce===plan.nonce
    &&value.currentPid===plan.currentPid&&value.sourceSha===plan.current.sourceSha
    &&value.buildNumber===plan.current.buildNumber&&value.quitSettled===true;
}
export function validateBootAck(value,plan,pid) {
  exactKeys(value,['schemaVersion','transactionId','nonce','pid','sourceSha','buildNumber','version','appBooted']);
  return value.schemaVersion===1&&value.transactionId===plan.transactionId&&value.nonce===plan.nonce
    &&value.pid===pid&&value.sourceSha===plan.target.sourceSha&&value.buildNumber===plan.target.buildNumber
    &&value.version===plan.target.version&&value.appBooted===true;
}

export const OUTCOME_PHASES=Object.freeze(['healthy','rolled-back','recovery-needed','failed']);
export const JOURNAL_PHASES=Object.freeze(['validated','copied','backed-up','installed','launched',...OUTCOME_PHASES]);
/** Stable JSON integrity binds the entire value; this is not a publisher signature. */
export function protocolDigest(value) {
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function timestamp(value) {
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw Error('Invalid outcome timestamp');
}
export function validateJournal(value,plan) {
  exactKeys(value,['schemaVersion','transactionId','phase','updatedAt','launchedPid','originalAppSha256','detail']);
  if(value.schemaVersion!==1||value.transactionId!==plan.transactionId||!JOURNAL_PHASES.includes(value.phase)
    ||(value.launchedPid!==null&&(!Number.isSafeInteger(value.launchedPid)||value.launchedPid<2))
    ||(value.originalAppSha256!==null&&!DIGEST.test(value.originalAppSha256))
    ||(value.detail!==null&&(typeof value.detail!=='string'||value.detail.length>128)))throw Error('Invalid outcome journal');
  timestamp(value.updatedAt);
  if(Date.parse(value.updatedAt)<Date.parse(plan.createdAt))throw Error('Outcome predates intent');
  if(value.phase!=='failed'&&!DIGEST.test(value.originalAppSha256))throw Error('Missing original app integrity');
  if(value.phase==='healthy'&&value.launchedPid===null)throw Error('Missing healthy app process');
  return value;
}
export function createOutcomeReceipt(plan,journal) {
  validateJournal(journal,plan);
  if(!OUTCOME_PHASES.includes(journal.phase))throw Error('Not a terminal update outcome');
  const value={schemaVersion:1,updaterProtocolVersion:1,transactionId:plan.transactionId,nonce:plan.nonce,
    planSha256:protocolDigest(plan),current:{...plan.current},target:{...plan.target},phase:journal.phase,
    updatedAt:journal.updatedAt,journalSha256:protocolDigest(journal)};
  return {...value,receiptSha256:protocolDigest(value)};
}
export function validateOutcomeReceipt(value,plan,journal) {
  exactKeys(value,['schemaVersion','updaterProtocolVersion','transactionId','nonce','planSha256','current','target','phase','updatedAt','journalSha256','receiptSha256']);
  const expected=createOutcomeReceipt(plan,journal);
  if(protocolDigest(value)!==protocolDigest(expected))throw Error('Update receipt does not match intent or journal');
  return value;
}
