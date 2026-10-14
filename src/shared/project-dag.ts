import {parseProjectDraftId,parseProjectDraftRevision} from './project-draft';

/** This request selects saved app metadata only. It grants no filesystem access. */
export interface PrepareProjectDagRequest {draftId:string;expectedDraftRevision:number}
export interface ConfirmProjectDagRequest {previewId:string;expectedContentHash:string}
export interface CancelProjectDagRequest {previewId:string}

export interface EmptyProjectDagDocument {
  schema:2;legacy:false;
  project:{repo:string;project_path:string;note_dir:string};
  project_policy:[
    {key:'base_branch';decided_at:string;decision:string;legacy:false},
    {key:'verification';decided_at:string;decision:string[];legacy:false},
    {key:'project_instructions';decided_at:string;decision:string;legacy:false},
  ];
  rounds:[];phases:[];
}

export type ProjectDagUnavailableReason=
  |'draft_unavailable'|'draft_changed'|'single_repository_required'
  |'custom_instructions_required'|'additional_instructions_unresolved'
  |'source_validation_unavailable'|'source_changed'|'destination_selection_unavailable'
  |'destination_changed'|'invalid_source'|'invalid_destination'|'content_limit'
  |'busy'|'cancelled'|'timeout'|'preparation_failed'|'writer_unavailable'
  |'preview_expired'|'preview_changed'|'target_unavailable'|'publication_failed'|'publication_unverified';

export interface ProjectDagPreview {
  /** null for an offline preview, otherwise an opaque main-owned confirmation ticket. */
  previewId:string|null;
  draftId:string;draftRevision:number;draftHash:string;
  /** A planned target from a main-owned native selection; no existence/safety claim. */
  targetPath:string;targetState:'not-checked'|'absent';
  /** Exact UTF-8 JSON bytes, also valid YAML, including one trailing newline. */
  content:string;contentHash:string;byteLength:number;
  createdAt:string;expiresAt:string;
  summary:{tasks:0;phases:0;rounds:0;execution:'not-started';completion:'not-evaluated'};
  publication:{state:'unavailable';reasons:['safe-no-replace-writer-unavailable','fresh-filesystem-validation-required']}|{state:'confirmation-required'};
  registration:{state:'not-registered'};
}

export type ProjectDagPreparation=
  |{state:'unavailable';reason:ProjectDagUnavailableReason}
  |{state:'preview';preview:ProjectDagPreview};

export type ProjectDagPublication=
  |{state:'created'|'already-created';targetPath:string;contentHash:string;draftId:string;draftRevision:number;registration:{state:'not-registered'}}
  |{state:'unavailable';reason:ProjectDagUnavailableReason;outcome:'not-created'|'uncertain'};
export interface ProjectDagCreationPreview extends ProjectDagPreview {
  previewId:string;targetState:'absent';publication:{state:'confirmation-required'};
}
export type ProjectDagCreationPreparation=
  |{state:'unavailable';reason:ProjectDagUnavailableReason}
  |{state:'preview';preview:ProjectDagCreationPreview};
export type ProjectDagCreationResult=ProjectDagPublication;

export const PROJECT_DAG_LIMITS=Object.freeze({
  repo:256,projectPath:1024,noteDir:1024,branch:256,verificationCount:32,
  verificationInstruction:2048,policyCharacters:32768,contentBytes:128*1024,path:4096,sourceRevision:256,
  timeoutMs:5000,previewLifetimeMs:120000,
});

/** No destination, content, policy, authorization flag or arbitrary renderer path. */
export function parsePrepareProjectDagRequest(value:unknown):PrepareProjectDagRequest {
  function invalid():never {throw Error('저장한 프로젝트 초안을 다시 선택해 주세요.');}
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  if(Reflect.ownKeys(value).length!==2)invalid();
  const id=Object.getOwnPropertyDescriptor(value,'draftId'),revision=Object.getOwnPropertyDescriptor(value,'expectedDraftRevision');
  if(!id||!('value' in id)||!revision||!('value' in revision))invalid();
  return {draftId:parseProjectDraftId(id.value),expectedDraftRevision:parseProjectDraftRevision(revision.value)};
}

function confirmationFields(value:unknown,keys:string[]):Record<string,unknown> {
  function invalid():never {throw Error('DAG 미리보기를 다시 확인해 주세요.');}
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  if(Reflect.ownKeys(value).length!==keys.length)invalid();
  const result:Record<string,unknown>={};
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value' in descriptor))invalid();result[key]=descriptor.value;}
  if(typeof result.previewId!=='string'||!/^project-dag-preview-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(result.previewId))invalid();
  return result;
}
export function parseConfirmProjectDagRequest(value:unknown):ConfirmProjectDagRequest {
  const v=confirmationFields(value,['previewId','expectedContentHash']);
  if(typeof v.expectedContentHash!=='string'||! /^[0-9a-f]{64}$/u.test(v.expectedContentHash))throw Error('DAG 미리보기 해시를 다시 확인해 주세요.');
  return {previewId:v.previewId as string,expectedContentHash:v.expectedContentHash};
}
export function parseCancelProjectDagRequest(value:unknown):CancelProjectDagRequest {
  const v=confirmationFields(value,['previewId']);return {previewId:v.previewId as string};
}
