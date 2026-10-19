import fs from 'node:fs/promises';
import path from 'node:path';
import {parseHarnessYaml} from '../phase2/harness-yaml';
import {projectHarnessDeclarations,type HarnessLedgerHeader,type HarnessTaskDeclaration} from '../phase2/harness-ledger';
import {Budget,snapshot,assertSnapshot,type Snapshot} from '../collector/notes/link-workflow/safe-io';
import {gitRead,inspectGit} from '../collector/notes/link-workflow/git';
import {directGitConfiguration,directGitMetadata} from './project-dag-source';
export interface HarnessMainTask {id:string;title:string|null;status:string|null;harness?:HarnessTaskDeclaration}
export type HarnessMainObservation={state:'observed';commit:string;observedAt:string;ledger:HarnessLedgerHeader;tasks:HarnessMainTask[];taskCount:number}|{state:'not-observed';reason:string};
/** Exact file at a locally observed main commit. Never fetches or changes refs.
 * Repository and Git metadata must both be covered by existing read permission. */
export async function observeHarnessMain(options:{roots:string[];dagPath:string;gitExecutable:string;allowedCommonGitDirs:string[];authorize:(path:string)=>Promise<boolean>;signal:AbortSignal;track?:<T>(operation:Promise<T>)=>Promise<T>}):Promise<HarnessMainObservation>{
 const budget=new class extends Budget {override trackOperation<T>(operation:Promise<T>){return options.track?options.track(operation):operation;}}(5000,options.signal);
 try {
  let root:string|undefined;
  for(const candidate of options.roots){
   budget.check();const relative=path.relative(candidate,options.dagPath);
   if(!relative||relative.startsWith('..')||path.isAbsolute(relative))continue;
   if(!await options.authorize(candidate)||!await options.authorize(path.join(candidate,'.git')))continue;
   const stat=await budget.run(()=>fs.lstat(path.join(candidate,'.git'))).catch(()=>null);
   if(stat?.isDirectory()&&!stat.isSymbolicLink()){root=candidate;break;}
  }
  if(!root)return {state:'not-observed',reason:'장부 저장소와 Git 메타데이터를 포함하는 등록된 읽기 범위 미확인'};
  const stamps:Snapshot[]=[];const chosenRoot=root;
  const check=async()=>{budget.check();if(!await options.authorize(chosenRoot)||!await options.authorize(path.join(chosenRoot,'.git')))throw Error('Main permission changed');for(const stamp of stamps)await assertSnapshot(stamp,budget);};
  const authority=await inspectGit(options.gitExecutable,root,options.allowedCommonGitDirs,budget,async authority=>{
   for(const filename of new Set([path.join(authority.commonDirectory,'config'),path.join(authority.commonDirectory,'config.worktree'),path.join(authority.gitDirectory,'config.worktree')])){
    const file=await snapshot(filename,budget,true,1024*1024);
    if(file.snapshot.exists&&file.snapshot.kind!=='file')throw Error('Unsafe Git configuration');
    if(file.bytes)directGitConfiguration(file.bytes);stamps.push(file.snapshot);
   }
   stamps.push(...await directGitMetadata(authority,null,'main',budget));await check();
  });
  stamps.push(...authority.snapshots);
  const read=async(args:string[])=>{await check();const bytes=await gitRead(options.gitExecutable,chosenRoot,['--no-replace-objects',...args],budget);await check();return bytes;};
  const commit=(await read(['rev-parse','--verify','--end-of-options','refs/heads/main^{commit}'])).toString('utf8').trim();
  if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Invalid main identity');
  const relative=path.relative(root,options.dagPath).split(path.sep).join('/');
  const tree=(await read(['ls-tree',commit,'--',relative])).toString('utf8');
  if(!/^100(?:644|755) blob [a-f0-9]{40}\t/u.test(tree)||tree.trim().slice(tree.indexOf('\t')+1)!==relative)throw Error('Main ledger is not a regular blob');
  const bytes=await read(['show',commit+':'+relative]);
  const document=parseHarnessYaml(bytes.toString('utf8'));
  const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
  if(!object(document)||!Array.isArray(document.phases)||document.phases.some(phase=>!object(phase)||!Array.isArray(phase.tasks)))throw Error('Invalid main ledger');
  const declarations=document.phases.flatMap(phase=>object(phase)&&Array.isArray(phase.tasks)?phase.tasks:[]);
  if(declarations.length>10000||declarations.some(task=>!object(task)||typeof task.id!=='string'||task.id.length>256))throw Error('Invalid main tasks');
  const text=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max?v:null;
  const selected=declarations.slice(0,100);
  const tasks:HarnessMainTask[]=selected.map(task=>({id:task.id as string,title:text(task.title,4096),status:text(task.status,128)}));
  const ledger=projectHarnessDeclarations({ledger:document,ledgerTasks:selected},tasks);
  if(!ledger)throw Error('Main header unavailable');
  await check();
  return {state:'observed',commit,observedAt:new Date().toISOString(),ledger,tasks:ledger.state==='supported'?tasks:[],taskCount:declarations.length};
 }catch{return {state:'not-observed',reason:'로컬 main의 고정 커밋·장부를 안전하게 관측하지 못했습니다. session 파일과 합치지 않습니다.'};}
}
