import {afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as Vue from 'vue';
import {createRenderer,defineComponent,h,nextTick,reactive,ref,type App,type Component} from 'vue';
import {readFile} from 'node:fs/promises';
import {compileScript,parse} from '@vue/compiler-sfc';
import {transform} from 'esbuild';
import type {UpdateBridge,UpdateOutcome,UpdateState} from '../../src/shared/update';

const Button=defineComponent({
  props:['label','disabled','loading'],
  setup(props,{attrs}){return()=>h('button',{...attrs,disabled:props.disabled},props.label);},
});
const Dialog=defineComponent({
  props:['visible','header'],
  setup(props,{slots}){return()=>props.visible?h('dialog',{'aria-label':props.header},slots.default?.()):null;},
});
let UpdateSettings:Component,UpdateOutcomeNotice:Component,Application:Component;
const route=reactive({path:'/'});
const appStore={initialize:vi.fn(),dispose:vi.fn(),snapshot:ref(null),mode:ref('live'),liveState:ref(null),environment:ref(null)};
async function compile(filename:string,additional:Record<string,unknown>={}):Promise<Component>{
  // Vitest compiles SFC imports for SSR. Compile each exact production SFC for a client host
  // instead, preserving its real setup, event bindings and render code for lifecycle tests.
  const {descriptor}=parse(await readFile(filename,'utf8'),{filename});
  const script=compileScript(descriptor,{id:filename,inlineTemplate:true,templateOptions:{ssr:false}});
  const {code}=await transform(script.content,{loader:'ts',format:'cjs',target:'node24'});
  const imports:Record<string,unknown>={vue:Vue,'primevue/button':Button,'primevue/dialog':Dialog,'../store':{formatTime:(value:string)=>value},...additional};
  const module={exports:{} as {default:Component}};
  new Function('require','module','exports',code)((id:string)=>{if(!(id in imports))throw Error(`Unexpected SFC import ${id}`);return imports[id];},module,module.exports);
  return module.exports.default;
}
beforeAll(async()=>{
  UpdateSettings=await compile('src/renderer/components/UpdateSettings.vue');
  UpdateOutcomeNotice=await compile('src/renderer/components/UpdateOutcomeNotice.vue');
  Application=await compile('src/renderer/App.vue',{'./store':appStore,'./components/UpdateOutcomeNotice.vue':UpdateOutcomeNotice,
    'vue-router':{useRoute:()=>route,useRouter:()=>({isReady:async()=>{}})}});
});

// Exercise the production Vue component and its lifecycle without weakening Electron's sandbox.
// This host is deliberately not browser/layout coverage; the actual-Electron suite owns that.
interface Node {type:string;props:Record<string,unknown>;text:string;children:Node[];parent:Node|null}
const node=(type:string,text=''):Node=>({type,props:{},text,children:[],parent:null});
const renderer=createRenderer<Node,Node>({
  createElement:type=>node(type),createText:text=>node('#text',text),createComment:text=>node('#comment',text),
  setText:(element,text)=>{element.text=text;},setElementText:(element,text)=>{element.text=text;element.children=[];},
  parentNode:element=>element.parent,nextSibling:element=>{const children=element.parent?.children??[];return children[children.indexOf(element)+1]??null;},
  patchProp:(element,key,_previous,next)=>{element.props[key]=next;},
  insert(element,parent,anchor=null){if(element.parent){const old=element.parent.children;old.splice(old.indexOf(element),1);}const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,element);element.parent=parent;},
  remove(element){if(element.parent){const siblings=element.parent.children;siblings.splice(siblings.indexOf(element),1);element.parent=null;}},
});
const base=():UpdateState=>({status:'idle',current:{version:'0.1.0',buildNumber:'1',sourceSha:'a'.repeat(40)},target:null,message:'아직 확인하지 않았습니다.',checkedAt:null,prerequisites:[],canCheck:true,canPrepare:false,canCancel:false,canDefer:false,canInstall:false});
const target={version:'0.1.1',buildNumber:'2',sourceSha:'b'.repeat(40),changelog:['<img src=x onerror=alert(1)>'],publishedAt:'2026-10-09T00:00:00.000Z'};
const receipt=(kind:UpdateOutcome['kind']):UpdateOutcome=>({attemptId:`test-${kind}`,kind,targetVersion:'0.1.1',occurredAt:'2026-10-08T01:00:00.000Z'});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
let app:App|undefined,root:Node,bridge:UpdateBridge,current:UpdateState;
const listeners=new Set<(state:UpdateState)=>void>();
function all(element=root):Node[]{return[element,...element.children.flatMap(child=>all(child))];}
function get(id:string){const value=all().find(element=>element.props['data-testid']===id);if(!value)throw Error(`Missing ${id}`);return value;}
function text(element:Node):string{return element.text+element.children.map(text).join('');}
async function flush(){await Promise.resolve();await nextTick();await Promise.resolve();await nextTick();}
async function mount(component:Component=UpdateOutcomeNotice){
  root=node('root');app=renderer.createApp(component);
  app.component('RouterView',defineComponent({setup:()=>()=>route.path==='/settings'?h(UpdateSettings):h('section',{'data-testid':'overview-route'},'Overview')}));
  app.component('RouterLink',defineComponent({props:['to'],setup:(props,{slots})=>()=>h('a',{onClick:()=>{route.path=props.to;}},slots.default?.())}));
  app.mount(root);await flush();
}
async function emit(state:UpdateState){current=state;for(const listener of listeners)listener(structuredClone(state));await flush();}
async function click(id:string){(get(id).props.onClick as ()=>void)();await flush();}
beforeEach(()=>{
  current=base();listeners.clear();route.path='/';
  bridge={getUpdateState:vi.fn(async()=>structuredClone(current)),checkUpdate:vi.fn(),prepareUpdate:vi.fn(),cancelUpdate:vi.fn(),deferUpdate:vi.fn(),installUpdate:vi.fn(),dismissUpdateOutcome:vi.fn(async()=>{current={...current,outcome:null};return structuredClone(current);}),onUpdateState:vi.fn(callback=>{listeners.add(callback);return()=>{listeners.delete(callback);};})};
  vi.stubGlobal('window',{noteApp:{...bridge,confirmAppBoot:vi.fn(async()=>{})}});
});
afterEach(()=>{app?.unmount();app=undefined;vi.unstubAllGlobals();});

describe('update feedback component',()=>{
  it.each(['success','rollback','recovery-needed','failed','unverified'] as const)('shows %s as a nonmodal result without starting work',async kind=>{
    current={...base(),outcome:receipt(kind)};await mount();
    expect(get('update-outcome').props['data-outcome-kind']).toBe(kind);expect(get('update-outcome').props.role).toBe('status');
    expect(text(get('update-outcome'))).toContain('대상 0.1.1');expect(all().some(element=>element.type==='dialog')).toBe(false);
    for(const action of [bridge.checkUpdate,bridge.prepareUpdate,bridge.installUpdate,bridge.dismissUpdateOutcome])expect(action).not.toHaveBeenCalled();
    app!.unmount();await mount();expect(get('update-outcome').props['data-outcome-kind']).toBe(kind);
    expect(all().some(element=>element.type==='dialog')).toBe(false);
  });
  it('mounts one notice on the normal initial App route and keeps it single across Settings navigation',async()=>{
    current={...base(),outcome:receipt('success')};await mount(Application);
    expect(route.path).toBe('/');expect(get('overview-route')).toBeTruthy();expect(get('update-outcome')).toBeTruthy();
    expect(all().some(element=>element.type==='dialog')).toBe(false);expect(bridge.getUpdateState).toHaveBeenCalledOnce();
    await click('nav-settings');expect(route.path).toBe('/settings');expect(get('update-settings')).toBeTruthy();
    expect(all().filter(element=>element.props['data-testid']==='update-outcome')).toHaveLength(1);
    await click('nav-overview');expect(get('overview-route')).toBeTruthy();expect(get('update-outcome')).toBeTruthy();
    expect(listeners.size).toBe(1);expect(bridge.getUpdateState).toHaveBeenCalledTimes(2);
    await click('update-outcome-dismiss');await click('nav-settings');
    expect(all().filter(element=>element.props['data-testid']==='update-outcome')).toHaveLength(0);
    expect(all().some(element=>element.type==='dialog')).toBe(false);
    for(const action of [bridge.checkUpdate,bridge.prepareUpdate,bridge.installUpdate])expect(action).not.toHaveBeenCalled();
  });
  it('does not let a delayed initial state overwrite a newer outcome notification',async()=>{
    const pending=deferred<UpdateState>();vi.mocked(bridge.getUpdateState).mockReturnValueOnce(pending.promise);await mount();
    await emit({...base(),outcome:receipt('rollback')});pending.resolve({...base(),outcome:null});await flush();
    expect(get('update-outcome').props['data-outcome-kind']).toBe('rollback');
  });
  it('dismisses through one no-argument main request and keeps the result dismissed after remount',async()=>{
    current={...base(),outcome:receipt('success')};await mount();
    const pending=deferred<UpdateState>();vi.mocked(bridge.dismissUpdateOutcome).mockReturnValueOnce(pending.promise);
    const action=get('update-outcome-dismiss').props.onClick as ()=>void;for(let i=0;i<6;i++)action();await flush();
    expect(bridge.dismissUpdateOutcome).toHaveBeenCalledExactlyOnceWith();expect(get('update-outcome-dismiss').props.disabled).toBe(true);
    current={...current,outcome:null};pending.resolve(current);await flush();
    expect(all().some(element=>element.props['data-testid']==='update-outcome')).toBe(false);
    app!.unmount();await mount();expect(all().some(element=>element.props['data-testid']==='update-outcome')).toBe(false);
  });
  it('retains the banner and reports a failed persistence request, then permits retry',async()=>{
    current={...base(),outcome:receipt('unverified')};vi.mocked(bridge.dismissUpdateOutcome).mockRejectedValueOnce(Error('storage unavailable'));await mount();
    await click('update-outcome-dismiss');expect(text(get('update-outcome-error'))).toContain('결과를 닫지 못했습니다');expect(get('update-outcome')).toBeTruthy();
    await click('update-outcome-dismiss');expect(all().some(element=>element.props['data-testid']==='update-outcome')).toBe(false);
  });
  it('does not let a stale dismiss response hide a newer main outcome',async()=>{
    current={...base(),outcome:receipt('success')};await mount();
    const pending=deferred<UpdateState>();vi.mocked(bridge.dismissUpdateOutcome).mockReturnValueOnce(pending.promise);
    await click('update-outcome-dismiss');await emit({...base(),outcome:receipt('recovery-needed')});
    pending.resolve({...base(),outcome:null});await flush();expect(get('update-outcome').props['data-outcome-kind']).toBe('recovery-needed');
  });
  it('shows stage counts rather than download percentages including completed 7/7',async()=>{
    current={...base(),status:'preparing',progress:{step:'빌드 검증',completed:3,total:7}};await mount(UpdateSettings);
    expect(text(get('update-progress-count'))).toBe('준비 단계 3/7');expect(text(root)).toContain('단계 기준이며, 다운로드 퍼센트가 아닙니다.');
    await emit({...current,status:'ready',progress:{step:'완료',completed:7,total:7}});expect(text(get('update-progress-count'))).toBe('준비 단계 7/7');
  });
  it('claims restored preparation is verified only when main permits installation',async()=>{
    current={...base(),status:'deferred',canInstall:true};await mount(UpdateSettings);expect(text(get('update-deferred'))).toContain('파일 검증이 확인되었습니다');
    expect(all().some(element=>element.type==='dialog')).toBe(false);
    await emit({...current,canInstall:false});expect(text(get('update-deferred'))).toContain('검증이 확인되지 않아 설치할 수 없습니다');
    expect(text(get('update-deferred'))).not.toContain('검증이 확인되었습니다');expect(all().some(element=>element.props['data-testid']==='update-install')).toBe(false);
  });
});


describe('source update settings',()=>{
  it('explains the fixed-feed local-build flow and prerequisites without starting work',async()=>{
    current={...base(),status:'available',target,canPrepare:true};await mount(UpdateSettings);
    expect(text(get('update-prepare'))).toBe('업데이트 준비');
    expect(text(root)).toContain('해당 소스를 내려받아 이 Mac에서 빌드합니다');
    expect(text(get('update-preparation-help'))).toContain('현재 앱을 계속 사용할 수 있습니다');
    expect(text(get('update-preparation-help'))).toContain('Git, Node.js 24 이상, npm');
    expect(text(get('update-preparation-help'))).toContain('없는 도구를 자동으로 설치하지 않습니다');
    expect(text(root)).toContain('SHA 입력이나 별도 설정은 필요하지 않습니다');
    expect(all().some(element=>['input','textarea','select','dialog'].includes(element.type))).toBe(false);
    expect(text(get('update-changelog'))).toContain('<img src=x onerror=alert(1)>');
    expect(all().some(element=>element.type==='img')).toBe(false);
    for(const action of [bridge.checkUpdate,bridge.prepareUpdate,bridge.installUpdate,bridge.deferUpdate])expect(action).not.toHaveBeenCalled();
  });
  it('names missing prerequisites prominently and opens their supplied recovery details',async()=>{
    current={...base(),status:'available',target,prerequisites:[
      {id:'runtime',label:'Node.js 24 이상',ready:false,detail:'Node.js 24 이상을 설치한 뒤 앱을 다시 열어 주세요.'},
      {id:'npm',label:'npm',ready:false,detail:'npm을 사용할 수 있는지 확인해 주세요.'},
      {id:'git',label:'Git',ready:true},
    ]};await mount(UpdateSettings);
    expect(text(get('update-missing-prerequisites'))).toContain('Node.js 24 이상, npm');
    expect(text(get('update-missing-prerequisites'))).not.toContain('Git');
    expect(text(get('update-prerequisites'))).toContain('앱을 다시 열어 주세요');
    expect(all().find(element=>element.type==='details')?.props.open).toBe(true);
    expect(all().some(element=>element.props['data-testid']==='update-prepare')).toBe(false);
    expect(bridge.prepareUpdate).not.toHaveBeenCalled();
  });
  it('coalesces repeated preparation and cancel while retaining the cancellation result',async()=>{
    current={...base(),status:'available',target,canPrepare:true};await mount(UpdateSettings);
    const prepared=deferred<UpdateState>(),cancelled=deferred<UpdateState>();
    vi.mocked(bridge.prepareUpdate).mockReturnValueOnce(prepared.promise);vi.mocked(bridge.cancelUpdate).mockReturnValueOnce(cancelled.promise);
    const prepare=get('update-prepare').props.onClick as ()=>void;for(let i=0;i<6;i++)prepare();await flush();
    expect(bridge.prepareUpdate).toHaveBeenCalledExactlyOnceWith();
    await emit({...current,status:'preparing',canPrepare:false,canCheck:false,canCancel:true});
    const cancel=get('update-cancel').props.onClick as ()=>void;for(let i=0;i<6;i++)cancel();await flush();
    expect(bridge.cancelUpdate).toHaveBeenCalledExactlyOnceWith();expect(get('update-cancel').props.disabled).toBe(true);
    cancelled.resolve({...base(),status:'cancelled'});await flush();
    prepared.resolve({...base(),status:'ready',target,canInstall:true});await flush();
    expect(text(get('update-status'))).toBe('업데이트 취소됨');
    expect(all().some(element=>element.props['data-testid']==='update-install')).toBe(false);
  });
  it('coalesces repeated checks and cancels once without accepting the late check result',async()=>{
    await mount(UpdateSettings);const checked=deferred<UpdateState>(),cancelled=deferred<UpdateState>();
    vi.mocked(bridge.checkUpdate).mockReturnValueOnce(checked.promise);vi.mocked(bridge.cancelUpdate).mockReturnValueOnce(cancelled.promise);
    const check=get('update-check').props.onClick as ()=>void;for(let i=0;i<6;i++)check();await flush();
    expect(bridge.checkUpdate).toHaveBeenCalledExactlyOnceWith();
    await emit({...base(),status:'checking',canCheck:false,canCancel:true});
    const cancel=get('update-cancel').props.onClick as ()=>void;for(let i=0;i<6;i++)cancel();await flush();
    expect(bridge.cancelUpdate).toHaveBeenCalledExactlyOnceWith();
    cancelled.resolve({...base(),status:'cancelled'});await flush();
    checked.resolve({...base(),status:'available',target,canPrepare:true});await flush();
    expect(text(get('update-status'))).toBe('업데이트 취소됨');expect(all().some(element=>element.props['data-testid']==='update-prepare')).toBe(false);
    vi.mocked(bridge.checkUpdate).mockResolvedValueOnce({...base(),status:'available',target,canPrepare:true});await click('update-check');
    expect(bridge.checkUpdate).toHaveBeenCalledTimes(2);expect(get('update-prepare')).toBeTruthy();
  });
  it('ignores a cancelled preparation result and preserves newer state after route interruption',async()=>{
    current={...base(),status:'available',target,canPrepare:true};await mount(UpdateSettings);
    const prepared=deferred<UpdateState>();vi.mocked(bridge.prepareUpdate).mockReturnValueOnce(prepared.promise);
    await click('update-prepare');await emit({...current,status:'preparing',canPrepare:false,canCheck:false,canCancel:true});
    vi.mocked(bridge.cancelUpdate).mockResolvedValueOnce({...base(),status:'cancelled'});await click('update-cancel');
    prepared.resolve({...base(),target,status:'ready',canInstall:true});await flush();
    expect(text(get('update-status'))).toBe('업데이트 취소됨');expect(bridge.installUpdate).not.toHaveBeenCalled();
    const delayedCheck=deferred<UpdateState>();vi.mocked(bridge.checkUpdate).mockReturnValueOnce(delayedCheck.promise);
    await click('update-check');app!.unmount();app=undefined;expect(listeners.size).toBe(0);
    current={...base(),status:'available',target,canPrepare:true};await mount(UpdateSettings);
    delayedCheck.resolve({...base(),status:'unavailable'});await flush();
    expect(text(get('update-status'))).toBe('업데이트 있음');expect(get('update-prepare')).toBeTruthy();
  });
  it('requires explicit restart confirmation, closes changed targets, and coalesces installation',async()=>{
    current={...base(),status:'ready',target,canInstall:true};await mount(UpdateSettings);
    await click('update-install');expect(all().some(element=>element.type==='dialog')).toBe(true);
    expect(text(root)).toContain('이전 앱으로 복구를 시도합니다');expect(bridge.installUpdate).not.toHaveBeenCalled();
    expect(get('update-install-cancel').props.autofocus).toBe('');
    await emit({...current,target:{...target,buildNumber:'3'}});expect(all().some(element=>element.type==='dialog')).toBe(false);
    await click('update-install');await emit({...current,canInstall:false});expect(all().some(element=>element.type==='dialog')).toBe(false);
    await emit({...current,canInstall:true});await click('update-install');
    const installed=deferred<UpdateState>();vi.mocked(bridge.installUpdate).mockReturnValueOnce(installed.promise);
    const confirm=get('update-install-confirm').props.onClick as ()=>void;for(let i=0;i<6;i++)confirm();await flush();
    expect(bridge.installUpdate).toHaveBeenCalledExactlyOnceWith();expect(all().some(element=>element.type==='dialog')).toBe(false);
    installed.resolve({...base(),status:'installing'});await flush();expect(text(get('update-status'))).toBe('설치 및 재시작 중');
  });
  it('treats a rejected restart request as unconfirmed and refreshes state without retrying installation',async()=>{
    current={...base(),status:'ready',target,canInstall:true};await mount(UpdateSettings);await click('update-install');
    vi.mocked(bridge.installUpdate).mockRejectedValueOnce(Error('IPC disconnected'));
    vi.mocked(bridge.getUpdateState).mockResolvedValueOnce({...base(),status:'installing',canCheck:false});
    await click('update-install-confirm');
    expect(text(get('update-error'))).toContain('결과를 확인하지 못했습니다');
    expect(text(get('update-error'))).not.toContain('현재 앱을 유지');expect(text(get('update-status'))).toBe('설치 및 재시작 중');
    expect(bridge.installUpdate).toHaveBeenCalledExactlyOnceWith();expect(bridge.getUpdateState).toHaveBeenCalledTimes(2);
    expect(all().some(element=>element.type==='dialog')).toBe(false);
  });
});
