import {ref,shallowRef,type InjectionKey} from 'vue';
import type {SummaryPrepareRequest,SummaryProviderChoice,SummaryWorkflowBridge,SummaryWorkflowView} from '../shared/summary-workflow';

export const MAX_SUMMARY_TASKS=32;
export function boundedTaskSelection(taskIds:readonly string[],availableIds:readonly string[]):string[] {
  const available=new Set(availableIds);
  return [...new Set(taskIds)].filter(id=>available.has(id)).slice(0,MAX_SUMMARY_TASKS);
}
const technicalMessage=(error:unknown)=>error instanceof Error?error.message:'IPC request failed';

/** Each mounted journey owns its tickets. Navigation cannot revive an old response. */
export function createSummaryActions(bridge:SummaryWorkflowBridge|undefined) {
  const view=shallowRef<SummaryWorkflowView|null>(null);
  const busy=ref(false);
  const error=ref<string|null>(null);
  const technicalError=ref<string|null>(null);
  let generation=0;
  let disposed=false;
  let cancellingTicket:string|null=null;
  let preparingWorkstream:string|null=null;
  const pendingViews=new Map<string,SummaryWorkflowView>();
  let unsubscribe:(()=>void)|undefined;
  const retire=async(ticketId:string)=>{try {await bridge?.cancelSummary({ticketId});} catch {/* Best effort on dismissal; never restore dismissed state. */}};
  function observe(next:SummaryWorkflowView) {
    const current=view.value;
    if(disposed||!Number.isSafeInteger(next.sequence)||next.sequence<1) return;
    if(!current){
      // The prepare RPC supplies ticket ownership. Retain early events only until
      // that identity arrives; an event alone cannot create a displayed review.
      if(next.workstreamId===preparingWorkstream){
        const prior=pendingViews.get(next.ticketId);
        if(!prior||next.sequence>prior.sequence){
          if(!prior&&pendingViews.size>=64)pendingViews.delete(pendingViews.keys().next().value!);
          pendingViews.set(next.ticketId,next);
        }
      }
      return;
    }
    if(next.ticketId!==current.ticketId||next.workstreamId!==current.workstreamId||next.sequence<=current.sequence) return;
    // Cancellation can be followed by a real late cache outcome. Main's sequence,
    // not delivery order or a terminal-state filter, decides which observation wins.
    view.value=next;
  }
  function subscribe() {
    if(disposed||unsubscribe||!bridge) return;
    unsubscribe=bridge.onSummary(observe);
  }
  async function prepare(request:SummaryPrepareRequest) {
    if(disposed||busy.value) return;
    const previous=view.value;
    const current=++generation;
    busy.value=true;error.value=null;technicalError.value=null;view.value=null;pendingViews.clear();preparingWorkstream=request.workstreamId;
    if(previous?.canCancel) void retire(previous.ticketId);
    try {
      if(!bridge) throw new Error('Summary bridge unavailable');
      const next=await bridge.prepareSummary({...request,taskIds:[...request.taskIds]});
      if(disposed||current!==generation) {await retire(next.ticketId);return;}
      if(next.workstreamId!==request.workstreamId) {await retire(next.ticketId);throw new Error('Summary selection mismatch');}
      view.value=next;
      const pending=pendingViews.get(next.ticketId);if(pending)observe(pending);
    } catch(cause) {
      if(!disposed&&current===generation) {error.value='요약 준비를 완료하지 못했습니다. 실제 소스 연결과 선택한 작업을 확인해 주세요.';technicalError.value=technicalMessage(cause);}
    } finally {if(!disposed&&current===generation) {busy.value=false;preparingWorkstream=null;pendingViews.clear();}}
  }
  async function act(action:'run'|'read'|'approve'|'reject',provider?:SummaryProviderChoice) {
    const currentView=view.value;
    if(disposed||busy.value||!bridge||!currentView) return;
    if(action==='run'&&!currentView.canRun||action==='approve'&&!currentView.canApprove||action==='reject'&&!currentView.canReject) return;
    if((action==='approve'||action==='reject')&&!currentView.candidateHash) return;
    const current=++generation;
    busy.value=true;error.value=null;technicalError.value=null;
    try {
      const ticketId=currentView.ticketId;
      const next=await (action==='run'?bridge.runSummary({ticketId,provider:provider??currentView.providerChoice}):action==='read'?bridge.readSummary({ticketId}):action==='approve'?bridge.approveSummary({ticketId,candidateHash:currentView.candidateHash!}):bridge.rejectSummary({ticketId,candidateHash:currentView.candidateHash!}));
      if(next.ticketId!==currentView.ticketId||next.workstreamId!==currentView.workstreamId) throw new Error('Summary ticket mismatch');
      observe(next);
    } catch(cause) {
      if(!disposed&&current===generation) {error.value='요약 요청 결과를 확인하지 못했습니다. 표시된 저장 상태와 기술 정보를 확인해 주세요.';technicalError.value=technicalMessage(cause);}
    } finally {if(!disposed&&current===generation) busy.value=false;}
  }
  async function cancel() {
    const currentView=view.value;
    if(disposed||!bridge||!currentView||!currentView.canCancel||cancellingTicket===currentView.ticketId) return;
    const current=++generation;
    cancellingTicket=currentView.ticketId;
    busy.value=true;error.value=null;technicalError.value=null;
    try {
      const next=await bridge.cancelSummary({ticketId:currentView.ticketId});
      if(next.ticketId!==currentView.ticketId||next.workstreamId!==currentView.workstreamId) throw new Error('Summary ticket mismatch');
      observe(next);
    } catch(cause) {
      if(!disposed&&current===generation) {error.value='취소 결과를 확인하지 못했습니다. 저장 상태가 확정되지 않았을 수 있습니다.';technicalError.value=technicalMessage(cause);}
    } finally {if(!disposed&&current===generation) {busy.value=false;cancellingTicket=null;}}
  }
  function dismiss() {
    const previous=view.value;
    generation++;cancellingTicket=null;preparingWorkstream=null;pendingViews.clear();view.value=null;busy.value=false;error.value=null;technicalError.value=null;
    if(previous?.canCancel) void retire(previous.ticketId);
  }
  function dispose() {dismiss();disposed=true;unsubscribe?.();unsubscribe=undefined;}
  return {view,busy,error,technicalError,subscribe,prepare,run:(provider?:SummaryProviderChoice)=>act('run',provider),refresh:()=>act('read'),approve:()=>act('approve'),reject:()=>act('reject'),cancel,dismiss,dispose};
}
export type SummaryActions=ReturnType<typeof createSummaryActions>;

import type {NoteLinkBridge,Phase1Options} from '../shared/phase1-options';
import type {NoteLinkPreviewRequest,NoteLinkProposal,NoteLinkConfirmResult,NoteLinkRejection} from '../shared/note-link-workflow';

export function createNoteLinkActions(bridge:NoteLinkBridge|undefined) {
  const options=shallowRef<Phase1Options|null>(null);
  const proposal=shallowRef<NoteLinkProposal|null>(null);
  const result=shallowRef<NoteLinkConfirmResult|null>(null);
  const rejection=shallowRef<NoteLinkRejection|null>(null);
  const busy=ref<'options'|'preview'|'confirm'|null>(null);
  const error=ref<string|null>(null);
  const technicalError=ref<string|null>(null);
  const notice=ref<string|null>(null);
  let generation=0;
  let disposed=false;
  let optionsGeneration=0;
  const consumed=new Set<string>();
  const retire=async(proposalId:string)=>{try {await bridge?.cancelNoteLink({proposalId});} catch {/* Dismissal never revives a proposal. The server also expires it. */}};
  async function loadOptions() {
    if(disposed||!bridge||busy.value==='options') return;
    const current=++optionsGeneration;
    busy.value='options';
    try {const next=await bridge.getPhase1Options();if(!disposed&&current===optionsGeneration) options.value=next;}
    catch(cause) {if(!disposed&&current===optionsGeneration) {error.value='등록된 노트 범위를 확인하지 못했습니다.';technicalError.value=technicalMessage(cause);}}
    finally {if(!disposed&&current===optionsGeneration&&busy.value==='options') busy.value=null;}
  }
  async function preview(request:NoteLinkPreviewRequest) {
    if(disposed||busy.value) return;
    if(!bridge||!options.value?.noteLinkConfigured||!options.value.noteScopes.some(scope=>scope.scopeId===request.scopeId)) {
      error.value='시작 설정에 등록된 노트 범위를 선택해 주세요.';return;
    }
    const previous=proposal.value;
    const current=++generation;
    proposal.value=null;result.value=null;rejection.value=null;error.value=null;technicalError.value=null;notice.value=null;busy.value='preview';
    if(previous) void retire(previous.proposalId);
    try {
      const next=await bridge.previewNoteLink({...request});
      if(disposed||current!==generation) {if(next.status==='ready') await retire(next.proposal.proposalId);return;}
      if(next.status==='ready') {
        if(next.proposal.worktreeId!==request.worktreeId||next.proposal.scopeId!==request.scopeId) {await retire(next.proposal.proposalId);throw new Error('Note preview selection mismatch');}
        proposal.value=next.proposal;
      }
      else rejection.value=next;
    } catch(cause) {
      if(!disposed&&current===generation) {error.value='연결 변경을 미리 확인하지 못했습니다. 파일은 변경 요청하지 않았습니다.';technicalError.value=technicalMessage(cause);}
    } finally {if(!disposed&&current===generation) busy.value=null;}
  }
  async function confirm(now=Date.now()) {
    const prepared=proposal.value;
    if(disposed||busy.value||!bridge||!prepared||prepared.status==='conflict'||consumed.has(prepared.proposalId)) return;
    if(!Number.isFinite(Date.parse(prepared.expiresAt))||Date.parse(prepared.expiresAt)<=now) {
      proposal.value=null;error.value='미리보기 유효 시간이 지났습니다. 변경 내용을 다시 확인해 주세요.';void retire(prepared.proposalId);return;
    }
    const current=++generation;
    consumed.add(prepared.proposalId);busy.value='confirm';error.value=null;technicalError.value=null;notice.value=null;
    try {
      const next=await bridge.confirmNoteLink({proposalId:prepared.proposalId,confirmationToken:prepared.confirmationToken});
      if(next.proposalId&&next.proposalId!==prepared.proposalId) throw new Error('Note confirmation proposal mismatch');
      if(!disposed&&current===generation) {result.value=next;proposal.value=null;}
    } catch(cause) {
      if(!disposed&&current===generation) {proposal.value=null;error.value='연결 요청의 최종 상태를 확인하지 못했습니다. 일부 변경이 적용됐을 수 있으니 실제 파일 상태를 확인한 뒤 새로 미리 보세요.';technicalError.value=technicalMessage(cause);}
    } finally {if(!disposed&&current===generation) busy.value=null;}
  }
  function dismiss() {
    const previous=proposal.value;
    const confirming=busy.value==='confirm';
    generation++;proposal.value=null;result.value=null;rejection.value=null;error.value=null;technicalError.value=null;
    if(busy.value!=='options') busy.value=null;
    notice.value=confirming?'미리보기를 닫았습니다. 이미 요청한 변경은 적용됐을 수 있으며 닫기만으로 되돌려지지 않습니다. 실제 파일 상태를 확인해 주세요.':null;
    if(previous) {consumed.add(previous.proposalId);void retire(previous.proposalId);}
  }
  function dispose() {dismiss();disposed=true;optionsGeneration++;}
  return {options,proposal,result,rejection,busy,error,technicalError,notice,loadOptions,preview,confirm,dismiss,dispose};
}
export type NoteLinkActions=ReturnType<typeof createNoteLinkActions>;

export const summaryActionsKey:InjectionKey<SummaryActions>=Symbol('summary-actions');
export const noteLinkActionsKey:InjectionKey<NoteLinkActions>=Symbol('note-link-actions');
