/** Entered onboarding metadata only. Nothing here authorizes reads, writes or execution. */
export type ProjectReferenceKind = 'notion' | 'slack' | 'figma';
export interface ProjectDraftReference {kind:ProjectReferenceKind;url:string;state:'entered'}
export interface ProjectDraftInstructions {
  mode:'inherit'|'custom';
  /** User-entered source descriptor, revision/hash and captured text; never verified upstream. */
  source:string;sourceRevision:string;text:string;additional:string;
}
export interface ProjectDraftRepository {
  name:string;path:string;
  workspace:{mode:'existing'|'new';worktreeId:string;path:string;branch:string};
}
export interface ProjectDraftInput {
  name:string;description:string;references:ProjectDraftReference[];instructions:ProjectDraftInstructions;
  /** The authoritative note/DAG destination is independent of every repository/workspace. */
  noteLocation:string;repositories:ProjectDraftRepository[];
}
export interface ProjectDraft {id:string;revision:number;updatedAt:string;input:ProjectDraftInput}
export interface SaveProjectDraftRequest {id:string|null;expectedRevision:number|null;input:ProjectDraftInput}
export interface ProjectDraftBridge {
  listProjectDrafts():Promise<ProjectDraft[]>;
  saveProjectDraft(request:SaveProjectDraftRequest):Promise<ProjectDraft>;
}
export const PROJECT_DRAFT_LIMITS = Object.freeze({
  name:160,description:12000,references:32,url:2048,source:4096,sourceRevision:256,
  instructionText:32000,additionalInstructions:16000,path:4096,branch:256,repositories:16,inputBytes:256*1024,drafts:32,
});
export const createEmptyProjectDraftInput = ():ProjectDraftInput => ({
  name:'',description:'',references:[],instructions:{mode:'inherit',source:'',sourceRevision:'',text:'',additional:''},
  noteLocation:'',repositories:[],
});
function invalid():never {throw Error('프로젝트 초안 입력의 형식 또는 크기를 확인해 주세요.');}
function fields(value:unknown,keys:string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  const names=Reflect.ownKeys(value);
  if(names.length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))invalid();
  const result:Record<string,unknown>={};
  for(const key of keys){const property=Object.getOwnPropertyDescriptor(value,key);if(!property||!('value' in property))invalid();result[key]=property.value;}
  return result;
}
function text(value:unknown,maximum:number,multiline=false):string {
  if(typeof value!=='string'||value.length>maximum||(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u:/[\u0000-\u001f\u007f]/u).test(value))invalid();
  return value;
}
function list(value:unknown,maximum:number):unknown[] {
  if(!Array.isArray(value)||value.length>maximum||Reflect.ownKeys(value).length!==value.length+1)invalid();
  return Array.from({length:value.length},(_,index)=>{const property=Object.getOwnPropertyDescriptor(value,String(index));if(!property||!('value' in property))invalid();return property.value;});
}
function choice<T extends string>(value:unknown,allowed:readonly T[]):T {
  if(typeof value!=='string'||!allowed.includes(value as T))invalid();return value as T;
}
function reference(value:unknown):ProjectDraftReference {
  const r=fields(value,['kind','url','state']);
  const kind=choice(r.kind,['notion','slack','figma'] as const),url=text(r.url,PROJECT_DRAFT_LIMITS.url);
  if(r.state!=='entered')invalid();
  // An empty row is an incomplete draft, but nonempty links must be safe provider URLs.
  if(url){
    if(url.trim()!==url||/[\\\s]/u.test(url))invalid();
    let parsed:URL;try{parsed=new URL(url);}catch{invalid();}
    const domains=kind==='notion'?['notion.so','notion.site']:kind==='slack'?['slack.com']:['figma.com'];
    if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||!domains.some(domain=>parsed.hostname===domain||parsed.hostname.endsWith('.'+domain)))invalid();
  }
  return {kind,url,state:'entered'};
}
export function parseProjectDraftInput(value:unknown):ProjectDraftInput {
  const v=fields(value,['name','description','references','instructions','noteLocation','repositories']);
  const i=fields(v.instructions,['mode','source','sourceRevision','text','additional']);
  const result:ProjectDraftInput={
    name:text(v.name,PROJECT_DRAFT_LIMITS.name),description:text(v.description,PROJECT_DRAFT_LIMITS.description,true),
    references:list(v.references,PROJECT_DRAFT_LIMITS.references).map(reference),
    instructions:{mode:choice(i.mode,['inherit','custom'] as const),source:text(i.source,PROJECT_DRAFT_LIMITS.source),
      sourceRevision:text(i.sourceRevision,PROJECT_DRAFT_LIMITS.sourceRevision),text:text(i.text,PROJECT_DRAFT_LIMITS.instructionText,true),additional:text(i.additional,PROJECT_DRAFT_LIMITS.additionalInstructions,true)},
    noteLocation:text(v.noteLocation,PROJECT_DRAFT_LIMITS.path),
    repositories:list(v.repositories,PROJECT_DRAFT_LIMITS.repositories).map(value=>{
      const r=fields(value,['name','path','workspace']),w=fields(r.workspace,['mode','worktreeId','path','branch']);
      return {name:text(r.name,PROJECT_DRAFT_LIMITS.name),path:text(r.path,PROJECT_DRAFT_LIMITS.path),
        workspace:{mode:choice(w.mode,['existing','new'] as const),worktreeId:text(w.worktreeId,PROJECT_DRAFT_LIMITS.path),path:text(w.path,PROJECT_DRAFT_LIMITS.path),branch:text(w.branch,PROJECT_DRAFT_LIMITS.branch)}};
    }),
  };
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>PROJECT_DRAFT_LIMITS.inputBytes)invalid();
  return result;
}
export function parseProjectDraftId(value:unknown):string {
  if(typeof value!=='string'||!/^project-draft-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))invalid();return value;
}
export function parseProjectDraftRevision(value:unknown):number {
  if(!Number.isSafeInteger(value)||(value as number)<1||(value as number)>=Number.MAX_SAFE_INTEGER)invalid();return value as number;
}
export function parseProjectDraft(value:unknown):ProjectDraft {
  const v=fields(value,['id','revision','updatedAt','input']);
  if(typeof v.updatedAt!=='string'||v.updatedAt.length>32||!Number.isFinite(Date.parse(v.updatedAt))||new Date(v.updatedAt).toISOString()!==v.updatedAt)invalid();
  return {id:parseProjectDraftId(v.id),revision:parseProjectDraftRevision(v.revision),updatedAt:v.updatedAt,input:parseProjectDraftInput(v.input)};
}
export function parseSaveProjectDraftRequest(value:unknown):SaveProjectDraftRequest {
  const v=fields(value,['id','expectedRevision','input']);
  if((v.id===null)!==(v.expectedRevision===null))invalid();
  return {id:v.id===null?null:parseProjectDraftId(v.id),expectedRevision:v.expectedRevision===null?null:parseProjectDraftRevision(v.expectedRevision),input:parseProjectDraftInput(v.input)};
}
export type ProjectDraftMissingField='name'|'description'|'references'|'instructions'|'noteLocation'|'repositories'|'workspaceBindings';
/** Input completeness only. A ready draft remains unverified and cannot be published or executed. */
export function projectDraftReadiness(value:ProjectDraftInput):{readyForReview:boolean;missing:ProjectDraftMissingField[]} {
  const v=parseProjectDraftInput(value),missing:ProjectDraftMissingField[]=[];
  if(!v.name.trim())missing.push('name');
  if(!v.description.trim())missing.push('description');
  if(v.references.some(reference=>!reference.url))missing.push('references');
  if(!v.instructions.text.trim()||(v.instructions.mode==='inherit'&&(!v.instructions.source.trim()||!v.instructions.sourceRevision.trim())))missing.push('instructions');
  if(!v.noteLocation.trim())missing.push('noteLocation');
  if(!v.repositories.length||v.repositories.some(repository=>!repository.name.trim()||!repository.path.trim()))missing.push('repositories');
  if(v.repositories.some(repository=>!repository.workspace.path.trim()||(repository.workspace.mode==='existing'?!repository.workspace.worktreeId.trim():!repository.workspace.branch.trim())))missing.push('workspaceBindings');
  return {readyForReview:missing.length===0,missing};
}
