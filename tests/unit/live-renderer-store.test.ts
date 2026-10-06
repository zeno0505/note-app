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
  bridge={getEnvironment:vi.fn().mockResolvedValue({version:'test',platform:'linux',dataMode:'configured',summaryBackend:'unconfigured',capabilities:{realOrca:true,noteWrites:false,remoteSummary:false}}),getLiveState:vi.fn().mockResolvedValue(state()),connectLive:vi.fn().mockResolvedValue(state({connection:'connected'})),refreshLive:vi.fn().mockResolvedValue(state({connection:'connected'})),summarizeNow:vi.fn().mockResolvedValue(state({connection:'connected'})),setProjectStatus:vi.fn(),disconnectLive:vi.fn().mockResolvedValue(state()),onLiveState:vi.fn(callback=>{listener=callback;return stop;}),loadDemo:vi.fn().mockResolvedValue(new DemoStore().read('normal')),prepareSummary:vi.fn(),runSummary:vi.fn(),readSummary:vi.fn(),approveSummary:vi.fn(),rejectSummary:vi.fn(),cancelSummary:vi.fn(),onSummary:vi.fn(()=>()=>{}),getPhase1Options:vi.fn().mockResolvedValue({noteLinkConfigured:false,noteLinkMessage:'Not configured',noteScopes:[],summaryTransport:'blocked'}),previewNoteLink:vi.fn(),confirmNoteLink:vi.fn(),cancelNoteLink:vi.fn()};
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
    const workstream:LiveWorkstreamView={id:'one',title:'One',projectName:null,branch:null,archived:null,terminalConnected:null,terminalCount:null,agentState:'unknown',projectMapping:'missing-project-id',noteMapping:{state:'unresolved',reason:'missing-note',dagId:null}};
    store.liveState.value=state({workstreams:[workstream,{...workstream,id:'two',archived:false,terminalConnected:true},{...workstream,id:'three',archived:true,terminalConnected:true}]});
    expect(store.liveConnectedCount.value).toBe(1);expect(store.liveWorkstreams.value).toHaveLength(2);expect(store.visibleLiveWorkstreams.value).toHaveLength(1);store.filter.value='all';expect(store.visibleLiveWorkstreams.value).toHaveLength(2);expect(store.visibleLiveWorkstreams.value[0].terminalCount).toBeNull();
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
    app.component('RouterLink',defineComponent({setup(_props,{slots}){return ()=>h('a',slots.default?.());}}));
    return renderToString(app);
  }
  it('renders four sentence sections, old-evidence warning and escaped citations independently of approval',async()=>{
    const {default:Reading}=await import('../../src/renderer/components/ReadingSummary.vue');
    const {createReadingScheduler}=await import('../../src/summary/reading');
    const workstream:LiveWorkstreamView={id:'one',title:'One',projectName:null,branch:null,archived:false,terminalConnected:false,terminalCount:0,agentState:'unknown',projectMapping:'missing-project-id',noteMapping:{state:'unresolved',reason:null,dagId:null}};
    const [summary]=await createReadingScheduler().update([{workstream}],new AbortController().signal);
    summary.sections[0].paragraphs.push({text:'<img src=x onerror="steal()">',basis:'unknown',sources:[{kind:'dag',id:'<script>bad</script>',sha:null,sourceHash:null,observedAt:null}]});
    const html=await render(Reading,{summary,historical:true});
    for(const title of ['현재 어디까지 구현되었나요?','다음에는 무엇을 구현하나요?','완료 판단에 어떤 근거가 있나요?','논의하거나 결정할 일이 있나요?']) expect(html).toContain(title);
    expect(html).toContain('모델 호출 없음');expect(html).toContain('이전 관측');expect(html).toContain('설계 합의 여부가 없습니다');expect(html).toContain('고정 규칙');
    expect(html).toContain('&lt;img');expect(html).not.toContain('<img');expect(html).not.toContain('<script>bad');expect(html).not.toContain('"sections":');
    expect(html).toContain('SHA 미확인');expect(html).toContain('사용자 승인 요약과 별도');
  });
  it('shows distinct source-refresh and now-summary buttons on the connected overview',async()=>{
    const {default:Overview}=await import('../../src/renderer/views/Overview.vue');
    store.liveState.value=state({connection:'connected'});const html=await render(Overview,{});
    expect(html).toContain('data-testid="live-refresh"');expect(html).toContain('data-testid="reading-summary-now"');expect(html).toContain('지금 요약');
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
});
