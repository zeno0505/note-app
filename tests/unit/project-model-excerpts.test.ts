import {afterEach,expect,it} from 'vitest';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildProjectModelPack,type ProjectModelSource} from '../../src/main/project-model';
import {readingInputHash,validateModelAnswer,SECTION_IDS} from '../../src/summary/reading/model-harness';
import {createRegisteredExcerptReader,validateRegisteredExcerptContext} from '../../src/summary/context/registered';
import {selectedTaskExcerpts} from '../../src/summary/reading/scoped-project';
const at='2026-10-13T00:00:00.000Z';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(count:number,text=(i:number)=>'합성 기록 '+i){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'model-excerpts-')));roots.push(root);
 // Four registrations per file exercise the reader's full 32-excerpt / 8-file bound.
 const registrations=Array.from({length:count},(_,i)=>({id:'doc'+i,kind:'document' as const,relativePath:'doc'+Math.floor(i/4)+'.md',startLine:i%4+1,endLine:i%4+1}));
 const write=async(content:(i:number)=>string)=>{for(let f=0;f<Math.ceil(count/4);f++)await writeFile(path.join(root,'doc'+f+'.md'),Array.from({length:Math.min(4,count-f*4)},(_,j)=>content(f*4+j)).join('\n'));};
 await write(text);
 const s:ProjectModelSource={projectKey:'project:'+'a'.repeat(64),mappingIdentity:'synthetic',codeburn:[],dag:{dagId:'dag-1',sourceHash:'b'.repeat(64),sourceMtimeMs:1,observedAt:at,doneStatus:'done',tasks:[{id:'T-1',title:'합성 작업',status:'pending',dependencies:[],commitReferences:[],commitVerification:'not-performed',e2e:{state:'undeclared',required:null,coveredBy:null,coverage:'undeclared'},details:{description:[...new Set(registrations.map(r=>'[문서]('+r.relativePath+')'))].join(' '),acceptanceCriteria:[],targetFiles:[],discussion:[],design:[],omissions:0}}],statusCounts:[],coverage:{tasksTotal:1,declared:0,required:0,uncoveredDone:[],uncoveredOpen:[],malformed:[]},verifiedFacts:[]},readingSummary:{kind:'rules-only',workstreamId:'work-1',fingerprint:'fixture',revision:1,generatedAt:at,checkedAt:at,changed:false,partial:false,limitation:'bounded',sections:SECTION_IDS.map(id=>({id,title:id,paragraphs:[{text:'합성 근거입니다',basis:'declaration',sources:[]}]}))}};
 const read=async(now=at)=>{const context=await createRegisteredExcerptReader({dagId:s.dag.dagId,canonicalScopePath:root,canonicalNotePath:root,registrations,now:()=>Date.parse(now)}).read(s.dag.dagId);s.registeredExcerpts=selectedTaskExcerpts(validateRegisteredExcerptContext(context),s.dag,['T-1'],root);return buildProjectModelPack(s);};
 return {s,root,read,write};
}
const manifest=(p:ReturnType<typeof buildProjectModelPack>)=>JSON.parse(p.sources.find(s=>s.path==='documents/registered-excerpts.json')!.excerpt);
it('explicitly identifies fifth linked evidence omission and invalidates when its blocker changes',async()=>{
 const f=await fixture(5,i=>i===4?'배포를 막는 필수 승인 대기 기록':'합성 문서 '+i),before=await f.read(),m=manifest(before);
 expect(f.s.registeredExcerpts?.excerpts).toHaveLength(5);expect(m.selected).toHaveLength(4);expect(m.omitted).toHaveLength(1);
 expect(m.omitted[0].id).toBe(f.s.registeredExcerpts!.excerpts[4].id);expect(m.omitted[0].sourceHash).toBe(f.s.registeredExcerpts!.excerpts[4].sourceHash);
 const binding={runId:'synthetic',project:before.project,inputHash:readingInputHash(before),version:'connected-project-reading-v3',attempt:1 as const};
 const answer={...binding,sections:SECTION_IDS.map(id=>({id,text:before.facts.filter(f=>f.section===id).map(f=>f.text).join(' '),facts:before.facts.filter(f=>f.section===id).map(f=>({id:f.id,state:f.state})),sourceIds:[...new Set(before.facts.filter(f=>f.section===id).flatMap(f=>f.sourceIds))]}))};
 expect(validateModelAnswer(answer,binding,before)).toEqual([]);
 for(const qualifier of ['5개 중 1개','내용 근거가 아닙니다','차단·논의·완료 여부는 판단하지 않습니다']){
  const changed=structuredClone(answer);changed.sections.find(s=>s.id==='evidence')!.text=changed.sections.find(s=>s.id==='evidence')!.text.replace(qualifier,'일부');
  expect(validateModelAnswer(changed,binding,before).some(e=>e.startsWith('Required factual anchor'))).toBe(true);
 }
 expect(JSON.stringify(before)).not.toContain('배포를 막는');expect(before.facts.some(x=>x.section==='evidence'&&x.text.includes('5개 중 1개')&&x.text.includes('차단·논의·완료'))).toBe(true);
 await f.write(i=>i===4?'배포 승인 완료, 차단 해제 기록':'합성 문서 '+i);const after=await f.read();
 expect(readingInputHash(after)).not.toBe(readingInputHash(before));expect(manifest(after).omitted[0].sourceHash).not.toBe(m.omitted[0].sourceHash);
 expect(JSON.stringify(after)).not.toContain(f.root);expect(JSON.stringify(after)).not.toContain('canonicalPath');
});
it('retains all four included excerpts and changes hashes for included content, not observation time',async()=>{
 const f=await fixture(4),before=await f.read();expect(manifest(before).omitted).toEqual([]);expect(manifest(before).selected).toHaveLength(4);
 expect(readingInputHash(await f.read('2026-10-13T01:00:00.000Z'))).toBe(readingInputHash(before));
 await f.write(i=>'변경된 합성 기록 '+i);expect(readingInputHash(await f.read())).not.toBe(readingInputHash(before));
});
it('keeps 32-excerpt metadata and bounded content with Phase2 and recent activity',async()=>{
 const f=await fixture(32,i=>'한'.repeat(110)+i);f.s.dag.readContractVersion=2;f.s.dag.policies=[];
 f.s.recentActivity={state:'ready',coverage:'bounded-records',omittedReferences:0,message:'synthetic',taskIds:['T-1'],activities:[{taskId:'T-1',kind:'discussion',at,timeBasis:'declared-record-time',source:'doc0.md',sourceHash:'b'.repeat(64)}]};
 f.s.dag.tasks[0].status='running';
 f.s.readingSummary={...f.s.readingSummary,sections:f.s.readingSummary.sections.map(section=>({...section,paragraphs:Array.from({length:4},(_,i)=>({text:'합성 설명 '+i,basis:'declaration' as const,sources:[]}))}))};
 const pack=await f.read(),m=manifest(pack);expect(pack.facts).toHaveLength(24);expect(m.selected).toHaveLength(4);expect(m.omitted).toHaveLength(28);
 expect(pack.sources.length).toBeLessThanOrEqual(12);expect(pack.facts.length).toBeLessThanOrEqual(24);expect(Buffer.byteLength(JSON.stringify(pack))).toBeLessThanOrEqual(48000);
 expect(()=>readingInputHash(pack)).not.toThrow();expect(JSON.stringify(m)).not.toContain('observedAt');
});
it('rejects over-limit, mismatched, tampered, and sensitive omitted evidence before building a pack',async()=>{
 const f=await fixture(5);await f.read();const original=structuredClone(f.s.registeredExcerpts!);
 f.s.registeredExcerpts={...original,excerpts:[...original.excerpts,...Array(28).fill(original.excerpts[0])]};expect(()=>buildProjectModelPack(f.s)).toThrow();
 f.s.registeredExcerpts=original;f.s.dag.dagId='other';expect(()=>buildProjectModelPack(f.s)).toThrow('Registered excerpt scope mismatch');f.s.dag.dagId='dag-1';
 f.s.registeredExcerpts={...original,scopeDagId:'other'};expect(()=>buildProjectModelPack(f.s)).toThrow();
 f.s.registeredExcerpts=structuredClone(original);f.s.registeredExcerpts.excerpts[4].text='tampered';expect(()=>buildProjectModelPack(f.s)).toThrow();
 await f.write(i=>i===4?'person@example.test':'합성 기록 '+i);await expect(f.read()).rejects.toThrow('Sensitive input blocked');
});
it('retains the total-byte reader limit and per-excerpt limit',async()=>{
 const total=await fixture(32,()=> 'x'.repeat(400));await expect(total.read()).rejects.toThrow();
 const one=await fixture(1,()=> 'x'.repeat(2049));await expect(one.read()).rejects.toThrow();
});
