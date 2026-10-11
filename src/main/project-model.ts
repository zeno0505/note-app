import {interpretTasks} from '../phase2/tasks';
import {selectSummaryTasks,SUMMARY_SELECTION_POLICY} from '../summary/reading/task-selection';
import {taskPrefix} from '../shared/summary-prefix';
import {randomUUID} from 'node:crypto';
import type {ModelRetryProposal,ModelRetryView} from '../shared/model-retry';
import type {createModelRetryStorage} from '../summary/reading/model-retry-storage';
import {ModelProcessFailure,type ModelProcessInfo} from '../summary/reading/model-process-failure';
import {diagnosticCode,diagnosticProject,diagnosticCorrelation,ModelDiagnosticError,type DiagnosticStage,type DiagnosticCode,type ModelCallState,type ModelDiagnosticView,type createModelDiagnostics} from './model-diagnostics';
import {createHash} from 'node:crypto';
import {createPublicReadingHarness,readingInputHash,SECTION_IDS,type ModelAdapter,type ProjectReadingPack} from '../summary/reading/model-harness';
import type {createModelReadingStorage,LatestModelReadingView} from '../summary/reading/model-reading-storage';
import type {SummaryWorkflowSource} from '../summary/workflow';
import type {DeepReadonly} from '../collector/snapshot/types';
import type {ReadingSummary} from '../shared/reading-summary';
export interface ProjectModelSource extends SummaryWorkflowSource {recentActivity?:import('../summary/reading/recent-tasks').RecentSummaryTasks;projectKey:string;policyProjectId?:string;summaryPrefix?:string;taskSelection?:import('../shared/summary-prefix').SummaryTaskSelection;dependencyObservations?:import('../shared/summary-prefix').SummaryPrefixScope['dependencies'];readingSummary:DeepReadonly<ReadingSummary>}
export interface ProjectModelView {state:'disabled'|'idle'|'running'|'failed'|'cancelled';message:string;latest:LatestModelReadingView;inputHash:string|null;diagnostics?:ModelDiagnosticView;retry?:ModelRetryView}

const hash=(x:string)=>createHash('sha256').update(x).digest('hex');
export function assertSafeModelInput(text:string,filename=''){
  if(/(?:^|\/)(?:(?:.*\.)?env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|kubeconfig|secrets?(?:\..*)?|tokens?(?:\..*)?|credentials?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|p12|key))$/i.test(filename)||/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|authorization)\s*["']?\s*[:=]\s*["']?\S{8,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?82[- .]?)?01[016789][- .]?\d{3,4}[- .]?\d{4}|\b\d{6}-[1-4]\d{6}\b/i.test(text))throw Error('Sensitive input blocked');
}
// Only digest fields owned by the source/answer contracts are metadata. Authored
// text, paths and arbitrary task policy/detail fields still receive the full check.
const opaqueDigest=(value:unknown,pattern:RegExp)=>typeof value==='string'&&pattern.test(value)?'[opaque digest]':value;
const sha256=/^(?:sha256:)?[a-f0-9]{64}$/i,gitSha=/^[a-f0-9]{40}$/i,projectDigest=/^(?:project|worktree|dag):[a-f0-9]{64}$/i;
function checkedReadingSource(value:DeepReadonly<import('../shared/reading-summary').ReadingSource>){return {...value,id:value.kind==='dag'?opaqueDigest(value.id,/^dag:[a-f0-9]{64}$/i):value.id,sha:opaqueDigest(value.sha,gitSha),sourceHash:opaqueDigest(value.sourceHash,sha256)};}
function assertSafeProjectSource(source:ProjectModelSource){
  const dag={...source.dag,dagId:opaqueDigest(source.dag.dagId,projectDigest),sourceHash:opaqueDigest(source.dag.sourceHash,sha256),tasks:source.dag.tasks.map(task=>({...task,commitReferences:task.commitReferences.map(sha=>opaqueDigest(sha,gitSha))}))};
  const summary={...source.readingSummary,workstreamId:opaqueDigest(source.readingSummary.workstreamId,projectDigest),fingerprint:opaqueDigest(source.readingSummary.fingerprint,sha256),sections:source.readingSummary.sections.map(section=>({...section,paragraphs:section.paragraphs.map(paragraph=>({...paragraph,sources:paragraph.sources.map(checkedReadingSource)}))})),dagMismatches:source.readingSummary.dagMismatches?.map(item=>({...item,sources:item.sources.map(checkedReadingSource)}))};
  assertSafeModelInput(JSON.stringify({dag,summary}));
}
export function assertSafeModelAnswerInput(answer:unknown){
  if(!answer||typeof answer!=='object'||Array.isArray(answer)){assertSafeModelInput(JSON.stringify(answer));return;}
  const value=answer as Record<string,unknown>;
  assertSafeModelInput(JSON.stringify({...value,project:opaqueDigest(value.project,projectDigest),inputHash:opaqueDigest(value.inputHash,sha256)}));
}
export function buildProjectModelPack(source:ProjectModelSource):ProjectReadingPack {
  if(!/^project:[a-f0-9]{64}$/.test(source.projectKey))throw Error('Current bounded source unavailable');
  if(source.summaryPrefix&&(!source.dag.tasks.length||source.dag.tasks.some(t=>taskPrefix(t.id)!==source.summaryPrefix)||source.readingSummary.summaryPrefix!==source.summaryPrefix))throw Error('Current bounded source unavailable');
  if(source.taskSelection&&(source.taskSelection.taskIds.length>20||source.taskSelection.missingIds.length||JSON.stringify(source.taskSelection.taskIds)!==JSON.stringify(source.readingSummary.summaryTaskIds)||source.taskSelection.taskIds.some(id=>!source.dag.tasks.some(t=>t.id===id))))throw Error('Current bounded source unavailable');
  // 선별 전에 검사하여 생략된 원문의 명백한 민감정보도 전송을 중단합니다.
  assertSafeProjectSource(source);
  for(const section of source.readingSummary.sections)for(const p of section.paragraphs)for(const s of p.sources)if(s.document)assertSafeModelInput('',s.document.relativePath);
  for(const p of source.registeredExcerpts?.provenance??[])assertSafeModelInput('',p.registration.relativePath);
  for(const e of source.registeredExcerpts?.excerpts??[])assertSafeModelInput(e.text);
  const sources:ProjectReadingPack['sources']=[],facts:ProjectReadingPack['facts']=[];
  const add=(path:string,excerpt:string)=>{const id='S'+(sources.length+1);sources.push({id,path,excerpt,lineStart:1,lineEnd:excerpt.split('\n').length,sha256:hash(excerpt)});return id;};
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
  const selection=source.taskSelection??selectSummaryTasks(source.dag.tasks,source.dag.tasks,source.dag.doneStatus);
  const tasks=selection.taskIds.map(id=>source.dag.tasks.find(t=>t.id===id)!);
  const policyContext=source.dag.readContractVersion===2?interpretTasks(tasks,{projectId:source.policyProjectId??source.projectKey,dagId:source.dag.dagId,sourceHash:source.dag.sourceHash,observedAt:source.dag.observedAt,policies:source.dag.policies??[]}).map(row=>({id:row.task.id,lifecycle:row.lifecycle,discussion:row.discussion,verification:row.verification,verificationState:row.verificationState,policy:row.policy?{id:row.policy.id,revision:row.policy.revision,scope:row.policy.scope,mappingVersion:row.policy.mappingVersion}:null,interpretationVersion:row.provenance.interpretationVersion})):undefined;
  const v2=source.dag.readContractVersion===2;
  const coreTasks=v2?tasks.map(({details,...task})=>task):tasks;
  const dagText=JSON.stringify({tasks:coreTasks,summaryPrefix:source.summaryPrefix,dependencyObservations:source.dependencyObservations,tasksSelection:selection.mode==='explicit'?'사용자가 직접 선택한 작업':SUMMARY_SELECTION_POLICY,omitted:selection.omittedCount});
  if(Buffer.byteLength(dagText)>12000)throw Error('DAG selection exceeds limit');
  const dagSource=add('dag/task-state.json',dagText),dagSourceIds=[dagSource];
  if(v2){
    // Extra Phase2 declarations have their own bounded source; retain all selected IDs.
    // This does not weaken the original 12KiB DAG or 48KiB total pack guard.
    const encodeDetails=(limit:number)=>JSON.stringify({contract:'bounded-task-details-v1',tasks:tasks.map(task=>{const raw=JSON.stringify(task.details??null),bytes=Buffer.from(raw),cut=bytes.subarray(0,limit);return {id:task.id,sourceHash:hash(raw),excerpt:cut.toString('utf8'),omittedBytes:Math.max(0,bytes.length-cut.length),complete:cut.length===bytes.length};})});
    let detailLimit=tasks.length?Math.floor(5000/tasks.length):0,detailText=encodeDetails(detailLimit);
    while(Buffer.byteLength(detailText)>8000&&detailLimit>0){detailLimit=Math.floor(detailLimit/2);detailText=encodeDetails(detailLimit);}
    if(Buffer.byteLength(detailText)>8000)throw Error('Task detail selection exceeds limit');
    dagSourceIds.push(add('dag/selected-details.json',detailText));
    const policyText=JSON.stringify({interpretationVersion:'phase2-task-v1',verificationState:'not-performed',tasks:policyContext?.map(({policy,...row})=>({...row,policy:policy?{id:policy.id,revision:policy.revision,mappingVersion:policy.mappingVersion,scopeHash:hash(JSON.stringify(policy.scope))}:null}))});
    if(Buffer.byteLength(policyText)>8000)throw Error('Policy selection exceeds limit');
    dagSourceIds.push(add('dag/selected-policy.json',policyText));
  }
  facts.push({id:'F'+facts.length,section:'evidence',state:'known',text:(source.recentActivity?'확인된 명시 연결 활동 기록 중 시각 순으로 최대 3개 작업을 선별합니다. 전체 프로젝트의 최신 작업을 보장하지 않습니다. ':'선택한 작업 범위에서 최대 20개를 선별합니다. 작업별 시각이 없어 최신 작업을 판단하지 않습니다. ')+'DAG 상태는 선언이며 테스트·배포의 증명이 아닙니다. 선별 태스크 '+tasks.length+'개, 생략 '+selection.omittedCount+'개입니다. 모든 섹션의 설명은 전체 완료 판정을 대신하지 않습니다.'+(v2?' 상세 excerpt의 complete=false와 omittedBytes는 내용 생략이며 자료 부재가 아닙니다.':''),sourceIds:dagSourceIds,anchors:['DAG','선언','생략']});
  const focus=tasks.filter(t=>['running','in_progress','blocked','in_review'].includes(t.status??'')).slice(0,3);
  if(focus.length)facts.push({id:'F'+facts.length,section:'implemented',state:'known',text:'현재 DAG의 우선 확인 작업은 '+focus.map(t=>t.id+' '+(t.title??'제목 미기재')+' ('+t.status+')').join(', ')+'입니다. 검토·진행 상태는 구현 완료 인증이 아닙니다.',sourceIds:[dagSource],anchors:[...focus.map(t=>t.id),'완료 인증이 아닙니다']});
  for(const e of (source.registeredExcerpts?.excerpts??[]).slice(0,4)){
    const sourceId=add('documents/'+hash(e.id).slice(0,16)+'.txt',e.text);let section:typeof SECTION_IDS[number]='decisions',text=e.text;
    try{const record=JSON.parse(e.text);if(SECTION_IDS.includes(record.section)&&typeof record.text==='string'){section=record.section;text=record.text;}}catch{}
    if(text.length>1000)text=text.slice(0,1000)+' … 문서 발췌 일부 생략';
    facts.push({id:'F'+facts.length,section,state:'known',text:'등록된 문서 기록(현재 미대조): '+text,sourceIds:[sourceId],anchors:['문서 기록','현재 미대조']});
  }
  if(source.recentActivity?.activities.length){
    const activities=source.recentActivity.activities.filter(event=>tasks.some(task=>task.id===event.taskId));
    const sourceId=add('dag/selected-activity.json',JSON.stringify({activities,coverage:source.recentActivity.activityCoverage??null}));
    facts.push({id:'F'+facts.length,section:'evidence',state:'known',text:(source.recentActivity.activityCoverage?.state!=='complete'?'부분 확인 범위이며 전체 최신 작업이 아닙니다. ':'명시 선언된 참조 범위입니다. ')+'최근 활동 선택 근거: '+activities.map(event=>event.taskId+' '+event.kind+' '+event.at+' ('+event.timeBasis+')').join(', ')+'. 명시 연결된 기록의 시각이며 작업 완료·검증 통과를 인증하지 않습니다.',sourceIds:[sourceId],anchors:activities.map(event=>event.taskId)});
  }
  // 빈 anchors 대신 원문의 첫 구절을 사용하되 긴 문장 전체 복사를 강요하지 않습니다.
  for(const f of facts)if(!f.anchors.length)f.anchors=[f.text.slice(0,Math.min(12,f.text.length))];
  const content={project:source.projectKey,scope:'connected-project' as const,sources,facts};
  const pack={...content,sourceSha:hash(JSON.stringify(content)).slice(0,40)};readingInputHash(pack);return pack;
}
export function createProjectModelController(options:{storage:ReturnType<typeof createModelReadingStorage>;adapter?:ModelAdapter;resolve(workstreamId:string,signal:AbortSignal,phase?:'start'|'revalidate'):Promise<ProjectModelSource>;identify(workstreamId:string):string|null;revision?(workstreamId:string):string|null;timeoutMs?:number;diagnostics?:ReturnType<typeof createModelDiagnostics>;retryStorage?:ReturnType<typeof createModelRetryStorage>;now?:()=>number;accountId?(id:string):string|undefined;guard?(id:string,phase:'send'|'launch'|'publish',signal:AbortSignal):Promise<void>}){
  const views=new Map<string,ProjectModelView>();let active:{id:string;abort:AbortController;harness:ReturnType<typeof createPublicReadingHarness>|null;correlationId:string;flight:Promise<ProjectModelView>}|undefined,disposed=false;
  const bindings=new Map<string,string>();const viewProjects=new Map<string,string|null>();
  const diagnosticIdentity=(id:string)=>diagnosticProject(options.identify(id)??id);
  const empty=(state:ProjectModelView['state'],message:string):ProjectModelView=>({state,message,inputHash:null,latest:{state:'empty',message:'저장된 AI 요약이 없습니다. 화면 조회는 모델을 호출하지 않습니다.'}});
  let retryTicket:(ModelRetryProposal&{project:string;revision:string|null})|null=null,retryGeneration=0;const now=options.now??Date.now;
  async function retryView(project:string|null):Promise<ModelRetryView>{if(!project||!options.retryStorage||!options.adapter)return {available:false,used:false,inputHash:null};try{const failed=await options.storage.failedReservation(project);const used=!!failed&&await options.retryStorage.used(project,failed.inputHash);return {available:!!failed&&!used,used,inputHash:failed?.inputHash??null};}catch{return {available:false,used:true,inputHash:null};}}
  async function view(id:string):Promise<ProjectModelView>{const project=options.identify(id),previous=viewProjects.get(id)===project?views.get(id):undefined;return {...previous??empty(options.adapter?'idle':'disabled',options.adapter?'선택한 프로젝트만 수동 요약합니다.':'Claude 실행 경로가 설정되지 않았습니다.'),...(options.retryStorage?{retry:await retryView(project)}:{}),...(options.diagnostics?{diagnostics:await options.diagnostics.view(diagnosticIdentity(id))}:{}),latest:project?await options.storage.readLatest(project,bindings.get(id)!==options.revision?.(id)?'0'.repeat(64):previous?.inputHash??'0'.repeat(64)):{state:'unavailable',message:'현재 프로젝트 연결을 확인할 수 없습니다. 저장 결과를 다른 프로젝트에 표시하지 않습니다.'}};}
  const current=async(id:string,signal:AbortSignal,phase:'start'|'revalidate'='start')=>{const s=await options.resolve(id,signal,phase);if(signal.aborted||disposed||s.projectKey!==options.identify(id))throw Error('Source retired');return buildProjectModelPack(s);};
  function cancel(id?:string,message='취소했습니다. 늦은 결과는 저장하지 않습니다.'){if(active&&(!id||active.id===id)){active.abort.abort();active.harness?.cancel();views.set(active.id,empty('cancelled',message));}}
  function cancelRetry(request:unknown){if(!request||typeof request!=='object'||Object.keys(request).join(',')!=='ticketId')throw Error('진단 재시도 취소 요청 오류');if(retryTicket?.ticketId===(request as {ticketId:string}).ticketId){retryTicket=null;retryGeneration++;}}
  async function prepareRetry(id:string):Promise<ModelRetryProposal>{
    if(disposed||active||!options.adapter||!options.retryStorage||!options.diagnostics)throw Error('진단 재시도를 준비할 수 없습니다.');retryTicket=null;const generation=++retryGeneration,abort=new AbortController();
    const pack=await current(id,abort.signal),failed=await options.storage.failedReservation(pack.project);if(!failed)throw Error('진단할 실패 예약이 없습니다.');const inputHash=readingInputHash(pack);
    if(inputHash!==failed.inputHash){views.set(id,{...await view(id),inputHash,state:'failed',message:'현재 입력이 기존 실패 입력과 다릅니다. 진단 모델을 호출하지 않았습니다.'});await options.diagnostics.append({correlationId:diagnosticCorrelation(),projectId:diagnosticIdentity(id),stage:'source-check',code:'diagnostic_retry_input_changed',modelCall:'not-started',attempt:null});throw Error('diagnostic_retry_input_changed');}
    if(await options.retryStorage.used(pack.project,inputHash))throw Error('이 실패 입력의 진단 재시도는 이미 사용했습니다.');if(disposed||active||generation!==retryGeneration)throw Error('진단 준비가 취소되거나 바뀌었습니다.');
    const ticket={ticketId:randomUUID(),workstreamId:id,inputHash,originalRunId:failed.runId,expiresAt:now()+120000,project:pack.project,revision:options.revision?.(id)??null};retryTicket=ticket;const {project:_project,revision:_revision,...publicTicket}=ticket;return publicTicket;
  }
  async function runRetry(request:unknown):Promise<ProjectModelView>{
    if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).sort().join(',')!=='oneCallConfirmed,ticketId,transferConfirmed')throw Error('진단 재시도 요청 오류');const r=request as {ticketId:string;transferConfirmed:boolean;oneCallConfirmed:boolean},ticket=retryTicket;
    if(disposed||active||!ticket||r.ticketId!==ticket.ticketId||r.transferConfirmed!==true||r.oneCallConfirmed!==true||ticket.expiresAt<=now()||!options.retryStorage||!options.adapter||!options.diagnostics)throw Error('진단 재시도 확인이 만료되거나 취소되었습니다.');
    retryTicket=null;retryGeneration++;const id=ticket.workstreamId;viewProjects.set(id,ticket.project);const abort=new AbortController(),own={id,abort,diagnosticId:diagnosticIdentity(id),correlationId:diagnosticCorrelation(),harness:null as ReturnType<typeof createPublicReadingHarness>|null,flight:null as unknown as Promise<ProjectModelView>};active=own;
    views.set(id,{...empty('running','실패 진단 1회 · 자동 형식 수정 없음 · 기존 성공 본문 보존'),inputHash:ticket.inputHash});bindings.set(id,options.revision?.(id)??'');
    own.flight=(async()=>{let stage:DiagnosticStage='source-check',modelCall:ModelCallState='not-started',processInfo:ModelProcessInfo|undefined;const record=async(code:DiagnosticCode)=>options.diagnostics!.append({correlationId:own.correlationId,projectId:own.diagnosticId,stage,code,modelCall,attempt:1,...(processInfo?{process:processInfo}:{})});try{
      await record('request_started');const pack=await current(id,abort.signal),expectedAccountId=options.accountId?.(id);if(pack.project!==ticket.project||readingInputHash(pack)!==ticket.inputHash)throw new ModelDiagnosticError('diagnostic_retry_input_changed');
      let failure:DiagnosticCode|null=null,entered=false;
      const adapter:ModelAdapter={generate:async(request,signal)=>{entered=true;try{stage='source-check';if(readingInputHash(await current(id,signal,'revalidate'))!==ticket.inputHash)throw new ModelDiagnosticError('diagnostic_retry_input_changed');await options.guard?.(id,'send',signal);stage='reservation';await record('diagnostic_retry_reserved');const receipt=await options.adapter!.generate({...request,beforeLaunch:async()=>{await options.guard?.(id,'launch',signal);if(expectedAccountId&&options.accountId?.(id)!==expectedAccountId)throw Error('Immutable AI account binding changed');},...(expectedAccountId?{expectedAccountId}:{})},signal,async event=>{if(event==='authentication'){stage='authentication';modelCall='not-started';}else if(event==='launch-requested'){stage='model-call';modelCall='launch-requested';await record('model_launch_requested');}else{stage='model-call';modelCall='started';await record('model_started');}});processInfo=receipt.process;stage='result-check';assertSafeModelAnswerInput(receipt.answer);await options.guard?.(id,'publish',signal);if(readingInputHash(await current(id,signal,'revalidate'))!==ticket.inputHash)throw Error('Source changed before publish');return receipt;}catch(error){if(error instanceof ModelProcessFailure)processInfo=error.processInfo;failure=diagnosticCode(error,stage);throw error;}}};
      stage='reservation';own.harness=createPublicReadingHarness(adapter,options.retryStorage!.ledger(pack.project,ticket.inputHash,ticket.originalRunId),options.timeoutMs,{diagnosticRetry:true});const result=await own.harness.summarize(pack);stage=failure?stage:'complete';await record(abort.signal.aborted||result.status==='cancelled'?'request_cancelled':failure??(!entered?'diagnostic_retry_used':result.status==='model'?'diagnostic_retry_succeeded':'diagnostic_retry_result_invalid'));
      if(!disposed&&!abort.signal.aborted)views.set(id,{...empty(result.status==='model'?'idle':'failed',result.status==='model'?'진단 1회는 성공했습니다. 과거 일시 실패 원인까지 확정한 것은 아닙니다. 기존 성공 본문을 보존했습니다.':'진단 1회를 마쳤습니다. 기존 성공 본문과 실패 예약을 보존하며 추가 호출은 하지 않습니다.'),inputHash:ticket.inputHash});
    }catch(error){await record(diagnosticCode(error,stage)).catch(()=>{});if(!disposed&&!abort.signal.aborted)views.set(id,{...empty('failed','진단을 완료하지 못했습니다. 기록을 확인해 주세요. 자동 재시도하지 않습니다.'),inputHash:ticket.inputHash});}return view(id);})().finally(()=>{if(active===own)active=undefined;});return own.flight;
  }
  return {view,cancel,prepareRetry,cancelRetry,runRetry,invalidate(){if(retryTicket&&(options.identify(retryTicket.workstreamId)!==retryTicket.project||(options.revision?.(retryTicket.workstreamId)??null)!==retryTicket.revision)){retryTicket=null;retryGeneration++;}if(active&&bindings.has(active.id)&&bindings.get(active.id)!==(options.revision?.(active.id)??''))cancel(undefined,'프로젝트 근거·연결·읽기 권한이 변경되어 취소했습니다. 늦은 결과는 저장하지 않으며 같은 입력을 자동 재전송하지 않습니다.');},dispose(){disposed=true;retryTicket=null;retryGeneration++;cancel();},settle(){return active?.flight??Promise.resolve();},
    run(id:string):Promise<ProjectModelView>{if(disposed||!options.adapter)return view(id);if(active){if(active.id===id){void options.diagnostics?.append({correlationId:active.correlationId,projectId:diagnosticIdentity(id),stage:'reservation',code:'duplicate_joined',modelCall:'unknown',attempt:null}).catch(()=>{});return active.flight;}return (async()=>{await options.diagnostics?.append({correlationId:diagnosticCorrelation(),projectId:diagnosticIdentity(id),stage:'reservation',code:'request_busy',modelCall:'not-started',attempt:null}).catch(()=>{});return {...await view(id),state:'failed' as const,message:'다른 프로젝트 요약이 진행 중입니다. 동시에 실행하지 않습니다.'};})();}
      viewProjects.set(id,options.identify(id));const abort=new AbortController();const own={id,abort,diagnosticId:diagnosticIdentity(id),correlationId:diagnosticCorrelation(),harness:null as ReturnType<typeof createPublicReadingHarness>|null,flight:null as unknown as Promise<ProjectModelView>};active=own;
      views.set(id,empty('running','현재 근거와 민감정보를 검사하고 있습니다.'));
      own.flight=(async()=>{let stage:DiagnosticStage='source-check',modelCall:ModelCallState='not-started',attempt:number|null=null,adapterFailure:DiagnosticCode|null=null,adapterEntered=false,processInfo:ModelProcessInfo|undefined;const record=async(code:DiagnosticCode)=>{await options.diagnostics?.append({correlationId:own.correlationId,projectId:own.diagnosticId,stage,code,modelCall,attempt,...(processInfo?{process:processInfo}:{})});};try{
        await record('request_started');const resolved=await options.resolve(id,abort.signal,'start');if(abort.signal.aborted||disposed||resolved.projectKey!==options.identify(id))throw Error('Source retired');stage='input-check';const pack=buildProjectModelPack(resolved),inputHash=readingInputHash(pack),expectedAccountId=options.accountId?.(id);bindings.set(id,options.revision?.(id)??'');
        views.set(id,{...empty('running','Claude 수동 요약 중입니다.'),inputHash});
        const adapter:ModelAdapter={generate:async(request,signal)=>{
          adapterEntered=true;attempt=request.binding.attempt;try{stage='source-check';if(readingInputHash(await current(id,signal,'revalidate'))!==inputHash)throw Error('Source changed before send');await options.guard?.(id,'send',signal);stage='model-call';modelCall='unknown';const receipt=await options.adapter!.generate({...request,beforeLaunch:async()=>{await options.guard?.(id,'launch',signal);if(expectedAccountId&&options.accountId?.(id)!==expectedAccountId)throw Error('Immutable AI account binding changed');},...(expectedAccountId?{expectedAccountId}:{})},signal,async event=>{if(event==='authentication'){stage='authentication';modelCall='not-started';}else if(event==='launch-requested'){stage='model-call';modelCall='launch-requested';await record('model_launch_requested');}else{stage='model-call';modelCall='started';await record('model_started');}});stage='result-check';assertSafeModelAnswerInput(receipt.answer);stage='publish';await options.guard?.(id,'publish',signal);if(readingInputHash(await current(id,signal,'revalidate'))!==inputHash)throw Error('Source changed before publish');return receipt;}catch(error){adapterFailure=diagnosticCode(error,stage);if(error instanceof ModelProcessFailure)processInfo=error.processInfo;if(adapterFailure==='model_start_failed')modelCall='not-started';throw error;}
        }};
        stage='reservation';own.harness=createPublicReadingHarness(adapter,options.storage.ledger(pack),options.timeoutMs);
        const result=await own.harness.summarize(pack);
        if(adapterFailure)await record(adapterFailure);else{stage='complete';await record(abort.signal.aborted||result.status==='cancelled'?'request_cancelled':result.status==='model'?adapterEntered?'request_succeeded':'saved_input_reused':adapterEntered?'model_result_invalid':'saved_failed_input_reused');}
        if(!abort.signal.aborted&&!disposed)views.set(id,{...empty(result.status==='model'?'idle':'failed',result.status==='model'?'시작 시점 근거의 성공 요약을 저장했습니다. 같은 입력은 재호출하지 않습니다.':'완료하지 못했습니다. 이전 성공 결과를 보존하며 자동 재전송하지 않습니다.'),inputHash});
      }catch(error){await record(abort.signal.aborted?'request_cancelled':diagnosticCode(error,stage)).catch(()=>{});if(!abort.signal.aborted&&!disposed)views.set(id,{...views.get(id)??empty('failed',''),state:'failed',message:'근거·읽기 권한·민감정보 검사를 통과하지 못했거나 실행에 실패했습니다. 원문을 표시하지 않으며 이전 성공 결과를 보존합니다. 아래 진단 기록에서 단계와 코드를 확인해 주세요.'});}
      return view(id);})().finally(()=>{if(active===own)active=undefined;});return own.flight;
    },
  };
}
