import { readFileSync } from 'node:fs';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type Component, type RenderFunction } from 'vue';
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
vi.mock('../../src/renderer/components/EvidenceViewer.vue',()=>({default:{props:['expanded'],emits:['update:expanded'],setup(props:any,{emit}:any){return()=>Vue.h('button',{onClick:()=>emit('update:expanded',!props.expanded),'data-testid':'test-evidence-expand'},props.expanded?'Return from document':'Expand document');}}}));
const pipelineFactory = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/task-graph-layout-client', () => ({ createTaskGraphLayoutPipeline: pipelineFactory }));

// Run actual production templates and setup functions in Vue's custom renderer.
// This is component/event/lifecycle coverage, not native browser, layout or pixels.
for (const [component, name] of [[GraphInfoTooltip, 'GraphInfoTooltip'], [TaskGraphOverview, 'TaskGraphOverview'], [TaskGraphWorkspace, 'TaskGraphWorkspace'],[TaskWorkspace,'TaskWorkspace']] as const) {
  const filename = new URL(`../../src/renderer/components/${name}.vue`, import.meta.url);
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
  const compiled = compileTemplate({ source: descriptor.template!.content, filename: filename.pathname, id: `${name}-test`,
    compilerOptions: { mode: 'function', hoistStatic: false, bindingMetadata: compileScript(descriptor, { id: `${name}-test` }).bindings } });
  if (compiled.errors.length) throw Error(compiled.errors.map(String).join('\n'));
  (component as unknown as { render: RenderFunction }).render = new Function('Vue', transformSync(compiled.code, { loader: 'ts', target: 'es2022' }).code)(Vue) as RenderFunction;
}

interface HostNode {
  type: string; tagName: string; parent: HostNode | null; children: HostNode[]; props: Record<string, any>; text: string;
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
  vi.stubGlobal('window', { noteApp: options.bridge, innerWidth: 1280, innerHeight: 900,
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
  return { root, body, state, doc, observers, documentListeners, windowListeners, exposed:()=>app._instance?.subTree.component?.exposed, dispatchDocument: (event: string, value?: unknown) => dispatch(documentListeners, event, value), all, find, button, unmount,
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
  return { readTaskGraphDates: vi.fn(async (request: GraphReadRequest): Promise<GraphDateReadResult> => dateResult(sourceFor(request.projectId), request.requestId)),
    cancelTaskGraphDates: vi.fn(async (_request: { requestId: string }) => {}),
    getTaskGraphSession: vi.fn(async ({ projectId }: { projectId: string }): Promise<{ projectId: string; dagId: string; sessionKey: string } | null> => { const identity = sourceFor(projectId).metadata.identity; return { projectId, dagId: identity.dagId, sessionKey: identity.sessionKey }; }) };
}
function cardButtons(mounted: ReturnType<typeof mount>): HostNode[] { return mounted.all().filter(node => node.type === 'button' && node.props.class === 'group-open'); }
function tooltipPanel(mounted: ReturnType<typeof mount>, trigger: HostNode): HostNode { return mounted.all().find(node => node.props.id === trigger.props['aria-describedby'])!; }
function event(node: HostNode, name: string, value: Record<string, unknown> = {}) { expect(node.props[name], name).toBeTypeOf('function'); node.props[name](value); }

// Dedicated T064 regression probes. Shared host duplicated temporarily to avoid
// changing the actively edited T063 component test harness.
describe('T064 recovery and interruption (production custom host, not native browser)', () => {
  it('shows loading and then an empty source without claiming a failed read', async () => {
    const pending=deferred<{snapshot:AssembledGraphSnapshot;layout:GraphLayout}>();
    const m=workspace(p=>p.read.mockReturnValueOnce(pending.promise)); await settle();
    expect(m.all().some(n=>n.props.role==='status'&&textOf(n).includes('읽고 있습니다'))).toBe(true);
    const source=snapshot('project-1',[]); pending.resolve({snapshot:source,layout:layoutGraphSnapshot(source,{grouping:'prefix',groupKey:null})}); await settle();
    expect(m.text()).toContain('확인된 작업 선언이 없습니다'); expect(m.all().filter(n=>n.props.role==='alert')).toHaveLength(0);
  });
  it.each(['resolve','reject'] as const)('ignores a late retry %s after a newer source refresh succeeds',async outcome=>{
    const pending=deferred<{snapshot:AssembledGraphSnapshot;layout:GraphLayout}>();
    const m=workspace(p=>p.read.mockRejectedValueOnce(Error('timeout')).mockReturnValueOnce(pending.promise)); await settle();
    m.click('다시 읽기'); await settle(); m.state.sourceKey='new-source'; await settle(); expect(m.find('graph-overview')).toBeDefined();
    if(outcome==='reject')pending.reject(Error('private-old-path')); else {const source=snapshot('project-1',[sourceNode('OLD-1')]);pending.resolve({snapshot:source,layout:layoutGraphSnapshot(source,{grouping:'prefix',groupKey:null})});}
    await settle(); expect(m.find('graph-overview')).toBeDefined(); expect(m.text()).not.toContain('OLD');expect(m.text()).not.toContain('private-old-path');expect(m.all().filter(n=>n.props.role==='alert')).toHaveLength(0);
  });
  it.each(['sourceKey','visibility','active','current'] as const)('does not move keyboard focus during automatic %s recovery',async change=>{
    const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();
    const outside=host('outside-control');m.doc.activeElement=outside;
    if(change==='sourceKey')m.state.sourceKey='refreshed';else if(change==='visibility'){m.visibility(true);await settle();m.visibility(false);}else{m.state[change]=false;await settle();m.state[change]=true;}
    await settle();expect(m.doc.activeElement).toBe(outside);expect(m.selected).toEqual([]);
  });
  it('dismisses and reopens tooltip repeatedly without moving focus or selecting',async()=>{
    const m=workspace();await settle();const trigger=m.all().find(n=>n.type==='button'&&String(n.props['aria-label']).startsWith('A 선언 상태'))!;
    m.doc.activeElement=trigger;
    for(let i=0;i<4;i++){event(trigger,'onFocus');await settle();expect(tooltipPanel(m,trigger).style.display).not.toBe('none');const preventDefault=vi.fn(),stopPropagation=vi.fn();event(trigger,'onKeydown',{key:'Escape',preventDefault,stopPropagation});await settle();expect(tooltipPanel(m,trigger).style.display).toBe('none');expect(m.doc.activeElement).toBe(trigger);}
    expect(m.selected).toEqual([]);expect(m.pipeline.read).toHaveBeenCalledTimes(1);
  });
  it('retains search input focus when no matches are found and does not relayout',async()=>{
    const m=workspace();await settle();const input=m.all().find(n=>n.type==='input')!;m.doc.activeElement=input;
    input.props['onUpdate:modelValue']('does-not-exist');await settle();expect(m.text()).toContain('0개 결과');expect(m.doc.activeElement).toBe(input);expect(m.pipeline.layout).not.toHaveBeenCalled();
  });
  it('announces no-match search results without requiring focus movement',async()=>{
    const m=workspace();await settle();m.all().find(n=>n.type==='input')!.props['onUpdate:modelValue']('does-not-exist');await settle();
    expect(m.all().some(n=>(n.props.role==='status'||n.props['aria-live']==='polite')&&textOf(n).includes('0개 결과'))).toBe(true);
  });
  it('announces partial source coverage while preserving admitted graph access',async()=>{
    const source=snapshot();source.metadata.coverage={state:'partial',reasons:['incomplete-read'],counts:{sourceTaskRows:4,uniqueNodes:4,uniqueEdges:3,unresolvedEdges:0}};
    const m=workspace(undefined,()=>source);await settle();expect(m.find('graph-overview')).toBeDefined();
    expect(m.all().some(n=>(n.props.role==='status'||n.props.role==='alert')&&textOf(n).includes('일부 근거만 확인됨'))).toBe(true);
  });
  it('discloses true task cycles separately from group links',async()=>{
    const source=snapshot();source.edges=[...source.edges,{id:graphEdgeId('A-2','A-1','internal'),from:{kind:'node',id:'A-2'},to:{kind:'node',id:'A-1'},scope:'internal',declarations:1}];if(source.metadata.coverage.counts)source.metadata.coverage.counts.uniqueEdges=source.edges.length;source.metadata.diagnostics.cycles=[['A-1','A-2']];
    const m=workspace(undefined,()=>source);await settle();expect(m.text()).toContain('작업 순환');expect(m.text()).toContain('A-1');expect(m.text()).toContain('A-2');
  });
  it.each(['stale-session','disconnected','unauthorized','unsupported'] as const)('provides distinct actionable %s read failure copy',async reason=>{
    const m=workspace(p=>p.read.mockRejectedValueOnce(Error(reason)));await settle();
    const expected={'stale-session':'근거가 변경','disconnected':'연결이 끊','unauthorized':'읽기 권한','unsupported':'지원 범위'}[reason];expect(m.text()).toContain(expected);expect(m.find('graph-overview')).toBeUndefined();
  });
  it('does not steal focus from the filter control when hiding a previously focused card',async()=>{
    const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();
    const card=m.all().find(n=>n.props['data-graph-task']==='A-1')!;event(card,'onFocus');await settle();m.click('필터');await settle();
    const select=m.all().find(n=>n.type==='select')!;m.doc.activeElement=select;select.props['onUpdate:modelValue']('status:deferred');await settle();
    expect(m.doc.activeElement===select).toBe(true);
  });
  it('cancels a drag across background/resume instead of applying a stale pointer move',async()=>{
    const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();let pane=m.all().find(n=>n.props.class==='continuous-pane')!;
    event(pane,'onPointerdown',{button:0,pointerId:7,clientX:500,clientY:300});m.visibility(true);await settle();m.visibility(false);await settle();
    pane=m.all().find(n=>n.props.class==='continuous-pane')!;const left=pane.scrollLeft,top=pane.scrollTop;
    event(pane,'onPointermove',{pointerId:7,clientX:200,clientY:100,preventDefault:vi.fn()});await settle();expect([pane.scrollLeft,pane.scrollTop]).toEqual([left,top]);
  });

  it('announces empty source and date-read failure without exposing private error text',async()=>{
    const m=workspace((_p,b)=>b.readTaskGraphDates.mockRejectedValueOnce(Error('private-path')),()=>snapshot('project-1',[]));await settle();
    expect(m.all().some(n=>n.props.role==='status'&&textOf(n).includes('확인된 작업 선언이 없습니다'))).toBe(true);
    expect(m.all().some(n=>n.props.role==='status'&&textOf(n).includes('연결 커밋 날짜 근거를 확인하지 못했습니다'))).toBe(true);expect(m.text()).not.toContain('private-path');
  });
  it('does not present bidirectional group links as a task cycle',async()=>{
    const source=snapshot('project-1',[sourceNode('A-1'),sourceNode('A-2'),sourceNode('B-1'),sourceNode('B-2')]);
    source.edges=[['A-1','B-1'],['B-2','A-2']].map(([from,to])=>({id:graphEdgeId(from,to,'internal'),from:{kind:'node' as const,id:from},to:{kind:'node' as const,id:to},scope:'internal' as const,declarations:1}));
    const m=workspace(undefined,()=>source);await settle();expect(m.text()).toContain('그룹 집계');expect(m.text()).not.toContain('작업 순환');
  });
  it('allows only the latest repeated retry to publish',async()=>{
    const older=deferred<{snapshot:AssembledGraphSnapshot;layout:GraphLayout}>(),newer=deferred<{snapshot:AssembledGraphSnapshot;layout:GraphLayout}>();
    const m=workspace(p=>p.read.mockRejectedValueOnce(Error('timeout')).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise));await settle();
    const retry=m.button('다시 읽기');event(retry,'onClick');event(retry,'onClick');await settle();
    const source=snapshot();newer.resolve({snapshot:source,layout:layoutGraphSnapshot(source,{grouping:'prefix',groupKey:null})});await settle();
    const stale=snapshot('project-1',[sourceNode('OBSOLETE-1')]);older.resolve({snapshot:stale,layout:layoutGraphSnapshot(stale,{grouping:'prefix',groupKey:null})});await settle();
    expect(m.find('graph-overview')).toBeDefined();expect(m.text()).not.toContain('OBSOLETE');expect(m.bridge.readTaskGraphDates).toHaveBeenCalledTimes(1);
  });

  it('gives a new keyboard focus priority over a stationary pointer on another card',async()=>{
    const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();
    const first=m.all().find(n=>n.props['data-graph-task']==='A-1')!,second=m.all().find(n=>n.props['data-graph-task']==='A-2')!;
    event(first,'onMouseenter');await settle();event(second,'onFocus');await settle();expect(String(second.props.class)).toContain('relation-anchor');expect(String(first.props.class)).not.toContain('relation-anchor');expect(m.selected).toEqual([]);
  });
  it('bounds large cycle evidence to 20 IDs and makes later members reachable',async()=>{
    const nodes=Array.from({length:45},(_,i)=>sourceNode('C-'+String(i+1).padStart(2,'0'))),source=snapshot('project-1',nodes);
    source.edges=nodes.map((node,i)=>{const to=nodes[(i+1)%nodes.length].id;return {id:graphEdgeId(node.id,to,'internal'),from:{kind:'node' as const,id:node.id},to:{kind:'node' as const,id:to},scope:'internal' as const,declarations:1};});source.metadata.diagnostics.cycles=[nodes.map(n=>n.id)];
    const m=workspace(undefined,()=>source);await settle();const cycle=m.all().find(n=>n.props['aria-label']==='실제 작업 순환 근거')!;
    expect(textOf(cycle)).toContain('C-20');expect(textOf(cycle)).not.toContain('C-21');m.click('다음 순환 작업');await settle();expect(textOf(cycle)).toContain('C-21');expect(textOf(cycle)).not.toContain('C-01');m.click('다음 순환 작업');await settle();expect(textOf(cycle)).toContain('C-45');expect(m.button('다음 순환 작업').props.disabled).toBe(true);
  });

  it('restores anchor focus without reopening relation highlights when Escape removes a focused boundary chip',async()=>{
    const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();const anchor=m.all().find(n=>n.props['data-graph-task']==='A-2')!;
    event(anchor,'onFocus');await settle();const chip=m.all().find(n=>n.type==='button'&&textOf(n).includes('후속 B-1'))!;expect(chip).toBeDefined();
    Object.assign(chip,{closest:()=>chip.parent});m.doc.activeElement=chip;vi.mocked(anchor.focus).mockImplementation(()=>{m.doc.activeElement=anchor;event(anchor,'onFocus');});
    event(m.find('complete-task-graph')!,'onKeydown',{key:'Escape',preventDefault:vi.fn(),stopPropagation:vi.fn()});await settle();
    expect(m.doc.activeElement===anchor).toBe(true);expect(String(anchor.props.class)).not.toContain('relation-anchor');expect(m.all().some(n=>String(n.props.class)==='boundary-relations')).toBe(false);expect(m.selected).toEqual([]);
  });

  it('restores anchor focus when Escape removes the transient full-relations toolbar button',async()=>{
    const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();const anchor=m.all().find(n=>n.props['data-graph-task']==='A-2')!;
    event(anchor,'onFocus');await settle();const control=m.button('전체 직접 관계');Object.assign(control,{closest:(selector:string)=>selector.includes('[data-relation-dismiss-focus]')?control:null});m.doc.activeElement=control;
    vi.mocked(anchor.focus).mockImplementation(()=>{m.doc.activeElement=anchor;event(anchor,'onFocus');});event(m.find('complete-task-graph')!,'onKeydown',{key:'Escape',preventDefault:vi.fn(),stopPropagation:vi.fn()});await settle();
    expect(m.doc.activeElement===anchor).toBe(true);expect(String(anchor.props.class)).not.toContain('relation-anchor');expect(m.all().some(n=>n.type==='button'&&textOf(n)==='전체 직접 관계')).toBe(false);
  });

  it('counts a self-edge once while exposing both predecessor and successor roles',async()=>{
    const source=snapshot('project-1',[sourceNode('A-1')]);source.edges=[{id:graphEdgeId('A-1','A-1','internal'),from:{kind:'node',id:'A-1'},to:{kind:'node',id:'A-1'},scope:'internal',declarations:1}];
    const m=workspace(undefined,()=>source);await settle();m.click('A 그룹 1개 작업 열기');await settle();event(m.all().find(n=>n.props['data-graph-task']==='A-1')!,'onFocus');await settle();m.click('전체 직접 관계');await settle();
    const list=m.all().find(n=>n.props['aria-label']==='작업 전체 직접 관계')!;expect(textOf(list)).toContain('A-1 직접 관계 1개');expect(textOf(list)).toContain('역할 항목 2개');
  });

  it('returns detail focus to a clearly labelled filter-exception card then removes it on blur',async()=>{
    const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('필터');await settle();const select=m.all().find(n=>n.type==='select')!;
    select.props['onUpdate:modelValue']('status:deferred');await settle();expect(m.all().some(n=>n.props['data-graph-task']==='A-1')).toBe(false);
    const pane=m.all().find(n=>n.props.class==='continuous-pane')!;const before=[pane.scrollLeft,pane.scrollTop];await m.exposed()!.focusOnly('A-1');await settle();
    const card=m.all().find(n=>n.props['data-graph-task']==='A-1')!;expect(card).toBeDefined();expect(m.doc.activeElement===card).toBe(true);expect(card.props['aria-description']).toContain('현재 필터 밖');expect([pane.scrollLeft,pane.scrollTop]).toEqual(before);expect(m.text()).toContain('필터 숨김 1개');
    m.doc.activeElement=select;event(card,'onBlur',{relatedTarget:select});await settle();expect(m.all().some(n=>n.props['data-graph-task']==='A-1')).toBe(false);expect(m.doc.activeElement===select).toBe(true);
  });

  it.each([
    ['timeout', '전체 그래프를 읽는 시간이 초과되었습니다. 연결과 소스를 확인한 뒤 다시 읽어 주세요.'],
    ['invalid-schema', '그래프 응답을 검증하지 못했습니다. 최신 근거를 다시 읽어 주세요.'],
    ['invalid-result', '그래프 응답을 검증하지 못했습니다. 최신 근거를 다시 읽어 주세요.'],
    ['worker-unavailable', '그래프 계산을 완료하지 못했습니다. 다시 읽어 주세요.'],
    ['layout-failed', '그래프 계산을 완료하지 못했습니다. 다시 읽어 주세요.'],
  ])('renders exact allowlisted %s copy and successfully retries', async (reason, copy) => {
    const m = workspace(p => p.read.mockRejectedValueOnce(Error(reason)));
    await settle();
    const alerts = m.all().filter(n => n.props.role === 'alert');
    expect(alerts).toHaveLength(1);
    expect(textOf(alerts[0])).toBe(copy + ' 다시 읽기');
    expect(m.find('graph-overview')).toBeUndefined();
    expect(m.bridge.readTaskGraphDates).not.toHaveBeenCalled();
    m.click('다시 읽기'); await settle();
    expect(m.find('graph-overview')).toBeDefined();
    expect(m.all().filter(n => n.props.role === 'alert')).toHaveLength(0);
    expect(m.pipeline.read).toHaveBeenCalledTimes(2);
  });

  it.each(['worker-unavailable', 'layout-failed'])('handles %s during group projection with calculation-specific recovery', async reason => {
    const m = workspace(); await settle();
    m.pipeline.layout.mockRejectedValueOnce(Error(reason));
    m.click('A 그룹 2개 작업 열기'); await settle();
    expect(m.text()).toContain('그래프 계산을 완료하지 못했습니다. 다시 읽어 주세요.');
    expect(m.find('continuous-group-graph')).toBeUndefined();
    m.click('다시 읽기'); await settle();
    expect(m.find('graph-overview')).toBeDefined();
    expect(m.all().filter(n => n.props.role === 'alert')).toHaveLength(0);
  });

  it('navigates all SCCs in both directions, resets member paging and resets on source replacement', async () => {
    const cycles = ['C', 'D', 'E'].map(prefix => Array.from({ length: 23 }, (_, i) => prefix + '-' + String(i + 1).padStart(2, '0')));
    const source = snapshot('project-1', cycles.flat().map(id => sourceNode(id)));
    source.edges = cycles.flatMap(ids => ids.map((id, i) => ({ id: graphEdgeId(id, ids[(i + 1) % ids.length], 'internal'), from: {kind: 'node' as const, id}, to: {kind: 'node' as const, id: ids[(i + 1) % ids.length]}, scope: 'internal' as const, declarations: 1 })));
    source.metadata.diagnostics.cycles = cycles;
    const m = workspace(undefined, () => source); await settle();
    const evidence = () => textOf(m.all().find(n => n.props['aria-label'] === '실제 작업 순환 근거')!);
    expect(m.button('이전 순환').props.disabled).toBe(true);
    for (const [index, prefix] of ['C', 'D', 'E'].entries()) {
      expect(evidence()).toContain('순환 ' + (index + 1) + ' / 3');
      expect(evidence()).toContain(prefix + '-01');
      expect(evidence()).not.toContain(prefix + '-21');
      expect(m.button('이전 순환 작업').props.disabled).toBe(true);
      m.click('다음 순환 작업'); await settle();
      expect(evidence()).toContain(prefix + '-23');
      expect(evidence()).not.toContain(prefix + '-01');
      expect(m.button('다음 순환 작업').props.disabled).toBe(true);
      if (index < 2) { m.click('다음 순환'); await settle(); }
    }
    expect(m.button('다음 순환').props.disabled).toBe(true);
    for (const prefix of ['D', 'C']) {
      m.click('이전 순환'); await settle();
      expect(evidence()).toContain(prefix + '-01');
      expect(m.button('이전 순환 작업').props.disabled).toBe(true);
    }
    m.click('다음 순환'); await settle(); m.click('다음 순환 작업'); await settle();
    m.state.sourceKey = 'replacement'; await settle();
    expect(evidence()).toContain('순환 1 / 3'); expect(evidence()).toContain('C-01');
    expect(m.button('이전 순환').props.disabled).toBe(true);
    expect(m.button('이전 순환 작업').props.disabled).toBe(true);
  });

  it.each(['resolve', 'reject'] as const)('does not write an obsolete relation origin after deferred follow %s and same-ID source replacement', async outcome => {
    let source = snapshot();
    const m = workspace(undefined, () => source); await settle();
    m.click('A 그룹 2개 작업 열기'); await settle();
    event(m.all().find(n => n.props['data-graph-task'] === 'A-2')!, 'onFocus'); await settle();
    m.click('전체 직접 관계'); await settle();
    const pending = deferred<GraphLayout>(), oldSource = source;
    m.pipeline.layout.mockReturnValueOnce(pending.promise);
    m.click('B-1로 이동'); await settle();
    expect(m.pipeline.layout).toHaveBeenLastCalledWith(oldSource, expect.objectContaining({ groupKey: graphGroupKey(sourceNode('B-1'), 'prefix') }));
    source = snapshot();
    source.metadata.identity = { ...source.metadata.identity, sourceHash: 'replacement-hash', revision: 'replacement-revision' };
    m.state.sourceKey = 'replacement'; await settle();
    // Explicit new navigation reaches the same target ID in the replacement source.
    const input = m.all().find(n => n.type === 'input')!;
    input.props['onUpdate:modelValue']('B-1'); await settle();
    m.click('B-1 · Source title B-1'); await settle();
    const target = m.all().find(n => n.props['data-graph-task'] === 'B-1')!;
    expect(target).toBeDefined(); expect(m.doc.activeElement).toBe(target);
    if (outcome === 'resolve') pending.resolve(layoutGraphSnapshot(oldSource, {grouping: 'prefix', groupKey: graphGroupKey(sourceNode('B-1'), 'prefix')}));
    else pending.reject(Error('obsolete-private-path'));
    await settle();
    expect(m.doc.activeElement).toBe(target);
    expect(m.all().some(n => n.type === 'button' && textOf(n) === '이전 관계 위치로')).toBe(false);
    expect(m.all().filter(n => n.props.role === 'alert')).toHaveLength(0);
    expect(m.text()).not.toContain('obsolete-private-path'); expect(m.selected).toEqual([]);
    // A current follow still records the current B origin and returns to it.
    event(target, 'onFocus'); await settle();
    if (!m.button('전체 직접 관계').props['aria-expanded']) { m.click('전체 직접 관계'); await settle(); }
    m.click('A-2로 이동'); await settle(); m.click('이전 관계 위치로'); await settle();
    expect(m.doc.activeElement?.props['data-graph-task']).toBe('B-1');
    expect(m.selected).toEqual([]);
  });

  it('resets a no-match status filter without relayout or selection', async () => {
    const m = workspace(); await settle(); m.click('A 그룹 2개 작업 열기'); await settle();
    m.click('필터'); await settle();
    const select = m.all().find(n => n.type === 'select')!;
    select.props['onUpdate:modelValue']('status:done'); await settle();
    expect(m.text()).toContain('현재 상태 필터에 맞는 작업이 없습니다.');
    expect(m.all().filter(n => n.props['data-graph-task'])).toHaveLength(0);
    const layouts = m.pipeline.layout.mock.calls.length;
    m.click('필터 초기화'); await settle();
    expect(m.all().filter(n => n.props['data-graph-task']).map(n => n.props['data-graph-task']).sort()).toEqual(['A-1', 'A-2']);
    expect(m.text()).not.toContain('현재 상태 필터에 맞는 작업이 없습니다.');
    expect(m.pipeline.layout).toHaveBeenCalledTimes(layouts); expect(m.selected).toEqual([]);
  });

  it.each([false, true])('dismisses a focused full-relations item with pane fallback=%s', async fallback => {
    const m = workspace(undefined, snapshot, fallback ? {selectedId: 'B-1'} : {}); await settle();
    m.click('A 그룹 2개 작업 열기'); await settle();
    const anchor = m.all().find(n => n.props['data-graph-task'] === 'A-2')!;
    if (!fallback) { event(anchor, 'onFocus'); await settle(); }
    m.click('전체 직접 관계'); await settle();
    const list = m.all().find(n => n.props['aria-label'] === '작업 전체 직접 관계')!;
    const item = descendants(list).find(n => n.type === 'button')!;
    expect(item).toBeDefined();
    Object.assign(item, {closest: (selector: string) => selector.includes('.density-relations') ? list : null});
    m.doc.activeElement = item;
    const pane = m.all().find(n => n.props.class === 'continuous-pane')!;
    vi.mocked(anchor.focus).mockImplementation(() => {m.doc.activeElement = anchor; event(anchor, 'onFocus');});
    const preventDefault = vi.fn(), stopPropagation = vi.fn();
    event(m.find('complete-task-graph')!, 'onKeydown', {key: 'Escape', preventDefault, stopPropagation}); await settle();
    expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce();
    expect(m.doc.activeElement).toBe(fallback ? pane : anchor);
    expect(m.all().some(n => n.props['aria-label'] === '작업 전체 직접 관계')).toBe(false);
    expect(String(anchor.props.class)).not.toContain('relation-anchor'); expect(m.selected).toEqual([]);
  });

});
