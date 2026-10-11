export const SUMMARY_AUTO_LIMITS={debounceMs:10000,minIntervalMs:120000,windowMs:3600000,maxRuns:6,maxModelCalls:2} as const;
export interface SummaryConsentBinding {projectId:string;projectIdentity:string;provider:string;accountId:string;accountLabel:string;modelPolicy:string;roots:{path:string;identity:string}[];scopeRevision:string;inputContract:string;selectionPolicy:'last-three-exact-task-activities-v1'}
export interface SummaryConsentProposal {ticketId:string;expiresAt:number;binding:SummaryConsentBinding;limits:typeof SUMMARY_AUTO_LIMITS}
export interface SummaryAutomationView {state:'off'|'waiting'|'running'|'failed'|'limited'|'needs-consent'|'unavailable'|'current';remembered:boolean;autoEnabled:boolean;nextAt:number|null;message:string;binding:SummaryConsentBinding|null}
