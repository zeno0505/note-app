import {describe,it,expect,beforeEach,vi} from 'vitest';
import type {LiveWorkspaceView} from '../../src/shared/live';
import {DemoStore} from '../../src/main/demo-store';
import {snapshot,scenario,refreshDemo,exitDemo,busy,bridgeError,connectionStatus} from '../../src/renderer/store';

const disconnected:LiveWorkspaceView={mode:'live-read-only',connection:'disconnected',configuration:{state:'unconfigured',message:'Test configuration',orcaExecutable:null,codeburnExecutable:null,noteScopeCount:0,dagQueryConfigured:false,summaryTransport:'blocked'},refreshing:false,observedAt:null,freshness:'unknown',lastError:null,coverage:null,workstreams:[],dags:[],codeburn:{state:'unconfigured',results:[]}};
const disconnectLive=()=>Promise.resolve(disconnected);
describe('stateful synthetic last-good handling',()=>{
  it('does not invent a prior success',()=>{expect(()=>new DemoStore().read('failure')).toThrow('No previous observation');});
  it('retains actual successful empty result on failure',()=>{
    const store=new DemoStore();const empty=store.read('empty');const failed=store.read('failure');
    expect(failed.workstreams).toEqual([]);expect(failed.observedAt).toBe(empty.observedAt);expect(failed.freshness).toBe('stale');expect(failed.lastAttempt.outcome).toBe('error');
  });
  it('retains empty data when the local clock is at the sample timestamp',()=>{
    const store=new DemoStore();const empty=store.read('empty');
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse(empty.observedAt));
    try{const failed=store.read('failure');expect(failed.workstreams).toEqual([]);expect(Date.parse(failed.lastAttempt.observedAt)).toBeGreaterThan(Date.parse(empty.observedAt));}finally{clock.mockRestore();}
  });
  it('preserves prior workstreams/time and returns detached data',()=>{
    const store=new DemoStore();const normal=store.read('normal');normal.workstreams=[];
    const failed=store.read('failure');expect(failed.workstreams).toHaveLength(3);expect(failed.observedAt).toBe(normal.observedAt);expect(failed.workstreams.every(w=>w.goal.freshness==='stale')).toBe(true);
    expect(store.read('normal').freshness).toBe('current');
  });
});
describe('renderer bridge failures',()=>{
  beforeEach(()=>{exitDemo();busy.value=false;bridgeError.value=null;});
  it('keeps first-read failure unknown, not zero-success',async()=>{
    Object.defineProperty(globalThis,'window',{value:{noteApp:{disconnectLive,loadDemo:vi.fn().mockRejectedValue(new Error('IPC unavailable'))}},configurable:true});
    await refreshDemo();expect(snapshot.value).toBeNull();expect(bridgeError.value).toBeTruthy();expect(busy.value).toBe(false);
  });
  it('marks existing success stale on IPC rejection and allows retry',async()=>{
    const service=new DemoStore();const loadDemo=vi.fn().mockImplementation(({scenario})=>Promise.resolve(service.read(scenario)));
    Object.defineProperty(globalThis,'window',{value:{noteApp:{disconnectLive,loadDemo}},configurable:true});
    await refreshDemo();const before=snapshot.value!;loadDemo.mockRejectedValueOnce(new Error('IPC unavailable'));
    await refreshDemo();expect(snapshot.value?.observedAt).toBe(before.observedAt);expect(snapshot.value?.workstreams.map(w=>w.id)).toEqual(before.workstreams.map(w=>w.id));expect(snapshot.value?.freshness).toBe('stale');expect(snapshot.value?.lastAttempt.outcome).toBe('error');
    await refreshDemo();expect(snapshot.value?.freshness).toBe('current');expect(bridgeError.value).toBeNull();
  });
  it('ignores a late response after leaving sample mode',async()=>{
    let resolve!:(value:ReturnType<DemoStore['read']>)=>void;
    const loadDemo=vi.fn(()=>new Promise<ReturnType<DemoStore['read']>>(done=>{resolve=done;}));
    Object.defineProperty(globalThis,'window',{value:{noteApp:{disconnectLive,loadDemo}},configurable:true});
    const request=refreshDemo();await Promise.resolve();exitDemo();resolve(new DemoStore().read('normal'));await request;
    expect(snapshot.value).toBeNull();expect(busy.value).toBe(false);expect(bridgeError.value).toBeNull();
  });
  it('coalesces rapid refresh while request is pending',async()=>{
    let resolve!:(value:ReturnType<DemoStore['read']>)=>void;
    const loadDemo=vi.fn(()=>new Promise<ReturnType<DemoStore['read']>>(done=>{resolve=done;}));
    Object.defineProperty(globalThis,'window',{value:{noteApp:{disconnectLive,loadDemo}},configurable:true});
    const first=refreshDemo();await refreshDemo();expect(loadDemo).toHaveBeenCalledTimes(1);resolve(new DemoStore().read('normal'));await first;expect(busy.value).toBe(false);
  });
});

describe('connectivity meaning',()=>{
  it('keeps unknown distinct from disconnected and connected',()=>{
    const stream=new DemoStore().read('normal').workstreams[2];
    stream.worktrees[0].terminalConnected=null;stream.worktrees[0].terminalCount=null;
    expect(connectionStatus(stream)).toBe('unknown');
    stream.worktrees[0].terminalConnected=false;stream.worktrees[0].terminalCount=0;expect(connectionStatus(stream)).toBe('disconnected');
    stream.worktrees[0].terminalConnected=true;stream.worktrees[0].terminalCount=1;expect(connectionStatus(stream)).toBe('connected');
  });
});
