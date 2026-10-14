import type {EvidenceDescriptor,EvidenceResult} from '../phase2/evidence';
export interface EvidenceSelection {workstreamId:string;taskId:string;sourceHash:string;discoverTaskRecords?:true}
export interface EvidenceList {sessionId:string;items:(EvidenceDescriptor & {relativePath?:string;relationships?:import('./documents').DocumentRelationship[]})[];unsupportedCount:number;omissions?:string[]}
export interface EvidenceReadView {result:EvidenceResult;images?:EvidenceList;references?:{session:EvidenceList;targets:{href:string;kind:'link'|'image';evidenceId:string;status?:'resolved'|'missing'|'ambiguous'|'out-of-scope'|'unsupported';candidates?:{evidenceId:string;label:string;relativePath:string;anchor:string|null}[]}[]}}
