import { computed, ref } from 'vue';
import type { WorkspaceSnapshot, Workstream } from '../domain';
import { retainLastGoodSnapshot } from '../domain';
import type { AppEnvironment } from '../shared/bridge';
import type { LiveWorkspaceView } from '../shared/live';

export const mode = ref<'live'|'demo'>('live');
export const snapshot = ref<WorkspaceSnapshot|null>(null);
export const liveState = ref<LiveWorkspaceView|null>(null);
export const environment = ref<AppEnvironment|null>(null);
export const busy = ref(false);
export const liveBusy = ref(false);
export const bridgeError = ref<string|null>(null);
export const filter = ref<'connected'|'all'>('connected');
export const scenario = ref<'normal'|'empty'|'failure'>('normal');
export const search = ref('');
let requestGeneration = 0;
let liveGeneration = 0;
let observedGeneration = 0;
let unsubscribe: (()=>void)|null = null;

export function connectionStatus(workstream:Workstream):'connected'|'disconnected'|'unknown' {
  const trees=workstream.worktrees.filter(w=>!w.isArchived);
  if(trees.some(w=>w.terminalConnected===true)) return 'connected';
  if(!trees.length || trees.some(w=>w.terminalConnected===null)) return 'unknown';
  return 'disconnected';
}
export const hasConnection = (workstream:Workstream) => connectionStatus(workstream)==='connected';
export const workstreams = computed(()=>snapshot.value?.workstreams.filter(w=>w.worktrees.some(t=>!t.isArchived))??[]);
export const connectedCount = computed(()=>workstreams.value.filter(hasConnection).length);
export const visibleWorkstreams = computed(()=>workstreams.value.filter(w=>
  (filter.value==='all'||hasConnection(w)) && `${w.title} ${w.goal.text}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())
));
export const liveWorkstreams = computed(()=>liveState.value?.workstreams.filter(w=>w.archived!==true)??[]);
export const liveConnectedCount = computed(()=>liveWorkstreams.value.filter(w=>w.terminalConnected===true).length);
export const visibleLiveWorkstreams = computed(()=>liveWorkstreams.value.filter(w=>
  (filter.value==='all'||w.terminalConnected===true) && `${w.title} ${w.projectName??''} ${w.branch??''}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())
));
export const livePending = computed(()=>liveBusy.value||liveState.value?.refreshing===true);

export async function initialize() {
  unsubscribe?.();
  try {
    unsubscribe=window.noteApp.onLiveState(state=>{observedGeneration++;liveState.value=state;});
    const observed=observedGeneration;
    const [nextEnvironment,state]=await Promise.all([window.noteApp.getEnvironment(),window.noteApp.getLiveState()]);
    environment.value=nextEnvironment;
    if(observed===observedGeneration) liveState.value=state;
  } catch {bridgeError.value='앱 연결을 확인하지 못했습니다. 창을 다시 열어 주세요.';}
}
export function dispose() {unsubscribe?.();unsubscribe=null;}

async function liveAction(action:'connect'|'refresh'|'summarize'|'disconnect') {
  if((liveBusy.value&&action!=='disconnect')||busy.value||mode.value==='demo') return;
  const generation=++liveGeneration;
  const observed=observedGeneration;
  liveBusy.value=true;bridgeError.value=null;
  try {
    const state=await (action==='connect'?window.noteApp.connectLive():action==='refresh'?window.noteApp.refreshLive():action==='summarize'?window.noteApp.summarizeNow():window.noteApp.disconnectLive());
    if(generation===liveGeneration&&observed===observedGeneration) liveState.value=state;
  } catch {if(generation===liveGeneration) bridgeError.value=action==='disconnect'?'연결 해제를 확인하지 못했습니다. 다시 시도해 주세요.':'실제 소스 요청을 완료하지 못했습니다. 마지막 관측과 연결 상태를 확인해 주세요.';}
  finally {if(generation===liveGeneration) liveBusy.value=false;}
}
export const connectLive=()=>liveAction('connect');
export const refreshLive=()=>liveAction('refresh');
export const summarizeNow=()=>liveAction('summarize');
export const disconnectLive=()=>liveAction('disconnect');

export async function refreshDemo() {
  if(busy.value) return;
  const generation=++requestGeneration;
  busy.value=true; bridgeError.value=null;
  try {
    if(mode.value!=='demo') {
      ++liveGeneration;liveBusy.value=false;
      const observed=observedGeneration;
      const disconnected=await window.noteApp.disconnectLive();
      if(generation!==requestGeneration) return;
      if(observed===observedGeneration) liveState.value=disconnected;
      liveBusy.value=false;mode.value='demo';
      search.value='';filter.value='connected';
    }
    const result=await window.noteApp.loadDemo({scenario:scenario.value});
    if(generation===requestGeneration) snapshot.value=result;
  }
  catch {
    if(generation!==requestGeneration) return;
    bridgeError.value=mode.value==='demo'?'새로고침하지 못했습니다. 마지막으로 확인한 내용을 유지합니다.':'실제 소스 연결 해제를 확인하지 못해 샘플로 전환하지 않았습니다.';
    if(snapshot.value) {
      const attemptedAt=new Date(Math.max(Date.now(),Date.parse(snapshot.value.lastAttempt.observedAt)+1)).toISOString();
      snapshot.value=retainLastGoodSnapshot(snapshot.value,attemptedAt,'앱 연결 오류로 갱신하지 못했습니다.');
    }
  }
  finally {if(generation===requestGeneration) busy.value=false;}
}
export function exitDemo() {requestGeneration++;snapshot.value=null;mode.value='live';scenario.value='normal';search.value='';filter.value='connected';busy.value=false;bridgeError.value=null;}
export function formatTime(value:string|number):string {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())) return '관측 시각 미확인';
  return new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}).format(date)+' UTC';
}
