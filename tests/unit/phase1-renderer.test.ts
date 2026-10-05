import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createSSRApp,type InjectionKey} from 'vue';
import {renderToString} from 'vue/server-renderer';
import {boundedTaskSelection,createSummaryActions,createNoteLinkActions,summaryActionsKey,noteLinkActionsKey} from '../../src/renderer/phase1-actions';
import type {SummaryWorkflowBridge,SummaryWorkflowView} from '../../src/shared/summary-workflow';
import type {NoteLinkBridge,Phase1Options} from '../../src/shared/phase1-options';
import type {NoteLinkConfirmResult,NoteLinkProposal,NoteLinkPreviewResult} from '../../src/shared/note-link-workflow';
import type {LiveDagView} from '../../src/shared/live';

const deferred=<T>()=>{let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const request={workstreamId:'work-one',taskIds:['T-1'],provider:'auto' as const};
function summary(overrides:Partial<SummaryWorkflowView>={}):SummaryWorkflowView {
  return {ticketId:'ticket-one',workstreamId:'work-one',taskIds:['T-1'],state:'prepared',message:'Prepared bounded context',providerChoice:'auto',selectedProvider:null,transport:'blocked',executionAuthorized:false,preview:{selectedTaskCount:1,recordCount:1,bytes:24,inputBytes:500,approximateTokens:125,maxResponseBytes:4096,accountingMethod:'utf8-byte-proxy-not-model-tokenizer',truncated:false,records:[],exclusions:[],unknowns:['Explicit goal is missing'],unresolvedDependencyIds:[]},budget:null,codeburn:[],candidateHash:null,approvedCandidateHash:null,candidateClaims:[],approvedClaims:[],approvedAt:null,persistence:{state:'not-saved',revision:null,message:'No write'},canRun:true,canApprove:false,canReject:false,canCancel:true,...overrides};
}
let listener:((view:SummaryWorkflowView)=>void)|undefined;
function summaryBridge():SummaryWorkflowBridge {
  return {prepareSummary:vi.fn().mockResolvedValue(summary()),runSummary:vi.fn().mockResolvedValue(summary({state:'blocked',canRun:false})),readSummary:vi.fn().mockResolvedValue(summary()),approveSummary:vi.fn().mockResolvedValue(summary({state:'approved',canApprove:false})),rejectSummary:vi.fn().mockResolvedValue(summary({state:'rejected',canReject:false})),cancelSummary:vi.fn().mockResolvedValue(summary({state:'cancelled',canCancel:false})),onSummary:vi.fn(callback=>{listener=callback;return vi.fn();})};
}
const options:Phase1Options={noteLinkConfigured:true,noteLinkMessage:'Registered scope only',noteScopes:[{scopeId:'scope-one',scopePath:'/vault/one'}],summaryTransport:'blocked'};
function proposal(overrides:Partial<NoteLinkProposal>={}):NoteLinkProposal {
  return {proposalId:'proposal-one',confirmationToken:'opaque-main-token',expiresAt:'2099-01-01T00:00:00.000Z',worktreeId:'work-one',scopeId:'scope-one',status:'changes',paths:{worktree:'/work/one',vault:'/vault',scope:'/vault/one',docs:'/work/one/docs',note:'/work/one/docs/note',gitDirectory:'/work/one/.git',commonGitDirectory:'/work/main/.git',exclude:'/work/main/.git/info/exclude',temporaryExclude:'/work/main/.git/info/exclude.tmp'},changes:{createDocsDirectory:true,createNoteSymlink:true,appendLocalExclude:true},exclude:{rule:'/docs/note',appendText:'\n/docs/note\n',beforeSha256:'before',afterSha256:'after',beforeBytes:1,afterBytes:13},sharedExclude:{worktreePaths:['/work/one','/work/two'],scopeDescription:'Shared by two worktrees'},conflicts:[],warnings:[],...overrides};
}
const applied:NoteLinkConfirmResult={status:'applied',message:'Applied',proposalId:'proposal-one',actual:{docsCreated:true,noteLinked:true,excludeUpdated:true},recovery:[],cancellationRequested:false};
function noteBridge():NoteLinkBridge {
  return {getPhase1Options:vi.fn().mockResolvedValue(options),previewNoteLink:vi.fn().mockResolvedValue({status:'ready',proposal:proposal()}),confirmNoteLink:vi.fn().mockResolvedValue(applied),cancelNoteLink:vi.fn().mockResolvedValue({cancelled:true})};
}
function dag(count=1):LiveDagView {
  return {dagId:'dag-one',state:'ready',reason:null,observedAt:'2026-10-03T00:00:00Z',unchanged:false,taskCount:count,displayedTaskCount:count,statusCounts:[],statusCountTotal:0,statusCountsOmitted:0,tasks:Array.from({length:count},(_,index)=>({id:'T-'+(index+1),title:'<img src=x onerror="steal()">',status:'todo',dependencies:[],commitReferences:[],commitVerification:'not-performed',e2e:{state:'undeclared',required:null,coveredBy:null,coverage:'undeclared'},displayOmissions:{dependencies:0,commitReferences:0,e2eReferences:0}})),summary:{state:'empty',reason:'No existing local summary cache.',revision:null,candidateClaims:[],approvedClaims:[],approvedAt:null,context:null}};
}
beforeEach(()=>{listener=undefined;});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('summary renderer action ownership',()=>{
  it('bounds unique selections to the displayed verified tasks',()=>{
    expect(boundedTaskSelection(['T-1','outside','T-1','T-2'],['T-1','T-2'])).toEqual(['T-1','T-2']);
    expect(boundedTaskSelection(Array.from({length:40},(_,i)=>String(i)),Array.from({length:40},(_,i)=>String(i)))).toHaveLength(32);
  });
  it('coalesces repeated prepare and copies the selected IDs',async()=>{
    const bridge=summaryBridge();const pending=deferred<SummaryWorkflowView>();vi.mocked(bridge.prepareSummary).mockReturnValue(pending.promise);const actions=createSummaryActions(bridge);const ids=['T-1'];
    const first=actions.prepare({...request,taskIds:ids});ids.push('T-2');await actions.prepare(request);expect(bridge.prepareSummary).toHaveBeenCalledTimes(1);expect(vi.mocked(bridge.prepareSummary).mock.calls[0][0].taskIds).toEqual(['T-1']);pending.resolve(summary());await first;expect(actions.busy.value).toBe(false);actions.dispose();
  });
  it('cancels a late-created ticket after close and does not resurrect it',async()=>{
    const bridge=summaryBridge();const pending=deferred<SummaryWorkflowView>();vi.mocked(bridge.prepareSummary).mockReturnValue(pending.promise);const actions=createSummaryActions(bridge);
    const preparing=actions.prepare(request);actions.dismiss();pending.resolve(summary());await preparing;expect(actions.view.value).toBeNull();expect(bridge.cancelSummary).toHaveBeenCalledWith({ticketId:'ticket-one'});expect(actions.busy.value).toBe(false);
  });
  it('keeps a newer selection when an older preparation completes afterward',async()=>{
    const bridge=summaryBridge();const old=deferred<SummaryWorkflowView>();vi.mocked(bridge.prepareSummary).mockReturnValueOnce(old.promise).mockResolvedValueOnce(summary({ticketId:'new',taskIds:['T-2']}));const actions=createSummaryActions(bridge);
    const pending=actions.prepare(request);actions.dismiss();await actions.prepare({...request,taskIds:['T-2']});old.resolve(summary());await pending;expect(actions.view.value?.ticketId).toBe('new');expect(bridge.cancelSummary).toHaveBeenCalledWith({ticketId:'ticket-one'});actions.dispose();
  });
  it('ignores unmatched and older RPC observations after a current event',async()=>{
    const bridge=summaryBridge();const actions=createSummaryActions(bridge);actions.subscribe();actions.subscribe();await actions.prepare(request);const pending=deferred<SummaryWorkflowView>();vi.mocked(bridge.runSummary).mockReturnValue(pending.promise);
    const running=actions.run('codex');listener!(summary({ticketId:'elsewhere',message:'ignore'}));expect(actions.view.value?.message).not.toBe('ignore');listener!(summary({state:'candidate',message:'new event',candidateHash:'newhash'}));pending.resolve(summary({state:'waiting',message:'old RPC'}));await running;expect(actions.view.value?.message).toBe('new event');expect(bridge.onSummary).toHaveBeenCalledTimes(1);actions.dispose();
  });
  it('coalesces repeated review and binds approval to the exact displayed candidate hash',async()=>{
    const bridge=summaryBridge();vi.mocked(bridge.prepareSummary).mockResolvedValue(summary({state:'candidate',candidateHash:'hash-one',canApprove:true,canReject:true}));const actions=createSummaryActions(bridge);await actions.prepare(request);const pending=deferred<SummaryWorkflowView>();vi.mocked(bridge.approveSummary).mockReturnValue(pending.promise);
    const approving=actions.approve();await actions.approve();await actions.reject();expect(bridge.approveSummary).toHaveBeenCalledExactlyOnceWith({ticketId:'ticket-one',candidateHash:'hash-one'});expect(bridge.rejectSummary).not.toHaveBeenCalled();pending.resolve(summary({state:'approved',canApprove:false}));await approving;expect(actions.view.value?.state).toBe('approved');actions.dispose();
  });
  it('does not call disabled run or review methods and never invents a candidate',async()=>{
    const bridge=summaryBridge();vi.mocked(bridge.prepareSummary).mockResolvedValue(summary({state:'blocked',canRun:false,canCancel:false,message:'Filesystem isolation is unverified'}));const actions=createSummaryActions(bridge);await actions.prepare(request);await actions.run();await actions.approve();await actions.reject();expect(bridge.runSummary).not.toHaveBeenCalled();expect(bridge.approveSummary).not.toHaveBeenCalled();expect(actions.view.value?.candidateClaims).toEqual([]);actions.dismiss();expect(bridge.cancelSummary).not.toHaveBeenCalled();
  });
  it('preempts running work with one cancel and drops late run responses/events',async()=>{
    const bridge=summaryBridge();const actions=createSummaryActions(bridge);actions.subscribe();await actions.prepare(request);const run=deferred<SummaryWorkflowView>();const cancelled=deferred<SummaryWorkflowView>();vi.mocked(bridge.runSummary).mockReturnValue(run.promise);vi.mocked(bridge.cancelSummary).mockReturnValue(cancelled.promise);
    const running=actions.run();const cancelling=actions.cancel();await actions.cancel();expect(bridge.cancelSummary).toHaveBeenCalledTimes(1);cancelled.resolve(summary({state:'cancelled',canCancel:false}));await cancelling;listener!(summary({state:'candidate'}));run.resolve(summary({state:'candidate'}));await running;expect(actions.view.value?.state).toBe('cancelled');actions.dispose();
  });
  it('unsubscribes on disposal and ignores delayed failures after navigation',async()=>{
    const bridge=summaryBridge();const stop=vi.fn();vi.mocked(bridge.onSummary).mockReturnValue(stop);const pending=deferred<SummaryWorkflowView>();vi.mocked(bridge.prepareSummary).mockReturnValue(pending.promise);const actions=createSummaryActions(bridge);actions.subscribe();const preparing=actions.prepare(request);actions.dispose();pending.reject(new Error('late'));await preparing;expect(stop).toHaveBeenCalledOnce();expect(actions.error.value).toBeNull();expect(actions.view.value).toBeNull();
  });
  it('keeps readable errors separate from raw IPC diagnostics',async()=>{
    const bridge=summaryBridge();vi.mocked(bridge.prepareSummary).mockRejectedValue(new Error('<script>private diagnostic</script>'));const actions=createSummaryActions(bridge);await actions.prepare(request);expect(actions.error.value).not.toContain('script');expect(actions.technicalError.value).toContain('<script>');expect(actions.view.value).toBeNull();
  });
});

describe('note link renderer action ownership',()=>{
  it('requires a configured registered scope before preview',async()=>{
    const bridge=noteBridge();const actions=createNoteLinkActions(bridge);await actions.preview({worktreeId:'work-one',scopeId:'scope-one'});expect(bridge.previewNoteLink).not.toHaveBeenCalled();await actions.loadOptions();await actions.preview({worktreeId:'work-one',scopeId:'/arbitrary/path'});expect(bridge.previewNoteLink).not.toHaveBeenCalled();await actions.preview({worktreeId:'work-one',scopeId:'scope-one'});expect(bridge.previewNoteLink).toHaveBeenCalledExactlyOnceWith({worktreeId:'work-one',scopeId:'scope-one'});expect(bridge.confirmNoteLink).not.toHaveBeenCalled();actions.dispose();
  });
  it('coalesces repeated preview and invalidates late results on close',async()=>{
    const bridge=noteBridge();const pending=deferred<NoteLinkPreviewResult>();vi.mocked(bridge.previewNoteLink).mockReturnValue(pending.promise);const actions=createNoteLinkActions(bridge);await actions.loadOptions();const previewing=actions.preview({worktreeId:'work-one',scopeId:'scope-one'});await actions.preview({worktreeId:'work-one',scopeId:'scope-one'});expect(bridge.previewNoteLink).toHaveBeenCalledOnce();actions.dismiss();pending.resolve({status:'ready',proposal:proposal()});await previewing;expect(actions.proposal.value).toBeNull();expect(bridge.cancelNoteLink).toHaveBeenCalledExactlyOnceWith({proposalId:'proposal-one'});
  });
  it('sends only the exact issued confirmation capability and prevents resubmit',async()=>{
    const bridge=noteBridge();const pending=deferred<NoteLinkConfirmResult>();vi.mocked(bridge.confirmNoteLink).mockReturnValue(pending.promise);const actions=createNoteLinkActions(bridge);await actions.loadOptions();await actions.preview({worktreeId:'work-one',scopeId:'scope-one'});const confirming=actions.confirm();await actions.confirm();expect(bridge.confirmNoteLink).toHaveBeenCalledExactlyOnceWith({proposalId:'proposal-one',confirmationToken:'opaque-main-token'});pending.resolve(applied);await confirming;await actions.confirm();expect(bridge.confirmNoteLink).toHaveBeenCalledOnce();expect(actions.proposal.value).toBeNull();expect(actions.result.value?.status).toBe('applied');
  });
  it.each(['conflict','expired'] as const)('does not confirm a %s proposal',async kind=>{
    const bridge=noteBridge();vi.mocked(bridge.previewNoteLink).mockResolvedValue({status:'ready',proposal:proposal(kind==='conflict'?{status:'conflict',conflicts:['Existing file']}:{expiresAt:'2020-01-01T00:00:00Z'})});const actions=createNoteLinkActions(bridge);await actions.loadOptions();await actions.preview({worktreeId:'work-one',scopeId:'scope-one'});await actions.confirm();expect(bridge.confirmNoteLink).not.toHaveBeenCalled();if(kind==='expired') {expect(actions.error.value).toContain('유효 시간');expect(bridge.cancelNoteLink).toHaveBeenCalledOnce();}actions.dispose();
  });
  it('keeps new navigation state over late confirmation, warning that close is not rollback',async()=>{
    const bridge=noteBridge();const pending=deferred<NoteLinkConfirmResult>();vi.mocked(bridge.confirmNoteLink).mockReturnValue(pending.promise);const actions=createNoteLinkActions(bridge);await actions.loadOptions();await actions.preview({worktreeId:'work-one',scopeId:'scope-one'});const confirming=actions.confirm();actions.dismiss();expect(actions.notice.value).toContain('되돌려지지 않습니다');vi.mocked(bridge.previewNoteLink).mockResolvedValue({status:'ready',proposal:proposal({proposalId:'new',worktreeId:'work-two'})});await actions.preview({worktreeId:'work-two',scopeId:'scope-one'});pending.resolve(applied);await confirming;expect(actions.result.value).toBeNull();expect(actions.proposal.value?.proposalId).toBe('new');actions.dispose();
  });
  it.each(['noop','rolled-back','partial','rejected'] as const)('preserves the actual %s outcome and recovery details',async status=>{
    const bridge=noteBridge();vi.mocked(bridge.confirmNoteLink).mockResolvedValue({...applied,status,actual:{docsCreated:null,noteLinked:false,excludeUpdated:true},recovery:['Inspect exact exclude file'],cancellationRequested:true});const actions=createNoteLinkActions(bridge);await actions.loadOptions();await actions.preview({worktreeId:'work-one',scopeId:'scope-one'});await actions.confirm();expect(actions.result.value?.status).toBe(status);expect(actions.result.value?.actual.docsCreated).toBeNull();expect(actions.result.value?.recovery).toEqual(['Inspect exact exclude file']);expect(actions.result.value?.cancellationRequested).toBe(true);
  });
  it('treats lost confirmation response as unknown, consumes the proposal, and never retries automatically',async()=>{
    const bridge=noteBridge();vi.mocked(bridge.confirmNoteLink).mockRejectedValue(new Error('channel closed'));const actions=createNoteLinkActions(bridge);await actions.loadOptions();await actions.preview({worktreeId:'work-one',scopeId:'scope-one'});await actions.confirm();await actions.confirm();expect(actions.error.value).toContain('일부 변경이 적용됐을 수');expect(actions.proposal.value).toBeNull();expect(bridge.confirmNoteLink).toHaveBeenCalledOnce();
  });
  it('refuses a proposal for a different worktree or scope and invalidates it',async()=>{
    const bridge=noteBridge();vi.mocked(bridge.previewNoteLink).mockResolvedValue({status:'ready',proposal:proposal({worktreeId:'different-worktree'})});const actions=createNoteLinkActions(bridge);await actions.loadOptions();await actions.preview({worktreeId:'work-one',scopeId:'scope-one'});await actions.confirm();expect(actions.proposal.value).toBeNull();expect(bridge.cancelNoteLink).toHaveBeenCalledExactlyOnceWith({proposalId:'proposal-one'});expect(bridge.confirmNoteLink).not.toHaveBeenCalled();expect(actions.technicalError.value).toBe('Note preview selection mismatch');
  });
  it('ignores a late options response after disposal',async()=>{
    const bridge=noteBridge();const pending=deferred<Phase1Options>();vi.mocked(bridge.getPhase1Options).mockReturnValue(pending.promise);const actions=createNoteLinkActions(bridge);const loading=actions.loadOptions();actions.dispose();pending.resolve(options);await loading;expect(actions.options.value).toBeNull();
  });
});

async function render<T>(component:import('vue').Component,props:Record<string,unknown>,key?:InjectionKey<T>,actions?:T) {
  const app=createSSRApp(component,props);if(key&&actions) app.provide(key,actions);return renderToString(app);
}

describe('phase 1 journey presentation',()=>{
  it('escapes observed task text and collapses large selection/task lists by default',async()=>{
    const {default:Summary}=await import('../../src/renderer/components/SummaryJourney.vue');const html=await render(Summary,{workstreamId:'work-one',dag:dag(10),current:true});expect(html).toContain('&lt;img');expect(html).not.toContain('<img');expect(html).toContain('승인은 실행 권한이 아닙니다');expect(html).toMatch(/data-testid="summary-task-selection">/);expect(html).not.toMatch(/data-testid="summary-task-selection" open/);
    const {default:Dag}=await import('../../src/renderer/components/LiveDag.vue');const dagHtml=await render(Dag,{dag:dag(10)});expect(dagHtml).toMatch(/data-testid="dag-task-details">/);expect(dagHtml.indexOf('저장된 요약')).toBeLessThan(dagHtml.indexOf('선언된 작업 상세'));
  });
  it('shows an exact blocked reason, missing goal and distinct preserved approvals',async()=>{
    const bridge=summaryBridge();vi.mocked(bridge.prepareSummary).mockResolvedValue(summary({state:'prepared',message:'Filesystem sandbox is not verified',canRun:false}));const actions=createSummaryActions(bridge);await actions.prepare(request);const {default:Summary}=await import('../../src/renderer/components/SummaryJourney.vue');const html=await render(Summary,{workstreamId:'work-one',dag:dag(),current:true},summaryActionsKey,actions);
    expect(html).toContain('Filesystem sandbox is not verified');expect(html).toContain('Explicit goal is missing');expect(html).toMatch(/data-testid="summary-run" disabled/);expect(html).toContain('유지된 승인 요약');expect(html).toContain('새 후보 요약');expect(html).toContain('검토할 후보가 없습니다');expect(bridge.runSummary).not.toHaveBeenCalled();actions.dispose();
  });
  it('keeps stale approved claims and a different unapproved candidate distinct and escaped',async()=>{
    const bridge=summaryBridge();const claim={claim:{claimId:'approved',aspect:'goal' as const,kind:'unknown' as const,text:'<script>approved text</script>',intent:'informational' as const,citations:[],assertions:[]},freshness:'stale' as const,reasons:['source changed']};vi.mocked(bridge.prepareSummary).mockResolvedValue(summary({state:'candidate',candidateHash:'candidate-hash',candidateClaims:[{...claim,claim:{...claim.claim,claimId:'candidate',text:'new candidate'}}],approvedClaims:[claim],canApprove:true,canReject:true}));const actions=createSummaryActions(bridge);await actions.prepare(request);const {default:Summary}=await import('../../src/renderer/components/SummaryJourney.vue');const html=await render(Summary,{workstreamId:'work-one',dag:dag(),current:true},summaryActionsKey,actions);
    expect(html).toContain('이전 근거 · 변경됨');expect(html).toContain('new candidate');expect(html).toContain('&lt;script&gt;approved text');expect(html).not.toContain('<script>');expect(html).toContain('이 후보를 요약으로 승인');expect(html).toContain('이 후보 거절');expect(html.indexOf('summary-approved')).toBeLessThan(html.indexOf('summary-task-selection'));actions.dispose();
  });
  it('does not mislabel an already approved restored candidate as unapproved',async()=>{
    const bridge=summaryBridge();vi.mocked(bridge.prepareSummary).mockResolvedValue(summary({state:'prepared',candidateHash:'same',approvedCandidateHash:'same',persistence:{state:'restored',revision:2,message:'Restored approval'},canApprove:false,canReject:false}));const actions=createSummaryActions(bridge);await actions.prepare(request);const {default:Summary}=await import('../../src/renderer/components/SummaryJourney.vue');const html=await render(Summary,{workstreamId:'work-one',dag:dag(),current:true},summaryActionsKey,actions);expect(html).toContain('이미 승인된 후보 요약');expect(html).toContain('동일 후보의 승인 기록 있음');expect(html).not.toContain('검토 전 · 미승인');expect(html).not.toContain('data-testid="summary-approve"');actions.dispose();
  });
  it('displays exact shared changes and hostile source text without leaking the confirmation token',async()=>{
    const bridge=noteBridge();vi.mocked(bridge.previewNoteLink).mockResolvedValue({status:'ready',proposal:proposal({warnings:['<img src=x onerror="steal()">']})});const actions=createNoteLinkActions(bridge);await actions.loadOptions();await actions.preview({worktreeId:'work-one',scopeId:'scope-one'});const {default:Note}=await import('../../src/renderer/components/NoteLinkJourney.vue');const html=await render(Note,{worktreeId:'work-one',current:true},noteLinkActionsKey,actions);
    expect(bridge.confirmNoteLink).not.toHaveBeenCalled();expect(html).toContain('/work/main/.git/info/exclude');expect(html).toContain('/work/two');expect(html).toContain('\n/docs/note\n');expect(html).toContain('&lt;img');expect(html).not.toContain('<img');expect(html).not.toContain('opaque-main-token');expect(html).toContain('위 로컬 변경을 확인하고 적용');actions.dispose();
  });
  it.each(['partial','rolled-back'] as const)('renders truthful %s recovery separately from applied success',async status=>{
    const bridge=noteBridge();vi.mocked(bridge.confirmNoteLink).mockResolvedValue({...applied,status,actual:{docsCreated:null,noteLinked:false,excludeUpdated:true},recovery:['<b>Inspect exclude file</b>']});const actions=createNoteLinkActions(bridge);await actions.loadOptions();await actions.preview({worktreeId:'work-one',scopeId:'scope-one'});await actions.confirm();const {default:Note}=await import('../../src/renderer/components/NoteLinkJourney.vue');const html=await render(Note,{worktreeId:'work-one',current:true},noteLinkActionsKey,actions);
    expect(html).toContain(status==='partial'?'일부 변경 남음':'원상 복구됨');expect(html).toContain('docs 생성: 미확인');expect(html).toContain('&lt;b&gt;Inspect exclude file');expect(html).not.toContain('노트 연결 적용됨');expect(html).not.toContain('data-testid="note-link-confirm"');actions.dispose();
  });
});
