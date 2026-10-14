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

describe('graph overview production components (custom host, not native browser)', () => {
  it('renders every source count beyond page limits, with source order and complete aggregate relations', async () => {
    const nodes = [sourceNode('Z-1'), ...Array.from({ length: 1000 }, (_, i) => sourceNode(`A-${i + 1}`, i === 999 ? 'running' : 'done'))];
    const source = snapshot('large-project', nodes), layout = layoutGraphSnapshot(source, { grouping: 'prefix', groupKey: graphGroupKey(nodes[0], 'prefix') });
    expect(layout.nodes).toHaveLength(1);
    const opened: string[] = [], m = mount(TaskGraphOverview, { layout, dates: dateResult(source, 'overview'), orderedGroupKeys: nodes.map(node => graphGroupKey(node, 'prefix')), onOpenGroup: (key: string) => opened.push(key) });
    await settle();
    expect(m.text()).toContain('2그룹 · 1001개 작업');
    expect(cardButtons(m).map(textOf)).toEqual(['Z1개 작업내부 관계 0', 'A1000개 작업내부 관계 0']);
    m.click('A 그룹 1000개 작업 열기'); expect(opened).toEqual([graphGroupKey(nodes[1], 'prefix')]);
    const status = m.button('A 선언 상태, 총 1000개. 완료 999, 실행 중 1'); event(status, 'onFocus'); await settle();
    expect(m.text()).toContain('완료 999'); expect(m.text()).toContain('실행 중 1'); expect(m.text()).toContain('선언 상태 · 실행 검증 결과 아님');
  });

  it('keeps date-only card labels and exposes exact KST time, SHA, repository and source URL in the date tooltip', async () => {
    const source = snapshot(), layout = layoutGraphSnapshot(source, { grouping: 'prefix', groupKey: null });
    const m = mount(TaskGraphOverview, { layout, dates: dateResult(source, 'overview') }); await settle();
    const date = m.button('A 최근 연결 커밋 날짜 01.01');
    expect(textOf(date).trim()).toBe('01.01'); expect(m.text()).toContain('2027'); expect(m.text()).not.toContain('01:01:02'); expect(m.text()).not.toContain('2099');
    event(date, 'onFocus'); await settle(); const panel = tooltipPanel(m, date);
    expect(panel.props.role).toBe('tooltip'); expect(panel.style.display).not.toBe('none');
    expect(textOf(panel)).toContain('2027.01.01 01:01:02 KST'); expect(textOf(panel)).toContain('A-1 · ' + 'a'.repeat(40));
    expect(textOf(panel)).toContain('github.com/synthetic/graph-source'); expect(textOf(panel)).toContain('https://github.com/synthetic/graph-source/commit/' + 'a'.repeat(40));
    expect(textOf(panel)).toContain('날짜 확인 2/2개'); expect(textOf(panel)).toContain('참조 확인 2/2개'); expect(textOf(panel)).toContain('작업일·완료일 아님');
  });

  it('preserves cross-year context and unavailable date claims without borrowing the graph-wide date', async () => {
    const source = snapshot(), result = dateResult(source, 'overview');
    result.tasks = result.tasks.map(task => task.id === 'B-1' ? { ...task, summary: resolved(task.id, '2025-01-01T00:00:00Z') } : task);
    const m = mount(TaskGraphOverview, { layout: layoutGraphSnapshot(source, { grouping: 'prefix', groupKey: null }), dates: result }); await settle();
    expect(textOf(m.button('A 최근 연결 커밋 날짜 2027.01.01')).trim()).toBe('2027.01.01');
    expect(textOf(m.button('B 최근 연결 커밋 날짜 2025.01.01')).trim()).toBe('2025.01.01');
    m.state.dates = null; await settle(); const trigger = m.button('A 최근 연결 커밋 날짜 미확인'); event(trigger, 'onMouseenter'); await settle();
    expect(m.text()).toContain('날짜 근거를 확인하지 못했습니다'); expect(m.text()).not.toContain('2099'); expect(m.text()).not.toContain('2027.01.01');
  });

  it('keeps arbitrary source declarations literal and undeclared status distinct', async () => {
    const nodes = [sourceNode('A-1', 'custom-review'), sourceNode('A-2', null), sourceNode('a-1', 'DONE')], source = snapshot('literal', nodes);
    const m = mount(TaskGraphOverview, { layout: layoutGraphSnapshot(source, { grouping: 'prefix', groupKey: null }), dates: null }); await settle();
    expect(cardButtons(m).map(node => node.props['aria-label'])).toEqual(['A 그룹 2개 작업 열기', 'a 그룹 1개 작업 열기']);
    event(m.button('A 선언 상태, 총 2개. 미선언 1, custom-review 1'), 'onFocus'); await settle();
    expect(m.text()).toContain('custom-review 1'); expect(m.text()).toContain('미선언 1'); expect(m.text()).not.toContain('완료');
  });
});

describe('graph info tooltip production events (custom host, not native browser)', () => {
  it.each(['status', 'date'] as const)('opens %s details by focus or hover, keeps pointer travel usable and dismisses Escape', async kind => {
    vi.useFakeTimers();
    const m = mount(GraphInfoTooltip, { label: `Synthetic ${kind}`, kind }, { slots: { default: () => 'Short label', content: () => h('p', 'Evidence detail') } });
    const trigger = m.button(`Synthetic ${kind}`), panel = tooltipPanel(m, trigger);
    expect(panel.style.display).toBe('none'); expect(m.text()).not.toContain('Evidence detail');
    m.doc.activeElement = trigger; event(trigger, 'onFocus'); await settle(); expect(panel.style.display).not.toBe('none');
    event(trigger, 'onMouseleave'); vi.advanceTimersByTime(200); await settle(); expect(panel.style.display).not.toBe('none');
    const preventDefault = vi.fn(), stopPropagation = vi.fn(); event(trigger, 'onKeydown', { key: 'Escape', preventDefault, stopPropagation }); await settle();
    expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce(); expect(panel.style.display).toBe('none');
    m.doc.activeElement = null; event(trigger, 'onMouseenter'); await settle(); event(trigger, 'onMouseleave'); vi.advanceTimersByTime(100); event(panel, 'onMouseenter'); vi.advanceTimersByTime(200); await settle();
    expect(panel.style.display).not.toBe('none'); event(panel, 'onMouseleave'); vi.advanceTimersByTime(200); await settle(); expect(panel.style.display).toBe('none');
    event(trigger, 'onFocus'); await settle(); event(trigger, 'onBlur'); vi.advanceTimersByTime(200); await settle(); expect(panel.style.display).toBe('none');
    event(trigger, 'onClick', { detail: 0 }); await settle(); expect(panel.style.display).not.toBe('none');
    event(panel, 'onKeydown', { key: 'Escape', preventDefault, stopPropagation }); await settle(); expect(panel.style.display).toBe('none');
    event(trigger, 'onMouseenter'); event(trigger, 'onMouseleave'); m.unmount(); expect(vi.getTimerCount()).toBe(0); expect(m.body.children).toHaveLength(0);
  });

  it('keeps focus-to-panel pointer travel open and closes only on outside pointer, document Escape, or a second touch', async () => {
    vi.useFakeTimers();
    const m = mount(GraphInfoTooltip, { label: 'Date details', kind: 'date' }, { slots: { default: () => '01.01', content: () => h('span', 'Exact source') } });
    const trigger = m.button('Date details'), panel = tooltipPanel(m, trigger);
    event(trigger, 'onFocus'); await settle(); event(trigger, 'onBlur'); vi.advanceTimersByTime(100); event(panel, 'onMouseenter'); vi.advanceTimersByTime(200); await settle();
    expect(panel.style.display).not.toBe('none');
    m.dispatchDocument('pointerdown', { target: panel.children[0] }); await settle(); expect(panel.style.display).not.toBe('none');
    m.dispatchDocument('pointerdown', { target: host('outside') }); await settle(); expect(panel.style.display).toBe('none');
    event(trigger, 'onMouseenter'); await settle();
    const preventDefault = vi.fn(), stopPropagation = vi.fn(); m.dispatchDocument('keydown', { key: 'Escape', preventDefault, stopPropagation }); await settle();
    expect(panel.style.display).toBe('none'); expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce();
    event(trigger, 'onPointerdown', { pointerType: 'touch' }); event(trigger, 'onFocus'); event(trigger, 'onClick', { detail: 1 }); await settle();
    expect(panel.style.display).not.toBe('none'); event(trigger, 'onPointerdown', { pointerType: 'touch' }); event(trigger, 'onClick', { detail: 1 }); await settle(); expect(panel.style.display).toBe('none');
    m.unmount(); expect(m.documentListeners.size).toBe(0); expect(m.windowListeners.size).toBe(0);
  });

  it('gives one tooltip ownership at a time and handles document Escape only once', async () => {
    const source = snapshot(), m = mount(TaskGraphOverview, { layout: layoutGraphSnapshot(source, { grouping: 'prefix', groupKey: null }), dates: dateResult(source, 'overview') }); await settle();
    const first = m.button('A 최근 연결 커밋 날짜 01.01'), second = m.button('B 선언 상태, 총 1개. 완료 1');
    event(first, 'onFocus'); await settle(); expect(tooltipPanel(m, first).style.display).not.toBe('none');
    event(second, 'onMouseenter'); await settle(); expect(tooltipPanel(m, first).style.display).toBe('none'); expect(tooltipPanel(m, second).style.display).not.toBe('none');
    expect(m.all().filter(node => node.props.role === 'tooltip' && node.style.display !== 'none')).toHaveLength(1);
    const preventDefault = vi.fn(), stopPropagation = vi.fn(); m.dispatchDocument('keydown', { key: 'Escape', preventDefault, stopPropagation }); await settle();
    expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce();
    expect(m.all().filter(node => node.props.role === 'tooltip' && node.style.display !== 'none')).toHaveLength(0);
    event(first, 'onFocus'); await settle(); m.unmount(); expect(m.documentListeners.size).toBe(0); expect(m.windowListeners.size).toBe(0);
  });
});

describe('task graph workspace production navigation (custom host, not native browser)', () => {
  it('reads full source once, preserves source order, switches prefix/phase/ungrouped and opens/backtracks without selecting a task', async () => {
    const m = workspace(); await settle();
    expect(m.pipeline.read).toHaveBeenCalledExactlyOnceWith('project-1', { grouping: 'prefix', groupKey: null, previous: undefined });
    expect(cardButtons(m).map(node => node.props['aria-label'])).toEqual(['B 그룹 1개 작업 열기', 'A 그룹 2개 작업 열기', '접두사 미분류 그룹 1개 작업 열기']);
    expect(m.text()).toContain('3그룹 · 4개 작업'); expect(m.text()).toContain('그룹 간 관계 2');
    m.click('A 그룹 2개 작업 열기'); await settle(); expect(m.find('continuous-group-graph')).toBeDefined(); expect(m.find('graph-overview')).toBeUndefined();
    expect(m.opened).toEqual([[graphGroupKey(sourceNode('A-1'), 'prefix'), 'prefix']]); expect(m.selected).toEqual([]);
    expect(m.text()).toContain('Source title A-1'); expect(m.text()).toContain('Source title A-2');
    m.click('A-1 Source title A-1 선언 상태 pending 상세 열기'); expect(m.selected).toEqual(['A-1']);
    m.click('‹ 전체'); await settle(); expect(m.find('graph-overview')).toBeDefined(); expect(m.opened.at(-1)).toEqual([null, 'prefix']);
    m.click('Phase'); await settle(); expect(m.button('Phase').props['aria-pressed']).toBe(true);
    expect(cardButtons(m).map(node => node.props['aria-label'])).toEqual(['Source phase 0 그룹 2개 작업 열기', 'Source phase 1 그룹 2개 작업 열기']);
    m.click('Source phase 1 그룹 2개 작업 열기'); await settle(); expect(m.opened.at(-1)).toEqual([graphGroupKey(sourceNode('A-2', 'deferred', 1), 'phase'), 'phase']);
    m.click('묶지 않음'); await settle(); expect(m.find('graph-overview')).toBeDefined(); expect(cardButtons(m).map(node => node.props['aria-label'])).toEqual(['전체 작업 그룹 4개 작업 열기']);
    m.click('전체 작업 그룹 4개 작업 열기'); await settle(); expect(m.opened.at(-1)).toEqual(['["ungrouped"]', 'ungrouped']);
    m.click('접두사'); await settle(); expect(m.text()).toContain('3그룹 · 4개 작업'); expect(m.pipeline.read).toHaveBeenCalledTimes(1);
    expect(m.bridge.readTaskGraphDates).toHaveBeenCalledTimes(1);
  });

  it('uses full-source search to reveal a task outside the opened group and emits selection only on its task button', async () => {
    const m = workspace(); await settle(); m.click('B 그룹 1개 작업 열기'); await settle();
    const input = m.all().find(node => node.type === 'input')!; input.props['onUpdate:modelValue']('A-2'); await settle();
    expect(m.text()).toContain('1개 결과'); m.click('A-2 · Source title A-2'); await settle();
    expect(m.opened.at(-1)?.[0]).toBe(graphGroupKey(sourceNode('A-2'), 'prefix')); expect(m.selected).toEqual([]);
    expect(m.text()).not.toContain('1개 결과'); expect(m.button('A-2 Source title A-2 선언 상태 deferred 상세 열기').focus).toHaveBeenCalledOnce();
  });

  it('labels partial source coverage and retries a failed full-source read without exposing error internals', async () => {
    const m = workspace(pipeline => pipeline.read.mockRejectedValueOnce(Error('secret path must not appear'))); await settle();
    expect(m.text()).toContain('전체 그래프를 읽지 못했습니다'); expect(m.text()).not.toContain('secret path'); m.click('다시 읽기'); await settle(); expect(m.find('graph-overview')).toBeDefined();
    const partial = snapshot(); partial.metadata.coverage = { state: 'partial', reasons: ['incomplete-read'], counts: { sourceTaskRows: null, uniqueNodes: 4, uniqueEdges: 3, unresolvedEdges: 0 } };
    m.pipeline.read.mockResolvedValueOnce({ snapshot: partial, layout: layoutGraphSnapshot(partial, { grouping: 'prefix', groupKey: null }) }); m.state.sourceKey = 'partial'; await settle();
    expect(m.text()).toContain('일부 근거만 확인됨'); expect(m.text()).toContain('표시 집계가 전체 작업을 뜻하지 않습니다');
  });

  it.each(['sourceKey', 'current', 'active', 'visibility'] as const)('restores group, zoom and scroll after a same-project %s interruption', async changed => {
    const m = workspace(); await settle(); m.click('A 그룹 2개 작업 열기'); await settle(); m.click('그래프 확대'); await settle();
    const pane = m.all().find(node => node.props.class === 'continuous-pane')!; pane.scrollTo({ left: 31, top: 42 }); event(pane, 'onScroll');
    const previous = m.pipeline.layout.mock.results[0].value; const priorLayout = await previous;
    if (changed === 'sourceKey') m.state.sourceKey = 'refreshed'; else if (changed === 'visibility') m.visibility(true); else m.state[changed] = false;
    await settle();
    if (changed !== 'sourceKey') {
      expect(m.find('continuous-group-graph')).toBeUndefined(); expect(m.text()).not.toContain('Source title A-1');
      if (changed === 'visibility') m.visibility(false); else m.state[changed] = true; await settle();
    }
    expect(m.find('continuous-group-graph')).toBeDefined(); expect(m.button('125%')).toBeDefined();
    expect(m.pipeline.read.mock.calls.at(-1)?.[1]).toMatchObject({ grouping: 'prefix', groupKey: graphGroupKey(sourceNode('A-1'), 'prefix'), previous: expect.objectContaining({identity:expect.objectContaining({projectId:priorLayout.identity.projectId,dagId:priorLayout.identity.dagId,sessionKey:''}),positionById:priorLayout.positionById,index:expect.objectContaining({nodeById:new Map()})}) });
    const restored = m.all().find(node => node.props.class === 'continuous-pane')!;
    expect(restored.scrollTo).toHaveBeenLastCalledWith({ left: 31, top: 42 }); expect(restored.scrollLeft).toBe(31); expect(restored.scrollTop).toBe(42);
  });

  it('returns to the overview when the saved group disappears from refreshed source', async () => {
    let latest = snapshot(); const m = workspace(undefined, () => latest); await settle(); m.click('A 그룹 2개 작업 열기'); await settle();
    latest = snapshot('project-1', [sourceNode('B-1'), sourceNode('B-2')]); m.state.sourceKey = 'group-removed'; await settle();
    expect(m.find('graph-overview')).toBeDefined(); expect(m.find('continuous-group-graph')).toBeUndefined();
    expect(cardButtons(m).map(node => node.props['aria-label'])).toEqual(['B 그룹 2개 작업 열기']); expect(m.text()).not.toContain('Source title A-1');
    expect(m.pipeline.layout).toHaveBeenLastCalledWith(latest, { grouping: 'prefix', groupKey: null });
  });

  it('resets phase selection and saved view when the project changes', async () => {
    const m = workspace(); await settle(); m.click('Phase'); await settle(); m.click('Source phase 1 그룹 2개 작업 열기'); await settle(); m.click('그래프 확대'); await settle();
    m.state.projectId = 'project-2'; await settle();
    expect(m.button('접두사').props['aria-pressed']).toBe(true); expect(m.find('graph-overview')).toBeDefined();
    expect(m.pipeline.read).toHaveBeenLastCalledWith('project-2', { grouping: 'prefix', groupKey: null, previous: undefined });
    m.click('B 그룹 1개 작업 열기'); await settle(); expect(m.button('100%')).toBeDefined();
  });

  it('resets the saved group, phase, zoom and pan for another DAG within the same project', async () => {
    let latest = snapshot(); const m = workspace(undefined, () => latest); await settle();
    m.state.dagId = latest.metadata.identity.dagId; await settle(); m.click('Phase'); await settle();
    m.click('Source phase 1 그룹 2개 작업 열기'); await settle(); m.click('그래프 확대'); await settle();
    m.all().find(node => node.props.class === 'continuous-pane')!.scrollTo({ left: 23, top: 45 });
    latest = { ...latest, metadata: { ...latest.metadata, identity: { ...latest.metadata.identity, dagId: 'another-dag', sessionKey: 'another-session', revision: 'another-revision' } } };
    m.state.dagId = 'another-dag'; await settle();
    expect(m.find('graph-overview')).toBeDefined(); expect(m.button('접두사').props['aria-pressed']).toBe(true);
    expect(m.pipeline.read).toHaveBeenLastCalledWith('project-1', { grouping: 'prefix', groupKey: null, previous: undefined });
    m.click('A 그룹 2개 작업 열기'); await settle(); expect(m.button('100%')).toBeDefined();
    expect(m.all().find(node => node.props.class === 'continuous-pane')!.scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 0 });
  });
});

describe('task graph workspace interrupted reads (custom host, not native browser)', () => {
  it.each(['projectId', 'sourceKey', 'current', 'active', 'visibility', 'unmount'] as const)('discards a late graph read after %s changes', async changed => {
    const stale = deferred<{ snapshot: AssembledGraphSnapshot; layout: GraphLayout }>();
    const m = workspace(pipeline => pipeline.read.mockReturnValueOnce(stale.promise)); await settle();
    expect(m.bridge.readTaskGraphDates).not.toHaveBeenCalled();
    if (changed === 'projectId') m.state.projectId = 'project-2'; else if (changed === 'sourceKey') m.state.sourceKey = 'basis-2';
    else if (changed === 'current' || changed === 'active') m.state[changed] = false;
    else if (changed === 'visibility') m.visibility(true); else m.unmount(); await settle();
    const reads = m.bridge.readTaskGraphDates.mock.calls.length, source = snapshot('obsolete', [sourceNode('OLD-1')]);
    stale.resolve({ snapshot: source, layout: layoutGraphSnapshot(source, { grouping: 'prefix', groupKey: null }) }); await settle();
    expect(m.text()).not.toContain('OLD'); expect(m.bridge.readTaskGraphDates).toHaveBeenCalledTimes(reads); expect(m.pipeline.cancel).toHaveBeenCalled();
    if (changed === 'current' || changed === 'active' || changed === 'visibility' || changed === 'unmount') expect(m.find('graph-overview')).toBeUndefined();
    else expect(m.find('graph-overview')).toBeDefined();
    if (changed === 'unmount') { expect(m.pipeline.dispose).toHaveBeenCalledOnce(); expect(m.documentListeners.size).toBe(0); }
  });

  it.each(['projectId', 'sourceKey', 'current', 'active', 'visibility', 'unmount'] as const)('withdraws dates and cancels a late date read after %s changes', async changed => {
    const stale = deferred<GraphDateReadResult>(); const m = workspace((_pipeline, bridge) => bridge.readTaskGraphDates.mockReturnValueOnce(stale.promise)); await settle();
    const oldRequest = m.bridge.readTaskGraphDates.mock.calls[0][0];
    if (changed === 'projectId') m.state.projectId = 'project-2'; else if (changed === 'sourceKey') m.state.sourceKey = 'basis-2';
    else if (changed === 'current' || changed === 'active') m.state[changed] = false;
    else if (changed === 'visibility') m.visibility(true); else m.unmount(); await settle();
    stale.resolve(dateResult(snapshot(), oldRequest.requestId, '2040-04-05T00:00:00Z')); await settle();
    expect(m.text()).not.toContain('2040'); expect(m.text()).not.toContain('04.05');
    expect(m.bridge.cancelTaskGraphDates).toHaveBeenCalledWith({ requestId: oldRequest.requestId });
    if (changed === 'current' || changed === 'active' || changed === 'visibility') {
      expect(m.find('graph-overview')).toBeUndefined();
      if (changed === 'visibility') m.visibility(false); else m.state[changed] = true; await settle();
      expect(m.find('graph-overview')).toBeDefined(); expect(m.button('A 최근 연결 커밋 날짜 01.01')).toBeDefined();
      expect(m.pipeline.setBackground).toHaveBeenCalledWith(true); expect(m.pipeline.setBackground).toHaveBeenLastCalledWith(false);
    }
  });

  it.each(['projectId', 'dagId', 'sourceHash', 'sessionKey', 'revision', 'requestId'] as const)('rejects a date response with mismatched %s', async field => {
    const m = workspace((_pipeline, bridge) => bridge.readTaskGraphDates.mockImplementationOnce(async request => {
      const result = dateResult(snapshot(), request.requestId);
      if (field === 'requestId') result.requestId = 'different-request'; else result.identity = { ...result.identity, [field]: 'different-identity' };
      return result;
    })); await settle();
    expect(m.text()).toContain('연결 커밋 날짜 근거를 확인하지 못했습니다'); expect(m.button('A 최근 연결 커밋 날짜 미확인')).toBeDefined();
    expect(m.bridge.getTaskGraphSession).not.toHaveBeenCalled();
    expect(m.bridge.cancelTaskGraphDates).toHaveBeenCalledWith({ requestId: m.bridge.readTaskGraphDates.mock.calls[0][0].requestId });
  });

  it.each(['current', 'active', 'visibility'] as const)('withdraws already displayed date evidence immediately on %s loss', async changed => {
    const m = workspace(); await settle(); event(m.button('A 최근 연결 커밋 날짜 01.01'), 'onFocus'); await settle();
    expect(m.text()).toContain('https://github.com/synthetic/graph-source/commit/');
    if (changed === 'visibility') m.visibility(true); else m.state[changed] = false; await settle();
    expect(m.find('graph-overview')).toBeUndefined(); expect(m.text()).not.toContain('github.com'); expect(m.body.children).toHaveLength(0);
  });

  it.each(['unavailable', 'rejected'] as const)('keeps %s date reads unknown without leaking failure details', async failure => {
    const m = workspace((_pipeline, bridge) => {
      if (failure === 'rejected') bridge.readTaskGraphDates.mockRejectedValueOnce(Error('sensitive repository path'));
      else bridge.readTaskGraphDates.mockImplementationOnce(async request => ({ state: 'unavailable', requestId: request.requestId, reason: 'timeout' }));
    }); await settle();
    expect(m.find('graph-overview')).toBeDefined(); expect(m.text()).toContain('연결 커밋 날짜 근거를 확인하지 못했습니다'); expect(m.text()).not.toContain('sensitive repository path');
    event(m.button('A 최근 연결 커밋 날짜 미확인'), 'onFocus'); await settle(); expect(m.text()).toContain('날짜 근거를 확인하지 못했습니다');
    expect(m.text()).not.toContain('날짜 확인 0/0'); expect(m.bridge.getTaskGraphSession).not.toHaveBeenCalled();
  });

  it.each(['stale-session', 'source-changed', 'disconnected', 'unauthorized'] as const)('withdraws graph evidence when date authority reports %s', async reason => {
    const m = workspace((_pipeline, bridge) => bridge.readTaskGraphDates.mockImplementationOnce(async request => ({ state: 'unavailable', requestId: request.requestId, reason }))); await settle();
    expect(m.find('graph-overview') === undefined).toBe(true); expect(m.text()).toContain('그래프 연결 또는 읽기 권한이 변경되었습니다');
    expect(m.text()).not.toContain('Source title'); expect(m.body.children).toHaveLength(0); expect(m.bridge.getTaskGraphSession).not.toHaveBeenCalled();
    expect(m.bridge.cancelTaskGraphDates).toHaveBeenCalledWith({ requestId: m.bridge.readTaskGraphDates.mock.calls[0][0].requestId });
  });

  it('clears a failed-date notice when group navigation retries and recovers the date read', async () => {
    const pending = deferred<GraphDateReadResult>();
    const m = workspace((_pipeline, bridge) => bridge.readTaskGraphDates.mockRejectedValueOnce(Error('unavailable')).mockReturnValueOnce(pending.promise)); await settle();
    expect(m.text()).toContain('연결 커밋 날짜 근거를 확인하지 못했습니다');
    m.click('A 그룹 2개 작업 열기'); await settle();
    expect(m.bridge.readTaskGraphDates).toHaveBeenCalledTimes(2); expect(m.text()).not.toContain('연결 커밋 날짜 근거를 확인하지 못했습니다');
    pending.resolve(dateResult(snapshot(), m.bridge.readTaskGraphDates.mock.calls[1][0].requestId)); await settle();
    expect(m.text()).not.toContain('연결 커밋 날짜 근거를 확인하지 못했습니다'); m.click('‹ 전체'); await settle();
    expect(m.button('A 최근 연결 커밋 날짜 01.01')).toBeDefined(); expect(m.bridge.readTaskGraphDates).toHaveBeenCalledTimes(2);
  });

  it.each(['null', 'different-project'] as const)('withdraws graph and dates when the final session recheck returns %s', async response => {
    const m = workspace((_pipeline, bridge) => bridge.getTaskGraphSession.mockResolvedValueOnce(response === 'null' ? null : {
      projectId: 'another-project', dagId: 'dag-project-1', sessionKey: 'session-project-1',
    })); await settle();
    expect(m.find('graph-overview') === undefined).toBe(true); expect(m.text()).toContain('근거가 변경되었습니다. 다시 읽어 주세요.');
  });

  it('rechecks the current session before exposing dates and withdraws a changed graph basis', async () => {
    const pending = deferred<{ projectId: string; dagId: string; sessionKey: string }>();
    const m = workspace((_pipeline, bridge) => bridge.getTaskGraphSession.mockReturnValueOnce(pending.promise)); await settle();
    expect(m.button('A 최근 연결 커밋 날짜 미확인')).toBeDefined();
    pending.resolve({ projectId: 'project-1', dagId: 'changed-dag', sessionKey: 'changed-session' }); await settle();
    expect(m.text()).toContain('근거가 변경되었습니다. 다시 읽어 주세요.'); expect(m.find('graph-overview')).toBeUndefined();
  });

  it('does not revive dates when the session recheck completes after the project changed', async () => {
    const pending = deferred<{ projectId: string; dagId: string; sessionKey: string }>();
    const m = workspace((_pipeline, bridge) => bridge.getTaskGraphSession.mockReturnValueOnce(pending.promise)); await settle();
    m.state.projectId = 'project-2'; await settle();
    pending.resolve({ projectId: 'project-1', dagId: 'obsolete-dag', sessionKey: 'obsolete-session' }); await settle();
    expect(m.find('graph-overview')).toBeDefined(); expect(m.text()).not.toContain('근거가 변경'); expect(m.button('A 최근 연결 커밋 날짜 01.01')).toBeDefined();
  });

  it('ignores an older group projection when a newer group finishes first', async () => {
    const pending = deferred<GraphLayout>(), m = workspace(); await settle();
    const source = snapshot(), aKey = graphGroupKey(sourceNode('A-1'), 'prefix'), bKey = graphGroupKey(sourceNode('B-1'), 'prefix');
    m.pipeline.layout.mockReturnValueOnce(pending.promise);
    const a = m.button('A 그룹 2개 작업 열기'), b = m.button('B 그룹 1개 작업 열기');
    event(a, 'onClick'); event(b, 'onClick'); await settle();
    expect(m.opened).toEqual([[bKey, 'prefix']]); pending.resolve(layoutGraphSnapshot(source, { grouping: 'prefix', groupKey: aKey })); await settle();
    expect(m.opened).toEqual([[bKey, 'prefix']]); expect(m.text()).toContain('Source title B-1'); expect(m.text()).not.toContain('Source title A-1');
  });

  it('cancels a pending date read on group navigation and rereads the same exact source identity', async () => {
    const stale = deferred<GraphDateReadResult>(), m = workspace((_pipeline, bridge) => bridge.readTaskGraphDates.mockReturnValueOnce(stale.promise)); await settle();
    const first = m.bridge.readTaskGraphDates.mock.calls[0][0]; m.click('A 그룹 2개 작업 열기'); await settle();
    expect(m.bridge.cancelTaskGraphDates).toHaveBeenCalledWith({ requestId: first.requestId });
    expect(m.bridge.readTaskGraphDates).toHaveBeenCalledTimes(2);
    expect(m.bridge.readTaskGraphDates.mock.calls[1][0]).toMatchObject({ projectId: 'project-1', dagId: 'dag-project-1', sessionKey: 'session-project-1', expectedRevision: 'revision-project-1' });
    stale.resolve(dateResult(snapshot(), first.requestId, '2040-04-05T00:00:00Z')); await settle(); m.click('‹ 전체'); await settle();
    expect(m.button('A 최근 연결 커밋 날짜 01.01')).toBeDefined(); expect(m.text()).not.toContain('2040');
  });

  it('cleans up visibility handlers, observers, pipeline and teleported tooltip content on unmount', async () => {
    const m = workspace(); await settle(); event(m.button('A 최근 연결 커밋 날짜 01.01'), 'onFocus'); await settle();
    expect(m.text()).toContain('작업일·완료일 아님'); m.click('A 그룹 2개 작업 열기'); await settle();
    expect(m.observers.length).toBeGreaterThan(0); m.unmount(); await settle();
    expect(m.pipeline.dispose).toHaveBeenCalledOnce(); expect(m.documentListeners.size).toBe(0); expect(m.observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true);
    expect(m.body.children).toHaveLength(0); expect(m.root.children).toHaveLength(0);
  });
});


describe('continuous canvas navigation T062',()=>{
 it('restores each group viewport and zoom independently through overview and grouping changes',async()=>{
  const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('그래프 확대');await settle();
  const pane=m.all().find(n=>n.props.class==='continuous-pane')!;pane.scrollTo({left:31,top:42});event(pane,'onScroll');
  m.click('‹ 전체');await settle();m.click('B 그룹 1개 작업 열기');await settle();expect(m.button('100%')).toBeDefined();m.click('‹ 전체');await settle();
  m.click('Phase');await settle();m.click('접두사');await settle();m.click('A 그룹 2개 작업 열기');await settle();
  expect(m.button('125%')).toBeDefined();expect(m.all().find(n=>n.props.class==='continuous-pane')!.scrollLeft).toBe(31);
 });
 it('re-admits saved detail selection and explicitly invalidates a removed ID',async()=>{
  let latest=snapshot();const m=workspace(undefined,()=>latest);await settle();m.click('A 그룹 2개 작업 열기');await settle();m.state.selectedId='A-2';m.state.detailOpen=true;await settle();
  m.click('‹ 전체');await settle();m.state.selectedId=null;m.state.detailOpen=false;await settle();m.click('A 그룹 2개 작업 열기');await settle();expect(m.restored.at(-1)).toEqual(['A-2',true]);
  m.state.selectedId='A-2';m.state.detailOpen=true;await settle();latest=snapshot('project-1',[sourceNode('A-1')]);m.state.sourceKey='removed';await settle();expect(m.restored.at(-1)).toEqual([null,false]);expect(m.text()).toContain('이전 선택 작업이 삭제되었거나 중복');
 });
 it('does not clear parent detail when active is suspended for document expansion',async()=>{
  const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.state.selectedId='A-1';m.state.detailOpen=true;await settle();m.restored.length=0;m.state.active=false;await settle();expect(m.restored).toEqual([]);m.state.active=true;await settle();expect(m.restored.at(-1)).toEqual(['A-1',true]);
 });
 it('searches beyond 1000 legacy rows and pages every matching result',async()=>{
  const source=snapshot('project-1',Array.from({length:1002},(_,i)=>sourceNode(`A-${String(i).padStart(4,'0')}`)));const m=workspace(undefined,()=>source);await settle();
  const input=m.all().find(n=>n.type==='input')!;input.props['onUpdate:modelValue']('A-');await settle();expect(m.text()).toContain('1002개 결과');for(let i=0;i<10;i++){m.click('검색 다음');await settle();}m.click('A-1001 · Source title A-1001');await settle();expect(m.selected).toEqual([]);expect(m.doc.activeElement?.dataset.graphTask).toBe('A-1001');
 });
 it('pans both axes by keyboard, ignores keys on cards, and does not open detail after dragging',async()=>{
  const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();const pane=m.all().find(n=>n.props.class==='continuous-pane')!;
  event(pane,'onKeydown',{target:pane,currentTarget:pane,key:'ArrowRight',preventDefault:vi.fn()});event(pane,'onKeydown',{target:pane,currentTarget:pane,key:'ArrowDown',preventDefault:vi.fn()});expect([pane.scrollLeft,pane.scrollTop]).toEqual([100,100]);
  event(pane,'onPointerdown',{button:0,pointerId:1,clientX:100,clientY:100});event(pane,'onPointermove',{pointerId:1,clientX:50,clientY:40,preventDefault:vi.fn()});event(pane,'onPointerup',{pointerId:1});
  const task=m.button('A-1 Source title A-1 선언 상태 pending 상세 열기');event(task,'onClick',{detail:1});expect(m.selected).toEqual([]);event(task,'onClick',{detail:0});expect(m.selected).toEqual(['A-1']);
 });
 it('pins the focused card when geometric culling moves it offscreen',async()=>{
  const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();event(m.button('A-1 Source title A-1 선언 상태 pending 상세 열기'),'onFocus');await settle();const pane=m.all().find(n=>n.props.class==='continuous-pane')!;pane.scrollTo({left:10000,top:10000});event(pane,'onScroll');await settle();expect(m.button('A-1 Source title A-1 선언 상태 pending 상세 열기')).toBeDefined();expect(m.text()).toContain('현재 화면 0/2개');
 });
 it('keeps a searched high-degree task focusable when the route safety budget suspends lines',async()=>{
  const nodes=[...Array.from({length:2002},(_,i)=>sourceNode(`A-${i}`)),sourceNode('A-9999')],source=snapshot('project-1',nodes);
  source.edges=nodes.slice(0,-1).map(n=>({id:graphEdgeId(n.id,'A-9999','internal'),from:{kind:'node',id:n.id},to:{kind:'node',id:'A-9999'},scope:'internal',declarations:1}));
  const m=workspace(undefined,()=>source);await settle();const input=m.all().find(n=>n.type==='input')!;input.props['onUpdate:modelValue']('A-9999');await settle();m.click('A-9999 · Source title A-9999');await settle();expect(m.text()).toContain('연결 그림을 일시 중지');expect(m.doc.activeElement?.dataset.graphTask).toBe('A-9999');m.click('A-9999 Source title A-9999 선언 상태 done 상세 열기');expect(m.selected).toEqual(['A-9999']);
 });
 it('does not rebuild layout for status filtering and distinguishes hidden from offscreen nodes',async()=>{
  const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();const calls=m.pipeline.layout.mock.calls.length;m.click('필터');await settle();const select=m.all().find(n=>n.type==='select')!;select.props['onUpdate:modelValue']('status:pending');await settle();expect(m.pipeline.layout).toHaveBeenCalledTimes(calls);expect(m.text()).toContain('필터 숨김 1개');expect(m.text()).toContain('필터 밖 작업 연결 2');
 });
});


describe('T062 session restore and minimap',()=>{
 it('restores A → B → A across component unmount with a fresh authorized read',async()=>{
  const a=workspace(undefined,snapshot,{dagId:'dag-project-1'});await settle();a.click('A 그룹 2개 작업 열기');await settle();a.click('그래프 확대');await settle();const pane=a.all().find(n=>n.props.class==='continuous-pane')!;pane.scrollTo({left:31,top:42});event(pane,'onScroll');a.state.selectedId='A-1';a.state.detailOpen=true;await settle();a.unmount();
  const b=workspace(undefined,snapshot,{projectId:'project-2',dagId:'dag-project-2'});await settle();expect(b.find('graph-overview')).toBeDefined();expect(b.restored.at(-1)).toEqual([null,false]);b.unmount();
  const returned=workspace(undefined,snapshot,{dagId:'dag-project-1'});await settle();expect(returned.pipeline.read).toHaveBeenCalledOnce();expect(returned.find('continuous-group-graph')).toBeDefined();expect(returned.button('125%')).toBeDefined();expect(returned.restored.at(-1)).toEqual(['A-1',true]);expect(returned.all().find(n=>n.props.class==='continuous-pane')!.scrollLeft).toBe(31);
 });
 it('never republishes saved task content or selection when return authorization is revoked',async()=>{
  const a=workspace(undefined,snapshot,{dagId:'dag-project-1'});await settle();a.click('A 그룹 2개 작업 열기');await settle();a.state.selectedId='A-1';a.state.detailOpen=true;await settle();a.unmount();
  const returned=workspace(p=>p.read.mockRejectedValue(Error('unauthorized')),snapshot,{dagId:'dag-project-1'});await settle();expect(returned.find('continuous-group-graph')).toBeUndefined();expect(returned.text()).not.toContain('Source title A-1');expect(returned.restored).not.toContainEqual(['A-1',true]);
 });
 it('uses the actual minimap SVG bounds, excluding button label and padding',async()=>{
  const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();const pane=m.all().find(n=>n.props.class==='continuous-pane')!;pane.clientWidth=100;pane.clientHeight=100;event(pane,'onScroll');
  const button=m.button('전체 그래프 미니맵, 클릭한 위치로 이동, 방향키로 이동');event(button,'onClick',{currentTarget:button,clientX:160,clientY:240,detail:1});await settle();expect(pane.scrollLeft).toBe(175);expect(pane.scrollTop).toBe(3);
 });
});


describe('T062 actual TaskWorkspace parent integration, custom host',()=>{
 function parent(sourceFor=snapshot,limit=1000){
  const source=sourceFor(),pipeline=fakePipeline(sourceFor),bridge=fakeBridge(sourceFor);pipelineFactory.mockReturnValueOnce(pipeline);
  liveState.value={connection:'connected',freshness:'current',refreshing:false,observedAt:'now'} as any;
  const tasks=source.nodes.slice(0,limit).map(node=>({id:node.id,title:node.title,status:node.declaredStatus,phase:node.phase,dependencies:[] as {id:string;scope:'internal'|'external'}[],e2e:{state:'undeclared',required:null,coveredBy:null,coverage:'undeclared'},commitReferences:[],commitVerification:'not-performed',displayOmissions:{dependencies:0,commitReferences:0,e2eReferences:0},details:{description:null,acceptanceCriteria:[],targetFiles:[],omissions:0}}));
  const state=reactive({...defaultWorkspaceState(),view:'dag' as const});
  const m=mount(TaskWorkspace,{workstream:{id:'project-1',noteMapping:{state:'resolved'}},dag:{dagId:'dag-project-1',sourceHash:'hash-project-1',state:'ready',tasks,workspaceTasks:tasks,observedAt:'now'},state,active:true},{bridge});return {...m,taskState:state,pipeline,bridge};
 }
 it('scopes compact detail layout to complete graph and preserves expanded evidence override',async()=>{
  const m=parent();await settle();
  const split=()=>m.all().find(n=>String(n.props.class??'').split(' ').includes('task-split'))!;
  expect(split().props.class).toContain('complete-graph-split');
  m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();
  expect(split().props.class).toContain('task-selected');expect(m.find('continuous-group-graph')).toBeDefined();
  m.click('Expand document');await settle();expect(split().props.class).toContain('document-expanded-split');
  m.click('Return from document');await settle();expect(split().props.class).not.toContain('document-expanded-split');
  m.click('작업 목록');await settle();expect(split().props.class).not.toContain('complete-graph-split');
  m.click('관계 그래프');await settle();m.click('기존 페이지 DAG');await settle();expect(split().props.class).not.toContain('complete-graph-split');
 });
 it('retains selected detail while expanding and returning from the real parent document flow',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();expect(m.find('task-detail')).toBeDefined();expect(m.taskState.selected).toBe('A-1');
  m.click('Expand document');await settle();expect(m.taskState.selected).toBe('A-1');expect(m.button('Return from document')).toBeDefined();expect(m.find('task-detail')?.props.class).toContain('document-expanded-detail');
  m.click('Return from document');await settle();expect(m.taskState.selected).toBe('A-1');expect(m.find('continuous-group-graph')).toBeDefined();expect(m.find('task-detail')).toBeDefined();
 });
 it('restores group geometry and selection after real list and legacy view round trips',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('그래프 확대');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();
  m.click('작업 목록');await settle();m.click('관계 그래프');await settle();expect(m.button('125%')).toBeDefined();expect(m.taskState.selected).toBe('A-1');expect(m.find('task-detail')).toBeDefined();
  m.click('기존 페이지 DAG');await settle();m.click('전체 그래프로 돌아가기');await settle();expect(m.button('125%')).toBeDefined();expect(m.taskState.selected).toBe('A-1');expect(m.pipeline.read).toHaveBeenCalledTimes(3);
 });
 it('declines stale source-hash detail admission even when an ID exists in the legacy reader',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();(m.state.dag as any).sourceHash='different';await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();expect(m.taskState.selected).toBe('');expect(m.find('task-detail')).toBeUndefined();expect(m.text()).toContain('그래프와 상세의 현재 근거가 일치하지 않습니다');
 });
 it('loads complete source detail beyond legacy task 1000 and never consumes truncated legacy detail',async()=>{
  const nodes=Array.from({length:1005},(_,i)=>sourceNode('A-'+(i+1))),source=snapshot('project-1',nodes),m=parent(()=>source);await settle();m.click('A 그룹 1005개 작업 열기');await settle();
  const search=m.all().find(n=>n.type==='input'&&n.props.placeholder==='작업 ID 또는 이름 검색')!;event(search,'onUpdate:modelValue','A-1005' as any);await settle();m.click('A-1005 · Source title A-1005');await settle();m.click('A-1005 Source title A-1005 선언 상태 done 상세 열기');await settle();expect(m.taskState.selected).toBe('A-1005');expect(m.find('task-detail')).toBeDefined();expect(m.bridge.readTaskGraphDetail).toHaveBeenCalledOnce();expect(m.text()).toContain('실제 실행 검증 미수행');
 });
 it('retains all high-degree detail dependencies in accessible pages and rejects session withdrawal',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();const read=m.bridge.readTaskGraphDetail.getMockImplementation()!;m.bridge.readTaskGraphDetail.mockImplementation(async request=>{const result=await read(request);result.task.dependencies=Array.from({length:45},(_,i)=>({id:'R-'+i,scope:'internal'}));return result;});m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();expect(m.text()).toContain('의존성 45개');expect(m.text()).toContain('R-19');expect(m.text()).not.toContain('R-44');m.click('의존성 다음');await settle();m.click('의존성 다음');await settle();expect(m.text()).toContain('R-44');expect(m.text()).toContain('3 / 3');
  m.bridge.getTaskGraphSession.mockResolvedValueOnce(null);m.click('A-2 Source title A-2 선언 상태 deferred 상세 열기');await settle();expect(m.find('task-detail')).toBeUndefined();expect(m.text()).toContain('그래프와 상세의 현재 근거가 일치하지 않습니다');
 });
 it('restores only focus on detail close without zoom, filter or position changes',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('그래프 확대');await settle();const pane=m.all().find(n=>n.props.class==='continuous-pane')!;pane.scrollTo({left:21,top:33});event(pane,'onScroll');m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();m.click('태스크 상세 닫기');await settle();expect(m.taskState.selected).toBe('');expect(pane.scrollLeft).toBe(21);expect(pane.scrollTop).toBe(33);expect(m.button('125%')).toBeDefined();expect(m.doc.activeElement?.props['data-graph-task']).toBe('A-1');
 });
 it('returns detail-close focus to an explicitly labelled filter-hidden node without clearing the filter',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();m.click('필터');await settle();const select=m.all().find(n=>n.type==='select'&&n.parent?.props.class==='graph-filter')!;event(select,'onUpdate:modelValue','status:deferred' as any);await settle();m.click('태스크 상세 닫기');await settle();expect(m.doc.activeElement?.props['data-graph-task']).toBe('A-1');expect(m.doc.activeElement?.props['aria-description']).toContain('필터 밖');expect(m.text()).toContain('필터 숨김 1개');
 });
 it('cancels late detail responses on a newer selection and source replacement',async()=>{
  const m=parent();await settle();m.click('A 그룹 2개 작업 열기');await settle();const delayed=deferred<any>();m.bridge.readTaskGraphDetail.mockReturnValueOnce(delayed.promise);m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();m.click('A-2 Source title A-2 선언 상태 deferred 상세 열기');await settle();expect(m.taskState.selected).toBe('A-2');delayed.resolve({state:'unavailable',requestId:'old',reason:'timeout'});await settle();expect(m.taskState.selected).toBe('A-2');expect(m.find('task-detail')).toBeDefined();expect(m.bridge.cancelTaskGraph).toHaveBeenCalled();
  const pending=deferred<any>();m.bridge.readTaskGraphDetail.mockReturnValueOnce(pending.promise);m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');await settle();(m.state.dag as any).sourceHash='new';await settle();pending.resolve({state:'unavailable',requestId:'old',reason:'timeout'});await settle();expect(m.find('task-detail')).toBeUndefined();
 });

});


describe('T063 direct relation interaction, production component synthetic host',()=>{
 it('highlights only one hop on hover/focus without selecting, opening detail or relayout',async()=>{
  const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();const layouts=m.pipeline.layout.mock.calls.length,node=m.button('A-2 Source title A-2 선언 상태 deferred 상세 열기');event(node,'onMouseenter');await settle();expect(m.selected).toEqual([]);expect(m.text()).toContain('직접 선행 1');expect(m.text()).toContain('직접 후속 1');expect(m.button('A-1 Source title A-1 선언 상태 pending 상세 열기').props.class).toContain('relation-predecessor');expect(node.props.class).toContain('relation-anchor');expect(m.pipeline.layout).toHaveBeenCalledTimes(layouts);event(node,'onFocus');event(node,'onMouseleave');await settle();expect(m.selected).toEqual([]);expect(m.find('task-detail')).toBeUndefined();
 });
 it('navigates other-group chips without detail and returns exact origin zoom/scroll',async()=>{
  const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();m.click('그래프 확대');await settle();const pane=m.all().find(n=>n.props.class==='continuous-pane')!;pane.scrollTo({left:17,top:29});event(pane,'onScroll');event(m.button('A-2 Source title A-2 선언 상태 deferred 상세 열기'),'onFocus');await settle();const chip=m.all().find(n=>n.type==='button'&&textOf(n).includes('후속 B-1'))!;event(chip,'onClick');await settle();expect(m.selected).toEqual([]);expect(m.doc.activeElement?.props['data-graph-task']).toBe('B-1');m.click('이전 관계 위치로');await settle();expect(m.button('125%')).toBeDefined();expect(m.all().find(n=>n.props.class==='continuous-pane')!.scrollLeft).toBe(17);expect(m.all().find(n=>n.props.class==='continuous-pane')!.scrollTop).toBe(29);expect(m.doc.activeElement?.props['data-graph-task']).toBe('A-2');
 });
 it('paginates every direct boundary relation without manufacturing edges for unresolved references',async()=>{
  const nodes=[sourceNode('A-1'),...Array.from({length:21},(_,i)=>sourceNode('B-'+i))],source=snapshot('project-1',nodes);source.edges=[...nodes.slice(1).map(n=>({id:graphEdgeId('A-1',n.id,'internal'),from:{kind:'node' as const,id:'A-1'},to:{kind:'node' as const,id:n.id},scope:'internal' as const,declarations:1})),{id:graphEdgeId('missing','A-1','internal'),from:{kind:'unresolved' as const,id:'missing',reason:'missing' as const},to:{kind:'node' as const,id:'A-1'},scope:'internal' as const,declarations:1}];
  const m=workspace(undefined,()=>source);await settle();m.click('A 그룹 1개 작업 열기');await settle();event(m.button('A-1 Source title A-1 선언 상태 done 상세 열기'),'onFocus');await settle();expect(m.text()).toContain('직접 후속 21');expect(m.text()).toContain('원문 참조 미해결 (missing)');const seen=new Set<string>();for(let page=0;page<4;page++){m.all().filter(n=>n.type==='button'&&textOf(n).startsWith('후속 B-')).forEach(n=>seen.add(textOf(n)));if(page<3){m.click('다음 관계');await settle();}}expect(seen.size).toBe(21);expect(m.text()).toContain('4 / 4');expect(m.selected).toEqual([]);
 });
 it('does not activate a node after pointer cancel, even without a completed drag',async()=>{
  const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();const pane=m.all().find(n=>n.props.class==='continuous-pane')!;event(pane,'onPointerdown',{button:0,pointerId:3,clientX:0,clientY:0});event(pane,'onPointercancel',{type:'pointercancel',pointerId:3});m.click('A-1 Source title A-1 선언 상태 pending 상세 열기');expect(m.selected).toEqual([]);event(m.button('A-1 Source title A-1 선언 상태 pending 상세 열기'),'onClick',{detail:0});expect(m.selected).toEqual(['A-1']);
 }); it('retains relation controls through focus transition and dismisses transient relations with Escape',async()=>{
  const m=workspace();await settle();m.click('A 그룹 2개 작업 열기');await settle();const node=m.button('A-2 Source title A-2 선언 상태 deferred 상세 열기');event(node,'onFocus');await settle();const button=m.button('전체 직접 관계');event(node,'onBlur',{relatedTarget:{closest:(selector:string)=>selector==='[data-relation-controls]'?button:null}});await settle();m.click('전체 직접 관계');await settle();expect(m.text()).toContain('A-2 직접 관계 2개');expect(node.props['aria-description']).toBeUndefined();const preventDefault=vi.fn();event(m.find('complete-task-graph')!,'onKeydown',{key:'Escape',preventDefault,stopPropagation:vi.fn()});await settle();expect(preventDefault).toHaveBeenCalledOnce();expect(m.text()).not.toContain('직접 후속 1');expect(m.selected).toEqual([]);event(node,'onFocus');await settle();expect(m.text()).toContain('직접 후속 1');
 });
 it('reveals filter-hidden relation targets and never restores a remembered target-group detail',async()=>{
  const m=workspace();await settle();m.click('B 그룹 1개 작업 열기');await settle();m.state.selectedId='B-1';m.state.detailOpen=true;await settle();m.click('‹ 전체');await settle();m.state.selectedId=null;m.state.detailOpen=false;m.click('A 그룹 2개 작업 열기');await settle();m.click('필터');await settle();const select=m.all().find(n=>n.type==='select')!;event(select,'onUpdate:modelValue','status:pending' as any);await settle();event(m.button('A-1 Source title A-1 선언 상태 pending 상세 열기'),'onFocus');await settle();const hidden=m.all().find(n=>n.type==='button'&&textOf(n).includes('후속 A-2'))!;expect(textOf(hidden)).toContain('현재 필터 밖');event(hidden,'onClick');await settle();expect(m.doc.activeElement?.props['data-graph-task']).toBe('A-2');expect(m.selected).toEqual([]);const before=m.restored.length;const external=m.all().find(n=>n.type==='button'&&textOf(n).includes('후속 B-1'))!;event(external,'onClick');await settle();expect(m.doc.activeElement?.props['data-graph-task']).toBe('B-1');expect(m.restored.slice(before)).not.toContainEqual(['B-1',true]);expect(m.selected).toEqual([]);
 });

});
