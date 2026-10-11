import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {parseProjectDraft,type ProjectDraft} from '../shared/project-draft';
import {
  PROJECT_DAG_LIMITS,parsePrepareProjectDagRequest,parseConfirmProjectDagRequest,parseCancelProjectDagRequest,type EmptyProjectDagDocument,
  type ProjectDagPreparation,type ProjectDagPreview,type ProjectDagUnavailableReason,type ProjectDagPublication,
  type ProjectDagCreationPreparation,type ProjectDagCreationPreview,
} from '../shared/project-dag';
import type {ProjectDagWriter,ProjectDagDirectorySnapshot,ProjectDagWriteReceipt} from './project-dag-writer';

/**
 * Main-only contract, never an IPC argument or a renderer-supplied "verified" flag.
 * The host must independently establish repository identity, formal project path,
 * note mapping and explicitly chosen base branch/verification instructions.
 * Observed Orca labels, draft paths and the current workspace branch are insufficient.
 * revision must identify the exact current validation evidence, not its display label.
 */
export interface ProjectDagValidatedSource {
  revision:string;draftId:string;draftRevision:number;
  repositoryPath:string;workspacePath:string;
  repo:string;projectPath:string;noteDir:string;baseBranch:string;
  verification:string[];decidedAt:string;
}

/** An existing main-owned native selection, never a path copied out of the draft. */
export interface ProjectDagPickedDestination {selectionId:string;targetPath:string}

export interface ProjectDagPreparerOptions {
  readDraft(id:string,signal:AbortSignal):Promise<ProjectDraft|null>;
  resolveSource?(draft:ProjectDraft,signal:AbortSignal):Promise<ProjectDagValidatedSource|null>;
  /** Read a prior native selection; do not open a picker for this unavailable publisher. */
  resolveDestination?(draft:ProjectDraft,signal:AbortSignal):Promise<ProjectDagPickedDestination|null>;
  now?:()=>number;
}

class PreparationError extends Error {
  constructor(readonly reason:ProjectDagUnavailableReason){super(reason);}
}
function fail(reason:ProjectDagUnavailableReason):never {throw new PreparationError(reason);}
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
/** Preserve only the finite source-validator codes; never expose exception bodies. */
function sourceFailure(error:unknown,fallback:ProjectDagUnavailableReason):ProjectDagUnavailableReason {
  if(error instanceof PreparationError)return error.reason;
  if(error&&typeof error==='object'){
    const descriptor=Object.getOwnPropertyDescriptor(error,'reason');
    const allowed=['invalid_source','source_changed','single_repository_required','custom_instructions_required','additional_instructions_unresolved','cancelled','timeout'] as const;
    if(descriptor&&'value' in descriptor&&typeof descriptor.value==='string'&&allowed.some(reason=>reason===descriptor.value))return descriptor.value as ProjectDagUnavailableReason;
  }
  return fallback;
}
function fields(value:unknown,keys:string[],reason:ProjectDagUnavailableReason):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(reason);
  if(Reflect.ownKeys(value).length!==keys.length)fail(reason);
  const result:Record<string,unknown>={};
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value' in descriptor))fail(reason);result[key]=descriptor.value;}
  return result;
}
function text(value:unknown,max:number,reason:ProjectDagUnavailableReason):string {
  if(typeof value!=='string'||!value.trim()||value.trim()!==value||value.length>max||/[\u0000-\u001f\u007f]/u.test(value))fail(reason);
  return value;
}
function absolute(value:unknown,reason:ProjectDagUnavailableReason):string {
  const result=text(value,PROJECT_DAG_LIMITS.path,reason);
  // Syntax only. This deliberately does not assert realpath, ownership or existence.
  if(!path.isAbsolute(result)||path.resolve(result)!==result||result===path.parse(result).root||result.includes('\\'))fail(reason);
  return result;
}
function relative(value:unknown,max:number):string {
  const result=text(value,max,'invalid_source');
  if(result.includes('\\')||result.startsWith('/')||result.split('/').some(part=>!part||part==='.'||part==='..'||part.trim()!==part))fail('invalid_source');
  return result;
}
function source(value:unknown,draft:ProjectDraft):ProjectDagValidatedSource {
  const v=fields(value,['revision','draftId','draftRevision','repositoryPath','workspacePath','repo','projectPath','noteDir','baseBranch','verification','decidedAt'],'invalid_source');
  if(v.draftId!==draft.id||v.draftRevision!==draft.revision)fail('source_changed');
  const repo=relative(v.repo,PROJECT_DAG_LIMITS.repo),projectPath=relative(v.projectPath,PROJECT_DAG_LIMITS.projectPath);
  if(repo.split('/').length!==2||!projectPath.startsWith(repo+'/'))fail('invalid_source');
  const repositoryPath=absolute(v.repositoryPath,'invalid_source'),workspacePath=absolute(v.workspacePath,'invalid_source');
  if(repositoryPath!==draft.input.repositories[0].path||workspacePath!==draft.input.repositories[0].workspace.path)fail('source_changed');
  const baseBranch=text(v.baseBranch,PROJECT_DAG_LIMITS.branch,'invalid_source');
  // Git ref-name shape validation, not a claim that the branch exists or was selected.
  if(baseBranch==='@'||baseBranch.startsWith('-')||baseBranch.startsWith('/')||baseBranch.endsWith('/')
    ||baseBranch.endsWith('.')||baseBranch.includes('..')||baseBranch.includes('@{')||/[ ~^:?*\[\\]/u.test(baseBranch)
    ||baseBranch.split('/').some(part=>!part||part.startsWith('.')||part.endsWith('.lock')))fail('invalid_source');
  if(!Array.isArray(v.verification)||!v.verification.length||v.verification.length>PROJECT_DAG_LIMITS.verificationCount
    ||Reflect.ownKeys(v.verification).length!==v.verification.length+1)fail('invalid_source');
  const verification=Array.from({length:v.verification.length},(_,index)=>{
    const descriptor=Object.getOwnPropertyDescriptor(v.verification,String(index));
    if(!descriptor||!('value' in descriptor))fail('invalid_source');
    return text(descriptor.value,PROJECT_DAG_LIMITS.verificationInstruction,'invalid_source');
  });
  const decidedAt=text(v.decidedAt,10,'invalid_source');
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(decidedAt)||!Number.isFinite(Date.parse(decidedAt+'T00:00:00.000Z'))
    ||new Date(decidedAt+'T00:00:00.000Z').toISOString().slice(0,10)!==decidedAt)fail('invalid_source');
  return {revision:text(v.revision,PROJECT_DAG_LIMITS.sourceRevision,'invalid_source'),draftId:draft.id,draftRevision:draft.revision,
    repositoryPath,workspacePath,repo,projectPath,noteDir:relative(v.noteDir,PROJECT_DAG_LIMITS.noteDir),baseBranch,verification,decidedAt};
}
function destination(value:unknown):ProjectDagPickedDestination {
  const v=fields(value,['selectionId','targetPath'],'invalid_destination'),targetPath=absolute(v.targetPath,'invalid_destination');
  // The existing pinned candidate discovery reads YAML. JSON is emitted as a YAML subset.
  if(!/\.(yaml|yml)$/u.test(path.basename(targetPath)))fail('invalid_destination');
  return {selectionId:text(v.selectionId,PROJECT_DAG_LIMITS.sourceRevision,'invalid_destination'),targetPath};
}
function supportedDraft(draft:ProjectDraft):void {
  if(draft.input.repositories.length!==1)fail('single_repository_required');
  // No implicit inheritance or precedence semantics are invented for schema2.
  if(draft.input.instructions.mode!=='custom'||!draft.input.instructions.text.trim())fail('custom_instructions_required');
  if(draft.input.instructions.additional.trim())fail('additional_instructions_unresolved');
}

/**
 * Offline, side-effect-free generator. All inputs are detached and shape-validated.
 * A source/destination can be supplied only by trusted main code. This function does
 * not verify that a file is absent, authorize a write, publish, or register a project.
 */
export function createEmptyProjectDagPreview(
  value:ProjectDraft,validatedSource:ProjectDagValidatedSource,pickedDestination:ProjectDagPickedDestination,at:number=Date.now(),
):ProjectDagPreview {
  const draft=parseProjectDraft(value);supportedDraft(draft);
  const s=source(validatedSource,draft),d=destination(pickedDestination);
  if(!Number.isSafeInteger(at)||at<0||at+PROJECT_DAG_LIMITS.previewLifetimeMs>8_640_000_000_000_000)fail('invalid_source');
  const document:EmptyProjectDagDocument={schema:2,legacy:false,
    project:{repo:s.repo,project_path:s.projectPath,note_dir:s.noteDir},
    project_policy:[
      {key:'base_branch',decided_at:s.decidedAt,decision:s.baseBranch,legacy:false},
      {key:'verification',decided_at:s.decidedAt,decision:[...s.verification],legacy:false},
      {key:'project_instructions',decided_at:s.decidedAt,decision:draft.input.instructions.text,legacy:false},
    ],rounds:[],phases:[]};
  // Match the existing versioned read-model policy envelope, including JSON escapes.
  if(document.project_policy.some(policy=>JSON.stringify(policy).length>PROJECT_DAG_LIMITS.policyCharacters))fail('content_limit');
  const content=JSON.stringify(document,null,2)+'\n',byteLength=Buffer.byteLength(content,'utf8');
  if(byteLength>PROJECT_DAG_LIMITS.contentBytes)fail('content_limit');
  return {previewId:null,draftId:draft.id,draftRevision:draft.revision,draftHash:hash(JSON.stringify(draft)),
    targetPath:d.targetPath,targetState:'not-checked',content,contentHash:hash(content),byteLength,
    createdAt:new Date(at).toISOString(),expiresAt:new Date(at+PROJECT_DAG_LIMITS.previewLifetimeMs).toISOString(),
    summary:{tasks:0,phases:0,rounds:0,execution:'not-started',completion:'not-evaluated'},
    publication:{state:'unavailable',reasons:['safe-no-replace-writer-unavailable','fresh-filesystem-validation-required']},
    registration:{state:'not-registered'}};
}

/**
 * Offline integration seam; intentionally not wired to host/preload/renderer.
 * Missing authority fails closed before asking for a destination. Orca observation
 * metadata alone does not prove repo/project_path/base_branch; a validated adapter
 * such as project-dag-source is required.
 * No picker, filesystem operation, context.md generation, command or model call.
 *
 * Publication is deliberately absent from this offline seam. createProjectDagCreation
 * below uses project-dag-writer's descriptor-relative no-replace helper, fresh source
 * checks and exact expiring target/content/hash confirmation. Successful file creation
 * still needs separately validated local-host/worktree/note mapping before registry
 * insertion. The offline preview must never be presented as that creation authority.
 */
export function createProjectDagPreparer(options:ProjectDagPreparerOptions) {
  const now=options.now??Date.now;
  let busy=false,retired=false,active:AbortController|null=null;
  const unavailable=(reason:ProjectDagUnavailableReason):ProjectDagPreparation=>({state:'unavailable',reason});
  return {
    async prepare(value:unknown):Promise<ProjectDagPreparation> {
      const request=parsePrepareProjectDagRequest(value);
      if(retired)return unavailable('cancelled');
      if(busy)return unavailable('busy');
      if(!options.resolveSource)return unavailable('source_validation_unavailable');
      if(!options.resolveDestination)return unavailable('destination_selection_unavailable');
      const resolveSource=options.resolveSource,resolveDestination=options.resolveDestination;
      const controller=new AbortController();active=controller;busy=true;
      let timer:ReturnType<typeof setTimeout>|undefined;
      const check=()=>{if(controller.signal.aborted)fail(retired?'cancelled':'timeout');};
      const read=async()=>{
        check();const raw=await options.readDraft(request.draftId,controller.signal);check();
        if(!raw)fail('draft_unavailable');
        const draft=parseProjectDraft(raw);
        if(draft.id!==request.draftId||draft.revision!==request.expectedDraftRevision)fail('draft_changed');
        supportedDraft(draft);return draft;
      };
      const observe=async():Promise<ProjectDagPreparation>=>{
        const draft=await read(),initialDraft=JSON.stringify(draft);
        const rawSource=await resolveSource(structuredClone(draft),controller.signal);check();
        if(!rawSource)fail('source_validation_unavailable');
        const s=source(rawSource,draft);
        const rawDestination=await resolveDestination(structuredClone(draft),controller.signal);check();
        if(!rawDestination)fail('destination_selection_unavailable');
        const d=destination(rawDestination);
        // Re-read independently; no stale source/destination may become a fresh preview.
        if(JSON.stringify(await read())!==initialDraft)fail('draft_changed');
        const currentSource=await resolveSource(structuredClone(draft),controller.signal);check();
        if(!currentSource||JSON.stringify(source(currentSource,draft))!==JSON.stringify(s))fail('source_changed');
        const currentDestination=await resolveDestination(structuredClone(draft),controller.signal);check();
        if(!currentDestination||JSON.stringify(destination(currentDestination))!==JSON.stringify(d))fail('destination_changed');
        if(JSON.stringify(await read())!==initialDraft)fail('draft_changed');
        check();return {state:'preview',preview:createEmptyProjectDagPreview(draft,s,d,now())};
      };
      try {
        return await Promise.race([observe(),new Promise<ProjectDagPreparation>(resolve=>{
          controller.signal.addEventListener('abort',()=>resolve(unavailable(retired?'cancelled':'timeout')),{once:true});
          timer=setTimeout(()=>controller.abort(),PROJECT_DAG_LIMITS.timeoutMs);
        })]);
      }catch(error){return unavailable(sourceFailure(error,'preparation_failed'));}
      finally{
        if(timer)clearTimeout(timer);
        // Retire on timeout: an uncooperative adapter must not accumulate pending reads.
        if(controller.signal.aborted)retired=true;
        busy=false;if(active===controller)active=null;
      }
    },
    /** Invalidates this instance and any pending read. There is no confirmation/write API. */
    dispose(){retired=true;active?.abort();},
  };
}

export interface ProjectDagCreationOptions {
  readDraft(id:string,signal:AbortSignal):Promise<ProjectDraft|null>;
  resolveSource(draft:ProjectDraft,signal:AbortSignal):Promise<ProjectDagValidatedSource|null>;
  /** The host opens a native directory picker. Human decision time has no IO deadline. */
  pickDirectory(draft:ProjectDraft,source:ProjectDagValidatedSource,signal:AbortSignal):Promise<string|null>;
  writer:ProjectDagWriter;
  now?:()=>number;
}

/** Main-only native-selection + exact-confirmation workflow. No registration or draft mutation. */
export function createProjectDagCreation(options:ProjectDagCreationOptions) {
  const now=options.now??Date.now,pending=new Set<Promise<unknown>>();
  interface Ticket {
    preview:ProjectDagPreview;draft:ProjectDraft;source:ProjectDagValidatedSource;
    directory:ProjectDagDirectorySnapshot;receipt?:ProjectDagWriteReceipt;
  }
  let ticket:Ticket|null=null,busy=false,retired=false,unverified=false,active:AbortController|null=null;
  function session() {
    const controller=new AbortController();active=controller;let timedOut=false;
    function check(){if(controller.signal.aborted)fail(timedOut?'timeout':'cancelled');}
    async function run<T>(action:(signal:AbortSignal)=>Promise<T>,bounded=true):Promise<T> {
      check();
      const operation=Promise.resolve().then(()=>{check();return action(controller.signal);});
      pending.add(operation);void operation.then(()=>pending.delete(operation),()=>pending.delete(operation));
      let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
      try {
        return await Promise.race([operation,new Promise<never>((_,reject)=>{
          abort=()=>reject(new PreparationError(timedOut?'timeout':'cancelled'));
          controller.signal.addEventListener('abort',abort,{once:true});
          if(bounded)timer=setTimeout(()=>{timedOut=true;retired=true;controller.abort();},PROJECT_DAG_LIMITS.timeoutMs);
          if(controller.signal.aborted)abort();
        })]).then(value=>{check();return value;});
      }finally{if(timer)clearTimeout(timer);if(abort)controller.signal.removeEventListener('abort',abort);}
    }
    return {controller,check,run};
  }
  function clearActive(controller:AbortController){busy=false;if(active===controller)active=null;}
  function reason(error:unknown,fallback:ProjectDagUnavailableReason):ProjectDagUnavailableReason {
    return sourceFailure(error,fallback);
  }
  async function current(request:{draftId:string;expectedDraftRevision:number},s:ReturnType<typeof session>) {
    const raw=await s.run(signal=>options.readDraft(request.draftId,signal));
    if(!raw)fail('draft_unavailable');
    const d=parseProjectDraft(raw);
    if(d.id!==request.draftId||d.revision!==request.expectedDraftRevision)fail('draft_changed');
    supportedDraft(d);return d;
  }
  async function validated(draft:ProjectDraft,s:ReturnType<typeof session>) {
    const value=await s.run(signal=>options.resolveSource(structuredClone(draft),signal));
    if(!value)fail('source_validation_unavailable');return source(value,draft);
  }
  async function unchanged(t:Pick<Ticket,'draft'|'source'>,s:ReturnType<typeof session>) {
    const d=await current({draftId:t.draft.id,expectedDraftRevision:t.draft.revision},s);
    if(JSON.stringify(d)!==JSON.stringify(t.draft))fail('draft_changed');
    if(JSON.stringify(await validated(d,s))!==JSON.stringify(t.source))fail('source_changed');
    if(JSON.stringify(await current({draftId:d.id,expectedDraftRevision:d.revision},s))!==JSON.stringify(d))fail('draft_changed');
  }
  return {
    async prepare(value:unknown):Promise<ProjectDagCreationPreparation> {
      const request=parsePrepareProjectDagRequest(value);
      if(retired)return {state:'unavailable',reason:'cancelled'};
      if(busy)return {state:'unavailable',reason:'busy'};
      busy=true;ticket=null;const s=session();
      try {
        const draft=await current(request,s),validatedSource=await validated(draft,s);
        const picked=await s.run(signal=>options.pickDirectory(structuredClone(draft),structuredClone(validatedSource),signal),false);
        if(picked===null)fail('cancelled');
        const directoryPath=absolute(picked,'invalid_destination');
        // project_path is the reviewed logical note hierarchy, not a worktree path.
        if(!directoryPath.endsWith(path.sep+validatedSource.projectPath.split('/').join(path.sep)))fail('invalid_destination');
        const directory=await s.run(signal=>options.writer.inspect(directoryPath,signal));
        if(directory.directory!==directoryPath||directory.targetState!=='absent')fail('target_unavailable');
        await unchanged({draft,source:validatedSource},s);
        const previewId='project-dag-preview-'+randomUUID();
        const preview:ProjectDagCreationPreview={
          ...createEmptyProjectDagPreview(draft,validatedSource,{selectionId:previewId,targetPath:path.join(directory.directory,'dag.yaml')},now()),
          previewId,targetState:'absent',publication:{state:'confirmation-required'},
        };
        s.check();ticket={preview:structuredClone(preview),draft,source:validatedSource,directory};
        return {state:'preview',preview};
      }catch(error){
        return {state:'unavailable',reason:reason(error,'target_unavailable')};
      }finally{clearActive(s.controller);}
    },
    async confirm(value:unknown):Promise<ProjectDagPublication> {
      const request=parseConfirmProjectDagRequest(value),t=ticket;
      const unavailable=(r:ProjectDagUnavailableReason,outcome:'not-created'|'uncertain'='not-created'):ProjectDagPublication=>({state:'unavailable',reason:r,outcome});
      if(retired)return unavailable(unverified?'publication_unverified':'cancelled',unverified?'uncertain':'not-created');
      if(busy)return unavailable('busy');
      if(!t||t.preview.previewId!==request.previewId||t.preview.contentHash!==request.expectedContentHash)return unavailable('preview_changed');
      if(Date.parse(t.preview.expiresAt)<=now()){ticket=null;return unavailable('preview_expired');}
      busy=true;const s=session();let publishing=false;
      try {
        await unchanged(t,s);
        if(ticket!==t||Date.parse(t.preview.expiresAt)<=now())fail('preview_expired');
        if(hash(t.preview.content)!==request.expectedContentHash)fail('preview_changed');
        // The writer opens the held directory identity and validates absence/ownership
        // atomically relative to its descriptor; no renderer path reaches this call.
        publishing=true;
        const receipt=await s.run(signal=>options.writer.publish({directory:t.directory,content:t.preview.content,
          contentHash:t.preview.contentHash,publicationId:t.preview.previewId!,...(t.receipt?{previousReceipt:t.receipt}:{})},signal));
        if(receipt.targetPath!==t.preview.targetPath||receipt.contentHash!==t.preview.contentHash||receipt.publicationId!==t.preview.previewId
          ||!['created','already-created'].includes(receipt.state))fail('publication_unverified');
        t.receipt=structuredClone(receipt);
        return {state:receipt.state,targetPath:receipt.targetPath,contentHash:receipt.contentHash,
          draftId:t.draft.id,draftRevision:t.draft.revision,registration:{state:'not-registered'}};
      }catch(error){
        // Writer errors provide a conservative explicit outcome; unknown errors after
        // publication starts are uncertain even if a caller requested cancellation.
        const knownNotCreated=!!error&&typeof error==='object'&&'outcome' in error&&error.outcome==='not-created';
        const uncertain=publishing&&!knownNotCreated;
        if(uncertain){unverified=true;retired=true;ticket=null;}
        else if(!t.receipt)ticket=null;
        return unavailable(uncertain?'publication_unverified':reason(error,'publication_failed'),uncertain?'uncertain':'not-created');
      }finally{clearActive(s.controller);}
    },
    cancel(value:unknown):void {
      const request=parseCancelProjectDagRequest(value);
      if(ticket?.preview.previewId===request.previewId){ticket=null;active?.abort();}
    },
    dispose():void {retired=true;ticket=null;active?.abort();},
    cleanupState:()=>({pending:pending.size>0,unverified}),
    async settle():Promise<void> {while(pending.size)await Promise.allSettled([...pending]);},
  };
}
