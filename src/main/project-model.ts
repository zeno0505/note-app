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
  const decisionScope='현재 이 프로젝트의 수동 Claude 요약은 사용자 승인 범위에서 전송 안내 확인 후 실행합니다. 과거 production model transport 차단은 기존 후보 승인 워크플로와 자동·일괄 실행의 제한입니다. 자동 호출 없음. 과거의 별도 승인 필요 기록을 현재 수동 요약의 미승인 판정으로 바꾸지 않습니다.';
  const runtimeSource=add('runtime/manual-ai.txt',runtime+'\n'+decisionScope);
  facts.push({id:'F0',section:'implemented',state:'known',text:runtime,sourceIds:[runtimeSource],anchors:['Claude','수동','자동 호출 없음']});
  facts.push({id:'F1',section:'decisions',state:'known',text:decisionScope,sourceIds:[runtimeSource],anchors:['수동 Claude','사용자 승인','기존 후보','자동 호출 없음']});
  for(const id of SECTION_IDS){
    const section=source.readingSummary.sections.find(s=>s.id===id);
    const paragraphs=section?.paragraphs??[];
    const rank=(p:typeof paragraphs[number])=>p.sources.some(s=>['ci','review','pull'].includes(s.kind))?3:p.sources.some(s=>s.kind==='git')?2:p.sources.some(s=>s.kind==='document')?1:0;
    const selected=[...paragraphs].sort((a,b)=>rank(b)-rank(a)).slice(0,3);
    const excerpt=JSON.stringify({paragraphs:selected.map(p=>({text:p.text,basis:p.basis,sources:p.sources.map(s=>({kind:s.kind,sha:s.sha,sourceHash:s.sourceHash,document:s.document}))})),omitted:Math.max(0,paragraphs.length-selected.length)});
    const sourceId=add('reading/'+id+'.json',excerpt);
    const omissions=Math.max(0,paragraphs.length-selected.length);if(omissions)facts.push({id:'F'+facts.length,section:id,state:'known',text:'입력 한도로 이 섹션의 설명 '+omissions+'개를 생략했습니다. 생략된 범위의 전체 완료나 근거 부재를 판단하지 않습니다.',sourceIds:[sourceId],anchors:['생략']});
    for(const p of selected){if(p.text.length>1050)throw Error('Paragraph requires bounded selection');const document=p.sources.some(s=>s.kind==='document'),text=(document?'등록 문서 기록(현재 미대조): ':'')+p.text;facts.push({id:'F'+facts.length,section:id,state:/조회를 완료하지 못했습니다|조회 실패/.test(p.text)?'query-failed':p.basis==='unknown'?'unrecorded':'known',text,sourceIds:[sourceId],anchors:document?['등록 문서','현재 미대조']:[]});}
    if(!selected.length)facts.push({id:'F'+facts.length,section:id,state:'unrecorded',text:'이 섹션의 근거가 기록되지 않았습니다.',sourceIds:[sourceId],anchors:['기록되지']});
  }
  const taskRank=(t:typeof source.dag.tasks[number])=>['running','in_progress'].includes(t.status??'')?0:t.status==='blocked'?1:t.status==='in_review'?2:t.status===source.dag.doneStatus?5:t.dependencies.every(d=>d.scope==='internal'&&source.dag.tasks.some(other=>other.id===d.id&&other.status===source.dag.doneStatus))?3:4;
  const number=(id:string)=>Number(id.match(/\d+$/)?.[0]??0);
  const ordered=[...source.dag.tasks].sort((a,b)=>taskRank(a)-taskRank(b)||number(b.id)-number(a.id)||a.id.localeCompare(b.id));
  const tasks=ordered.slice(0,24);
  const dagText=JSON.stringify({tasks,coverage:source.dag.coverage,omitted:source.dag.tasks.length-tasks.length});
  if(Buffer.byteLength(dagText)>12000)throw Error('DAG selection exceeds limit');
  const dagSource=add('dag/task-state.json',dagText);
  facts.push({id:'F'+facts.length,section:'evidence',state:'known',text:'DAG 상태는 선언이며 테스트·배포의 증명이 아닙니다. 선별 태스크 '+tasks.length+'개, 생략 '+(source.dag.tasks.length-tasks.length)+'개입니다. 모든 섹션의 설명은 전체 완료 판정을 대신하지 않습니다.',sourceIds:[dagSource],anchors:['DAG','선언','생략']});
  const focus=tasks.filter(t=>['running','in_progress','blocked','in_review'].includes(t.status??'')).slice(0,3);
  if(focus.length)facts.push({id:'F'+facts.length,section:'implemented',state:'known',text:'현재 DAG의 우선 확인 작업은 '+focus.map(t=>t.id+' '+(t.title??'제목 미기재')+' ('+t.status+')').join(', ')+'입니다. 검토·진행 상태는 구현 완료 인증이 아닙니다.',sourceIds:[dagSource],anchors:[...focus.map(t=>t.id),'완료 인증이 아닙니다']});
  for(const e of (source.registeredExcerpts?.excerpts??[]).slice(0,4)){
    const sourceId=add('documents/'+hash(e.id).slice(0,16)+'.txt',e.text);let section:typeof SECTION_IDS[number]='decisions',text=e.text;
    try{const record=JSON.parse(e.text);if(SECTION_IDS.includes(record.section)&&typeof record.text==='string'){section=record.section;text=record.text;}}catch{}
    if(text.length>1100)throw Error('Document requires bounded selection');
    facts.push({id:'F'+facts.length,section,state:'known',text:'등록된 문서 기록(현재 미대조): '+text,sourceIds:[sourceId],anchors:['문서 기록','현재 미대조']});
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
  function cancel(id?:string,message='취소했습니다. 늦은 결과는 저장하지 않습니다.'){if(active&&(!id||active.id===id)){active.abort.abort();active.harness?.cancel();views.set(active.id,empty('cancelled',message));}}
  return {view,cancel,invalidate(){if(active&&bindings.has(active.id)&&bindings.get(active.id)!==(options.revision?.(active.id)??''))cancel(undefined,'현재 관측·프로젝트 연결·읽기 권한이 변경되어 취소했습니다. 늦은 결과는 저장하지 않으며 같은 입력을 자동 재전송하지 않습니다.');},dispose(){disposed=true;cancel();},settle(){return active?.flight??Promise.resolve();},
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
