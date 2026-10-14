import {parseSafeMarkdown} from './markdown';
import type {EvidenceList,EvidenceReadView,EvidenceSelection} from '../shared/evidence';
import type {DocumentRelationship} from '../shared/documents';

export type VerificationSourceState='present'|'none'|'unknown';
export interface VerificationSourceRecord {
  kind:'verification'|'review';
  text:string;
  relativePath:string;
  sourceHash:string;
  observedAt:string;
  sessionId:string;
  evidenceId:string;
  anchors:(string|null)[];
  /** Source prose is a claim, never a test result or an identity attestation. */
  assessment:'not-assessed';
  reviewerIdentity:'unconfirmed';
  targetSha:'unconfirmed';
  independence:'unconfirmed';
}
export interface TaskVerificationSources {
  taskId:string;
  state:VerificationSourceState;
  records:VerificationSourceRecord[];
  issues:string[];
}
type Item=EvidenceList['items'][number];
type Section={title:string;level:number;start:number;body:number;end:number};
const taskHeading=(title:string)=>title.match(/^(T-[A-Za-z0-9_-]+)(?=$|\s|[:·—–])/u)?.[1]??null;
const verificationHeading=(title:string)=>/^(Verification|검증|검증 기록)$/iu.test(title);

/** Bounded, inert Markdown parsing. Code/quoted/list headings are not declarations. */
export function parseVerificationMarkdown(text:string,taskId:string,contractOwned:boolean,reviewFile:boolean):{verification:string|null;review:string|null;issues:string[]} {
  const unknown=(issue:string)=>({verification:null,review:null,issues:[issue]});
  if(!/^T-[A-Za-z0-9_-]+$/u.test(taskId))return unknown('invalid-task-id');
  const document=parseSafeMarkdown(text);
  if(document.limited||document.issues.length)return unknown('malformed-or-limited-markdown');
  const source=text.replace(/\r\n?/gu,'\n'),lines=source.split('\n');
  const sections:Section[]=[];let fence:{char:string;length:number}|null=null,offset=0;
  for(const line of lines){
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if(marker){if(!fence)fence={char:marker[1][0],length:marker[1].length};else if(marker[1][0]===fence.char&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;}
    else if(!fence){
      if(/^ {0,3}#{1,6}(Verification|검증)/iu.test(line))return unknown('malformed-verification-declaration');
      const heading=line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
      if(heading){const title=parseSafeMarkdown(line).headings[0]?.text??heading[2];sections.push({title,level:heading[1].length,start:offset,body:offset+line.length+1,end:source.length});}
    }
    offset+=line.length+1;
  }
  if(fence)return unknown('unterminated-code-fence');
  for(let i=0;i<sections.length;i++)sections[i].end=sections.slice(i+1).find(h=>h.level<=sections[i].level)?.start??source.length;
  const taskSections=sections.filter(h=>taskHeading(h.title)!==null);
  const own=taskSections.filter(h=>taskHeading(h.title)===taskId);
  if(own.length>1)return unknown('repeated-task-declaration');
  if(contractOwned&&taskSections.some(h=>taskHeading(h.title)!==taskId))return unknown('conflicting-task-heading');
  if(!contractOwned&&own.length!==1)return unknown('task-association-unconfirmed');
  const start=contractOwned?0:own[0].body,end=contractOwned?source.length:own[0].end;
  const scoped=sections.filter(h=>h.start>=start&&h.start<end);
  if(scoped.some(h=>taskHeading(h.title)!==null&&taskHeading(h.title)!==taskId))return unknown('conflicting-task-heading');
  const declarations=scoped.filter(h=>verificationHeading(h.title));
  if(declarations.length>1)return unknown('repeated-verification-declaration');
  if(scoped.some(h=>/^(Verification|검증)(?=$|[\s:：·—–])/iu.test(h.title)&&!verificationHeading(h.title)))return unknown('malformed-verification-declaration');
  const declaration=declarations[0];
  const verification=declaration?source.slice(declaration.body,Math.min(declaration.end,end)).trim():null;
  if(declaration&&!verification)return unknown('empty-verification-declaration');
  const review=reviewFile?source.slice(start,end).trim():null;
  if(reviewFile&&!review)return unknown('empty-review-document');
  return {verification,review,issues:[]};
}

function association(relativePath:string,relationships:DocumentRelationship[],taskId:string):{eligible:boolean;owned:boolean;review:boolean;issue?:string} {
  // Exact contract identity takes precedence over a misleading label/relationship.
  const contract=relativePath.match(/^inbox\/([^/]+)\/(assignment|implementation|final|review-[1-9]\d{0,5})\.md$/u);
  if(contract&&contract[1]!==taskId)return {eligible:false,owned:false,review:false,issue:'other-task-contract'};
  const taskRelations=relationships.filter(r=>r.kind==='task-record'||r.kind==='task-declaration');
  if(taskRelations.some(r=>r.taskId!==taskId))return {eligible:false,owned:false,review:false,issue:'conflicting-task-relationship'};
  const linked=taskRelations.some(r=>r.taskId===taskId);
  if(!linked)return {eligible:false,owned:false,review:false};
  return {eligible:true,owned:!!contract,review:!!contract&&contract[2].startsWith('review-')};
}

export interface VerificationEvidenceBridge {
  prepareTaskEvidence(request:EvidenceSelection):Promise<EvidenceList>;
  readTaskEvidence(request:{sessionId:string;evidenceId:string;expectedSourceHash:string|null}):Promise<EvidenceReadView>;
  releaseTaskEvidence(request:{sessionId:string}):Promise<void>;
}
/** Headless read model. Each load obtains fresh capabilities, reads only main-issued
 * IDs, and discards late results. No filesystem, link following, model or Git calls. */
export function createTaskVerificationReader(bridge:VerificationEvidenceBridge){
  let generation=0,activeSession:string|null=null;
  const release=async(id:string)=>{try{await bridge.releaseTaskEvidence({sessionId:id});}catch{/* revoked sessions are already unavailable */}};
  async function load(selection:EvidenceSelection):Promise<TaskVerificationSources>{
    const current=++generation,previous=activeSession;activeSession=null;
    if(previous)await release(previous);
    const result:TaskVerificationSources={taskId:selection.taskId,state:'unknown',records:[],issues:[]};
    let session:EvidenceList;
    try{session=await bridge.prepareTaskEvidence({...selection,discoverTaskRecords:true});}
    catch{return {...result,issues:['discovery-unavailable']};}
    if(current!==generation){await release(session.sessionId);return {...result,issues:['superseded']};}
    activeSession=session.sessionId;
    if(session.unsupportedCount||session.omissions?.length)result.issues.push('discovery-incomplete');
    const grouped=new Map<string,Item[]>();
    for(const item of session.items){
      if(!item.relativePath){result.issues.push('source-path-unavailable');continue;}
      if(!/\.(md|markdown)$/iu.test(item.relativePath))continue;
      const group=grouped.get(item.relativePath)??[];group.push(item);grouped.set(item.relativePath,group);
    }
    for(const [relativePath,items]of grouped){
      const relation=association(relativePath,items.flatMap(i=>i.relationships??[]),selection.taskId);
      if(relation.issue)result.issues.push(relation.issue);
      if(!relation.eligible)continue;
      const item=items[0];let view:EvidenceReadView;
      try{view=await bridge.readTaskEvidence({sessionId:session.sessionId,evidenceId:item.evidenceId,expectedSourceHash:null});}
      catch{return {...result,records:[],issues:[...new Set([...result.issues,'read-unavailable'])]};}
      // The existing bridge can derive child sessions while reading Markdown.
      // This model never follows links, so retire those unused capabilities.
      for(const id of new Set([view.images?.sessionId,view.references?.session.sessionId].filter((id):id is string=>!!id&&id!==session.sessionId)))await release(id);
      if(current!==generation)return {...result,records:[],issues:['superseded']};
      if(!view.result.ok){
        result.issues.push(`read-${view.result.code}`);
        if(['permission-denied','retired','cancelled','unregistered'].includes(view.result.code))return {...result,records:[],issues:[...new Set(result.issues)]};
        continue;
      }
      const body=view.result;
      if(body.content.kind!=='text'||body.content.mime!=='text/markdown'){result.issues.push('not-markdown');continue;}
      const parsed=parseVerificationMarkdown(body.content.text,selection.taskId,relation.owned,relation.review);
      result.issues.push(...parsed.issues);
      const provenance={relativePath,sourceHash:body.sourceHash,observedAt:body.observedAt,sessionId:session.sessionId,evidenceId:item.evidenceId,anchors:[...new Set(items.map(i=>i.anchor))],assessment:'not-assessed' as const,reviewerIdentity:'unconfirmed' as const,targetSha:'unconfirmed' as const,independence:'unconfirmed' as const};
      if(parsed.verification)result.records.push({...provenance,kind:'verification',text:parsed.verification});
      if(parsed.review)result.records.push({...provenance,kind:'review',text:parsed.review});
    }
    if(current!==generation)return {...result,records:[],issues:['superseded']};
    result.issues=[...new Set(result.issues)];
    result.state=result.issues.length?'unknown':result.records.length?'present':'none';
    return result;
  }
  return {load,async dispose(){generation++;const session=activeSession;activeSession=null;if(session)await release(session);}};
}
