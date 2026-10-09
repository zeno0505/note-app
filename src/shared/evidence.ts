import type {EvidenceDescriptor,EvidenceResult} from '../phase2/evidence';
export interface EvidenceSelection {workstreamId:string;taskId:string;sourceHash:string}
export interface EvidenceList {sessionId:string;items:EvidenceDescriptor[];unsupportedCount:number}
export interface EvidenceReadView {result:EvidenceResult;images?:EvidenceList;references?:{session:EvidenceList;targets:{href:string;kind:'link'|'image';evidenceId:string}[]}}
