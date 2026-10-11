import {readFileSync} from 'node:fs';
import {compileScript,compileStyle,compileTemplate,parse} from '@vue/compiler-sfc';
import {transformSync} from 'esbuild';
import {afterEach,describe,expect,it,vi} from 'vitest';
import * as Vue from 'vue';
import {createRenderer,h,nextTick,reactive,ssrContextKey,type Component,type RenderFunction} from 'vue';
import ProjectDocuments from '../../src/renderer/components/ProjectDocuments.vue';
import {defaultWorkspaceState} from '../../src/shared/workspace-state';
import {documentScopeState} from '../../src/renderer/phase2-state';
import type {ProjectDocumentCatalog,ProjectDocumentEntry,ProjectDocumentListing} from '../../src/shared/documents';
import type {NoteAppBridge} from '../../src/shared/bridge';
vi.mock('primevue/button',()=>({default:Vue.defineComponent({props:{label:String,disabled:Boolean},setup:(props,{attrs})=>()=>h('button',{...attrs,disabled:props.disabled},props.label)})}));
vi.mock('../../src/renderer/components/DocumentViewer.vue',()=>({default:Vue.defineComponent({props:{selection:Object,restoreAnchor:String,restoreScroll:Number},setup:props=>()=>h('section',{'data-testid':'viewer-stub','data-anchor':props.restoreAnchor,'data-scroll':props.restoreScroll},'Opened document')})}));
interface Host {type:string;text:string;parent:Host|null;children:Host[];props:Record<string,unknown>;style:Record<string,string>;tagName:string;scrollTop:number;value:string;getRootNode:()=>{activeElement:null};addEventListener:()=>void;removeEventListener:()=>void;focus:()=>void;querySelector:()=>null;querySelectorAll:()=>Host[]}
function host(type:string,text=''):Host{return{type,text,parent:null,children:[],props:{},style:{},tagName:type.toUpperCase(),scrollTop:0,value:'',getRootNode:()=>({activeElement:null}),addEventListener:()=>{},removeEventListener:()=>{},focus:()=>{},querySelector:()=>null,querySelectorAll:()=>[]};}
const filename=new URL('../../src/renderer/components/ProjectDocuments.vue',import.meta.url),descriptor=parse(readFileSync(filename,'utf8'),{filename:filename.pathname}).descriptor;
const compiled=compileTemplate({source:descriptor.template!.content,filename:filename.pathname,id:'project-documents',compilerOptions:{mode:'function',bindingMetadata:compileScript(descriptor,{id:'project-documents'}).bindings}});
if(compiled.errors.length)throw Error(compiled.errors.map(String).join('\n'));
const component={...ProjectDocuments,render:new Function('Vue',transformSync(compiled.code,{loader:'ts',target:'es2022'}).code)(Vue) as RenderFunction} as Component;

const scopeStyles=compileStyle({source:readFileSync(new URL('../../src/renderer/style.css',import.meta.url),'utf8')+'\n'+descriptor.styles.map(style=>style.content).join('\n'),filename:filename.pathname,id:'scope-layout'});
if(scopeStyles.errors.length)throw Error(scopeStyles.errors.map(String).join('\n'));
// A CSS contract, not a browser layout simulation: include the global notice row and
// matching media rules so a future class/style regression cannot restore the columns.
function scopeCssAt(selectors:string[],width:number){
 const output:Record<string,string>={};
 scopeStyles.rawResult!.root.walkRules(rule=>{
  if(!rule.selectors.some(selector=>selectors.includes(selector)))return;
  for(let parent=rule.parent;parent&&parent.type!=='root';parent=parent.parent){
   if(parent.type!=='atrule'||parent.name!=='media')continue;
   const max=/max-width\s*:\s*(\d+)px/u.exec(parent.params),min=/min-width\s*:\s*(\d+)px/u.exec(parent.params);
   if((max&&width>Number(max[1]))||(min&&width<Number(min[1])))return;
  }
  rule.walkDecls(declaration=>{output[declaration.prop]=declaration.value;});
 });return output;
}
const unmounts:(()=>void)[]=[];afterEach(()=>{unmounts.splice(0).forEach(unmount=>unmount());vi.useRealTimers();vi.unstubAllGlobals();});
function mount(state=reactive(defaultWorkspaceState()),accepted=true,viewProps=reactive({active:true,current:true})){
 documentScopeState('project').accepted=accepted;documentScopeState('project').mutating=false;
 const insert=(node:Host,parent:Host,before?:Host|null)=>{if(node.parent)node.parent.children.splice(node.parent.children.indexOf(node),1);node.parent=parent;const index=before?parent.children.indexOf(before):-1;if(index<0)parent.children.push(node);else parent.children.splice(index,0,node);};
 const renderer=createRenderer<Host,Host>({patchProp:(node,key,_before,value)=>{node.props[key]=value;},insert,remove:node=>{if(node.parent)node.parent.children.splice(node.parent.children.indexOf(node),1);node.parent=null;},createElement:type=>host(type),createText:text=>host('text',text),createComment:text=>host('comment',text),setText:(node,text)=>{node.text=text;},setElementText:(node,text)=>{node.text=text;node.children=[];},parentNode:node=>node.parent,nextSibling:node=>node.parent?.children[node.parent.children.indexOf(node)+1]??null,insertStaticContent:(content,parent,before)=>{const node=host('static',content);insert(node,parent,before);return[node,node];}});
 const root=host('root'),app=renderer.createApp({render:()=>h(component,{workstreamId:'project',projectTitle:'Synthetic project',state,...viewProps})});app.provide(ssrContextKey,{modules:new Set()});app.mount(root);unmounts.push(()=>app.unmount());
 const all=()=>{const nodes:Host[]=[];const walk=(node:Host)=>{nodes.push(node);node.children.forEach(walk);};walk(root);return nodes;};
 const byTest=(id:string)=>{const node=all().find(node=>node.props['data-testid']===id);expect(node,`test id ${id}`).toBeDefined();return node!;};
 const click=(name:string)=>{const node=all().find(node=>node.type==='button'&&(node.props['aria-label']===name||node.text===name||node.props['data-testid']===name));expect(node).toBeDefined();(node!.props.onClick as (event:unknown)=>void)({currentTarget:node});};
 const search=(text:string)=>{const input=byTest('document-filename-search');(input.props['onUpdate:modelValue'] as (value:string)=>void)(text);(input.props.onInput as ()=>void)();};
 return{all,byTest,click,search,state,text:()=>all().map(node=>node.text).join('\n')};
}
const catalog:ProjectDocumentCatalog={catalogId:'catalog',revision:'revision',rootDirectoryId:'virtual',scopeLabel:'Synthetic scope',observedAt:'2026-10-09T00:00:00Z'};
function entry(id:string,relativePath:string,kind:'directory'|'file'='file'):ProjectDocumentEntry{return{id,kind,name:relativePath.split('/').pop()||'Project note',relativePath,navigationKey:'rootkey/'+relativePath,scopeLabel:'Project note',relationships:[],...(kind==='file'?{format:'markdown' as const}:{})};}
function listing(directoryId:string,entries:ProjectDocumentEntry[]):ProjectDocumentListing{return{catalogId:'catalog',revision:'revision',directoryId,breadcrumbs:[{id:'virtual',name:'Folders'}],entries,nextCursor:null,partial:false,omissions:[],observedAt:'2026-10-09T00:00:00Z'};}
function deferred<T>(){let resolve!:(value:T)=>void;return{promise:new Promise<T>(done=>{resolve=done;}),resolve:(value:T)=>resolve(value)};}
async function settle(){for(let i=0;i<40;i++){await nextTick();await Promise.resolve();}}
function bridge(){vi.stubGlobal('Document',class{});vi.stubGlobal('ShadowRoot',class{});const api={selectProjectDocumentRoot:vi.fn<NoteAppBridge['selectProjectDocumentRoot']>().mockResolvedValue(null),prepareProjectDocuments:vi.fn<NoteAppBridge['prepareProjectDocuments']>().mockResolvedValue(catalog),listProjectDocuments:vi.fn<NoteAppBridge['listProjectDocuments']>(),openCatalogDocument:vi.fn<NoteAppBridge['openCatalogDocument']>().mockImplementation(async request=>({sessionId:'session-'+request.documentId,items:[{evidenceId:'evidence-'+request.documentId,registrationId:request.documentId,label:request.documentId,origin:'synthetic',anchor:null}],unsupportedCount:0})),releaseProjectDocuments:vi.fn().mockResolvedValue(undefined),releaseTaskEvidence:vi.fn().mockResolvedValue(undefined),getProjectDocumentRoots:vi.fn<NoteAppBridge['getProjectDocumentRoots']>().mockResolvedValue({projectId:'project',revision:null,editable:false,roots:[]}),cancelProjectDocumentRoot:vi.fn<NoteAppBridge['cancelProjectDocumentRoot']>().mockResolvedValue(undefined),confirmProjectDocumentRoot:vi.fn<NoteAppBridge['confirmProjectDocumentRoot']>().mockResolvedValue({projectId:'project',revision:1,editable:true,roots:[]}),revokeProjectDocumentRoot:vi.fn<NoteAppBridge['revokeProjectDocumentRoot']>().mockResolvedValue({projectId:'project',revision:2,editable:true,roots:[]})};vi.stubGlobal('window',{noteApp:api});return api;}
describe('Phase4 project document metadata navigation',()=>{
 it('does not enumerate any file names until scope consent',async()=>{const api=bridge();mount(undefined,false);await settle();expect(api.prepareProjectDocuments).not.toHaveBeenCalled();expect(api.listProjectDocuments).not.toHaveBeenCalled();expect(api.openCatalogDocument).not.toHaveBeenCalled();});
 it('serializes delayed filename searches and coalesces to the latest query',async()=>{vi.useFakeTimers();const api=bridge(),first=deferred<ProjectDocumentListing>(),second=deferred<ProjectDocumentListing>();api.listProjectDocuments.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);const view=mount();await settle();view.search('first');await vi.advanceTimersByTimeAsync(221);view.search('latest');await vi.advanceTimersByTimeAsync(221);expect(api.listProjectDocuments).toHaveBeenCalledTimes(1);first.resolve(listing('virtual',[entry('obsolete','obsolete.md')]));await settle();expect(api.listProjectDocuments).toHaveBeenCalledTimes(2);expect(api.listProjectDocuments).toHaveBeenLastCalledWith({catalogId:'catalog',directoryId:'virtual',query:'latest'});second.resolve(listing('virtual',[entry('latest','latest.md')]));await settle();expect(view.text()).toContain('latest.md');expect(view.text()).not.toContain('obsolete.md');expect(view.text()).not.toContain('파일 목록을 확인할 수 없습니다');expect(api.openCatalogDocument).not.toHaveBeenCalled();});
 it('restores a stored document only through freshly issued exact directory/file IDs and resets the anchor for another file',async()=>{const api=bridge(),state=reactive({...defaultWorkspaceState(),documentFolder:'rootkey/nested',documentPath:'rootkey/nested/last.md',documentAnchor:'last-section',documentScroll:321});api.listProjectDocuments.mockImplementation(async request=>request.directoryId==='virtual'?listing('virtual',[entry('root','', 'directory')]):request.directoryId==='root'?listing('root',[entry('folder','nested','directory')]):listing('folder',[entry('last','nested/last.md'),entry('other','nested/other.md')]));const view=mount(state);await settle();expect(api.openCatalogDocument).toHaveBeenCalledExactlyOnceWith({catalogId:'catalog',documentId:'last'});expect(view.byTest('viewer-stub').props['data-anchor']).toBe('last-section');expect(view.byTest('viewer-stub').props['data-scroll']).toBe(321);expect(api.listProjectDocuments.mock.calls.every(([request])=>!Object.hasOwn(request,'path'))).toBe(true);view.click('other.md');await settle();expect(api.openCatalogDocument).toHaveBeenLastCalledWith({catalogId:'catalog',documentId:'other'});expect(view.state.documentAnchor).toBe('');expect(view.state.documentScroll).toBe(0);(view.byTest('viewer-stub').props.onClose as ()=>void)();await settle();expect(view.state.documentPath).toBe('');expect(api.releaseTaskEvidence).toHaveBeenCalledWith({sessionId:'session-last'});expect(api.releaseTaskEvidence).toHaveBeenCalledWith({sessionId:'session-other'});});
 it('does not substitute a similarly named file when the restored identity is missing',async()=>{const api=bridge();api.listProjectDocuments.mockResolvedValue(listing('virtual',[entry('new-root','', 'directory')]));const view=mount(reactive({...defaultWorkspaceState(),documentPath:'retiredroot/context.md'}));await settle();expect(api.openCatalogDocument).not.toHaveBeenCalled();expect(view.text()).toContain('현재 목록에서 확인하지 못했습니다');});
 it('cancels delayed saved-folder restoration when a newer search and file selection wins',async()=>{vi.useFakeTimers();const api=bridge(),folder=deferred<ProjectDocumentListing>();api.listProjectDocuments.mockImplementation(async request=>request.query==='new'?listing('virtual',[entry('new','new.md')]):request.directoryId==='virtual'?listing('virtual',[entry('root','','directory')]):request.directoryId==='root'?listing('root',[entry('folder','nested','directory')]):folder.promise);const view=mount(reactive({...defaultWorkspaceState(),documentFolder:'rootkey/nested',documentPath:'rootkey/nested/old.md',documentAnchor:'old-heading',documentScroll:900}));await settle();expect(api.listProjectDocuments).toHaveBeenLastCalledWith({catalogId:'catalog',directoryId:'folder'});view.search('new');await vi.advanceTimersByTimeAsync(221);folder.resolve(listing('folder',[entry('old','nested/old.md')]));await settle();expect(api.openCatalogDocument).not.toHaveBeenCalled();view.click('new.md');await settle();expect(api.openCatalogDocument).toHaveBeenCalledExactlyOnceWith({catalogId:'catalog',documentId:'new'});expect(view.state.documentPath).toBe('rootkey/new.md');expect(view.state.documentAnchor).toBe('');expect(view.state.documentScroll).toBe(0);expect(view.byTest('viewer-stub').props['data-anchor']).toBe('');});

 it('does not open a catalog file while the shared viewer reports an active recheck',async()=>{const api=bridge();api.listProjectDocuments.mockResolvedValue(listing('virtual',[entry('first','first.md'),entry('second','second.md')]));const view=mount();await settle();view.click('first.md');await settle();const updateBusy=view.byTest('viewer-stub').props.onBusy as (value:boolean)=>void;updateBusy(true);await settle();const second=view.all().find(node=>node.props['aria-label']==='second.md')!;expect(second.props.disabled).toBe(true);view.click('second.md');await settle();expect(api.openCatalogDocument).toHaveBeenCalledTimes(1);updateBusy(false);await settle();view.click('second.md');await settle();expect(api.openCatalogDocument).toHaveBeenLastCalledWith({catalogId:'catalog',documentId:'second'});});

 it('reports a canceled native folder selection without implying a grant or error, and clears the status on retry',async()=>{const api=bridge();api.getProjectDocumentRoots.mockResolvedValue({projectId:'project',revision:null,editable:true,roots:[]});const view=mount(undefined,false);await settle();view.click('document-root-add-review');await settle();expect(api.selectProjectDocumentRoot).toHaveBeenCalledWith({projectId:'project',kind:'review'});expect(view.byTest('document-root-status').props.role).toBe('status');expect(view.text()).toContain('문서 폴더 선택을 취소했습니다. 연결 범위는 변경되지 않았습니다.');expect(view.text()).not.toContain('문서 폴더를 선택하지 못했습니다');const retry=deferred<null>();api.selectProjectDocumentRoot.mockReturnValueOnce(retry.promise);view.click('document-root-add-review');await settle();expect(view.text()).not.toContain('문서 폴더 선택을 취소했습니다');retry.resolve(null);await settle();expect(view.text()).toContain('문서 폴더 선택을 취소했습니다');expect(api.prepareProjectDocuments).not.toHaveBeenCalled();});

 it.each(['document-root-add-docs','document-root-add-review'])('restores focus to %s after native picker cancellation and re-enabling',async id=>{
  const api=bridge(),pending=deferred<null>();api.getProjectDocumentRoots.mockResolvedValue({projectId:'project',revision:null,editable:true,roots:[]});api.selectProjectDocumentRoot.mockReturnValue(pending.promise);
  const view=mount(undefined,false);await settle();const origin=view.byTest(id),focus=vi.fn(()=>expect(origin.props.disabled).toBe(false));const body={},documentElement={},ownerDocument={body,documentElement,activeElement:id==='document-root-add-docs'?body:documentElement};Object.assign(origin,{isConnected:true,disabled:false,focus,ownerDocument});
  view.click(id);await settle();expect(origin.props.disabled).toBe(true);expect(focus).not.toHaveBeenCalled();pending.resolve(null);await settle();expect(focus).toHaveBeenCalledExactlyOnceWith({preventScroll:true});expect(api.confirmProjectDocumentRoot).not.toHaveBeenCalled();
 });
 it.each(['inactive','stale','removed','new-focus'])('does not steal focus after picker cancellation when %s',async reason=>{
  const api=bridge(),pending=deferred<null>();api.getProjectDocumentRoots.mockResolvedValue({projectId:'project',revision:null,editable:true,roots:[]});api.selectProjectDocumentRoot.mockReturnValue(pending.promise);
  const viewProps=reactive({active:true,current:true}),view=mount(undefined,false,viewProps);await settle();const origin=view.byTest('document-root-add-review'),focus=vi.fn();Object.assign(origin,{isConnected:true,disabled:false,focus});view.click('document-root-add-review');await settle();
  if(reason==='inactive')viewProps.active=false;if(reason==='stale')viewProps.current=false;if(reason==='removed')Object.assign(origin,{isConnected:false});if(reason==='new-focus')Object.assign(origin,{ownerDocument:{activeElement:{},body:{},documentElement:{}}});pending.resolve(null);await settle();expect(focus).not.toHaveBeenCalled();
 });

 it('keeps the complete proposed path, consent and actions in separate full-width rows',async()=>{
  const api=bridge(),path='/synthetic/project-documents/'+('long-folder-name-'.repeat(20))+'/검토 기록';
  api.getProjectDocumentRoots.mockResolvedValue({projectId:'project',revision:null,editable:true,roots:[]});
  api.selectProjectDocumentRoot.mockResolvedValue({projectId:'project',proposalId:'proposal',path,kind:'review',expiresAt:Date.now()+120000});
  const view=mount(undefined,false);await settle();view.click('document-root-add-review');await settle();
  const proposal=view.byTest('document-root-proposal'),pathRow=view.byTest('document-root-proposal-path'),checkbox=view.byTest('document-root-confirm-checkbox'),confirm=view.byTest('document-root-confirm');
  expect(proposal.props.class).toContain('document-scope-confirmation');expect(pathRow.text).toBe(path);expect(pathRow.parent).toBe(proposal);
  expect(checkbox.parent?.props.class).toBe('document-scope-confirmation-check');expect(checkbox.parent?.parent).toBe(proposal);
  expect(confirm.parent?.props.class).toBe('document-scope-actions');expect(confirm.parent?.parent).toBe(proposal);expect(confirm.props.disabled).toBe(true);
  view.click('document-root-confirm');await settle();expect(api.confirmProjectDocumentRoot).not.toHaveBeenCalled();
  (checkbox.props['onUpdate:modelValue'] as (value:boolean)=>void)(true);await settle();expect(confirm.props.disabled).toBe(false);
  view.click('document-root-confirm');await settle();expect(api.confirmProjectDocumentRoot).toHaveBeenCalledExactlyOnceWith({projectId:'project',proposalId:'proposal',readOnlyConfirmed:true});
 });

 it('keeps removal path and cancel/confirm actions in separate rows without changing the grant before confirmation',async()=>{
  const api=bridge(),path='/synthetic/project-documents/'+('long-folder-name-'.repeat(20))+'/docs';
  api.getProjectDocumentRoots.mockResolvedValue({projectId:'project',revision:1,editable:true,roots:[{id:'root',projectId:'project',path,kind:'docs',available:true}]});
  const view=mount(undefined,false);await settle();view.click('연결 해제');await settle();
  const removal=view.byTest('document-root-removal'),pathRow=view.byTest('document-root-removal-path'),confirm=view.all().find(node=>node.type==='button'&&node.text==='읽기 연결 해제')!;
  expect(removal.props.class).toContain('document-scope-confirmation');expect(pathRow.text).toBe(path);expect(pathRow.parent).toBe(removal);
  expect(confirm.parent?.props.class).toBe('document-scope-actions');expect(confirm.parent?.parent).toBe(removal);expect(view.text()).toContain('원본 파일은 삭제하지 않습니다');
  view.click('취소');await settle();expect(api.revokeProjectDocumentRoot).not.toHaveBeenCalled();expect(view.all().some(node=>node.props['data-testid']==='document-root-removal')).toBe(false);
  view.click('연결 해제');await settle();view.click('읽기 연결 해제');await settle();expect(api.revokeProjectDocumentRoot).toHaveBeenCalledExactlyOnceWith({projectId:'project',rootId:'root',expectedRevision:1,confirmed:true});
 });

 it.each([1280,760,375])('retains a single-column scope confirmation and readable actions at %ipx in the CSS contract',width=>{
  expect(scopeCssAt(['.notice','.document-scope-confirmation'],width)).toMatchObject({display:'grid','grid-template-columns':'minmax(0,1fr)','align-items':'start','min-width':'0'});
  expect(scopeCssAt(['.document-scope-confirmation>*'],width)).toMatchObject({'min-width':'0',margin:'0'});
  expect(scopeCssAt(['.notice strong','.document-scope-confirmation>strong'],width)['white-space']).toBe('normal');
  expect(scopeCssAt(['.document-scope-confirmation .document-scope-path'],width)).toMatchObject({'overflow-wrap':'anywhere','word-break':'normal'});
  expect(scopeCssAt(['.document-scope-confirmation-check input'],width).flex).toBe('0 0 auto');
  expect(scopeCssAt(['.document-scope-actions','.document-scope-confirmation .document-scope-actions'],width)).toMatchObject({display:'flex','flex-wrap':'wrap'});
  const buttons=scopeCssAt(['.document-scope-confirmation .document-scope-actions>button'],width);
  expect(buttons).toMatchObject({flex:'0 0 auto','max-width':'100%','white-space':'normal','word-break':'keep-all'});
  if(width<=600){expect(scopeCssAt(['.document-scope-confirmation .document-scope-actions'],width)['flex-direction']).toBe('column');expect(buttons.width).toBe('100%');}
 });

});
