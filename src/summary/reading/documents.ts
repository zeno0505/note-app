import path from 'node:path';
import {validateRegisteredExcerptContext, type RegisteredExcerptContext} from '../context/registered';
import type {ReadingSection, ReadingSource} from '../../shared/reading-summary';

/** Explicit document records. No code analysis, task mapping or execution claims. */
export interface ProjectDocumentRecord {
  schemaVersion:1; id:string; section:ReadingSection['id']; text:string;
  verification:null|{sha:string;environment:string;result:'passed'|'failed'|'not-run'};
  references:string[];
  statement?:'recorded'|'not-applicable'|'unrecorded';
  designState?:'discussion'|'designed'|'not-applicable'|'unrecorded';
  links?:{role:'inbox'|'discussion'|'design';wikilink:string}[];
}
export interface ObservedProjectRecord extends ProjectDocumentRecord {source:ReadingSource}
export type ProjectDocumentObservation = {state:'unconfigured'|'unavailable'} | {state:'ready';dagId:string;records:ObservedProjectRecord[]};
function fail():never {throw new Error('Invalid registered project document');}
function object(v:unknown,keys:string[]):Record<string,unknown>{
  if(!v||typeof v!=='object'||Array.isArray(v)||Reflect.ownKeys(v).length!==keys.length)fail();
  const out:Record<string,unknown>={};for(const key of keys){const p=Object.getOwnPropertyDescriptor(v,key);if(!p||!('value'in p))fail();out[key]=p.value;}return out;
}
function text(v:unknown,max:number):string {if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v)>max||/[\u0000-\u001f\u007f]/u.test(v))fail();return v;}
export function parseProjectDocumentRecord(v:unknown):ProjectDocumentRecord {
  const optional=['statement','designState','links'].filter(k=>v&&typeof v==='object'&&Object.hasOwn(v,k));
  const r=object(v,['schemaVersion','id','section','text','verification','references',...optional]);
  if(r.statement!==undefined&&!['recorded','not-applicable','unrecorded'].includes(r.statement as string))fail();
  if(r.designState!==undefined&&(r.section!=='decisions'||!['discussion','designed','not-applicable','unrecorded'].includes(r.designState as string)))fail();
  let links:ProjectDocumentRecord['links'];
  if(r.links!==undefined){if(!Array.isArray(r.links)||r.links.length>3)fail();links=r.links.map(x=>{const l=object(x,['role','wikilink']);if(!['inbox','discussion','design'].includes(l.role as string))fail();const wikilink=text(l.wikilink,512);if(!/^\[\[[^\[\]]+\]\]$/.test(wikilink))fail();return {role:l.role as 'inbox'|'discussion'|'design',wikilink};});}
  if(r.schemaVersion!==1||!['implemented','next','evidence','decisions'].includes(r.section as string))fail();
  const id=text(r.id,128);if(!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(id))fail();
  let verification:ProjectDocumentRecord['verification']=null;
  if(r.verification!==null){const x=object(r.verification,['sha','environment','result']);const sha=text(x.sha,40);if(!/^[a-f0-9]{40}$/.test(sha)||!['passed','failed','not-run'].includes(x.result as string))fail();verification={sha,environment:text(x.environment,256),result:x.result as NonNullable<ProjectDocumentRecord['verification']>['result']};}
  if(!Array.isArray(r.references)||r.references.length>6)fail();
  const references=r.references.map(v=>{const p=text(v,256);if(path.isAbsolute(p)||p.includes('\\')||p.split('/').some(s=>!s||s==='.'||s==='..'))fail();return p;});
  if(new Set(references).size!==references.length)fail();
  return {schemaVersion:1,id,section:r.section as ReadingSection['id'],text:text(r.text,1200),verification,references,...(r.statement!==undefined?{statement:r.statement as ProjectDocumentRecord['statement']}:{}),...(r.designState!==undefined?{designState:r.designState as ProjectDocumentRecord['designState']}:{}),...(links?{links}:{})};
}
/** Each registered excerpt is one JSON record, bound to its exact read hash and lines. */
export function observeProjectDocuments(context:RegisteredExcerptContext,dagId:string):ProjectDocumentObservation {
  const checked=validateRegisteredExcerptContext(context);if(checked.scopeDagId!==dagId)fail();
  const records=checked.excerpts.map(excerpt=>{
    if(excerpt.kind!=='document')fail();
    const record=parseProjectDocumentRecord(JSON.parse(excerpt.text));
    const provenance=checked.provenance.find(p=>p.excerptId===excerpt.id)!;
    return {...record,source:{kind:'document' as const,id:`${excerpt.id}:${record.id}`,sha:record.verification?.sha??null,sourceHash:excerpt.sourceHash,observedAt:excerpt.observedAt,
      document:{relativePath:provenance.registration.relativePath,lineStart:provenance.lineStart,lineEnd:provenance.lineEnd,environment:record.verification?.environment??null,result:record.verification?.result??null,references:record.references}}};
  });
  if(!records.length||new Set(records.map(r=>r.id)).size!==records.length)fail();
  return {state:'ready',dagId,records};
}
