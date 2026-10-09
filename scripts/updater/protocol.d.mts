export interface InstallPlan {
  schemaVersion:1; transactionId:string; createdAt:string; expiresAt:string; currentPid:number;
  current:{sourceSha:string;buildNumber:string};
  target:{sourceSha:string;sourceTree:string;buildNumber:string;version:string;architecture:'arm64'|'x64';appSha256:string};
  nonce:string;
}
export type OutcomePhase='healthy'|'rolled-back'|'recovery-needed'|'failed';
export interface InstallJournal {
  schemaVersion:1;transactionId:string;phase:OutcomePhase|'validated'|'copied'|'backed-up'|'installed'|'launched';
  updatedAt:string;launchedPid:number|null;originalAppSha256:string|null;detail:string|null;
}
export interface OutcomeReceipt {
  schemaVersion:1;updaterProtocolVersion:1;transactionId:string;nonce:string;planSha256:string;
  current:InstallPlan['current'];target:InstallPlan['target'];phase:OutcomePhase;updatedAt:string;
  journalSha256:string;receiptSha256:string;
}
export const BUNDLE_ID:string;
export const TX_ID:RegExp;
export const SHA:RegExp;
export const DIGEST:RegExp;
export const VERSION:RegExp;
export const OUTCOME_PHASES:readonly OutcomePhase[];
export const JOURNAL_PHASES:readonly InstallJournal['phase'][];
export function validBuild(value:unknown):boolean;
export function exactKeys(value:unknown,keys:readonly string[]):void;
export function pathsFor(home:string,id:string):Record<'root'|'directory'|'canonical'|'plan'|'stage'|'manifest'|'quit'|'ack'|'journal'|'receipt'|'backup'|'incoming'|'rejected'|'lock',string>;
export function validatePlan(value:unknown,now?:number,options?:{recovery?:boolean}):InstallPlan;
export function validateQuit(value:unknown,plan:InstallPlan):boolean;
export function validateBootAck(value:unknown,plan:InstallPlan,pid:number):boolean;
export function protocolDigest(value:unknown):string;
export function validateJournal(value:unknown,plan:InstallPlan):InstallJournal;
export function createOutcomeReceipt(plan:InstallPlan,journal:InstallJournal):OutcomeReceipt;
export function validateOutcomeReceipt(value:unknown,plan:InstallPlan,journal:InstallJournal):OutcomeReceipt;
