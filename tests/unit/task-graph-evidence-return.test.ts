import { readFileSync } from 'node:fs';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type Component, type RenderFunction } from 'vue';
import EvidenceViewer from '../../src/renderer/components/EvidenceViewer.vue';
import DocumentViewer from '../../src/renderer/components/DocumentViewer.vue';
import SafeMarkdown from '../../src/renderer/components/SafeMarkdown.vue';
import TaskWorkspace from '../../src/renderer/components/TaskWorkspace.vue';
import {liveState} from '../../src/renderer/store';
import {defaultWorkspaceState} from '../../src/shared/workspace-state';
import GraphInfoTooltip from '../../src/renderer/components/GraphInfoTooltip.vue';
import TaskGraphOverview from '../../src/renderer/components/TaskGraphOverview.vue';
import {sessionGraphNavigationHistory} from '../../src/renderer/task-graph-navigation';
import TaskGraphWorkspace from '../../src/renderer/components/TaskGraphWorkspace.vue';
import { graphEdgeId, graphGroupKey, type GraphReadRequest, type GraphSourceNode, type LinkedDateSummary } from '../../src/shared/task-graph-contract';
import { layoutGraphSnapshot, type GraphLayout, type GraphLayoutOptions } from '../../src/shared/task-graph-layout';
import type { GraphDateReadResult } from '../../src/shared/task-graph-dates';
import type { AssembledGraphSnapshot } from '../../src/shared/task-graph-transport';

vi.mock('primevue/button',()=>({default:{inheritAttrs:false,props:['label'],setup(props:any,{attrs}:any){return()=>Vue.h('button',attrs,props.label);}}}));
vi.mock('primevue/select',()=>({default:{setup(){return()=>Vue.h('select');}}}));
vi.mock('primevue/inputtext',()=>({default:{setup(){return()=>Vue.h('input');}}}));
vi.mock('../../src/renderer/components/InfoDialog.vue',()=>({default:{setup(){return()=>Vue.h('span');}}}));
vi.mock('../../src/renderer/components/VerificationSourcesPopover.vue',()=>({default:{setup(){return()=>Vue.h('span');}}}));
const pipelineFactory = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/task-graph-layout-client', () => ({ createTaskGraphLayoutPipeline: pipelineFactory }));

// Run actual production templates and setup functions in Vue's custom renderer.
// This is component/event/lifecycle coverage, not native browser, layout or pixels.
for (const [component, name] of [[EvidenceViewer,'EvidenceViewer'],[DocumentViewer,'DocumentViewer'],[SafeMarkdown,'SafeMarkdown'],[GraphInfoTooltip, 'GraphInfoTooltip'], [TaskGraphOverview, 'TaskGraphOverview'], [TaskGraphWorkspace, 'TaskGraphWorkspace'],[TaskWorkspace,'TaskWorkspace']] as const) {
  const filename = new URL(`../../src/renderer/components/${name}.vue`, import.meta.url);
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
  const compiled = compileTemplate({ source: descriptor.template!.content, filename: filename.pathname, id: `${name}-test`,
    compilerOptions: { mode: 'function', hoistStatic: false, bindingMetadata: compileScript(descriptor, { id: `${name}-test` }).bindings } });
  if (compiled.errors.length) throw Error(compiled.errors.map(String).join('\n'));
  (component as unknown as { render: RenderFunction }).render = new Function('Vue', transformSync(compiled.code, { loader: 'ts', target: 'es2022' }).code)(Vue) as RenderFunction;
}

interface HostNode {
  type: string; tagName: string; parent: HostNode | null; children: HostNode[]; props: Record<string, any>; text: string;
  querySelector:(selector:string)=>HostNode|null;closest:()=>HostNode|null;scrollIntoView:()=>void;
  style: Record<string, string>; value: string; options: HostNode[]; scrollTop: number; scrollLeft: number; clientWidth: number; clientHeight: number;
  dataset: Record<string, string>; listeners: Map<string, (event: unknown) => void>;
  getBoundingClientRect: () => { left: number; top: number; bottom: number; width: number; height: number };
  addEventListener: (event: string, listener: (event: unknown) => void) => void;
  removeEventListener: (event: string) => void; focus: () => void;
  scrollTo: (position: { left: number; top: number }) => void;
  getRootNode: () => unknown; querySelectorAll: (selector: string) => HostNode[]; contains: (target: HostNode) => boolean;
}
function descendants(root: HostNode): HostNode[] { return [root, ...root.children.flatMap(descendants)]; }
function textOf(root: HostNode): string { return root.type === 'comment' ? '' : root.text + root.children.map(textOf).join(''); }
function visibleText(root: HostNode): string { return root.style.display === 'none' || root.type === 'comment' ? '' : root.text + root.children.map(visibleText).join(''); }
function host(type: string, text = ''): HostNode {
  const element: HostNode = { type, tagName: type.toUpperCase(), parent: null, children: [], props: {}, text, style: {}, value: '',
    options: [], scrollTop: 0, scrollLeft: 0, clientWidth: 1100, clientHeight: 600, dataset: {}, listeners: new Map(),
    getBoundingClientRect: () => ({ left: 100, top: 200, bottom: 234, width: 120, height: type === 'button' ? 34 : 80 }),
    addEventListener: (event, listener) => element.listeners.set(event, listener), removeEventListener: event => { element.listeners.delete(event); },
    focus: vi.fn(() => { Object.assign(document, { activeElement: element }); }),
    scrollTo: vi.fn(position => { element.scrollTop = position.top; element.scrollLeft = position.left; }),
    getRootNode: () => document,
    closest:()=>null,scrollIntoView:()=>{},querySelector:()=>null,
    contains: target => descendants(element).includes(target),
    querySelectorAll: selector => descendants(element).filter(node => selector === '[data-graph-task]' && node.props['data-graph-task'] !== undefined),
  };
  return Vue.markRaw(element);
}
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); vi.unstubAllGlobals(); pipelineFactory.mockReset(); sessionGraphNavigationHistory.clear(); liveState.value=null; });
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function settle() { for (let i = 0; i < 12; i++) { await nextTick(); await Promise.resolve(); } }
function mount(component: Component, props: Record<string, unknown>, options: { bridge?: unknown; slots?: Record<string, () => unknown> } = {}) {
  const body = host('body'), root = host('root');
  type Listener = (event?: any) => void;
  const documentListeners = new Map<string, Set<Listener>>(), windowListeners = new Map<string, Set<Listener>>();
  const add = (map: Map<string, Set<Listener>>, event: string, listener: Listener) => { if (!map.has(event)) map.set(event, new Set()); map.get(event)!.add(listener); };
  const remove = (map: Map<string, Set<Listener>>, event: string, listener: Listener) => { map.get(event)?.delete(listener); if (map.get(event)?.size === 0) map.delete(event); };
  const dispatch = (map: Map<string, Set<Listener>>, event: string, value: unknown = {}) => map.get(event)?.forEach(listener => listener(value));
  const doc = { hidden: false, visibilityState: 'visible', activeElement: null as HostNode | null,
    addEventListener: (event: string, listener: Listener) => add(documentListeners, event, listener),
    removeEventListener: (event: string, listener: Listener) => remove(documentListeners, event, listener),
    querySelector: () => descendants(root).find(node => node.props.class === 'overview-scroll') ?? null }; 
  const observers: { disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal('document', doc);
  vi.stubGlobal('Document', class {});
  vi.stubGlobal('ShadowRoot', class {});
  vi.stubGlobal('window', { scrollY:0,scrollTo:()=>{},noteApp: options.bridge, innerWidth: 1280, innerHeight: 900,
    addEventListener: (event: string, listener: Listener) => add(windowListeners, event, listener),
    removeEventListener: (event: string, listener: Listener) => remove(windowListeners, event, listener) });
  vi.stubGlobal('ResizeObserver', class { disconnect = vi.fn(); observe = vi.fn(); constructor() { observers.push(this); } });
  const insert = (child: HostNode, parent: HostNode, before?: HostNode | null) => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = parent; const index = before ? parent.children.indexOf(before) : -1;
    if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child);
  };
  const renderer = createRenderer<HostNode, HostNode>({
    patchProp: (element, key, _old, value) => { element.props[key] = value; if (key === 'data-graph-task') element.dataset.graphTask = value; },
    insert, remove: element => { if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1); element.parent = null; },
    createElement: type => host(type), createText: text => host('text', text), createComment: text => host('comment', text),
    setText: (element, text) => { element.text = text; }, setElementText: (element, text) => { element.text = text; element.children = []; },
    parentNode: element => element.parent, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
    querySelector: selector => selector === 'body' ? body : null,
    insertStaticContent: (content, parent, before) => { const element = host('static', content); insert(element, parent, before); return [element, element]; },
  });
  const state = reactive(props), app = renderer.createApp({ render: () => h(component, { ...state }, options.slots) });
  app.provide(ssrContextKey, { modules: new Set() }); app.mount(root);
  let mounted = true; const unmount = () => { if (mounted) { app.unmount(); mounted = false; } }; cleanups.push(unmount);
  const all = () => [...descendants(root), ...descendants(body)];
  const find = (id: string) => all().find(node => node.props['data-testid'] === id);
  const button = (label: string) => { const result = all().find(node => node.type === 'button' && (node.props['aria-label'] === label || textOf(node) === label)); expect(result, `button ${label}`).toBeDefined(); return result!; };
  return { root, body, state, doc, observers, documentListeners, windowListeners, dispatchDocument: (event: string, value?: unknown) => dispatch(documentListeners, event, value), all, find, button, unmount,
    text: () => visibleText(root) + visibleText(body), click: (label: string) => { const trigger = button(label); expect(trigger.props.disabled, `button ${label} is enabled`).not.toBe(true); trigger.props.onClick({ detail: 1 }); },
    visibility: (hidden: boolean) => { doc.hidden = hidden; doc.visibilityState = hidden ? 'hidden' : 'visible'; dispatch(documentListeners, 'visibilitychange'); } };
}

function sourceNode(id: string, status: string | null = 'done', phase = 0): GraphSourceNode {
  return { id, title: `Source title ${id}`, declaredStatus: status, phase: { id: `phase-${phase}`, title: `Source phase ${phase}`, index: phase } };
}
function snapshot(projectId = 'project-1', nodes: readonly GraphSourceNode[] = [sourceNode('B-1'), sourceNode('A-1', 'pending'), sourceNode('A-2', 'deferred', 1), sourceNode('invalid', null, 1)]): AssembledGraphSnapshot {
  const identity = { projectId, dagId: `dag-${projectId}`, sourceHash: `hash-${projectId}`, sessionKey: `session-${projectId}`, revision: `revision-${projectId}` };
  const pairs = nodes.length === 4 ? [['A-1', 'A-2'], ['A-2', 'B-1'], ['B-1', 'invalid']] : [];
  const edges = pairs.map(([from, to]) => ({ id: graphEdgeId(from, to, 'internal'), from: { kind: 'node' as const, id: from }, to: { kind: 'node' as const, id: to }, scope: 'internal' as const, declarations: 1 }));
  return { nodes, edges, metadata: { contractVersion: 1, identity, observedAt: '2026-10-14T00:00:00Z', chunkCount: 1, byteLength: 1,
    coverage: { state: 'complete', reasons: [], counts: { sourceTaskRows: nodes.length, uniqueNodes: nodes.length, uniqueEdges: edges.length, unresolvedEdges: 0 } },
    diagnostics: { duplicateIds: [], cycles: [], repeatedDeclarations: 0 } } };
}
function resolved(id: string, time = '2026-12-31T16:01:02Z'): LinkedDateSummary {
  const sha = 'a'.repeat(40);
  return { state: 'resolved', latest: { taskId: id, declaredReference: sha, repository: { host: 'github.com', owner: 'synthetic', name: 'graph-source' }, sha,
    committerAtUtc: time, verifiedCommitUrl: `https://github.com/synthetic/graph-source/commit/${sha}`, via: { kind: 'declared-commit' } },
    coverage: { inspection: 'complete', tasks: { total: 1, resolved: 1, noReference: 0, unresolved: 0 }, references: { total: 1, resolved: 1, unresolved: 0 } } };
}
function dateResult(source: AssembledGraphSnapshot, requestId: string, time?: string): Extract<GraphDateReadResult, { state: 'dates' }> {
  return { state: 'dates', requestId, identity: source.metadata.identity, metadataRevision: 'metadata-1',
    summary: resolved('unrelated-graph-maximum', '2099-01-01T00:00:00Z'), tasks: source.nodes.map(node => ({ id: node.id, summary: resolved(node.id, time) })) };
}
function workspace(configure?: (pipeline: ReturnType<typeof fakePipeline>, bridge: ReturnType<typeof fakeBridge>) => void, sourceFor = snapshot, initial:Record<string,unknown>={}) {
  const pipeline = fakePipeline(sourceFor), bridge = fakeBridge(sourceFor); configure?.(pipeline, bridge); pipelineFactory.mockReturnValueOnce(pipeline);
  const opened: [string | null, string][] = [], selected: string[] = [],restored:[string|null,boolean][]=[];
  const mounted = mount(TaskGraphWorkspace, { projectId: 'project-1', sourceKey: 'basis-1', current: true, active: true,...initial,
    onSelectionRestore:(id:string|null,open:boolean)=>restored.push([id,open]), onOpenGroup: (key: string | null, mode: string) => opened.push([key, mode]), onSelect: (id: string) => selected.push(id) }, { bridge });
  return { ...mounted, pipeline, bridge, opened, selected, restored };
}
function fakePipeline(sourceFor: (projectId?: string) => AssembledGraphSnapshot) {
  return { read: vi.fn(async (projectId: string, options: GraphLayoutOptions) => { const source = sourceFor(projectId); return { snapshot: source, layout: layoutGraphSnapshot(source, options) }; }),
    layout: vi.fn(async (source: AssembledGraphSnapshot, options: GraphLayoutOptions) => layoutGraphSnapshot(source, options)),
    cancel: vi.fn(), setBackground: vi.fn(), dispose: vi.fn() };
}
function fakeBridge(sourceFor: (projectId?: string) => AssembledGraphSnapshot) {
  return { readTaskGraphDetail:vi.fn(async(request:any)=>{const source=sourceFor(request.identity.projectId),node=source.nodes.find(n=>n.id===request.taskId)!;return {state:'detail',requestId:request.requestId,identity:source.metadata.identity,observedAt:'2026-10-14T00:00:00Z',policies:[],task:{id:node.id,title:node.title,status:node.declaredStatus,rawType:null,rawFeature:null,phase:node.phase,dependencies:[] as {id:string;scope:'internal'|'external'}[],e2e:{state:'undeclared',required:null,coveredBy:null,coverage:'undeclared'},commitReferences:[],commitReferencesUnsupported:0,commitVerification:'not-performed',displayOmissions:{dependencies:0,commitReferences:0,e2eReferences:0},details:{description:null,acceptanceCriteria:[],targetFiles:[],discussion:[],design:[],omissions:0}}};}),cancelTaskGraph:vi.fn(async()=>{}),readTaskGraphDates: vi.fn(async (request: GraphReadRequest): Promise<GraphDateReadResult> => dateResult(sourceFor(request.projectId), request.requestId)),
    cancelTaskGraphDates: vi.fn(async (_request: { requestId: string }) => {}),
    getTaskGraphSession: vi.fn(async ({ projectId }: { projectId: string }): Promise<{ projectId: string; dagId: string; sessionKey: string } | null> => { const identity = sourceFor(projectId).metadata.identity; return { projectId, dagId: identity.dagId, sessionKey: identity.sessionKey }; }) };
}
function cardButtons(mounted: ReturnType<typeof mount>): HostNode[] { return mounted.all().filter(node => node.type === 'button' && node.props.class === 'group-open'); }
function tooltipPanel(mounted: ReturnType<typeof mount>, trigger: HostNode): HostNode { return mounted.all().find(node => node.props.id === trigger.props['aria-describedby'])!; }
function event(node: HostNode, name: string, value: Record<string, unknown> = {}) { expect(node.props[name], name).toBeTypeOf('function'); node.props[name](value); }


describe('real evidence and graph parent integration, synthetic IPC/custom host',()=>{
 function parent(sourceFor=snapshot,limit=1000){
  const source=sourceFor(),pipeline=fakePipeline(sourceFor),bridge=fakeBridge(sourceFor);pipelineFactory.mockReturnValueOnce(pipeline);
  liveState.value={connection:'connected',freshness:'current',refreshing:false,observedAt:'now'} as any;
  const tasks=source.nodes.slice(0,limit).map(node=>({id:node.id,title:node.title,status:node.declaredStatus,phase:node.phase,dependencies:[] as {id:string;scope:'internal'|'external'}[],e2e:{state:'undeclared',required:null,coveredBy:null,coverage:'undeclared'},commitReferences:[],commitVerification:'not-performed',displayOmissions:{dependencies:0,commitReferences:0,e2eReferences:0},details:{description:null,acceptanceCriteria:[],targetFiles:[],omissions:0}}));
  Object.assign(bridge,{prepareTaskEvidence:vi.fn(async()=>({sessionId:'evidence-1',unsupportedCount:0,items:[{evidenceId:'file-1',registrationId:'registered-file',relativePath:'assignment.txt',label:'Assignment',anchor:null,origin:'synthetic'}]})),releaseTaskEvidence:vi.fn(async()=>{}),readTaskEvidence:vi.fn(async()=>({result:{ok:true,scopeId:'evidence-1',evidenceId:'file-1',label:'Assignment',anchor:null,origin:'synthetic',sourceHash:'document-hash',observedAt:'2026-10-14T00:00:00Z',byteLength:4,content:{kind:'text',mime:'text/plain',text:'test',rendering:'plain-text',imageReferences:{targets:[],unsupportedCount:0}},verification:'not-assessed',omissions:[]}}))});
  const state=reactive({...defaultWorkspaceState(),view:'dag' as const});
  const m=mount(TaskWorkspace,{workstream:{id:'project-1',noteMapping:{state:'resolved'}},dag:{dagId:'dag-project-1',sourceHash:'hash-project-1',state:'ready',tasks,workspaceTasks:tasks,observedAt:'now'},state,active:true},{bridge});return {...m,taskState:state,pipeline,bridge};
 }
 it('retains selected detail and open document when expanded reader returns',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();
  m.click('Assignment');await settle();expect(m.find('document-viewer')).toBeDefined();
  event(m.find('document-expand')!,'onClick');await settle();expect(m.find('document-return')).toBeDefined();
  event(m.find('document-return')!,'onClick');await settle();
  expect(m.taskState.selected).toBe('A-1');expect(m.find('task-detail')).toBeDefined();expect(m.find('document-viewer')).toBeDefined();expect(m.find('document-close')).toBeDefined();
 });
 it('withdraws resumed detail and document if the fresh graph read is denied',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();m.click('Assignment');await settle();
  event(m.find('document-expand')!,'onClick');await settle();m.pipeline.read.mockRejectedValueOnce(Error('unauthorized'));
  event(m.find('document-return')!,'onClick');await settle();
  expect(m.taskState.selected).toBe('');expect(m.find('task-detail')).toBeUndefined();expect(m.find('document-viewer')).toBeUndefined();expect(m.text()).toContain('읽기 권한');
 });
 it('does not preserve an expanded document after source identity changes',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();m.click('Assignment');await settle();
  event(m.find('document-expand')!,'onClick');await settle();(m.state.dag as any).sourceHash='changed-source';await settle();
  expect(m.find('document-viewer')).toBeUndefined();expect(m.find('task-detail')).toBeUndefined();
 });

 it('does not reopen detail closed while a resumed graph read is pending',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();m.click('Assignment');await settle();
  event(m.find('document-expand')!,'onClick');await settle();
  const resumed=deferred<Awaited<ReturnType<typeof m.pipeline.read>>>();const read=m.pipeline.read.getMockImplementation()!;
  m.pipeline.read.mockImplementationOnce(()=>resumed.promise);
  event(m.find('document-return')!,'onClick');await settle();
  expect(m.find('task-detail')).toBeDefined();event(m.find('task-detail-close')!,'onClick');await settle();expect(m.taskState.selected).toBe('');
  const call=m.pipeline.read.mock.calls.at(-1)!;resumed.resolve(await read(...call));await settle();
  expect(m.taskState.selected).toBe('');expect(m.find('task-detail')).toBeUndefined();expect(m.find('document-viewer')).toBeUndefined();
 });

 it('re-admits selected detail after a same-source poll replaces the DAG and renews its session',async()=>{
  let source=snapshot();const m=parent(()=>source);await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();m.click('Assignment');await settle();
  event(m.find('document-expand')!,'onClick');await settle();event(m.find('document-return')!,'onClick');await settle();
  expect(m.find('task-detail')).toBeDefined();
  source={...source,metadata:{...source.metadata,identity:{...source.metadata.identity,sessionKey:'renewed-session'}}};
  m.state.dag={...(m.state.dag as object),observedAt:'next-poll'};liveState.value={...liveState.value!,observedAt:'next-poll'};await settle();
  expect(m.taskState.selected).toBe('A-1');expect(m.find('task-detail')).toBeDefined();expect(m.bridge.readTaskGraphDetail).toHaveBeenCalledTimes(2);expect(m.find('document-viewer')).toBeDefined();expect(m.find('document-expand')).toBeDefined();
 });

 it('conceals retained reader until document permission recheck settles, then hides denied content',async()=>{
  let source=snapshot();const m=parent(()=>source);await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();m.click('Assignment');await settle();
  const reader=m.find('document-viewer');const permission=deferred<any>();(m.bridge as any).readTaskEvidence.mockReturnValueOnce(permission.promise);
  source={...source,metadata:{...source.metadata,identity:{...source.metadata.identity,sessionKey:'renewed-session'}}};
  m.state.dag={...(m.state.dag as object),observedAt:'next-poll'};liveState.value={...liveState.value!,observedAt:'next-poll'};await settle();
  expect(m.find('document-viewer')).toBe(reader);expect(m.find('validated-detail-content')?.props.style).toEqual({visibility:'hidden'});expect(m.find('validated-detail-content')?.props.inert).toBe(true);expect(m.find('validated-detail-content')?.props['aria-hidden']).toBe(true);expect(m.find('validated-detail-content')?.style.display).not.toBe('none');
  permission.resolve({result:{ok:false,code:'permission-denied',omitted:true}});await settle();
  expect(m.taskState.selected).toBe('A-1');expect(m.find('validated-detail-content')?.props.inert).toBe(false);expect(m.find('validated-detail-content')?.props['aria-hidden']).toBeUndefined();expect(m.find('document-viewer')).toBe(reader);expect(m.text()).toContain('읽기 허용이 없습니다');expect(m.text()).not.toContain('test');
 });
 it('keeps a newer close final while document revalidation is pending',async()=>{
  let source=snapshot();const m=parent(()=>source);await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();m.click('Assignment');await settle();
  const permission=deferred<any>();(m.bridge as any).readTaskEvidence.mockReturnValueOnce(permission.promise);
  source={...source,metadata:{...source.metadata,identity:{...source.metadata.identity,sessionKey:'renewed-session'}}};m.state.dag={...(m.state.dag as object),observedAt:'next-poll'};liveState.value={...liveState.value!,observedAt:'next-poll'};await settle();
  event(m.find('task-detail-close')!,'onClick');await settle();permission.resolve({result:{ok:false,code:'permission-denied',omitted:true}});await settle();
  expect(m.taskState.selected).toBe('');expect(m.find('task-detail')).toBeUndefined();expect(m.find('document-viewer')).toBeUndefined();
 });

 it('restores expanded reading position after returning to the earlier inline detail position',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();m.click('Assignment');await settle();
  const reader=m.find('document-viewer')!,detail=m.find('task-detail')!;reader.closest=()=>detail;detail.scrollTop=700;
  const body=()=>m.all().find(n=>String(n.props.class??'').split(' ').includes('document-body'))!;
  event(m.find('document-expand')!,'onClick');await settle();body().scrollTop=2300;event(body(),'onScroll');
  event(m.find('document-return')!,'onClick');await settle();expect(detail.scrollTop).toBe(700);
  // Native overflow removal clamps the former internal scroller; its queued scroll
  // is now an inline-layout event and must not replace the expanded reading spot.
  body().scrollTop=0;event(body(),'onScroll');
  event(m.find('document-expand')!,'onClick');await settle();expect(body().scrollTop).toBe(2300);
  body().scrollTop=3100;event(body(),'onScroll');event(m.find('document-return')!,'onClick');await settle();body().scrollTop=0;event(body(),'onScroll');event(m.find('document-expand')!,'onClick');await settle();expect(body().scrollTop).toBe(3100);
  event(m.find('document-close')!,'onClick');await settle();m.click('Assignment');await settle();event(m.find('document-expand')!,'onClick');await settle();expect(body().scrollTop).toBe(0);
 });

 it('does not restore a disposed document when close follows expansion before nextTick',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();m.click('Assignment');await settle();
  event(m.find('document-expand')!,'onClick');event(m.find('document-close')!,'onClick');await settle();
  expect(m.find('document-viewer')).toBeUndefined();expect(m.find('task-detail')).toBeDefined();expect(m.taskState.selected).toBe('A-1');
 });

 it('does not reuse the old expanded offset after explicit changed-source reread',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();m.click('Assignment');await settle();
  const reader=m.find('document-viewer')!,detail=m.find('task-detail')!;reader.closest=()=>detail;
  const body=()=>m.all().find(n=>String(n.props.class??'').split(' ').includes('document-body'))!;
  event(m.find('document-expand')!,'onClick');await settle();body().scrollTop=2300;event(body(),'onScroll');event(m.find('document-return')!,'onClick');await settle();body().scrollTop=0;
  (m.bridge as any).readTaskEvidence.mockResolvedValueOnce({result:{ok:false,code:'stale-source',omitted:true}});
  event(m.find('document-recheck')!,'onClick');await settle();expect(m.find('document-reread')).toBeDefined();
  event(m.find('document-reread')!,'onClick');await settle();event(m.find('document-expand')!,'onClick');await settle();expect(body().scrollTop).toBe(0);
 });

});
