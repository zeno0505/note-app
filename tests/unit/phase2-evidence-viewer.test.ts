import { readFileSync } from 'node:fs';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type Component, type RenderFunction } from 'vue';
import EvidenceViewer from '../../src/renderer/components/EvidenceViewer.vue';
import type { EvidenceList, EvidenceReadView } from '../../src/shared/evidence';
import type { NoteAppBridge } from '../../src/shared/bridge';

vi.mock('primevue/button', () => ({
  default: Vue.defineComponent({
    props: { label: String, disabled: Boolean },
    setup: (props, { attrs }) => () => h('button', { ...attrs, disabled: props.disabled }, props.label),
  }),
}));
vi.mock('primevue/dialog', () => ({
  default: Vue.defineComponent({
    props: { visible: Boolean, header: String },
    emits: ['update:visible'],
    setup: (props, { emit, slots }) => () => props.visible ? h('dialog', [
      h('h2', props.header),
      h('button', { 'aria-label': 'Close evidence', onClick: () => emit('update:visible', false) }, 'Close'),
      slots.default?.(),
    ]) : null,
  }),
}));

interface HostNode { type: string; parent: HostNode | null; children: HostNode[]; props: Record<string, unknown>; text: string }
function host(type: string, text = ''): HostNode { return { type, parent: null, children: [], props: {}, text }; }

// Vitest loads the SFC's SSR render. Compile its actual production template for this
// custom host so disabled buttons, displayed content and Dialog events stay covered.
const filename = new URL('../../src/renderer/components/EvidenceViewer.vue', import.meta.url);
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
const script = compileScript(descriptor, { id: 'evidence-viewer-test' });
const template = compileTemplate({
  source: descriptor.template!.content,
  filename: filename.pathname,
  id: 'evidence-viewer-test',
  compilerOptions: { mode: 'function', bindingMetadata: script.bindings },
});
if (template.errors.length) throw new Error(template.errors.map(String).join('\n'));
const render = new Function('Vue', transformSync(template.code, { loader: 'ts', target: 'es2022' }).code)(Vue) as RenderFunction;
const clientComponent = { ...EvidenceViewer, render } as Component;

const unmounts: (() => void)[] = [];
afterEach(() => { unmounts.splice(0).forEach(unmount => unmount()); vi.unstubAllGlobals(); });

function mount() {
  const insert = (child: HostNode, parent: HostNode, before?: HostNode | null) => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = parent;
    const index = before ? parent.children.indexOf(before) : -1;
    if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child);
  };
  const renderer = createRenderer<HostNode, HostNode>({
    patchProp: (node, key, _before, value) => { node.props[key] = value; },
    insert,
    remove: node => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; },
    createElement: type => host(type), createText: text => host('text', text), createComment: text => host('comment', text),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insertStaticContent: (content, parent, before) => { const node = host('static', content); insert(node, parent, before); return [node, node]; },
  });
  const state = reactive({ workstreamId: 'workstream-1', taskId: 'task-1', sourceHash: 'source-1' as string | null, current: true });
  const root = host('root');
  const app = renderer.createApp({ render: () => h(clientComponent, { ...state }) });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(root);
  let mounted = true;
  const unmount = () => { if (mounted) { app.unmount(); mounted = false; } };
  unmounts.push(unmount);
  const all = (): HostNode[] => { const result: HostNode[] = []; const visit = (node: HostNode) => { result.push(node); node.children.forEach(visit); }; visit(root); return result; };
  const button = (label: string) => {
    const node = all().find(node => node.type === 'button' && node.text === label);
    expect(node, `button ${label}`).toBeDefined();
    return node!;
  };
  const click = (label: string) => {
    const node = button(label);
    expect(node.props.disabled, `button ${label} must be enabled before activation`).not.toBe(true);
    (node.props.onClick as () => void)();
  };
  return { state, root, all, button, click, unmount, text: () => all().map(node => node.text).join('\n') };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { await nextTick(); await Promise.resolve(); await nextTick(); }
function evidence(sessionId: string): EvidenceList {
  return { sessionId, unsupportedCount: 0, items: [{ evidenceId: `${sessionId}-file`, registrationId: 'registered-file', label: sessionId, anchor: null, origin: 'synthetic' }] };
}
function readView(sessionId: string, text: string, withChildren = false): EvidenceReadView {
  return {
    result: {
      ok: true, scopeId: sessionId, evidenceId: `${sessionId}-file`, label: sessionId, anchor: null,
      origin: 'synthetic', sourceHash: `${sessionId}-hash`, observedAt: '2026-10-07T00:00:00.000Z', byteLength: text.length,
      content: { kind: 'text', mime: 'text/plain', text, rendering: 'plain-text', imageReferences: { targets: [], unsupportedCount: 0 } },
      verification: 'not-assessed', omissions: [],
    },
    ...(withChildren ? { images: evidence(`${sessionId}-images`), references: { session: evidence(`${sessionId}-references`), targets: [] } } : {}),
  };
}
function bridge() {
  let prepared = 0;
  const prepareTaskEvidence = vi.fn<NoteAppBridge['prepareTaskEvidence']>().mockImplementation(async () => evidence(`session-${++prepared}`));
  const readTaskEvidence = vi.fn<NoteAppBridge['readTaskEvidence']>();
  const releaseTaskEvidence = vi.fn<NoteAppBridge['releaseTaskEvidence']>().mockResolvedValue(undefined);
  vi.stubGlobal('window', { noteApp: { prepareTaskEvidence, readTaskEvidence, releaseTaskEvidence } });
  return { prepareTaskEvidence, readTaskEvidence, releaseTaskEvidence };
}

describe('EvidenceViewer interrupted reads', () => {
  it.each(['current', 'sourceHash', 'missing sourceHash', 'taskId', 'workstreamId'] as const)(
    're-enables freshly prepared evidence after %s changes and ignores a late previous read', async identity => {
      const ipc = bridge(), stale = deferred<EvidenceReadView>(), fresh = deferred<EvidenceReadView>();
      ipc.readTaskEvidence.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
      const mounted = mount(); await settle();
      mounted.click('session-1'); await settle();
      expect(mounted.button('session-1').props.disabled).toBe(true);
      expect(mounted.all().some(node => node.props.role === 'status')).toBe(true);

      if (identity === 'current') mounted.state.current = false;
      else if (identity === 'missing sourceHash') mounted.state.sourceHash = null;
      else if (identity === 'sourceHash') mounted.state.sourceHash = 'source-2';
      else if (identity === 'taskId') mounted.state.taskId = 'task-2';
      else mounted.state.workstreamId = 'workstream-2';
      await settle();
      expect(ipc.releaseTaskEvidence).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1' });
      expect(mounted.all().some(node => node.type === 'dialog')).toBe(false);
      if (identity === 'current' || identity === 'missing sourceHash') {
        expect(ipc.prepareTaskEvidence).toHaveBeenCalledTimes(1);
        expect(mounted.all().some(node => node.type === 'button')).toBe(false);
        mounted.state.current = true; mounted.state.sourceHash = 'source-2'; await settle();
      }
      expect(ipc.prepareTaskEvidence).toHaveBeenLastCalledWith({
        workstreamId: mounted.state.workstreamId, taskId: mounted.state.taskId, sourceHash: mounted.state.sourceHash,
      });
      expect(mounted.button('session-2').props.disabled).toBe(false);
      mounted.click('session-2'); await settle();
      expect(ipc.readTaskEvidence).toHaveBeenLastCalledWith({ sessionId: 'session-2', evidenceId: 'session-2-file', expectedSourceHash: null });

      stale.resolve(readView('session-1', 'Obsolete evidence must never appear', true)); await settle();
      expect(mounted.text()).not.toContain('Obsolete evidence must never appear');
      expect(mounted.button('session-2').props.disabled).toBe(true);
      expect(mounted.all().some(node => node.props.role === 'status')).toBe(true);
      expect(ipc.releaseTaskEvidence.mock.calls).toEqual([
        [{ sessionId: 'session-1' }], [{ sessionId: 'session-1-images' }], [{ sessionId: 'session-1-references' }],
      ]);

      fresh.resolve(readView('session-2', 'Current evidence is displayed')); await settle();
      expect(mounted.text()).toContain('Current evidence is displayed');
      expect(mounted.button('session-2').props.disabled).toBe(false);
      expect(mounted.all().some(node => node.props.role === 'status')).toBe(false);
      mounted.unmount();
      expect(ipc.releaseTaskEvidence).toHaveBeenLastCalledWith({ sessionId: 'session-2' });
    },
  );

  it('closes an in-flight read, releases late child handles and permits reopening fresh evidence', async () => {
    const ipc = bridge(), stale = deferred<EvidenceReadView>();
    ipc.readTaskEvidence.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(readView('session-2', 'Reopened evidence'));
    const mounted = mount(); await settle(); mounted.click('session-1'); await settle();
    mounted.click('Close'); await settle();
    expect(ipc.releaseTaskEvidence).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1' });
    expect(mounted.all().some(node => node.type === 'dialog')).toBe(false);
    expect(mounted.button('session-2').props.disabled).toBe(false);

    stale.resolve(readView('session-1', 'Dismissed evidence must never appear', true)); await settle();
    expect(mounted.text()).not.toContain('Dismissed evidence must never appear');
    expect(mounted.all().some(node => node.type === 'dialog')).toBe(false);
    expect(ipc.releaseTaskEvidence.mock.calls).toEqual([
      [{ sessionId: 'session-1' }], [{ sessionId: 'session-1-images' }], [{ sessionId: 'session-1-references' }],
    ]);
    mounted.click('session-2'); await settle();
    expect(mounted.text()).toContain('Reopened evidence');
    expect(ipc.readTaskEvidence).toHaveBeenCalledTimes(2);
  });

  it('releases the active session on unmount and releases child handles from its late read', async () => {
    const ipc = bridge(), stale = deferred<EvidenceReadView>();
    ipc.readTaskEvidence.mockReturnValueOnce(stale.promise);
    const mounted = mount(); await settle(); mounted.click('session-1'); await settle();
    mounted.unmount();
    expect(ipc.releaseTaskEvidence).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1' });
    stale.resolve(readView('session-1', 'Unmounted evidence must never appear', true)); await settle();
    expect(mounted.root.children).toEqual([]);
    expect(mounted.text()).not.toContain('Unmounted evidence must never appear');
    expect(ipc.prepareTaskEvidence).toHaveBeenCalledTimes(1);
    expect(ipc.releaseTaskEvidence.mock.calls).toEqual([
      [{ sessionId: 'session-1' }], [{ sessionId: 'session-1-images' }], [{ sessionId: 'session-1-references' }],
    ]);
  });
});
