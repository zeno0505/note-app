import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseProjectDraft,type ProjectDraft} from '../shared/project-draft';
import {PROJECT_DAG_LIMITS,type ProjectDagUnavailableReason} from '../shared/project-dag';
import type {ProjectWorkspaceOption} from '../shared/project-workspaces';
import type {ProjectDagValidatedSource} from './project-dag';
import {gitRead,inspectGit,validPath,type GitAuthority} from '../collector/notes/link-workflow/git';
import {assertSnapshot,Budget,LinkError,realDirectory,snapshot,type Snapshot} from '../collector/notes/link-workflow/safe-io';

/** Explicit policy choices. Verification is inert text, never a command to run. */
export interface ProjectDagSourceSettings {projectPath:string;baseBranch:string;verification:string[]}
/** Trusted startup configuration, never a renderer request or a saved draft path. */
export interface ProjectDagSourceConfiguration {gitExecutablePath:string;allowedCommonGitDirs:readonly string[]}
/** Main retains original IO promises even after the source deadline has returned. */
export type ProjectDagSourceNativeTracker=<T>(operation:Promise<T>)=>Promise<T>;
export class ProjectDagSourceError extends Error {
  constructor(readonly reason:ProjectDagUnavailableReason,message:string){super(message);}
}
function fail(reason:ProjectDagUnavailableReason,message:string):never {throw new ProjectDagSourceError(reason,message);}
function invalid():never {return fail('invalid_source','The source or explicit project settings could not be validated.');}
function changed():never {return fail('source_changed','The selected repository or worktree changed. Select the current workspace again.');}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');

function fields(value:unknown,keys:string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  if(Reflect.ownKeys(value).length!==keys.length)invalid();
  const result:Record<string,unknown>={};
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value' in descriptor))invalid();result[key]=descriptor.value;}
  return result;
}
function text(value:unknown,max:number):string {
  if(typeof value!=='string'||!value||value.trim()!==value||value.length>max||/[\u0000-\u001f\u007f]/u.test(value))invalid();
  return value;
}
function absolute(value:unknown):string {
  if(!validPath(value)||path.resolve(value)!==value||value===path.parse(value).root||value.includes('\\'))invalid();
  return value;
}
function list(value:unknown,maximum:number):unknown[] {
  if(!Array.isArray(value)||value.length>maximum||Reflect.ownKeys(value).length!==value.length+1)invalid();
  return Array.from({length:value.length},(_,index)=>{
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index));if(!descriptor||!('value' in descriptor))invalid();return descriptor.value;
  });
}
function branchName(value:unknown):string {
  const result=text(value,PROJECT_DAG_LIMITS.branch);
  if(result==='@'||result.startsWith('-')||result.startsWith('/')||result.endsWith('/')||result.endsWith('.')
    ||result.includes('..')||result.includes('@{')||/[ ~^:?*\[\\]/u.test(result)
    ||result.split('/').some(part=>!part||part.startsWith('.')||part.endsWith('.lock')))invalid();
  return result;
}
function settings(value:ProjectDagSourceSettings):ProjectDagSourceSettings {
  const v=fields(value,['projectPath','baseBranch','verification']),projectPath=text(v.projectPath,PROJECT_DAG_LIMITS.projectPath);
  // A logical NOTE hierarchy, not a checkout or a path resolved against the process cwd.
  if(projectPath.includes('\\')||projectPath.startsWith('/')||projectPath.split('/').some(part=>
    !part||part==='.'||part==='..'||part.trim()!==part||/[:*?"<>|]/u.test(part)))invalid();
  const verification=list(v.verification,PROJECT_DAG_LIMITS.verificationCount).map(value=>text(value,PROJECT_DAG_LIMITS.verificationInstruction));
  if(!verification.length)invalid();
  return {projectPath,baseBranch:branchName(v.baseBranch),verification};
}
function configuration(value:ProjectDagSourceConfiguration):ProjectDagSourceConfiguration {
  const v=fields(value,['gitExecutablePath','allowedCommonGitDirs']);
  const allowedCommonGitDirs=list(v.allowedCommonGitDirs,64).map(absolute);
  if(new Set(allowedCommonGitDirs).size!==allowedCommonGitDirs.length)invalid();
  return {gitExecutablePath:absolute(v.gitExecutablePath),allowedCommonGitDirs};
}
function selection(value:ProjectWorkspaceOption):ProjectWorkspaceOption {
  const v=fields(value,['optionId','fingerprint','hostId','worktreeId','path','branch','repository']);
  const r=fields(v.repository,['key','id','hostId','projectId','label']);
  const hostId=text(v.hostId,4096),id=text(r.id,4096);
  if(typeof v.optionId!=='string'||!/^project-workspace-[0-9a-f]{64}$/u.test(v.optionId)
    ||typeof v.fingerprint!=='string'||!/^[0-9a-f]{64}$/u.test(v.fingerprint)
    ||r.hostId!==hostId||r.key!==JSON.stringify([hostId,id]))invalid();
  return {optionId:v.optionId,fingerprint:v.fingerprint,hostId,worktreeId:text(v.worktreeId,4096),path:absolute(v.path),
    branch:v.branch===null?null:branchName(v.branch),repository:{key:r.key as string,id,hostId,
      projectId:r.projectId===null?null:text(r.projectId,4096),label:text(r.label,512)}};
}
function date(value:unknown):string {
  const result=text(value,10);
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(result)||!Number.isFinite(Date.parse(result+'T00:00:00.000Z'))
    ||new Date(result+'T00:00:00.000Z').toISOString().slice(0,10)!==result)invalid();
  return result;
}
function line(bytes:Buffer):string {
  const value=bytes.toString('utf8').replace(/\r?\n$/u,'');
  if(!value||value.length>4096||/[\u0000-\u0020\u007f]/u.test(value)||value.includes('\ufffd'))invalid();
  return value;
}
/** GitHub's transport username is fixed; passwords, URL tokens, helpers and other hosts are unsupported. */
function repositoryFromRemote(remote:string):string {
  const match=/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/(?:git@)?github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)$/iu.exec(remote);
  if(!match)fail('invalid_source','The origin remote must be a credential-free GitHub HTTPS or SSH repository URL.');
  const owner=match[1]!,name=match[2]!.replace(/\.git$/u,'');
  if(!name||name==='.'||name==='..'||name.endsWith('.')||owner.length>39||owner.endsWith('-'))invalid();
  const repo=owner+'/'+name;
  if(repo.length>PROJECT_DAG_LIMITS.repo)invalid();
  return repo;
}
function objectId(bytes:Buffer):string {
  const result=line(bytes);
  if(!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(result))invalid();
  return result;
}
/**
 * A deliberately restricted direct-config grammar. Do not ask Git to parse this:
 * even a read-only Git command resolves local include/includeIf targets first.
 * Ambiguous headers, continuations and malformed text fail closed without opening
 * any referenced path. Ordinary direct Git-generated configuration remains usable.
 */
function directGitConfiguration(bytes:Buffer):void {
  const decoded=bytes.toString('utf8');
  if(!Buffer.from(decoded,'utf8').equals(bytes)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoded)
    ||/\\(?:\r?\n|$)/u.test(decoded))fail('invalid_source','Indirect, continued or ambiguous Git configuration is unsupported for project creation.');
  let section='';
  for(const raw of decoded.replace(/^\ufeff/u,'').split(/\r?\n/u)){
    const entry=raw.trim();
    if(!entry||entry.startsWith('#')||entry.startsWith(';'))continue;
    if(entry.startsWith('[')){
      const header=/^\[([A-Za-z][A-Za-z0-9-]*)(?:\.[A-Za-z0-9.-]+|[ \t]+"(?:[^"\\\r\n]|\\["\\])*")?\][ \t]*(?:[#;].*)?$/u.exec(entry);
      if(!header)fail('invalid_source','Ambiguous Git configuration sections are unsupported for project creation.');
      section=header[1]!.toLowerCase();
      if(section==='include'||section==='includeif')fail('invalid_source','Git configuration includes are unsupported for project creation. No included file was opened.');
      continue;
    }
    const variable=/^([A-Za-z][A-Za-z0-9-]*)[ \t]*(?:=.*|[#;].*)?$/u.exec(entry);
    if(!section||!variable)fail('invalid_source','Ambiguous Git configuration entries are unsupported for project creation.');
    const key=variable[1]!.toLowerCase();
    // Commit dereferencing must not start Git's automatic promised-object fetch.
    if(section==='extensions'&&key==='partialclone'||section==='remote'&&key==='promisor')
      fail('invalid_source','Partial-clone and promisor configuration is unsupported for offline project creation.');
  }
}
async function directGitMetadata(
  authority:Pick<GitAuthority,'gitDirectory'|'commonDirectory'>,selected:ProjectWorkspaceOption,baseBranch:string,budget:Budget,
):Promise<Snapshot[]> {
  const stamps:Snapshot[]=[],common=authority.commonDirectory;
  const directory=async(p:string,required=false):Promise<boolean>=>{
    const current=(await snapshot(p,budget)).snapshot;stamps.push(current);
    if(!current.exists&&!required)return false;
    if(current.kind!=='directory'||await realDirectory(p,budget)!==p)fail('invalid_source','Git metadata directories must be direct canonical directories.');
    return true;
  };
  const file=async(p:string,content=false,limit=16_384)=>{
    const current=await snapshot(p,budget,content,limit);stamps.push(current.snapshot);
    if(current.snapshot.exists&&current.snapshot.kind!=='file')fail('invalid_source','Git metadata files must be direct regular files.');
    return current;
  };
  const absent=async(p:string)=>{
    const current=(await snapshot(p,budget)).snapshot;stamps.push(current);
    if(current.exists)fail('invalid_source','Indirect Git object storage is unsupported for offline project creation.');
  };
  const head=await file(path.join(authority.gitDirectory,'HEAD'),true);
  if(!head.bytes)invalid();
  const symbolic=/^ref: (refs\/heads\/[^\r\n]+)\r?\n?$/u.exec(head.bytes.toString('utf8'));
  let currentBranch:string|null=null,headId:string|undefined;
  if(symbolic)currentBranch=branchName(symbolic[1]!.slice(11));else headId=objectId(head.bytes);
  if(currentBranch!==selected.branch&&(currentBranch===null||selected.branch!=='refs/heads/'+currentBranch))changed();

  const packed=await file(path.join(common,'packed-refs'),true,1_048_576),packedRefs=new Map<string,string>();
  if(packed.bytes)for(const raw of packed.bytes.toString('utf8').split(/\r?\n/u)){
    if(!raw||raw.startsWith('#'))continue;
    if(/^\^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(raw))continue;
    const ref=/^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/[^\s\x00-\x1f\x7f]+)$/u.exec(raw);
    if(!ref||packedRefs.has(ref[2]!))invalid();
    if(ref[2]!.startsWith('refs/replace/'))fail('invalid_source','Replacement Git objects are unsupported for project creation.');
    packedRefs.set(ref[2]!,ref[1]!);
  }
  const branchObject=async(branch:string):Promise<string>=>{
    const pieces=['refs','heads',...branch.split('/')];let parent=common;
    for(const part of pieces.slice(0,-1)){
      parent=path.join(parent,part);
      if(!await directory(parent)){
        const packedId=packedRefs.get('refs/heads/'+branch);if(!packedId)invalid();return packedId;
      }
    }
    const loose=await file(path.join(parent,pieces.at(-1)!),true);
    // Symbolic loose branches are another indirection; only direct object IDs are supported.
    if(loose.bytes)return objectId(loose.bytes);
    const packedId=packedRefs.get('refs/heads/'+branch);if(!packedId)invalid();return packedId;
  };
  if(currentBranch)headId=await branchObject(currentBranch);
  const baseId=await branchObject(baseBranch);
  if(await directory(path.join(common,'refs')))await absent(path.join(common,'refs','replace'));

  const objects=path.join(common,'objects');await directory(objects,true);
  if(await directory(path.join(objects,'info'))){
    await absent(path.join(objects,'info','alternates'));
    await absent(path.join(objects,'info','http-alternates'));
    await absent(path.join(objects,'info','commit-graphs'));
    await file(path.join(objects,'info','commit-graph'));
  }
  const packs=path.join(objects,'pack');
  if(await directory(packs)){
    const names=await budget.run(()=>fs.readdir(packs));
    if(names.length>1024)fail('invalid_source','Git pack metadata exceeds the bounded source limit.');
    for(const name of names){
      if(name.endsWith('.promisor'))fail('invalid_source','Promisor objects are unsupported for offline project creation.');
      await file(path.join(packs,name));
    }
  }
  for(const id of new Set([headId!,baseId])){
    const prefix=path.join(objects,id.slice(0,2));
    if(await directory(prefix))await file(path.join(prefix,id.slice(2)));
  }
  await file(path.join(common,'shallow'));
  if(await directory(path.join(common,'info')))await file(path.join(common,'info','grafts'));
  return stamps;
}
interface Evidence {origin:string;branch:string|null;head:string;base:string}
async function evidence(executable:string,worktree:string,baseBranch:string,budget:Budget,checkConfiguration:()=>Promise<void>):Promise<Evidence> {
  // These are fixed local metadata reads. No fetch, helpers, hooks, shell or verification execution.
  const read=async(argv:string[],allowNoMatch=false):Promise<Buffer>=>{
    await checkConfiguration();const result=await gitRead(executable,worktree,['--no-replace-objects',...argv],budget,undefined,allowNoMatch);
    await checkConfiguration();return result;
  };
  const origin=line(await read(['remote','get-url','origin']));
  repositoryFromRemote(origin);
  const symbolic=await read(['symbolic-ref','--quiet','HEAD'],true);
  let branch:string|null=null;
  if(symbolic.length){const ref=line(symbolic);if(!ref.startsWith('refs/heads/'))invalid();branch=branchName(ref.slice(11));}
  const head=objectId(await read(['rev-parse','--verify','--end-of-options','HEAD^{commit}']));
  const reference='refs/heads/'+baseBranch;
  const base=objectId(await read(['show-ref','--verify','--hash',reference]));
  // A local branch must point directly at a commit, rather than merely containing a ref-shaped string.
  if(objectId(await read(['rev-parse','--verify','--end-of-options',reference+'^{commit}']))!==base)invalid();
  return {origin,branch,head,base};
}

/**
 * Main-only read-only validation. selected must come freshly from the existing main
 * workspace selector, never from IPC. Saved paths are compared, never followed.
 * A source revision is evidence for an expiring preview, not ongoing filesystem authority.
 * Native note destination correspondence and no-replace publication are separate.
 */
export async function validateProjectDagSource(
  value:ProjectDraft,current:ProjectWorkspaceOption,explicit:ProjectDagSourceSettings,
  trusted:ProjectDagSourceConfiguration,signal:AbortSignal,decidedAt:string,nativeTracker?:ProjectDagSourceNativeTracker,
):Promise<ProjectDagValidatedSource> {
  class SourceBudget extends Budget {
    override trackOperation<T>(operation:Promise<T>):Promise<T>{return nativeTracker?nativeTracker(operation):operation;}
  }
  const budget=new SourceBudget(PROJECT_DAG_LIMITS.timeoutMs,signal);
  try {
    budget.check();
    const draft=parseProjectDraft(value),selected=selection(current),policy=settings(explicit),config=configuration(trusted),decisionDate=date(decidedAt);
    if(draft.input.repositories.length!==1)fail('single_repository_required','EMPTY DAG creation requires exactly one repository.');
    const repository=draft.input.repositories[0];
    if(repository.workspace.mode!=='existing'||repository.workspace.worktreeId!==selected.worktreeId
      ||repository.path!==selected.path||repository.workspace.path!==selected.path
      ||repository.workspace.branch!==(selected.branch??''))changed();
    // The only checkout traversed comes from trusted current runtime metadata.
    const worktree=await realDirectory(selected.path,budget);
    if(worktree!==selected.path)fail('invalid_source','The selected checkout must be an existing canonical Git root.');
    const stamps:Snapshot[]=[(await snapshot(worktree,budget)).snapshot,(await snapshot(config.gitExecutablePath,budget)).snapshot];
    const executable=await budget.run(()=>fs.realpath(config.gitExecutablePath));
    let configurationStamps:Snapshot[]|undefined;
    const checkConfiguration=async()=>{for(const stamp of configurationStamps??[])await assertSnapshot(stamp,budget);};
    const git=await inspectGit(executable,worktree,config.allowedCommonGitDirs,budget,async authority=>{
      if(!configurationStamps){
        const verified:Snapshot[]=[];
        for(const file of new Set([path.join(authority.commonDirectory,'config'),
          path.join(authority.commonDirectory,'config.worktree'),path.join(authority.gitDirectory,'config.worktree')])){
          const result=await snapshot(file,budget,true,1_048_576);
          if(result.snapshot.exists&&result.snapshot.kind!=='file')fail('invalid_source','Git configuration must be direct regular files before any Git read.');
          if(result.bytes)directGitConfiguration(result.bytes);
          verified.push(result.snapshot);
        }
        verified.push(...await directGitMetadata(authority,selected,policy.baseBranch,budget));
        configurationStamps=verified;stamps.push(...verified);
      }
      await checkConfiguration();
    });
    stamps.push(...git.snapshots);
    const observed=await evidence(executable,worktree,policy.baseBranch,budget,checkConfiguration);
    // Orca may retain Git's full symbolic ref rather than its short branch name.
    // The saved draft still matches that exact observation; only Git comparison
    // accepts these two equivalent representations of the same actual branch.
    if(observed.branch!==selected.branch&&(observed.branch===null||selected.branch!=='refs/heads/'+observed.branch))changed();
    const repo=repositoryFromRemote(observed.origin);
    if(!policy.projectPath.startsWith(repo+'/'))fail('invalid_source','The explicit project path must begin with the origin owner/repository followed by the project name.');
    const latest=await evidence(executable,worktree,policy.baseBranch,budget,checkConfiguration);
    if(JSON.stringify(latest)!==JSON.stringify(observed))changed();
    for(const stamp of stamps)await assertSnapshot(stamp,budget);
    budget.check();
    // Observation handles intentionally expire on even identical polling refreshes.
    // The host resolves those afresh; this revision binds the stable selected resource.
    const selectedIdentity={hostId:selected.hostId,worktreeId:selected.worktreeId,path:selected.path,branch:selected.branch,
      repository:{key:selected.repository.key,id:selected.repository.id,hostId:selected.repository.hostId,projectId:selected.repository.projectId}};
    return {revision:digest({version:1,draft,selected:selectedIdentity,worktree,gitDirectory:git.gitDirectory,commonDirectory:git.commonDirectory,
      worktreePaths:git.worktreePaths,stamps,observed,repo,policy,decidedAt:decisionDate}),
      draftId:draft.id,draftRevision:draft.revision,repositoryPath:worktree,workspacePath:worktree,
      repo,projectPath:policy.projectPath,noteDir:'docs/note',baseBranch:policy.baseBranch,verification:[...policy.verification],decidedAt:decisionDate};
  }catch(error){
    if(error instanceof ProjectDagSourceError)throw error;
    if(error instanceof LinkError){
      if(error.code==='cancelled'||error.code==='timeout')fail(error.code,error.message);
      if(error.code==='stale-preview')changed();
    }
    fail('invalid_source','The selected checkout, registered Git metadata, origin, or local base branch could not be verified.');
  }
}
