import {createHash,randomUUID} from 'node:crypto';

export const MODEL_HARNESS_VERSION='public-reading-v1';
export const SECTION_IDS=['implemented','next','evidence','decisions'] as const;
export type SectionId=typeof SECTION_IDS[number];
export type FactState='known'|'none'|'unrecorded'|'query-failed';
export interface PublicReadingPack {
  project:'zeno0505/note-app'; sourceSha:string;
  sources:{id:string;path:string;lineStart:number;lineEnd:number;sha256:string;excerpt:string}[];
  facts:{id:string;section:SectionId;state:FactState;text:string;sourceIds:string[];anchors:string[]}[];
}
export interface ModelBinding {runId:string;project:string;inputHash:string;version:string;attempt:1|2}
export interface ModelAnswer extends ModelBinding {
  sections:{id:SectionId;text:string;facts:{id:string;state:FactState}[];sourceIds:string[]}[];
}
export interface ModelReceipt {answer:unknown;usage:Record<string,unknown>;runtimeMs:number;provider:string}
export interface ModelAdapter {generate(request:{binding:ModelBinding;pack:PublicReadingPack;repairErrors:string[]},signal:AbortSignal):Promise<ModelReceipt>}
export interface HarnessRecord {inputHash:string;runId?:string;attempts:number;status:'running'|'model'|'fallback'|'cancelled';answer?:ModelAnswer;fallback?:{kind:'rules-only';sections:{id:SectionId;text:string}[]};errors:string[];receipts:{provider:string;usage:Record<string,unknown>;runtimeMs:number}[]}
export interface HarnessLedger {get(hash:string):Promise<HarnessRecord|undefined>;put(record:HarnessRecord,signal?:AbortSignal):Promise<void>;lock():Promise<()=>Promise<void>>}
const exact=(x:Record<string,unknown>,keys:string[])=>Object.keys(x).sort().join('|')===keys.sort().join('|');
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function validatePublicPack(pack:PublicReadingPack){
  if(pack.project!=='zeno0505/note-app'||!/^[a-f0-9]{40}$/.test(pack.sourceSha)||Buffer.byteLength(JSON.stringify(pack))>48000||pack.sources.length>12||pack.facts.length>24||!pack.facts.length)throw Error('Invalid bounded public pack');
  const sources=new Set<string>(),facts=new Set<string>();
  for(const s of pack.sources){if(sources.has(s.id)||!/^S\d+$/.test(s.id)||!(/^(src\/|docs\/|tests\/unit\/|\.github\/workflows\/)/.test(s.path)||s.path==='reviews/usage-statistics-mac.md')||s.path.includes('..')||s.path.startsWith('docs/note/')||s.path==='docs/note'||s.lineStart<1||s.lineEnd<s.lineStart||createHash('sha256').update(s.excerpt).digest('hex')!==s.sha256)throw Error('Invalid public source');sources.add(s.id);}
  for(const f of pack.facts){if(facts.has(f.id)||!/^F\d+$/.test(f.id)||!SECTION_IDS.includes(f.section)||!['known','none','unrecorded','query-failed'].includes(f.state)||!f.sourceIds.length||f.sourceIds.some(id=>!sources.has(id))||!f.anchors.length||f.text.length>1200)throw Error('Invalid fact contract');facts.add(f.id);}
  if(SECTION_IDS.some(id=>!pack.facts.some(f=>f.section===id)))throw Error('Every section needs explicit facts or absence state');
}
/** Hash semantic content only. Run identity, observation time and polling do not trigger generation. */
export function publicInputHash(pack:PublicReadingPack){validatePublicPack(pack);return hash({version:MODEL_HARNESS_VERSION,pack});}
export function validateModelAnswer(value:unknown,binding:ModelBinding,pack:PublicReadingPack):string[]{
  const errors:string[]=[];
  if(!object(value)||!exact(value,['runId','project','inputHash','version','attempt','sections']))return ['Invalid output object'];
  for(const key of ['runId','project','inputHash','version','attempt'] as const)if(value[key]!==binding[key])errors.push('Binding mismatch: '+key);
  if(!Array.isArray(value.sections)||value.sections.length!==4)return [...errors,'Exactly four sections required'];
  const seen=new Set<string>();
  for(const section of value.sections){
    if(!object(section)||!exact(section,['id','text','facts','sourceIds'])||!SECTION_IDS.includes(section.id as SectionId)||seen.has(String(section.id))||typeof section.text!=='string'||section.text.length<8||section.text.length>1800||!/[가-힣]/.test(section.text)||!Array.isArray(section.facts)||!Array.isArray(section.sourceIds)){errors.push('Invalid section');continue;}seen.add(String(section.id));
    const expected=pack.facts.filter(f=>f.section===section.id),listed=new Set<string>();
    for(const item of section.facts){if(!object(item)||!exact(item,['id','state'])||typeof item.id!=='string'||listed.has(item.id)){errors.push('Invalid or duplicate fact');continue;}listed.add(item.id);const fact=expected.find(f=>f.id===item.id);if(!fact||fact.state!==item.state)errors.push('Fact state changed: '+item.id);}
    if(expected.some(f=>!listed.has(f.id))||listed.size!==expected.length)errors.push('Missing fact coverage: '+section.id);
    const sourceIds=new Set(expected.flatMap(f=>f.sourceIds));if(section.sourceIds.length!==sourceIds.size||new Set(section.sourceIds).size!==sourceIds.size||section.sourceIds.some(id=>typeof id!=='string'||!sourceIds.has(id)))errors.push('Source coverage changed: '+section.id);
    const text=section.text;
    for(const fact of expected)if(fact.anchors.some(anchor=>!text.includes(anchor)))errors.push('Required factual anchor missing: '+fact.id);
    // Reject new numbers/SHA literals. This is a guard, not a semantic truth proof.
    const allowed=new Set(expected.flatMap(f=>f.text.match(/[a-f0-9]{40}|\d+(?:\.\d+)?/g)??[]));
    for(const literal of section.text.match(/[a-f0-9]{40}|\d+(?:\.\d+)?/g)??[])if(!allowed.has(literal))errors.push('Unsupported numeric/SHA literal: '+section.id);
    if(/<\/?(?:script|iframe)|javascript:/i.test(section.text))errors.push('Active content forbidden');
  }
  return errors;
}
export function modelOutputSchema(binding:ModelBinding){
  return {type:'object',additionalProperties:false,required:['runId','project','inputHash','version','attempt','sections'],properties:{...Object.fromEntries(Object.entries(binding).map(([k,v])=>[k,{const:v,type:typeof v==='number'?'integer':'string'}])),sections:{type:'array',minItems:4,maxItems:4,items:{type:'object',additionalProperties:false,required:['id','text','facts','sourceIds'],properties:{id:{type:'string',enum:SECTION_IDS},text:{type:'string',minLength:8,maxLength:1800},facts:{type:'array',maxItems:24,items:{type:'object',additionalProperties:false,required:['id','state'],properties:{id:{type:'string'},state:{type:'string',enum:['known','none','unrecorded','query-failed']}}}},sourceIds:{type:'array',maxItems:12,items:{type:'string'}}}}}}};
}
const fallback=(pack:PublicReadingPack)=>({kind:'rules-only' as const,sections:SECTION_IDS.map(id=>({id,text:pack.facts.filter(f=>f.section===id).map(f=>f.text).join(' ')}))});
let globalFlight:Promise<HarnessRecord>|undefined,globalHash:string|undefined,globalRetire:(()=>void)|undefined,quarantined=false;
/** No provider racing. A durable ledger reserves each attempt before the paid call. */
export function createPublicReadingHarness(adapter:ModelAdapter,ledger:HarnessLedger,timeoutMs=120000){
  let generation=0,controller:AbortController|undefined;
  return {
    cancel(){generation++;controller?.abort();},
    async summarize(pack:PublicReadingPack):Promise<HarnessRecord>{
      const inputHash=publicInputHash(pack);
      if(quarantined)throw Error('Unsettled model adapter quarantined; no further calls');
      if(globalFlight){if(globalHash===inputHash)return globalFlight;globalRetire?.();throw Error('Global model slot busy; prior input retired');}
      const ownGeneration=++generation;controller=new AbortController();const signal=controller.signal;
      const flight=(async():Promise<HarnessRecord>=>{
        const unlock=await ledger.lock();let release=true;try{
          const saved=await ledger.get(inputHash);if(saved){
            if(signal.aborted||generation!==ownGeneration)return {...saved,status:'cancelled',answer:undefined};
            if(saved.status==='model'&&(!saved.answer||validateModelAnswer(saved.answer,{runId:saved.answer.runId,project:pack.project,inputHash,version:MODEL_HARNESS_VERSION,attempt:saved.answer.attempt},pack).length))throw Error('Stored model answer invalid; no automatic replay');
            return saved.status==='running'?{...saved,status:'fallback',fallback:fallback(pack),errors:[...saved.errors,'Interrupted prior attempt; no automatic replay']}:saved.status==='fallback'?{...saved,fallback:saved.fallback??fallback(pack)}:saved;
          }
          const runId=randomUUID();
          const record:HarnessRecord={inputHash,runId,attempts:0,status:'running',errors:[],receipts:[]};
          for(const attempt of [1,2] as const){
            if(signal.aborted||generation!==ownGeneration){record.status='cancelled';break;}
            record.attempts=attempt;await ledger.put(record);
            const binding:ModelBinding={runId,project:pack.project,inputHash,version:MODEL_HARNESS_VERSION,attempt};
            let timer:ReturnType<typeof setTimeout>|undefined;
            let timedOut=false;
            let settled=false,adapterFlight:Promise<ModelReceipt>|undefined;
            try{
              adapterFlight=adapter.generate({binding,pack,repairErrors:record.errors},signal).finally(()=>{settled=true;});
              const receipt=await Promise.race([adapterFlight,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller?.abort();reject(Error('Model deadline'));},timeoutMs);signal.addEventListener('abort',()=>reject(Error('Model cancelled')),{once:true});})]);
              if(signal.aborted||generation!==ownGeneration){record.status='cancelled';break;}
              record.receipts.push({provider:receipt.provider,usage:receipt.usage,runtimeMs:receipt.runtimeMs});
              record.errors=validateModelAnswer(receipt.answer,binding,pack);
              if(!record.errors.length){record.status='model';record.answer=receipt.answer as ModelAnswer;break;}
              if(attempt===2)record.status='fallback';
            }catch(error){record.status=timedOut?'fallback':signal.aborted?'cancelled':'fallback';record.errors=[String(error)];
              if(adapterFlight&&!settled){let drainTimer:ReturnType<typeof setTimeout>|undefined;await Promise.race([adapterFlight.catch(()=>{}),new Promise<void>(resolve=>{drainTimer=setTimeout(resolve,2000);})]);if(drainTimer)clearTimeout(drainTimer);if(!settled){quarantined=true;release=false;record.errors.push('Adapter did not settle; durable global slot retained');}}
              break;
            }finally{if(timer)clearTimeout(timer);}
          }
          if(signal.aborted&&record.status==='model'||generation!==ownGeneration){record.status='cancelled';delete record.answer;}
          if(record.status==='running')record.status='fallback';if(record.status==='fallback')record.fallback=fallback(pack);await ledger.put(record,record.status==='model'?signal:undefined);return record;
        }finally{if(release)await unlock();}
      })();globalFlight=flight;globalHash=inputHash;globalRetire=()=>{generation++;controller?.abort();};
      try{return await flight;}finally{if(globalFlight===flight){globalFlight=undefined;globalHash=undefined;globalRetire=undefined;}}
    },
  };
}
