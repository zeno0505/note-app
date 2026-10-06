import {createHash} from 'node:crypto';
import {createPublicReadingHarness,readingInputHash,SECTION_IDS,type ModelAdapter,type ProjectReadingPack} from '../summary/reading/model-harness';
import type {createModelReadingStorage,LatestModelReadingView} from '../summary/reading/model-reading-storage';
import type {SummaryWorkflowSource} from '../summary/workflow';
import type {DeepReadonly} from '../collector/snapshot/types';
import type {ReadingSummary} from '../shared/reading-summary';
export interface ProjectModelSource extends SummaryWorkflowSource {projectKey:string;readingSummary:DeepReadonly<ReadingSummary>}
export interface ProjectModelView {state:'disabled'|'idle'|'running'|'failed'|'cancelled';message:string;latest:LatestModelReadingView;inputHash:string|null}

const hash=(x:string)=>createHash('sha256').update(x).digest('hex');
export function assertSafeModelInput(text:string,filename=''){
  if(/(?:^|\/)(?:(?:.*\.)?env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|kubeconfig|secrets?(?:\..*)?|tokens?(?:\..*)?|credentials?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|p12|key))$/i.test(filename)||/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|authorization)\s*["']?\s*[:=]\s*["']?\S{8,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?82[- .]?)?01[016789][- .]?\d{3,4}[- .]?\d{4}|\b\d{6}-[1-4]\d{6}\b/i.test(text))throw Error('Sensitive input blocked');
}
export function buildProjectModelPack(source:ProjectModelSource):ProjectReadingPack {
  if(!/^project:[a-f0-9]{64}$/.test(source.projectKey))throw Error('Current bounded source unavailable');
  // 선별 전에 검사하여 생략된 원문의 명백한 민감정보도 전송을 중단합니다.
  assertSafeModelInput(JSON.stringify({dag:source.dag,summary:source.readingSummary}));
  for(const section of source.readingSummary.sections)for(const p of section.paragraphs)for(const s of p.sources)if(s.document)assertSafeModelInput('',s.document.relativePath);
  for(const p of source.registeredExcerpts?.provenance??[])assertSafeModelInput('',p.registration.relativePath);
  for(const e of source.registeredExcerpts?.excerpts??[])assertSafeModelInput(e.text);
  const sources:ProjectReadingPack['sources']=[],facts:ProjectReadingPack['facts']=[];
  const add=(path:string,excerpt:string)=>{const id='S'+(sources.length+1);sources.push({id,path,excerpt,lineStart:1,lineEnd:excerpt.split('\n').length,sha256:hash(excerpt)});return id;};
  const runtime='이 프로젝트의 지금 요약은 기존 로그인된 Claude를 사용하는 수동 AI 요약입니다. 자동 호출 없음. 아래 프로젝트 기록의 과거 모델 차단 설명은 당시 범위의 기록이며 현재 수동 AI 실행을 부정하지 않습니다.';
  facts.push({id:'F0',section:'implemented',state:'known',text:runtime,sourceIds:[add('runtime/manual-ai.txt',runtime)],anchors:['Claude','수동','자동 호출 없음']});
  for(const id of SECTION_IDS){
    const section=source.readingSummary.sections.find(s=>s.id===id);
    const paragraphs=section?.paragraphs??[];
    const selected=[...paragraphs].sort((a,b)=>Number(b.sources.some(s=>['document','ci','review','pull'].includes(s.kind)))-Number(a.sources.some(s=>['document','ci','review','pull'].includes(s.kind)))).slice(0,3);
    const excerpt=JSON.stringify({paragraphs:selected.map(p=>({text:p.text,basis:p.basis,sources:p.sources.map(s=>({kind:s.kind,sha:s.sha,sourceHash:s.sourceHash,document:s.document}))})),omitted:Math.max(0,paragraphs.length-selected.length)});
    const sourceId=add('reading/'+id+'.json',excerpt);
    const omissions=Math.max(0,paragraphs.length-selected.length);if(omissions)facts.push({id:'F'+facts.length,section:id,state:'known',text:'입력 한도로 이 섹션의 설명 '+omissions+'개를 생략했습니다. 생략된 범위의 전체 완료나 근거 부재를 판단하지 않습니다.',sourceIds:[sourceId],anchors:['생략']});
    for(const p of selected){if(p.text.length>1100)throw Error('Paragraph requires bounded selection');facts.push({id:'F'+facts.length,section:id,state:/조회를 완료하지 못했습니다|조회 실패/.test(p.text)?'query-failed':p.basis==='unknown'?'unrecorded':'known',text:p.text,sourceIds:[sourceId],anchors:[]});}
    if(!selected.length)facts.push({id:'F'+facts.length,section:id,state:'unrecorded',text:'이 섹션의 근거가 기록되지 않았습니다.',sourceIds:[sourceId],anchors:['기록되지']});
  }
  const ordered=[...source.dag.tasks].sort((a,b)=>(a.status===source.dag.doneStatus?1:0)-(b.status===source.dag.doneStatus?1:0)||a.id.localeCompare(b.id));
  const tasks=ordered.slice(0,24);
  const dagText=JSON.stringify({tasks,coverage:source.dag.coverage,omitted:source.dag.tasks.length-tasks.length});
  if(Buffer.byteLength(dagText)>12000)throw Error('DAG selection exceeds limit');
  const dagSource=add('dag/task-state.json',dagText);
  facts.push({id:'F'+facts.length,section:'evidence',state:'known',text:'DAG 상태는 선언이며 테스트·배포의 증명이 아닙니다. 선별 태스크 '+tasks.length+'개, 생략 '+(source.dag.tasks.length-tasks.length)+'개입니다. 모든 섹션의 설명은 전체 완료 판정을 대신하지 않습니다.',sourceIds:[dagSource],anchors:['DAG','선언','생략']});
  for(const e of (source.registeredExcerpts?.excerpts??[]).slice(0,6)){
    const sourceId=add('documents/'+hash(e.id).slice(0,16)+'.txt',e.text);let section:typeof SECTION_IDS[number]='decisions',text=e.text;
    try{const record=JSON.parse(e.text);if(SECTION_IDS.includes(record.section)&&typeof record.text==='string'){section=record.section;text=record.text;}}catch{}
    if(text.length>1100)throw Error('Document requires bounded selection');
    facts.push({id:'F'+facts.length,section,state:'known',text:'등록된 문서 기록: '+text,sourceIds:[sourceId],anchors:['문서 기록']});
  }
  // 빈 anchors 대신 원문의 첫 구절을 사용하되 긴 문장 전체 복사를 강요하지 않습니다.
  for(const f of facts)if(!f.anchors.length)f.anchors=[f.text.slice(0,Math.min(12,f.text.length))];
  const content={project:source.projectKey,scope:'connected-project' as const,sources,facts};
  const pack={...content,sourceSha:hash(JSON.stringify(content)).slice(0,40)};readingInputHash(pack);return pack;
}
export function createProjectModelController(options:{storage:ReturnType<typeof createModelReadingStorage>;adapter?:ModelAdapter;resolve(workstreamId:string,signal:AbortSignal):Promise<ProjectModelSource>;identify(workstreamId:string):string|null;revision?(workstreamId:string):string|null;timeoutMs?:number}){
  const views=new Map<string,ProjectModelView>();let active:{id:string;abort:AbortController;harness:ReturnType<typeof createPublicReadingHarness>|null;flight:Promise<ProjectModelView>}|undefined,disposed=false;
  const bindings=new Map<string,string>();
  const empty=(state:ProjectModelView['state'],message:string):ProjectModelView=>({state,message,inputHash:null,latest:{state:'empty',message:'저장된 AI 요약이 없습니다. 화면 조회는 모델을 호출하지 않습니다.'}});
  async function view(id:string):Promise<ProjectModelView>{const project=options.identify(id),previous=views.get(id);return {...previous??empty(options.adapter?'idle':'disabled',options.adapter?'선택한 프로젝트만 수동 요약합니다.':'Claude 실행 경로가 설정되지 않았습니다.'),latest:project?await options.storage.readLatest(project,bindings.get(id)!==options.revision?.(id)?'0'.repeat(64):previous?.inputHash??'0'.repeat(64)):{state:'unavailable',message:'현재 프로젝트 연결을 확인할 수 없습니다. 저장 결과를 다른 프로젝트에 표시하지 않습니다.'}};}
  const current=async(id:string,signal:AbortSignal)=>{const s=await options.resolve(id,signal);if(signal.aborted||disposed||s.projectKey!==options.identify(id))throw Error('Source retired');return buildProjectModelPack(s);};
  function cancel(id?:string){if(active&&(!id||active.id===id)){active.abort.abort();active.harness?.cancel();views.set(active.id,empty('cancelled','취소했습니다. 늦은 결과는 저장하지 않습니다.'));}}
  return {view,cancel,invalidate(){if(active&&bindings.has(active.id)&&bindings.get(active.id)!==(options.revision?.(active.id)??''))cancel();},dispose(){disposed=true;cancel();},settle(){return active?.flight??Promise.resolve();},
    run(id:string):Promise<ProjectModelView>{if(disposed||!options.adapter)return view(id);if(active){if(active.id===id)return active.flight;return Promise.resolve(empty('failed','다른 프로젝트 요약이 진행 중입니다. 동시에 실행하지 않습니다.'));}
      const abort=new AbortController();const own={id,abort,harness:null as ReturnType<typeof createPublicReadingHarness>|null,flight:null as unknown as Promise<ProjectModelView>};active=own;
      views.set(id,empty('running','현재 근거와 민감정보를 검사하고 있습니다.'));
      own.flight=(async()=>{try{
        const pack=await current(id,abort.signal),inputHash=readingInputHash(pack);bindings.set(id,options.revision?.(id)??'');
        views.set(id,{...empty('running','Claude 수동 요약 중입니다.'),inputHash});
        const adapter:ModelAdapter={generate:async(request,signal)=>{
          if(readingInputHash(await current(id,signal))!==inputHash)throw Error('Source changed before send');
          const receipt=await options.adapter!.generate(request,signal);assertSafeModelInput(JSON.stringify(receipt.answer));
          if(readingInputHash(await current(id,signal))!==inputHash)throw Error('Source changed before publish');return receipt;
        }};
        own.harness=createPublicReadingHarness(adapter,options.storage.ledger(pack),options.timeoutMs);
        const result=await own.harness.summarize(pack);
        if(!abort.signal.aborted&&!disposed)views.set(id,{...empty(result.status==='model'?'idle':'failed',result.status==='model'?'최신 성공 요약을 저장했습니다. 같은 입력은 재호출하지 않습니다.':'완료하지 못했습니다. 이전 성공 결과를 보존하며 자동 재전송하지 않습니다.'),inputHash});
      }catch{if(!abort.signal.aborted&&!disposed)views.set(id,{...views.get(id)??empty('failed',''),state:'failed',message:'근거·읽기 권한·민감정보 검사를 통과하지 못했거나 실행에 실패했습니다. 원문을 표시하지 않으며 이전 성공 결과를 보존합니다.'});}
      return view(id);})().finally(()=>{if(active===own)active=undefined;});return own.flight;
    },
  };
}
