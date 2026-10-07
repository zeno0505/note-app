import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import {NOTE_MAPPING_LIMITS} from '../collector/notes';
import type {AllowedNoteScope,NoteWorktree} from '../collector/notes';
import type {SummaryCacheRecord} from '../summary/storage';
import type {ReadRootsView,ReadRootProposal} from '../shared/read-roots';

interface Root {id:string;path:string;kind:'project'|'vault';identity:string|null}
interface Payload {roots:Root[]}
interface Persistence {read():Promise<SummaryCacheRecord<Payload>|null>;write(payload:Payload,revision:number|null):Promise<SummaryCacheRecord<Payload>>}
const id=(p:string)=>createHash('sha256').update(p).digest('hex');
const inside=(root:string,p:string)=>p===root||p.startsWith(root+path.sep);
const absolute=(p:unknown):p is string=>typeof p==='string'&&p.length<=4096&&path.isAbsolute(p)&&path.normalize(p)===p&&p!==path.parse(p).root&&!/[\u0000-\u001f]/u.test(p);
export const readRootsCodec={parse(value:unknown):Payload {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='roots')throw Error('Invalid read roots');
  const roots=(value as Payload).roots;
  if(!Array.isArray(roots)||roots.length>32)throw Error('Invalid read root count');
  const seen=new Set<string>();
  for(const r of roots){
    if(!r||Object.keys(r).sort().join(',')!=='id,identity,kind,path'||!absolute(r.path)||r.id!==id(r.path)||seen.has(r.path)||!['project','vault'].includes(r.kind)||(r.identity!==null&&!/^\d+:\d+$/.test(r.identity)))throw Error('Invalid read root');seen.add(r.path);
  }
  return structuredClone({roots});
}};
async function directory(p:string){const canonical=await realpath(p),stat=await lstat(canonical);if(!stat.isDirectory()||stat.isSymbolicLink()||!absolute(canonical))throw Error('읽기 폴더를 확인할 수 없습니다.');return {path:canonical,identity:`${stat.dev}:${stat.ino}`};}
function request(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error('읽기 권한 요청 오류');return value as Record<string,unknown>;}

/** Main-owned picker proposals authorize reads only. An allow root never triggers a vault scan. */
export function createReadRoots(options:{initialScopes:AllowedNoteScope[];hostId?:string;persistence?:Persistence;unavailable?:boolean;now?:()=>number}){
  let roots:Root[]=[],revision:number|null=null,loaded=false,busy=false,generation=0;
  let proposal:(ReadRootProposal&{identity:string;generation:number})|null=null;
  const now=options.now??Date.now;
  let blocked=options.unavailable===true;
  async function valid(r:Root){try{const current=await directory(r.path);return current.path===r.path&&current.identity===r.identity;}catch{return false;}}
  async function load(){if(loaded)return;if(blocked){loaded=true;return;}let saved:SummaryCacheRecord<Payload>|null|undefined;try{saved=await options.persistence?.read();}catch{blocked=true;loaded=true;return;}
    if(saved){try{roots=readRootsCodec.parse(saved.payload).roots;revision=saved.revision;}catch{blocked=true;loaded=true;return;}}
    else for(const scope of options.initialScopes){if(roots.some(r=>r.path===scope.scopePath))continue;let canonical={path:scope.scopePath,identity:null as string|null};try{canonical=await directory(scope.scopePath);}catch{}if(absolute(canonical.path))roots.push({id:id(canonical.path),kind:'project',...canonical});}
    loaded=true;
  }
  async function view():Promise<ReadRootsView>{await load();return {revision,editable:!!options.persistence&&!blocked,...(blocked?{error:'앱의 읽기 권한 저장 위치를 확인하지 못해 노트 읽기를 중단했습니다. 기존 파일은 보존했습니다.'}:{}),roots:await Promise.all(roots.map(async r=>({id:r.id,path:r.path,kind:r.kind,available:await valid(r)})))};}
  function cancel(value:unknown){const r=request(value,['proposalId']);if(proposal?.proposalId===r.proposalId){proposal=null;generation++;}}
  async function prepare(selectedPath:string):Promise<ReadRootProposal>{await load();if(busy||blocked||!options.persistence)throw Error('앱 권한 저장 위치를 사용할 수 없습니다.');proposal=null;const version=++generation;const chosen=await directory(selectedPath);if(version!==generation)throw Error('폴더 선택이 취소되었습니다.');const p={proposalId:randomUUID(),path:chosen.path,expiresAt:now()+120_000,identity:chosen.identity,generation:version};proposal=p;return {proposalId:p.proposalId,path:p.path,expiresAt:p.expiresAt};}
  async function save(next:Root[]){if(!options.persistence||busy)throw Error('읽기 권한 저장을 사용할 수 없습니다.');busy=true;try{const saved=await options.persistence.write(readRootsCodec.parse({roots:next}),revision);roots=saved.payload.roots;revision=saved.revision;generation++;proposal=null;}finally{busy=false;}}
  async function confirm(value:unknown){const r=request(value,['proposalId','readOnlyConfirmed']);const p=proposal;if(r.readOnlyConfirmed!==true||!p||p.proposalId!==r.proposalId||p.generation!==generation||p.expiresAt<=now())throw Error('폴더 확인이 만료되었거나 변경되었습니다.');const chosen=await directory(p.path);if(proposal!==p||chosen.path!==p.path||chosen.identity!==p.identity)throw Error('폴더 경로가 변경되었습니다. 다시 선택해 주세요.');
    const ancestor=roots.find(root=>root.kind==='vault'&&inside(root.path,p.path));
    if(ancestor&&await valid(ancestor)){proposal=null;generation++;return view();}
    if(proposal!==p||p.generation!==generation||p.expiresAt<=now())throw Error('폴더 확인이 취소되었거나 만료되었습니다.');
    await save([...roots.filter(root=>!inside(p.path,root.path)),{id:id(p.path),path:p.path,kind:'vault',identity:p.identity}]);return view();
  }
  async function revoke(value:unknown){await load();const r=request(value,['rootId','expectedRevision','confirmed']);if(r.confirmed!==true||r.expectedRevision!==revision||!roots.some(root=>root.id===r.rootId))throw Error('읽기 권한이 변경되었습니다. 다시 확인해 주세요.');await save(roots.filter(root=>root.id!==r.rootId));return view();}
  async function filterScopes(scopes:readonly AllowedNoteScope[],signal?:AbortSignal){await load();const validRoots=await Promise.all(roots.map(async root=>await valid(root)?root:null));const result:AllowedNoteScope[]=[];
    for(const s of scopes){if(signal?.aborted)throw Error('읽기 범위 확인 취소');const root=validRoots.find(r=>r&&inside(r.path,s.scopePath));if(!root)continue;try{const target=await directory(s.scopePath);if(target.path!==s.scopePath||!inside(root.path,target.path))continue;if(root.kind==='vault'&&(s.vaultRootPath!==root.path||s.scopePath===root.path))continue;result.push(structuredClone(s));}catch{}}
    return result;
  }
  async function scopesFor(worktrees:readonly NoteWorktree[],retained:readonly AllowedNoteScope[]=[],signal?:AbortSignal){
    await load();if(worktrees.length>1000)throw Error('워크트리 범위 초과');const usable=await Promise.all(roots.map(async r=>await valid(r)?r:null));
    const normalized=[...options.initialScopes,...retained].map(s=>{const root=usable.find(r=>r&&inside(r.path,s.scopePath));const initial=options.initialScopes.find(original=>original.scopeId===s.scopeId&&original.hostId===s.hostId);return root?.kind==='vault'?{...s,vaultRootPath:root.path}:root?.kind==='project'&&initial?initial:s;});
    const scopes=new Map((await filterScopes(normalized,signal)).map(s=>[s.scopeId,s]));
    for(const w of worktrees){if(signal?.aborted)throw Error('읽기 범위 확인 취소');if(w.hostId!==options.hostId)continue;
      try{const tree=await directory(w.worktreePath),docs=await directory(path.join(tree.path,'docs'));if(!inside(tree.path,docs.path))continue;const link=path.join(docs.path,'note');if(!(await lstat(link)).isSymbolicLink())continue;const target=await realpath(link);const root=usable.find(r=>r?.kind==='vault'&&target!==r.path&&inside(r.path,target));if(!root)continue;const note=await directory(target);if(note.path!==target)continue;
        if([...scopes.values()].some(s=>s.scopePath===target))continue;
        const dags:string[]=[],identities=new Set<string>();let absent=0;for(const name of ['dag.yaml','dag.yml']){try{const file=path.join(target,name),stat=await lstat(file);if(stat.isFile()&&!stat.isSymbolicLink()&&await realpath(file)===file&&!identities.has(`${stat.dev}:${stat.ino}`)){dags.push(name);identities.add(`${stat.dev}:${stat.ino}`);}}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')absent++;}}
        if(dags.length||absent===2)scopes.set('read-root:'+id(target),{scopeId:'read-root:'+id(target),hostId:w.hostId,vaultRootPath:root.path,scopePath:target,dagRelativePaths:dags});
      }catch{}
    }
    if(scopes.size>NOTE_MAPPING_LIMITS.scopes)throw Error('프로젝트 노트 범위 초과');return [...scopes.values()];
  }
  async function allowsDirectory(p:string){await load();try{const selected=await directory(p);if(selected.path!==p)return false;for(const root of roots){if(!await valid(root))continue;if(root.kind==='vault'&&p!==root.path&&inside(root.path,p))return true;if(root.kind==='project'&&p===root.path&&options.initialScopes.some(s=>s.scopePath===p))return true;}return false;}catch{return false;}}
  return {load,view,prepare,confirm,cancel,revoke,filterScopes,scopesFor,allowsDirectory};
}
