import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import type {NoteAppBridge} from '../../src/shared/bridge';
import type {LiveWorkspaceView,LiveWorkstreamView} from '../../src/shared/live';
import {DemoStore} from '../../src/main/demo-store';

function state(overrides:Partial<LiveWorkspaceView>={}):LiveWorkspaceView {
  return {mode:'live-read-only',polling:{activity:'stopped',nextRefreshAt:null,countdownSeconds:0},connection:'disconnected',configuration:{state:'ready',message:'Ready',orcaExecutable:'/trusted/orca',codeburnExecutable:null,noteScopeCount:0,dagQueryConfigured:false,summaryTransport:'blocked'},refreshing:false,observedAt:null,freshness:'unknown',lastError:null,coverage:null,workstreams:[],dags:[],codeburn:{state:'unconfigured',results:[]},...overrides};
}
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
let store:typeof import('../../src/renderer/store');
let bridge:NoteAppBridge;
let listener:((value:LiveWorkspaceView)=>void)|undefined;
const stop=vi.fn();
beforeEach(async()=>{
  vi.resetModules();stop.mockClear();listener=undefined;
  bridge={selectNoteReconnect:vi.fn(),cancelNoteReconnect:vi.fn(),confirmNoteReconnect:vi.fn(),getProjectModelState:vi.fn(),summarizeProjectModel:vi.fn(),cancelProjectModel:vi.fn(),getPublicModelState:vi.fn().mockResolvedValue({state:'disabled',message:'manual disabled',inputHash:'a'.repeat(64),sourceSha:'b'.repeat(40),latest:{state:'empty',message:'no model calls'}}),summarizePublicModel:vi.fn(),cancelPublicModel:vi.fn(),getPublicModelReview:vi.fn().mockResolvedValue({state:'empty',message:'no model calls'}),getReadRoots:vi.fn(),selectReadRoot:vi.fn(),confirmReadRoot:vi.fn(),cancelReadRoot:vi.fn(),revokeReadRoot:vi.fn(),getEnvironment:vi.fn().mockResolvedValue({version:'test',platform:'linux',dataMode:'configured',summaryBackend:'unconfigured',capabilities:{realOrca:true,noteWrites:false,remoteSummary:false}}),getLiveState:vi.fn().mockResolvedValue(state()),connectLive:vi.fn().mockResolvedValue(state({connection:'connected'})),refreshLive:vi.fn().mockResolvedValue(state({connection:'connected'})),summarizeNow:vi.fn().mockResolvedValue(state({connection:'connected'})),openProjectDocument:vi.fn(),confirmProjectConnection:vi.fn(),setProjectStatus:vi.fn(),disconnectLive:vi.fn().mockResolvedValue(state()),onLiveState:vi.fn(callback=>{listener=callback;return stop;}),loadDemo:vi.fn().mockResolvedValue(new DemoStore().read('normal')),prepareSummary:vi.fn(),runSummary:vi.fn(),readSummary:vi.fn(),approveSummary:vi.fn(),rejectSummary:vi.fn(),cancelSummary:vi.fn(),onSummary:vi.fn(()=>()=>{}),getPhase1Options:vi.fn().mockResolvedValue({noteLinkConfigured:false,noteLinkMessage:'Not configured',noteScopes:[],summaryTransport:'blocked'}),previewNoteLink:vi.fn(),confirmNoteLink:vi.fn(),cancelNoteLink:vi.fn()};
  vi.stubGlobal('window',{noteApp:bridge});store=await import('../../src/renderer/store');
});
afterEach(()=>{store.dispose();vi.unstubAllGlobals();});

describe('live renderer connection ownership',()=>{
  it('requests now-summary through its own bridge method, without model or approval calls',async()=>{
    await store.summarizeNow();expect(bridge.summarizeNow).toHaveBeenCalledTimes(1);expect(bridge.refreshLive).not.toHaveBeenCalled();
    expect(bridge.runSummary).not.toHaveBeenCalled();expect(bridge.approveSummary).not.toHaveBeenCalled();
  });
  it('loads state and subscribes without connecting or reading demo',async()=>{
    await store.initialize();expect(store.mode.value).toBe('live');expect(store.liveState.value?.configuration.state).toBe('ready');expect(bridge.connectLive).not.toHaveBeenCalled();expect(bridge.loadDemo).not.toHaveBeenCalled();
    await store.initialize();expect(stop).toHaveBeenCalledTimes(1);store.dispose();expect(stop).toHaveBeenCalledTimes(2);
  });
  it('does not overwrite a newer event with delayed initialization state',async()=>{
    const pending=deferred<LiveWorkspaceView>();vi.mocked(bridge.getLiveState).mockReturnValue(pending.promise);
    const initializing=store.initialize();listener!(state({connection:'connected',lastError:'newer event'}));pending.resolve(state());await initializing;
    expect(store.liveState.value?.connection).toBe('connected');expect(store.liveState.value?.lastError).toBe('newer event');
  });
  it('coalesces repeated connect requests',async()=>{
    const pending=deferred<LiveWorkspaceView>();vi.mocked(bridge.connectLive).mockReturnValue(pending.promise);
    const connecting=store.connectLive();await store.connectLive();expect(bridge.connectLive).toHaveBeenCalledTimes(1);expect(store.liveBusy.value).toBe(true);
    pending.resolve(state({connection:'connected'}));await connecting;expect(store.liveState.value?.connection).toBe('connected');expect(store.liveBusy.value).toBe(false);
  });
  it.each(['connect','refresh','summarize'] as const)('disconnect preempts a pending %s and rejects its late result',async action=>{
    const pending=deferred<LiveWorkspaceView>();vi.mocked(action==='connect'?bridge.connectLive:action==='refresh'?bridge.refreshLive:bridge.summarizeNow).mockReturnValue(pending.promise);
    const work=action==='connect'?store.connectLive():action==='refresh'?store.refreshLive():store.summarizeNow();await store.disconnectLive();expect(bridge.disconnectLive).toHaveBeenCalledTimes(1);expect(store.liveState.value?.connection).toBe('disconnected');
    pending.resolve(state({connection:'connected',workstreams:[]}));await work;expect(store.liveState.value?.connection).toBe('disconnected');expect(store.liveBusy.value).toBe(false);
  });
  it('deduplicates project changes and ignores their response after a newer observation or disconnect',async()=>{
    await store.initialize();const pending=deferred<LiveWorkspaceView>();vi.mocked(bridge.setProjectStatus).mockReturnValue(pending.promise);
    const first=store.setProjectStatus('one','completed','active');await store.setProjectStatus('one','completed','active');expect(bridge.setProjectStatus).toHaveBeenCalledTimes(1);
    listener!(state({observedAt:'2026-10-06T03:00:00.000Z'}));pending.resolve(state({observedAt:'2026-10-06T02:00:00.000Z'}));await first;expect(store.liveState.value?.observedAt).toBe('2026-10-06T03:00:00.000Z');
    const older=deferred<LiveWorkspaceView>();vi.mocked(bridge.setProjectStatus).mockReturnValue(older.promise);const change=store.setProjectStatus('one','active','completed');await store.disconnectLive();older.resolve(state({connection:'connected'}));await change;expect(store.liveState.value?.connection).toBe('disconnected');expect(store.liveBusy.value).toBe(false);
  });
  it('deduplicates the global now-summary request without invoking a model',async()=>{
    const pending=deferred<LiveWorkspaceView>();vi.mocked(bridge.summarizeNow).mockReturnValue(pending.promise);const first=store.summarizeNow();await store.summarizeNow();expect(bridge.summarizeNow).toHaveBeenCalledTimes(1);expect(bridge.runSummary).not.toHaveBeenCalled();pending.resolve(state());await first;
  });
  it('does not let an older RPC replace a newer subscription observation',async()=>{
    await store.initialize();const pending=deferred<LiveWorkspaceView>();vi.mocked(bridge.refreshLive).mockReturnValue(pending.promise);
    const refresh=store.refreshLive();listener!(state({connection:'connected',observedAt:'2026-10-03T03:00:00.000Z',freshness:'current'}));pending.resolve(state({connection:'connected',observedAt:'2026-10-03T02:00:00.000Z'}));await refresh;
    expect(store.liveState.value?.observedAt).toBe('2026-10-03T03:00:00.000Z');
  });
  it('reports rejected IPC without inventing a successful observation',async()=>{
    vi.mocked(bridge.connectLive).mockRejectedValue(new Error('unavailable'));await store.connectLive();expect(store.liveState.value).toBeNull();expect(store.bridgeError.value).toBeTruthy();expect(store.liveBusy.value).toBe(false);
  });
});

describe('explicit sample mode isolation',()=>{
  it('waits for disconnect before loading sample data',async()=>{
    const pending=deferred<LiveWorkspaceView>();vi.mocked(bridge.disconnectLive).mockReturnValue(pending.promise);
    const sample=store.refreshDemo();expect(store.mode.value).toBe('live');expect(bridge.loadDemo).not.toHaveBeenCalled();pending.resolve(state());await sample;
    expect(store.mode.value).toBe('demo');expect(store.snapshot.value?.workstreams.length).toBeGreaterThan(0);expect(store.liveState.value?.connection).toBe('disconnected');
    store.exitDemo();expect(store.mode.value).toBe('live');expect(store.snapshot.value).toBeNull();expect(bridge.connectLive).not.toHaveBeenCalled();
  });
  it('does not enter sample mode if disconnect fails',async()=>{
    vi.mocked(bridge.disconnectLive).mockRejectedValue(new Error('IPC unavailable'));await store.refreshDemo();expect(store.mode.value).toBe('live');expect(bridge.loadDemo).not.toHaveBeenCalled();expect(store.bridgeError.value).toContain('전환하지 않았습니다');expect(store.busy.value).toBe(false);
  });
  it('switches to demo during refresh without the old RPC changing the returned live state',async()=>{
    const pending=deferred<LiveWorkspaceView>();vi.mocked(bridge.refreshLive).mockReturnValue(pending.promise);
    const refresh=store.refreshLive();await store.refreshDemo();pending.resolve(state({connection:'connected'}));await refresh;store.exitDemo();expect(store.liveState.value?.connection).toBe('disconnected');
  });
  it('ignores a delayed sample after exit and allows fresh requests',async()=>{
    const pending=deferred<ReturnType<DemoStore['read']>>();vi.mocked(bridge.loadDemo).mockReturnValueOnce(pending.promise);
    const sample=store.refreshDemo();await vi.waitFor(()=>expect(bridge.loadDemo).toHaveBeenCalledOnce());store.exitDemo();pending.resolve(new DemoStore().read('normal'));await sample;expect(store.snapshot.value).toBeNull();expect(store.mode.value).toBe('live');expect(store.busy.value).toBe(false);
    await store.refreshDemo();expect(store.mode.value).toBe('demo');expect(store.snapshot.value).not.toBeNull();
  });
});

describe('observation-only view semantics',()=>{
  it('keeps unknown connection and archive values distinct from known false',()=>{
    const workstream:LiveWorkstreamView={id:'one',title:'One',projectName:null,branch:null,archived:null,terminalConnected:null,terminalCount:null,agentState:'unknown',projectMapping:'missing-project-id',noteMapping:{state:'unresolved',reason:'missing-note',dagId:null},observation:{worktree:'observed',sidebarActivity:false,selected:null,workspaceStatus:'unknown'}};
    store.liveState.value=state({workstreams:[workstream,{...workstream,id:'two',archived:false,terminalConnected:true,observation:{...workstream.observation!,sidebarActivity:true}},{...workstream,id:'three',archived:true,terminalConnected:true}]});
    expect(store.liveConnectedCount.value).toBe(1);expect(store.liveWorkstreams.value).toHaveLength(2);expect(store.visibleLiveWorkstreams.value).toHaveLength(1);store.liveScope.value='observed';expect(store.visibleLiveWorkstreams.value).toHaveLength(2);expect(store.visibleLiveWorkstreams.value[0].terminalCount).toBeNull();
  });
  it('does not infer project identity or detached branch from incomplete values',async()=>{
    const labels=await import('../../src/renderer/live-labels');expect(labels.diagnosticText('No existing local summary cache. Summary generation is unavailable.')).toContain('저장된 로컬 요약이 없습니다');expect(labels.diagnosticText('unrecognized diagnostic')).toBe('unrecognized diagnostic');expect(labels.branchLabel(null)).toBe('브랜치 없음 / 미확인');expect(labels.branchLabel('HEAD')).toBe('HEAD');expect(store.formatTime('invalid')).toBe('관측 시각 미확인');
  });
});

describe('live renderer disclosure and escaping',()=>{
  async function render(component:import('vue').Component,props:Record<string,unknown>) {
    const {createSSRApp,h,defineComponent}=await import('vue');
    const {renderToString}=await import('vue/server-renderer');
    const app=createSSRApp(component,props);
    app.use((await import('primevue/config')).default,{unstyled:false});
    app.component('RouterLink',defineComponent({setup(_props,{slots}){return ()=>h('a',slots.default?.());}}));
    return renderToString(app);
  }
  it('shows the stored public model experiment with scope and usage, without any model bridge call',async()=>{
    const component=(await import('../../src/renderer/components/PublicModelReview.vue')).default;
    const legacy=(await import('../../src/shared/public-model-review.json')).default;const latest={project:'zeno0505/note-app',inputHash:legacy.inputHash,sourceSha:legacy.sourceSha,version:legacy.version,provider:legacy.provider,generatedAt:'2026-10-06T11:00:00Z',answer:{sections:legacy.sections},sources:legacy.sources,validation:{schema:'passed',facts:'passed',semantic:'reviewed-with-scope-note',note:legacy.manualReview.note},attempts:1,usage:{inputTokens:2,cacheCreationInputTokens:7761,outputTokens:1578,reportedTurns:2},runtimeMs:16165};
    const html=await render(component,{initialView:{state:'ready',message:'saved',latest}});expect(html).toContain('공개 note-app 모델 요약 검증 결과');expect(html).toContain('이 화면을 열어도 모델을 호출하지 않습니다');expect(html).toContain('입력 SHA');expect(html).toContain('현재 어디까지 구현되었나요?');expect(html).toContain('조회한 결과는 성공');expect(bridge.runSummary).not.toHaveBeenCalled();expect(bridge.summarizeNow).not.toHaveBeenCalled();
    const repaired=await render(component,{initialView:{state:'ready',message:'saved',latest:{...latest,attempts:2}}});expect(repaired).toContain('생성 요청 1회');expect(repaired).toContain('검증 수정 1회');expect(repaired).toContain('앱 요청 2회');expect(repaired).not.toContain('생성 요청 2회');
  });
  it('shows a public cached preview only on verified note-app rows and offers an explicit shortcut',async()=>{
    const {default:Card}=await import('../../src/renderer/components/LiveWorkstreamCard.vue');const {default:Overview}=await import('../../src/renderer/components/LiveOverview.vue');
    const workstream:LiveWorkstreamView={id:'public-row',title:'Public note-app',projectName:'note-app',branch:null,archived:false,terminalConnected:null,terminalCount:0,agentState:'unknown',projectMapping:'matched',noteMapping:{state:'unresolved',reason:null,dagId:null},repository:{key:'verified-key',id:'repo',hostId:'local',projectId:'github:zeno0505/note-app',label:'zeno0505/note-app'}};
    const html=await render(Card,{workstream});expect(html).toContain('공개 note-app · AI 요약');expect(html).toContain('open');expect(bridge.runSummary).not.toHaveBeenCalled();
    store.liveState.value=state({observedAt:'2026-10-06T00:00:00Z',workstreams:[workstream]});expect(await render(Overview,{})).toContain('public-model-shortcut');
    workstream.repository!.projectId='github:other/note-app';expect(await render(Card,{workstream})).not.toContain('data-testid="public-model-review"');expect(await render(Overview,{})).not.toContain('public-model-shortcut');
  });
  it('keeps long reading summaries out of project list items and makes selection keyboard reachable',async()=>{
    const {default:Item}=await import('../../src/renderer/components/ProjectListItem.vue');
    const workstream:LiveWorkstreamView={id:'one',title:'<script>long Korean project</script>',projectName:null,branch:'refs/heads/long-topic',archived:false,terminalConnected:null,terminalCount:null,agentState:'unknown',projectMapping:'missing-project-id',noteMapping:{state:'unresolved',reason:null,dagId:null}};
    const [summary]=await (await import('../../src/summary/reading')).createReadingScheduler().update([{workstream}],new AbortController().signal);summary.sections[0].paragraphs[0].text='LONG_READING_CANARY';workstream.readingSummary=summary;
    const html=await render(Item,{workstream,selected:true});expect(html).toContain('aria-current="true"');expect(html).toContain('aria-controls="project-summary-pane"');expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('LONG_READING_CANARY');expect(html).not.toContain('data-testid="reading-summary"');
  });
  it('shows independent verified note roots and separates rules refresh from manual AI',async()=>{
    const {default:Card}=await import('../../src/renderer/components/LiveWorkstreamCard.vue');
    const base:LiveWorkstreamView={id:'shared',title:'Shared project',projectName:null,branch:null,archived:false,terminalConnected:null,terminalCount:null,agentState:'unknown',projectMapping:'matched',noteMapping:{state:'resolved',reason:null,dagId:'shared-dag',context:{state:'verified',noteRootPath:'/allowed/team-shared-note',dagPath:'/allowed/team-shared-note/dag.yaml'}}};
    const html=await render(Card,{workstream:base});expect(html).toContain('확인한 노트 맥락');expect(html).toContain('/allowed/team-shared-note');expect(html).toContain('독립된 읽기 맥락');expect(html).toContain('규칙 요약 갱신 · 전체 소스');expect(html).toContain('지금 요약 · Claude AI');expect(bridge.summarizeProjectModel).not.toHaveBeenCalled();
    base.noteMapping.context={state:'retained',noteRootPath:'/allowed/other-note',dagPath:'/allowed/other-note/dag.yaml'};const retained=await render(Card,{workstream:base});expect(retained).toContain('현재 접근 미확인');expect(retained).toContain('/allowed/other-note');expect(retained).not.toContain('/allowed/team-shared-note');
  });
  it('shows no aggregated records without implying zero actual Codex usage or a zero-cost graph',async()=>{
    const {default:CodeBurn}=await import('../../src/renderer/components/LiveCodeBurn.vue');const {projectCodeBurn}=await import('../../src/summary/budget/codeburn');const empty={cost:0,savings:0,calls:0};
    const html=await render(CodeBurn,{codeburn:{state:'observed',results:[projectCodeBurn('codex-status',{currency:'USD',hasUsage:false,today:empty,month:empty},1000)]}});expect(html).toContain('집계된 기록 없음');expect(html).toContain('실제 사용량이 0임을 뜻하지 않습니다');expect(html).not.toContain('비용 약 0');expect(html).not.toContain('기간 비용 비교: 0');
    const unknown=await render(CodeBurn,{codeburn:{state:'observed',results:[projectCodeBurn('codex-status',{currency:'USD',today:empty,month:empty},1000)]}});expect(unknown).toContain('집계 보고값은 0');expect(unknown).toContain('실제 사용량 0 여부는 미확인');
  });
  it('uses styled shared action buttons and discloses global source scope on a project summary',async()=>{
    const {default:Card}=await import('../../src/renderer/components/LiveWorkstreamCard.vue');store.liveState.value=state({connection:'connected'});
    const workstream:LiveWorkstreamView={id:'one',title:'One',projectName:null,branch:null,archived:false,terminalConnected:null,terminalCount:null,agentState:'unknown',projectMapping:'missing-project-id',noteMapping:{state:'unresolved',reason:null,dagId:null},project:{status:'active',changedAt:'2026-10-06T00:00:00.000Z',sourceState:'not-checked',worktreeState:'present',history:[]}};
    const html=await render(Card,{workstream});expect(html).toContain('p-button');expect(html).toContain('data-testid="project-status-button"');expect(html).toContain('data-testid="project-summary-button"');expect(html).toContain('설정된 전체 소스 조회');expect(html).toContain('프로젝트 완료');
    store.liveState.value=state({connection:'connected',refreshing:true});const loading=await render(Card,{workstream});expect(loading).toContain('전체 소스 요청 처리 중');expect(loading).toContain('disabled');
  });
  it('renders four sentence sections, old-evidence warning and escaped citations independently of approval',async()=>{
    const {default:Reading}=await import('../../src/renderer/components/ReadingSummary.vue');
    const {createReadingScheduler}=await import('../../src/summary/reading');
    const workstream:LiveWorkstreamView={id:'one',title:'One',projectName:null,branch:null,archived:false,terminalConnected:false,terminalCount:0,agentState:'unknown',projectMapping:'missing-project-id',noteMapping:{state:'unresolved',reason:null,dagId:null}};
    const [summary]=await createReadingScheduler().update([{workstream}],new AbortController().signal);
    summary.sections[0].paragraphs.push({text:'<img src=x onerror="steal()">',basis:'unknown',sources:[{kind:'dag',id:'<script>bad</script>',sha:null,sourceHash:null,observedAt:null}]});
    const html=await render(Reading,{summary,historical:true});
    for(const title of ['현재 어디까지 구현되었나요?','다음에는 무엇을 구현하나요?','완료 판단에 어떤 근거가 있나요?','논의하거나 결정할 일이 있나요?']) expect(html).toContain(title);
    expect(html).toContain('모델 호출 없음');expect(html).toContain('이전 관측');expect(html).toContain('설계 상태가 미기재');expect(html).toContain('고정 규칙');
    expect(html).toContain('&lt;img');expect(html).not.toContain('<img');expect(html).not.toContain('<script>bad');expect(html).not.toContain('"sections":');
    expect(html).toContain('SHA 미확인');expect(html).toContain('사용자 승인 요약과 별도');
  });
  it('shows distinct source-refresh and now-summary buttons on the connected overview',async()=>{
    const {default:Overview}=await import('../../src/renderer/views/Overview.vue');
    store.liveState.value=state({connection:'connected'});const html=await render(Overview,{});
    expect(html).toContain('data-testid="live-refresh"');expect(html).toContain('data-testid="reading-summary-now"');expect(html).toContain('규칙 요약 갱신 · 전체 소스');
    store.liveState.value=state();const stopped=await render(Overview,{});expect(stopped).not.toContain('data-testid="reading-summary-now"');
  });
  it('renders the main-owned return countdown, background schedule and last-good failure without a UI timer',async()=>{
    const {default:Status}=await import('../../src/renderer/components/LiveStatus.vue');
    const next='2026-10-03T00:05:00.000Z',observed='2026-10-03T00:00:00.000Z';
    store.liveState.value=state({connection:'connected',observedAt:observed,polling:{activity:'foreground',nextRefreshAt:next,countdownSeconds:5}});
    const countdown=await render(Status,{});expect(countdown).toContain('복귀 후 5초 뒤 새로고침');expect(countdown).toContain('다음 조회');expect(countdown).toContain('바로 조회');
    store.liveState.value=state({connection:'connected',observedAt:observed,freshness:'stale',lastError:'failed',polling:{activity:'background',nextRefreshAt:next,countdownSeconds:0}});
    const failed=await render(Status,{});expect(failed).toContain('백그라운드 · 5분 간격 조회');expect(failed).toContain('갱신 실패 · 이전 관측 유지');expect(failed).toContain('마지막 관측');expect(failed).toContain('다음 조회');
    store.liveState.value=state();const stopped=await render(Status,{});expect(stopped).not.toContain('다음 조회');expect(stopped).not.toContain('5초');
  });
  it('distinguishes historical candidate/approval and safely escapes source text',async()=>{
    const {default:Summary}=await import('../../src/renderer/components/LiveSummary.vue');
    const claim={claim:{claimId:'claim',aspect:'next',kind:'inference',text:'<img src=x onerror="steal()">',intent:'proposal',citations:[],assertions:[]},freshness:'stale',reasons:['source:changed']};
    const html=await render(Summary,{summary:{state:'restored',reason:'Historical only',revision:1,candidateClaims:[claim],approvedClaims:[claim],approvedAt:'2026-10-03T00:00:00.000Z',context:null},historical:true});
    expect(html).toContain('이전 후보 요약');expect(html).toContain('이전 승인 요약');expect(html).toContain('과거 승인 기록');expect(html).toContain('모델 요약 생성 비활성');expect(html).toContain('이전 근거 · 변경됨');expect(html).toContain('실행 승인 아님');expect(html).toContain('&lt;img');expect(html).not.toContain('<img');
  });
  it('labels missing project identity and unknown terminal values without inferring zeros',async()=>{
    const {default:Card}=await import('../../src/renderer/components/LiveWorkstreamCard.vue');
    const workstream={id:'one',title:'One',projectName:null,branch:null,archived:null,terminalConnected:null,terminalCount:null,agentState:'unknown',projectMapping:'missing-project-id',noteMapping:{state:'unresolved',reason:'note-missing',dagId:null}};
    const html=await render(Card,{workstream});expect(html).toContain('프로젝트 ID 없음');expect(html).toContain('브랜치 없음 / 미확인');expect(html).toContain('터미널 연결 미확인');expect(html).toContain('에이전트 상태 미확인');expect(html).toContain('docs/note 없음');expect(html).not.toContain('0개');
  });
  it('shows retained DAG tasks on failure and discloses bounded category/reference omissions',async()=>{
    const {default:Dag}=await import('../../src/renderer/components/LiveDag.vue');
    const html=await render(Dag,{dag:{dagId:'dag',state:'error',reason:'Refresh failed',observedAt:'2026-10-03T00:00:00.000Z',unchanged:false,taskCount:100,displayedTaskCount:1,statusCountTotal:20,statusCountsOmitted:19,statusCounts:[{status:'done',count:1}],tasks:[{id:'T-1',title:'Historical task',status:'done',dependencies:[{id:'T-2',scope:'external'}],commitReferences:['abc123'],commitVerification:'not-performed',e2e:{state:'declared',required:true,coveredBy:['E2E-1'],coverage:'references-declared'},displayOmissions:{dependencies:7,commitReferences:8,e2eReferences:9}}],summary:{state:'empty',reason:'No cache',revision:null,candidateClaims:[],approvedClaims:[],approvedAt:null,context:null}},expanded:true});
    expect(html).toContain('이전 DAG 관측 유지');expect(html).toContain('Historical task');expect(html).toContain('19개 생략');expect(html).toContain('추가 7개 생략');expect(html).toContain('추가 8개 생략');expect(html).toContain('추가 참조 9개 생략');expect(html).toContain('표시 상한 적용');expect(html).toContain('외부 · 충족 미확인');expect(html).toContain('검증하지 않음');
  });
  it('shows usage even when quota is unavailable and labels old successful results',async()=>{
    const {default:CodeBurn}=await import('../../src/renderer/components/LiveCodeBurn.vue');
    const html=await render(CodeBurn,{codeburn:{state:'observed',results:[{ok:true,value:{kind:'status',provider:'claude',currency:'USD',periods:[{label:'today',cost:7,savings:2,calls:3,approximate:true,window:null}],calendarBasis:'unknown',observedAt:1000,provenance:'codeburn-cli'}},{ok:false,observedAt:2000,error:{kind:'timeout',query:'claude-status'}},{ok:true,value:{kind:'quota',observedAt:2000,provenance:'codeburn-cli',providers:[{provider:'claude',quotaData:'unavailable',agentAvailability:'unknown',error:'reported-error',windows:[]}]}}]}});
    expect(html).toContain('비용 약 7 USD');expect(html).toContain('이전 관측');expect(html).toContain('실패한 시도');expect(html).toContain('쿼터 데이터: 사용 불가');expect(html).toContain('에이전트 실행 가능 여부: 미확인');expect(html).not.toContain('사용 0%');
  });
  it('explains Claude transfer and sensitive-data limits before manual project AI or granting read roots',async()=>{
    const {default:Model}=await import('../../src/renderer/components/ProjectModelReview.vue');const {default:Roots}=await import('../../src/renderer/components/ReadRootsSettings.vue');
    const html=await render(Model,{workstreamId:'work-one',current:true});const roots=await render(Roots,{});
    for(const text of ['Claude(Anthropic)','비밀키','개인정보','자동 탐지를 보장하지','자동 호출은 없습니다']){expect(html).toContain(text);expect(roots).toContain(text);}
    expect(html).toContain('project-ai-confirm');expect(html).toContain('지금 요약 · Claude AI');expect(html.match(/<button[^>]*data-testid="project-ai-run"[^>]*>/i)?.[0]).toContain('disabled');
    expect(bridge.summarizeProjectModel).not.toHaveBeenCalled();expect(bridge.summarizePublicModel).not.toHaveBeenCalled();
  });
  it('moves usage into its own page while preserving partial failure and unconfigured meanings',async()=>{
    const {default:Usage}=await import('../../src/renderer/views/UsageStatistics.vue');
    const {default:Overview}=await import('../../src/renderer/components/LiveOverview.vue');
    store.liveState.value=state({connection:'connected',observedAt:'2026-10-06T12:00:00Z',freshness:'stale',codeburn:{state:'observed',results:[{ok:true,value:{kind:'status',provider:'claude',currency:'USD',periods:[{label:'today',cost:7,savings:2,calls:3,approximate:true,window:null}],calendarBasis:'unknown',observedAt:1000,provenance:'codeburn-cli'}},{ok:false,observedAt:2000,error:{kind:'timeout',query:'claude-status'}},{ok:true,value:{kind:'quota',observedAt:2000,provenance:'codeburn-cli',providers:[{provider:'claude',quotaData:'unavailable',agentAvailability:'unknown',error:'reported-error',windows:[]}]}}]}});
    const html=await render(Usage,{});expect(html).toContain('사용량 통계');expect(html).toContain('비용 약 7 USD');expect(html).toContain('timeout');expect(html).toContain('쿼터 데이터: 사용 불가');expect(html).toContain('이전 관측');expect(html).not.toContain('사용 0%');expect(await render(Overview,{})).not.toContain('data-testid="live-codeburn"');
    store.liveState.value=state();expect(await render(Usage,{})).toContain('CodeBurn이 설정되지 않아');
    store.mode.value='demo';const demo=await render(Usage,{});expect(demo).toContain('가상 사용량을 표시하지 않습니다');expect(demo).not.toContain('data-testid="live-codeburn"');
  });
  it('uses the product routes for overview, usage and settings with the requested navigation order',async()=>{
    const {createSSRApp}=await import('vue');const {renderToString}=await import('vue/server-renderer');
    const {createRouter,createMemoryHistory}=await import('vue-router');const {routes}=await import('../../src/renderer/routes');
    const {default:App}=await import('../../src/renderer/App.vue');const {default:PrimeVue}=await import('primevue/config');
    const router=createRouter({history:createMemoryHistory(),routes});const app=createSSRApp(App).use(router).use(PrimeVue);
    await router.push('/usage');await router.isReady();const usage=await renderToString(app);
    const nav=usage.slice(usage.indexOf('<nav'),usage.indexOf('</nav>'));expect(nav.indexOf('프로젝트 현황')).toBeLessThan(nav.indexOf('사용량 통계'));expect(nav.indexOf('사용량 통계')).toBeLessThan(nav.indexOf('연결 및 설정'));expect(usage).toContain('data-testid="usage-statistics-page"');
    const usageLink=nav.split('<a').find(tag=>tag.includes('data-testid="nav-usage"'))?.split('>')[0];expect(usageLink).toContain('aria-current="page"');expect(usageLink).toContain(' active"');
    await router.push('/settings');expect((await renderToString(app))).not.toContain('data-testid="usage-statistics-page"');
    await router.push('/');expect((await renderToString(app))).not.toContain('data-testid="live-codeburn"');
    expect(bridge.connectLive).not.toHaveBeenCalled();expect(bridge.refreshLive).not.toHaveBeenCalled();expect(bridge.runSummary).not.toHaveBeenCalled();
  });
});
