import path from 'node:path';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Budget,snapshot,assertSnapshot,realDirectory,type Snapshot} from '../collector/notes/link-workflow/safe-io';
import {gitRead,noteIsTracked} from '../collector/notes/link-workflow/git';
import type {NoteReconnectProposal} from '../shared/note-reconnect';

interface Selection {worktreePath:string}
function request(x:unknown,keys:string[]){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join(',')!==keys.sort().join(','))throw Error('재연결 요청을 확인할 수 없습니다.');return x as Record<string,unknown>;}
/** Picker paths stay in main. The existing grant is checked again before every link mutation. */
export function createNoteReconnect(options:{resolve(id:string):Selection|null;allowed(directory:string):Promise<boolean>;gitExecutable?:string;now?:()=>number}){
 const now=options.now??Date.now,git=options.gitExecutable??'/usr/bin/git';let busy=false,generation=0;
 let proposal:(NoteReconnectProposal&{selectedPath:string;tree:Snapshot;docs:Snapshot;note:Snapshot;target:Snapshot})|null=null;
 async function prepare(workstreamId:string,selectedPath:string):Promise<NoteReconnectProposal>{
  if(busy)throw Error('재연결 처리 중입니다.');proposal=null;const own=++generation,budget=new Budget(5000),selection=options.resolve(workstreamId);
  if(!selection)throw Error('현재 로컬 프로젝트를 다시 조회해 주세요.');
  const tree=await realDirectory(selection.worktreePath,budget),directory=await realDirectory(selectedPath,budget);
  if(!await options.allowed(directory))throw Error('선택한 디렉토리가 읽기 허용 범위 밖입니다. 연결 및 설정에서 읽기 범위를 명시적으로 허용한 뒤 다시 선택해 주세요.');
  if(directory===tree||tree.startsWith(directory+path.sep)||directory===path.parse(directory).root)throw Error('프로젝트 또는 전체 상위 디렉토리를 노트로 연결할 수 없습니다.');
  if((await gitRead(git,tree,['rev-parse','--show-toplevel'],budget)).toString().trim()!==tree)throw Error('Git 프로젝트 경로가 변경되었습니다.');
  if(await noteIsTracked(git,tree,budget))throw Error('Git이 추적하는 docs/note는 변경하지 않습니다.');
  const docsPath=path.join(tree,'docs'),docs=(await snapshot(docsPath,budget)).snapshot;
  if(docs.exists&&(docs.kind!=='directory'||await realDirectory(docsPath,budget)!==docsPath))throw Error('docs가 일반 디렉토리가 아닙니다. 기존 자료를 보존했습니다.');
  const note=(await snapshot(path.join(docsPath,'note'),budget)).snapshot;
  if(note.exists&&note.kind!=='symlink')throw Error('docs/note에 기존 파일 또는 디렉토리가 있습니다. 덮어쓰지 않습니다.');
  if(directory===docsPath||directory.startsWith(docsPath+path.sep))throw Error('docs 안의 디렉토리는 순환 연결 위험으로 선택할 수 없습니다.');
  let dag:NoteReconnectProposal['dag']='absent';
  for(const name of ['dag.yaml','dag.yml']){const file=(await snapshot(path.join(directory,name),budget)).snapshot;if(file.exists){if(file.kind!=='file')throw Error('DAG는 심볼릭 링크가 아닌 일반 파일이어야 합니다.');dag='present';}}
  const replacement=note.exists&&note.link!==directory;
  const p={proposalId:randomUUID(),workstreamId,directory,linkPath:note.path,previousTarget:note.link??null,replacement,dag,expiresAt:now()+120000,selectedPath,tree:(await snapshot(tree,budget)).snapshot,docs,note,target:(await snapshot(directory,budget)).snapshot};
  if(own!==generation)throw Error('폴더 선택이 취소되거나 바뀌었습니다.');proposal=p;
  return {proposalId:p.proposalId,workstreamId,directory,linkPath:p.linkPath,previousTarget:p.previousTarget,replacement,dag,expiresAt:p.expiresAt};
 }
 function cancel(x:unknown){const r=request(x,['proposalId']);if(proposal?.proposalId===r.proposalId){proposal=null;generation++;}}
 async function confirm(x:unknown):Promise<{backupPath:string|null}>{
  const r=request(x,['proposalId','linkChangeConfirmed']),p=proposal;
  if(busy||!p||r.proposalId!==p.proposalId||r.linkChangeConfirmed!==true||p.expiresAt<=now())throw Error('재연결 확인이 만료되었거나 취소되었습니다.');
  busy=true;proposal=null;generation++;const budget=new Budget(5000);let backupPath:string|null=null;
  try{
   const selection=options.resolve(p.workstreamId);
   if(!selection||await realDirectory(selection.worktreePath,budget)!==p.tree.path||await realDirectory(p.selectedPath,budget)!==p.directory||!await options.allowed(p.directory))throw Error('프로젝트 또는 읽기 허용 경로가 바뀌었습니다. 다시 선택해 주세요.');
   await assertSnapshot(p.tree,budget,false);await assertSnapshot(p.target,budget,false);await assertSnapshot(p.docs,budget,!p.docs.exists);await assertSnapshot(p.note,budget);
   if(await noteIsTracked(git,p.tree.path,budget))throw Error('Git이 추적하는 노트 연결은 바꾸지 않습니다.');
   if(!p.docs.exists)await fs.mkdir(p.docs.path,{mode:0o755});
   await assertSnapshot(p.tree,budget,false);
   if(await fs.realpath(p.docs.path)!==p.docs.path||(await fs.lstat(p.docs.path)).isSymbolicLink())throw Error('docs 경로가 변경되었습니다.');
   if(!p.replacement&&p.note.exists)return {backupPath:null};
   if(p.note.exists){
    // Moving preserves the old link, including broken targets. Never unlink user data.
    const backupDirectory=path.join(p.docs.path,'.note-app-link-backup-'+p.proposalId);await fs.mkdir(backupDirectory,{mode:0o700});backupPath=path.join(backupDirectory,'note');await fs.rename(p.note.path,backupPath);
    const moved=await fs.lstat(backupPath);
    if(moved.dev!==p.note.dev||moved.ino!==p.note.ino||!moved.isSymbolicLink())throw Error('연결이 동시에 변경되었습니다. 이동된 항목을 백업 경로에 보존했습니다.');
   }
   try{await fs.symlink(p.directory,p.linkPath);}catch{throw Error('새 연결을 만들지 못했습니다. 기존 자료와 백업을 보존했습니다.');}
   return {backupPath};
  }finally{busy=false;}
 }
 function invalidate(){proposal=null;generation++;}
 return {prepare,cancel,confirm,invalidate};
}
