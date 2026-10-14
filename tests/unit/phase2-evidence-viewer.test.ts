import { readFileSync } from 'node:fs';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type Component, type RenderFunction } from 'vue';
import EvidenceViewer from '../../src/renderer/components/EvidenceViewer.vue';
import DocumentViewer from '../../src/renderer/components/DocumentViewer.vue';
import SafeMarkdown from '../../src/renderer/components/SafeMarkdown.vue';
import {documentScopeState} from '../../src/renderer/phase2-state';
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

interface HostNode { type: string; parent: HostNode | null; children: HostNode[]; props: Record<string, unknown>; text: string; style:Record<string,string>; tagName:string;scrollTop:number;scrollLeft:number;getBoundingClientRect:()=>{height:number;top:number};closest:()=>HostNode|null; getRootNode:()=>{activeElement:null};addEventListener:()=>void;removeEventListener:()=>void;focus:()=>void;scrollIntoView:()=>void;querySelector:()=>null;querySelectorAll:()=>HostNode[] }
function host(type: string, text = ''): HostNode { return { type, parent: null, children: [], props: {}, text,style:{},tagName:type.toUpperCase(),scrollTop:0,scrollLeft:0,getBoundingClientRect:()=>({height:640,top:900}),closest:()=>null,getRootNode:()=>({activeElement:null}),addEventListener:()=>{},removeEventListener:()=>{},focus:vi.fn(),scrollIntoView:vi.fn(),querySelector:()=>null,querySelectorAll:()=>[] }; }

for(const [component,name]of [[DocumentViewer,'DocumentViewer'],[SafeMarkdown,'SafeMarkdown']] as const){
 const file=new URL('../../src/renderer/components/'+name+'.vue',import.meta.url),parsed=parse(readFileSync(file,'utf8'),{filename:file.pathname}).descriptor;
 const bindings=compileScript(parsed,{id:name+'-test'}).bindings;
 const compiled=compileTemplate({source:parsed.template!.content,filename:file.pathname,id:name+'-test',compilerOptions:{mode:'function',bindingMetadata:bindings}});
 if(compiled.errors.length)throw Error(compiled.errors.map(String).join('\n'));
 (component as unknown as {render:RenderFunction}).render=new Function('Vue',transformSync(compiled.code,{loader:'ts',target:'es2022'}).code)(Vue) as RenderFunction;
}
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
  documentScopeState('workstream-1').accepted=false;
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
  const nodeText=(node:HostNode):string=>node.text+node.children.map(nodeText).join('');
  const button = (label: string) => {
    const node = all().find(node => node.type === 'button' && (nodeText(node) === label || node.props['aria-label']===label || node.props['data-testid']===label));
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
async function settle() { for(let i=0;i<6;i++){await nextTick();await Promise.resolve();} }
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
  vi.stubGlobal('Document',class{});vi.stubGlobal('ShadowRoot',class{});
  let prepared = 0;
  const prepareTaskEvidence = vi.fn<NoteAppBridge['prepareTaskEvidence']>().mockImplementation(async () => evidence(`session-${++prepared}`));
  const readTaskEvidence = vi.fn<NoteAppBridge['readTaskEvidence']>();
  const releaseTaskEvidence = vi.fn<NoteAppBridge['releaseTaskEvidence']>().mockResolvedValue(undefined);
  vi.stubGlobal('window', { noteApp: { prepareTaskEvidence, readTaskEvidence, releaseTaskEvidence } });
  return { prepareTaskEvidence, readTaskEvidence, releaseTaskEvidence };
}

describe('inline EvidenceViewer interrupted reads', () => {
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
      expect(mounted.all().some(node => node.props['data-testid'] === 'document-viewer')).toBe(false);
      if (identity === 'current' || identity === 'missing sourceHash') {
        expect(ipc.prepareTaskEvidence).toHaveBeenCalledTimes(1);
        expect(mounted.all().some(node => node.props['data-evidence-id'])).toBe(false);
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
      expect(mounted.all().some(node => node.props['aria-busy'] === true)).toBe(false);
      mounted.unmount();
      expect(ipc.releaseTaskEvidence).toHaveBeenLastCalledWith({ sessionId: 'session-2' });
    },
  );

  it('closes an in-flight read, releases late child handles and permits reopening fresh evidence', async () => {
    const ipc = bridge(), stale = deferred<EvidenceReadView>();
    ipc.readTaskEvidence.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(readView('session-2', 'Reopened evidence'));
    const mounted = mount(); await settle(); mounted.click('session-1'); await settle();
    mounted.click('문서 닫기'); await settle();
    expect(ipc.releaseTaskEvidence).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1' });
    expect(mounted.all().some(node => node.props['data-testid'] === 'document-viewer')).toBe(false);
    expect(mounted.button('session-2').props.disabled).toBe(false);

    stale.resolve(readView('session-1', 'Dismissed evidence must never appear', true)); await settle();
    expect(mounted.text()).not.toContain('Dismissed evidence must never appear');
    expect(mounted.all().some(node => node.props['data-testid'] === 'document-viewer')).toBe(false);
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

describe('Phase4 pinned document sessions',()=>{
 it('only prepares the related list before the user chooses a document',async()=>{const ipc=bridge(),mounted=mount();await settle();expect(ipc.prepareTaskEvidence).toHaveBeenCalledTimes(1);expect(ipc.readTaskEvidence).not.toHaveBeenCalled();expect(mounted.all().some(node=>node.props['data-testid']==='document-viewer')).toBe(false);});
 it('keeps the cached child capability on an unchanged explicit recheck',async()=>{const ipc=bridge(),initial=readView('session-1','Pinned contents',true);ipc.readTaskEvidence.mockResolvedValue(initial);const mounted=mount();await settle();mounted.click('session-1');await settle();mounted.click('document-recheck');await settle();expect(ipc.readTaskEvidence).toHaveBeenLastCalledWith({sessionId:'session-1',evidenceId:'session-1-file',expectedSourceHash:'session-1-hash'});expect(ipc.releaseTaskEvidence).not.toHaveBeenCalled();expect(mounted.text()).toContain('Pinned contents');});
 it('keeps changed contents pinned until explicit reread and hides them on permission loss',async()=>{const ipc=bridge();ipc.readTaskEvidence.mockResolvedValueOnce(readView('session-1','Old pinned contents')).mockResolvedValueOnce({result:{ok:false,code:'stale-source',omitted:true}}).mockResolvedValueOnce(readView('session-1','New confirmed contents')).mockResolvedValueOnce({result:{ok:false,code:'permission-denied',omitted:true}});const mounted=mount();await settle();mounted.click('session-1');await settle();mounted.click('document-recheck');await settle();expect(mounted.text()).toContain('Old pinned contents');expect(mounted.text()).toContain('원본 문서가 변경');expect(mounted.text()).not.toContain('New confirmed contents');mounted.click('document-reread');await settle();expect(mounted.text()).toContain('New confirmed contents');expect(mounted.text()).not.toContain('Old pinned contents');mounted.click('document-recheck');await settle();expect(mounted.text()).not.toContain('New confirmed contents');expect(mounted.text()).toContain('읽기 허용이 없습니다');});
 it('preserves large JSON integers and duplicate keys as exact evidence text',async()=>{const ipc=bridge(),session=evidence('session-1');session.items[0].label='source.json';session.items[0].relativePath='source.json';ipc.prepareTaskEvidence.mockResolvedValueOnce(session);const source='{"id":9007199254740993,"duplicate":1,"duplicate":2}';ipc.readTaskEvidence.mockResolvedValueOnce(readView('session-1',source));const mounted=mount();await settle();mounted.click('source.json');await settle();expect(mounted.text()).toContain(source);expect(mounted.text()).not.toContain('9007199254740992');mounted.click('document-raw');await settle();expect(mounted.text()).toContain(source);});
 it('revalidates both back and forward against each previously read hash',async()=>{const ipc=bridge(),session=evidence('session-1');session.items.push({...session.items[0],evidenceId:'second-file',registrationId:'second',label:'second.md'});ipc.prepareTaskEvidence.mockResolvedValueOnce(session);ipc.readTaskEvidence.mockResolvedValueOnce(readView('first','First')).mockResolvedValueOnce(readView('second','Second')).mockResolvedValueOnce(readView('first','First')).mockResolvedValueOnce(readView('second','Second'));const mounted=mount();await settle();mounted.click('session-1');await settle();mounted.click('second.md');await settle();mounted.click('document-back');await settle();expect(ipc.readTaskEvidence).toHaveBeenLastCalledWith({sessionId:'session-1',evidenceId:'session-1-file',expectedSourceHash:'first-hash'});mounted.click('document-forward');await settle();expect(ipc.readTaskEvidence).toHaveBeenLastCalledWith({sessionId:'session-1',evidenceId:'second-file',expectedSourceHash:'second-hash'});});
 it('raw document find keeps original Unicode offsets after case-folding characters',async()=>{const ipc=bridge();ipc.readTaskEvidence.mockResolvedValueOnce(readView('session-1','İ test 한글 suffix'));const mounted=mount();await settle();mounted.click('session-1');await settle();mounted.click('document-find-toggle');await settle();const input=mounted.all().find(node=>node.props['data-testid']==='document-find-input')!;(input.props['onUpdate:modelValue'] as (value:string)=>void)('한글');(input.props.onInput as ()=>void)();await settle();const mark=mounted.all().find(node=>node.type==='mark');expect(mark?.text).toBe('한글');});

 it('blocks linked navigation and related-file clicks while a delayed recheck owns the reader, then permits a clean linked read',async()=>{const ipc=bridge(),check=deferred<EvidenceReadView>(),initial=readView('session-1','[Linked](next.md)');if(initial.result.ok&&initial.result.content.kind==='text')initial.result.content.mime='text/markdown';initial.references={session:evidence('child-session'),targets:[{href:'next.md',kind:'link',evidenceId:'child-session-file',status:'resolved'}]};ipc.readTaskEvidence.mockResolvedValueOnce(initial).mockReturnValueOnce(check.promise).mockResolvedValueOnce(readView('child-session','Linked body'));const mounted=mount();await settle();mounted.click('session-1');await settle();mounted.click('document-recheck');await settle();expect(mounted.button('Linked').props.disabled).toBe(true);expect(mounted.button('session-1').props.disabled).toBe(true);expect(mounted.button('document-close').props.disabled).not.toBe(true);(mounted.button('Linked').props.onClick as ()=>void)();(mounted.button('session-1').props.onClick as ()=>void)();await settle();expect(ipc.readTaskEvidence).toHaveBeenCalledTimes(2);check.resolve(initial);await settle();expect(mounted.button('Linked').props.disabled).toBe(false);expect(mounted.button('session-1').props.disabled).toBe(false);mounted.click('Linked');await settle();expect(ipc.readTaskEvidence).toHaveBeenLastCalledWith({sessionId:'child-session',evidenceId:'child-session-file',expectedSourceHash:null});expect(mounted.text()).toContain('Linked body');expect(mounted.text()).not.toContain('읽기 범위를 재확인할 수 없습니다');});
 it('disables both history directions during a delayed recheck and does not dispatch stale history clicks',async()=>{const ipc=bridge(),session=evidence('session-1'),check=deferred<EvidenceReadView>();session.items.push({...session.items[0],evidenceId:'second-file',registrationId:'second',label:'second.md'},{...session.items[0],evidenceId:'third-file',registrationId:'third',label:'third.md'});ipc.prepareTaskEvidence.mockResolvedValueOnce(session);ipc.readTaskEvidence.mockResolvedValueOnce(readView('first','First')).mockResolvedValueOnce(readView('second','Second')).mockResolvedValueOnce(readView('third','Third')).mockResolvedValueOnce(readView('second','Second')).mockReturnValueOnce(check.promise).mockResolvedValueOnce(readView('first','First'));const mounted=mount();await settle();mounted.click('session-1');await settle();mounted.click('second.md');await settle();mounted.click('third.md');await settle();mounted.click('document-back');await settle();expect(mounted.button('document-back').props.disabled).toBe(false);expect(mounted.button('document-forward').props.disabled).toBe(false);mounted.click('document-recheck');await settle();expect(mounted.button('document-back').props.disabled).toBe(true);expect(mounted.button('document-forward').props.disabled).toBe(true);(mounted.button('document-back').props.onClick as ()=>void)();(mounted.button('document-forward').props.onClick as ()=>void)();await settle();expect(ipc.readTaskEvidence).toHaveBeenCalledTimes(5);check.resolve(readView('second','Second'));await settle();expect(mounted.button('document-back').props.disabled).toBe(false);expect(mounted.button('document-forward').props.disabled).toBe(false);mounted.click('document-back');await settle();expect(ipc.readTaskEvidence).toHaveBeenLastCalledWith({sessionId:'session-1',evidenceId:'session-1-file',expectedSourceHash:'first-hash'});expect(mounted.text()).toContain('First');});
 it('keeps close usable during a delayed recheck and releases the canceled root before reopening',async()=>{const ipc=bridge(),check=deferred<EvidenceReadView>();ipc.readTaskEvidence.mockResolvedValueOnce(readView('session-1','Pinned')).mockReturnValueOnce(check.promise).mockResolvedValueOnce(readView('session-2','Reopened'));const mounted=mount();await settle();mounted.click('session-1');await settle();mounted.click('document-recheck');await settle();mounted.click('document-close');await settle();expect(ipc.releaseTaskEvidence).toHaveBeenCalledWith({sessionId:'session-1'});mounted.click('session-2');await settle();check.resolve(readView('session-1','Late check body',true));await settle();expect(mounted.text()).toContain('Reopened');expect(mounted.text()).not.toContain('Late check body');expect(mounted.button('session-2').props.disabled).toBe(false);});

 it('reveals the reader as soon as a related file starts opening and reserves its prior height across navigation',async()=>{const ipc=bridge(),first=deferred<EvidenceReadView>(),second=deferred<EvidenceReadView>(),session=evidence('session-1');session.items.push({...session.items[0],evidenceId:'second-file',registrationId:'second',label:'second.md'});ipc.prepareTaskEvidence.mockResolvedValueOnce(session);ipc.readTaskEvidence.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);const mounted=mount();await settle();mounted.click('session-1');await settle();const viewer=mounted.all().find(node=>node.props['data-testid']==='document-viewer')!;expect(viewer.scrollIntoView).toHaveBeenCalledWith({block:'start',behavior:'auto'});expect((viewer.props.style as {minHeight:string}).minHeight).toBe('280px');first.resolve(readView('session-1','Original body'));await settle();expect(mounted.text()).toContain('Original body');viewer.getBoundingClientRect=()=>({height:680,top:76});const calls=vi.mocked(viewer.scrollIntoView).mock.calls.length;mounted.click('second.md');await settle();expect((viewer.props.style as {minHeight:string}).minHeight).toBe('680px');expect(mounted.text()).not.toContain('Original body');expect(vi.mocked(viewer.scrollIntoView).mock.calls.length).toBeGreaterThan(calls);second.resolve(readView('second','Target body'));await settle();expect(mounted.text()).toContain('Target body');expect(viewer.props.style).toBeUndefined();expect(vi.mocked(viewer.scrollIntoView).mock.calls.length).toBeGreaterThan(calls+1);});
 it('reveals the new reader before applying its explicit heading anchor',async()=>{const ipc=bridge(),session=evidence('session-1'),initial=readView('session-1','# Target heading\nBody');session.items[0].anchor='target-heading';ipc.prepareTaskEvidence.mockResolvedValueOnce(session);if(initial.result.ok&&initial.result.content.kind==='text'){initial.result.content.mime='text/markdown';initial.result.anchor='target-heading';}ipc.readTaskEvidence.mockResolvedValueOnce(initial);const mounted=mount();await settle();mounted.click('session-1');await settle();const viewer=mounted.all().find(node=>node.props['data-testid']==='document-viewer')!,heading=mounted.all().find(node=>node.props['data-markdown-anchor']==='target-heading')!;expect(heading).toBeDefined();expect(heading.scrollIntoView).toHaveBeenCalledWith({block:'nearest',behavior:'auto'});expect(vi.mocked(heading.scrollIntoView).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(viewer.scrollIntoView).mock.invocationCallOrder.at(-1)!);});
 it('restores the related-list and outer-page origin when closing the inline reader',async()=>{const ipc=bridge(),scrollTo=vi.fn();Object.assign(window,{scrollY:220,scrollTo});ipc.readTaskEvidence.mockResolvedValueOnce(readView('session-1','Body'));const mounted=mount();await settle();const container=mounted.all().find(node=>node.props['data-testid']==='task-related-documents')!,detail=host('aside');detail.scrollTop=700;container.closest=()=>detail;mounted.click('session-1');await settle();detail.scrollTop=1400;mounted.click('document-close');await settle();expect(detail.scrollTop).toBe(700);expect(scrollTo).toHaveBeenLastCalledWith({top:220,behavior:'auto'});});

 it.each([['missing','# Visible heading\nOriginal body.\n[Missing](#not-here)','Missing','찾지 못했습니다'],['ambiguous','## Repeated\nFirst source.\n## Repeated\nSecond source.\n[Ambiguous](#Repeated)','Ambiguous','여러 개'],['block','# Visible heading\nOriginal body.\n[Block](#^unsupported)','Block','지원하지 않습니다']] as const)('shows %s anchor feedback beside the controls without replacing source',async(_kind,text,label,expected)=>{const ipc=bridge(),initial=readView('session-1',text);if(initial.result.ok&&initial.result.content.kind==='text')initial.result.content.mime='text/markdown';ipc.readTaskEvidence.mockResolvedValueOnce(initial);const mounted=mount();await settle();mounted.click('session-1');await settle();mounted.click(label);await settle();const notice=mounted.all().find(node=>node.props['data-testid']==='document-anchor-notice')!;expect(notice).toBeDefined();expect(notice.parent?.type).toBe('header');expect(notice.props.role).toBe('status');expect(notice.props.tabindex).toBe('-1');expect(notice.scrollIntoView).toHaveBeenCalledWith({block:'nearest',behavior:'auto'});expect(notice.focus).toHaveBeenCalledWith({preventScroll:true});expect(mounted.text()).toContain(expected);expect(mounted.text()).toContain(_kind==='ambiguous'?'Second source.':'Original body.');expect(ipc.readTaskEvidence).toHaveBeenCalledTimes(1);mounted.click('document-anchor-return');await settle();expect(mounted.all().some(node=>node.props['data-testid']==='document-anchor-notice')).toBe(false);expect(mounted.text()).toContain(_kind==='ambiguous'?'Second source.':'Original body.');});
 it('does not show failure status or divert focus for a successful local anchor',async()=>{const ipc=bridge(),initial=readView('session-1','# Visible heading\n[Go](#visible-heading)');if(initial.result.ok&&initial.result.content.kind==='text')initial.result.content.mime='text/markdown';ipc.readTaskEvidence.mockResolvedValueOnce(initial);const mounted=mount();await settle();mounted.click('session-1');await settle();mounted.click('Go');await settle();expect(mounted.all().some(node=>node.props['data-testid']==='document-anchor-notice')).toBe(false);const heading=mounted.all().find(node=>node.props['data-markdown-anchor']==='visible-heading')!;expect(heading.focus).toHaveBeenCalledWith({preventScroll:true});expect(ipc.readTaskEvidence).toHaveBeenCalledTimes(1);});

});
