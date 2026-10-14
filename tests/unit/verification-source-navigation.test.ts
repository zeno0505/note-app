import {readFileSync} from 'node:fs';
import {compileScript,compileTemplate,parse} from '@vue/compiler-sfc';
import {transformSync} from 'esbuild';
import {afterEach,describe,it,expect,vi} from 'vitest';
import * as Vue from 'vue';
import {createRenderer,h,nextTick,reactive,ref,ssrContextKey,type Component,type RenderFunction} from 'vue';
import EvidenceViewer from '../../src/renderer/components/EvidenceViewer.vue';
import type {EvidenceList} from '../../src/shared/evidence';
vi.mock('primevue/button',()=>({default:Vue.defineComponent({props:{label:String,disabled:Boolean},setup:(props,{attrs})=>()=>h('button',{...attrs,disabled:props.disabled},props.label)})}));
vi.mock('../../src/renderer/components/DocumentViewer.vue',()=>({default:Vue.defineComponent({props:['selection','active'],setup:props=>()=>h('section',{'data-testid':'stub-document','data-selected':props.selection.id})})}));
const file=new URL('../../src/renderer/components/EvidenceViewer.vue',import.meta.url),descriptor=parse(readFileSync(file,'utf8'),{filename:file.pathname}).descriptor;
const template=compileTemplate({source:descriptor.template!.content,filename:file.pathname,id:'verification-navigation',compilerOptions:{mode:'function',bindingMetadata:compileScript(descriptor,{id:'verification-navigation'}).bindings}});
const component={...EvidenceViewer,render:new Function('Vue',transformSync(template.code,{loader:'ts',target:'es2022'}).code)(Vue) as RenderFunction} as Component;
interface Node{type:string;parent:Node|null;children:Node[];props:Record<string,any>;text:string;style:Record<string,string>;focus:()=>void;scrollIntoView:()=>void;closest:()=>null;addEventListener:()=>void;removeEventListener:()=>void;}
function node(type:string,text=''):Node{return {type,parent:null,children:[],props:{},text,style:{},focus:vi.fn(),scrollIntoView:vi.fn(),closest:()=>null,addEventListener:()=>{},removeEventListener:()=>{}};}
const cleanups:(()=>void)[]=[];afterEach(()=>{cleanups.splice(0).forEach(fn=>fn());vi.unstubAllGlobals();});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};};
async function settle(){for(let i=0;i<10;i++){await nextTick();await Promise.resolve();}}
const path='inbox/T-042/implementation.md';
function evidence(sessionId='fresh'):EvidenceList{return {sessionId,unsupportedCount:0,items:[{evidenceId:sessionId+'-file',registrationId:'implementation',relativePath:path,label:'implementation',anchor:null,origin:'synthetic'}]};}
function mount(){
 const bridge={prepareTaskEvidence:vi.fn(async()=>evidence()),releaseTaskEvidence:vi.fn(async()=>{})};vi.stubGlobal('window',{noteApp:bridge,scrollY:0});
 const insert=(child:Node,parent:Node,before?:Node|null)=>{if(child.parent)child.parent.children.splice(child.parent.children.indexOf(child),1);child.parent=parent;const index=before?parent.children.indexOf(before):-1;if(index<0)parent.children.push(child);else parent.children.splice(index,0,child);};
 const renderer=createRenderer<Node,Node>({patchProp:(element,key,_old,value)=>element.props[key]=value,insert,remove:element=>{if(element.parent)element.parent.children.splice(element.parent.children.indexOf(element),1);element.parent=null;},createElement:type=>node(type),createText:text=>node('text',text),createComment:text=>node('comment',text),setText:(element,text)=>element.text=text,setElementText:(element,text)=>{element.text=text;element.children=[];},parentNode:element=>element.parent,nextSibling:element=>element.parent?.children[element.parent.children.indexOf(element)+1]??null,insertStaticContent:(content,parent,before)=>{const element=node('static',content);insert(element,parent,before);return [element,element];}});
 const state=reactive({workstreamId:'source-navigation-unit',taskId:'T-042',sourceHash:'dag-a',current:true,active:true}),root=node('root'),viewer=ref<InstanceType<typeof EvidenceViewer>|null>(null);
 const app=renderer.createApp({render:()=>h(component,{...state,ref:viewer})});app.provide(ssrContextKey,{modules:new Set()});app.mount(root);cleanups.push(()=>app.unmount());
 const all=():Node[]=>{const result:Node[]=[];const visit=(element:Node)=>{result.push(element);element.children.forEach(visit);};visit(root);return result;};
 return {bridge,state,all,open:(relative=path)=>viewer.value!.openVerificationSource(relative),text:()=>all().map(element=>element.text).join('\n')};
}
describe('fresh verification source navigation',()=>{
 it('acquires new capabilities with discovery before selecting the exact relative path',async()=>{const m=mount();await settle();m.bridge.prepareTaskEvidence.mockResolvedValueOnce(evidence('navigation'));await m.open();await settle();expect(m.bridge.prepareTaskEvidence).toHaveBeenLastCalledWith({workstreamId:'source-navigation-unit',taskId:'T-042',sourceHash:'dag-a',discoverTaskRecords:true});expect(m.all().find(e=>e.props['data-testid']==='stub-document')?.props['data-selected']).toBe('navigation-file');});
 it('does not mount hidden reader after leaving and returning during pending discovery',async()=>{const m=mount();await settle();const pending=deferred<EvidenceList>();m.bridge.prepareTaskEvidence.mockReturnValueOnce(pending.promise);const opening=m.open();m.state.active=false;await settle();m.state.active=true;await settle();pending.resolve(evidence('late'));await opening;await settle();expect(m.all().some(e=>e.props['data-testid']==='stub-document')).toBe(false);});
 it('keeps ordinary reader persistence on tab changes',async()=>{const m=mount();await settle();await m.open();await settle();m.state.active=false;await settle();expect(m.all().some(e=>e.props['data-testid']==='stub-document')).toBe(true);});
 it('shows a recoverable error when a previously observed source disappears',async()=>{const m=mount();await settle();m.bridge.prepareTaskEvidence.mockResolvedValueOnce({sessionId:'empty',items:[],unsupportedCount:0});await m.open();await settle();expect(m.all().some(e=>e.props['data-testid']==='stub-document')).toBe(false);expect(m.text()).toContain('선택한 출처를 현재 태스크 문서에서 다시 찾지 못했습니다');});
});
