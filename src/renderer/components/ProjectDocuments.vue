<script setup lang="ts">
import {computed,nextTick,onMounted,onUnmounted,ref,watch} from 'vue';
import Button from 'primevue/button';
import DocumentViewer from './DocumentViewer.vue';
import {documentScopeState,type TaskWorkspaceState} from '../phase2-state';
import type {EvidenceList} from '../../shared/evidence';
import type {ProjectDocumentCatalog,ProjectDocumentEntry,ProjectDocumentListing} from '../../shared/documents';
import type {ProjectDocumentRootKind,ProjectDocumentRootProposal,ProjectDocumentRootsView,ProjectDocumentRootView} from '../../shared/project-document-roots';
const props=withDefaults(defineProps<{workstreamId:string;projectTitle:string;state:TaskWorkspaceState;current:boolean;active?:boolean;pickerActive?:boolean}>(),{active:true,pickerActive:true});
const scope=documentScopeState(props.workstreamId),confirmed=ref(false),catalog=ref<ProjectDocumentCatalog|null>(null),listing=ref<ProjectDocumentListing|null>(null),selection=ref<{session:EvidenceList;id:string;navigationRoot?:string}|null>(null);
const busy=ref(false),opening=ref(false),readingBusy=ref(false),error=ref(''),expanded=ref(false),query=ref(props.state.documentQuery),composing=ref(false),listPane=ref<HTMLElement|null>(null),viewerPane=ref<HTMLElement|null>(null),restoreNotice=ref('');
const roots=ref<ProjectDocumentRootsView|null>(null),proposal=ref<ProjectDocumentRootProposal|null>(null),rootConfirmed=ref(false),scopeBusy=ref(false),scopeError=ref(''),scopeNotice=ref(''),removal=ref<ProjectDocumentRootView|null>(null);
const shortcuts=computed(()=>listing.value?.entries.filter(entry=>entry.kind==='file'&&['context.md','dag.md','e2e-checklist.md'].includes(entry.name))??[]);
let generation=0,openGeneration=0,disposed=false,searchTimer:ReturnType<typeof setTimeout>|undefined,originId='',beforeExpandScroll=0,originPageScroll:number|null=null;
let rootTrigger:{element:HTMLButtonElement;projectId:string}|null=null;
let rootGeneration=0;
const sessions=new Set<string>(),entryKeys=new Map<string,string>();
type ListOptions={cursor?:string;refresh?:boolean;query?:string};
let pendingDirectory:{id:string;options:ListOptions}|null=null,listingFlight:Promise<void>|null=null,openedRootKey='',navigationIntent=0,restorationToken:number|null=null;
function stableKey(entry:ProjectDocumentEntry){return (entry.navigationKey??entry.relativePath).replace(/\/$/u,'');}
function release(){for(const sessionId of sessions)void window.noteApp.releaseTaskEvidence({sessionId}).catch(()=>{});sessions.clear();const prior=catalog.value;catalog.value=null;if(prior)void window.noteApp.releaseProjectDocuments({catalogId:prior.catalogId}).catch(()=>{});}
async function performDirectory(directoryId:string,options:ListOptions={}){
 const active=catalog.value;if(!active||!props.current)return;const own=++generation;busy.value=true;error.value='';
 try{const text=(options.query??query.value).trim().slice(0,256);const result=await window.noteApp.listProjectDocuments({catalogId:active.catalogId,directoryId,...(text?{query:text}:{}),...(options.cursor?{cursor:options.cursor}:{}),...(options.refresh?{refresh:true as const}:{})});
  if(disposed||own!==generation||pendingDirectory)return;listing.value=result;for(const entry of result.entries)entryKeys.set(entry.id,stableKey(entry));props.state.documentQuery=text;props.state.documentFolder=directoryId===active.rootDirectoryId?'':entryKeys.get(directoryId)??props.state.documentFolder;
  await nextTick();if(listPane.value)listPane.value.scrollTop=0;props.state.documentListScroll=0;
 }catch{if(!disposed&&own===generation&&!pendingDirectory){listing.value=null;error.value='파일 목록을 확인할 수 없습니다. 읽기 범위나 연결이 바뀌었을 수 있습니다. 범위를 다시 확인한 뒤 목록을 열어 주세요.';}}
 finally{if(!disposed&&own===generation)busy.value=false;}
}
function loadDirectory(id:string,options:ListOptions={}):Promise<void>{
 pendingDirectory={id,options};
 if(!listingFlight)listingFlight=(async()=>{while(pendingDirectory&&!disposed){const next: {id:string;options:ListOptions}=pendingDirectory;pendingDirectory=null;await performDirectory(next.id,next.options);}})().finally(()=>{listingFlight=null;});
 return listingFlight;
}
function cancelRestoration(){navigationIntent++;if(restorationToken!==null){restorationToken=null;openGeneration++;opening.value=false;}}
function restorationCurrent(token:number){return !disposed&&navigationIntent===token&&restorationToken===token;}
async function findListed(key:string,token:number):Promise<ProjectDocumentEntry|null>{
 for(let page=0;page<50&&restorationCurrent(token);page++){
  const current=listing.value;const match=current?.entries.find(entry=>stableKey(entry)===key);if(match)return match;
  if(!current?.nextCursor||current.partial)return null;await loadDirectory(current.directoryId,{query:'',cursor:current.nextCursor});
 }
 return null;
}
async function restoreNavigation(pathKey:string,folderKey:string,scroll:number,anchor:string,token:number){
 if(!restorationCurrent(token))return false;
 const rootRows=listing.value?.entries??[],target=pathKey||folderKey,rootEntry=rootRows.find(entry=>entry.kind==='directory'&&(target===stableKey(entry)||target.startsWith(stableKey(entry)+'/')));
 if(!rootEntry)return false;let directory=rootEntry;const targetFolder=pathKey?pathKey.slice(0,pathKey.lastIndexOf('/')):folderKey;
 await loadDirectory(directory.id,{query:''});if(!restorationCurrent(token))return false;
 const relative=targetFolder.slice(stableKey(rootEntry).length).replace(/^\//u,'');let prefix=stableKey(rootEntry);
 for(const segment of relative.split('/').filter(Boolean).slice(0,16)){prefix+='/'+segment;const found=await findListed(prefix,token);if(!restorationCurrent(token)||!found||found.kind!=='directory')return false;directory=found;await loadDirectory(directory.id,{query:''});if(!restorationCurrent(token))return false;}
 if(pathKey){const file=await findListed(pathKey,token);if(!restorationCurrent(token)||!file||file.kind!=='file')return false;props.state.documentAnchor=anchor;props.state.documentScroll=scroll;await openEntry(file,true,token);await nextTick();if(!restorationCurrent(token))return false;if(viewerPane.value)viewerPane.value.scrollTop=scroll;}
 return true;
}
async function start(){
 if(!scope.accepted||!props.current||busy.value)return;cancelRestoration();const intent=navigationIntent,own=++generation;openGeneration++;busy.value=true;readingBusy.value=false;selection.value=null;expanded.value=false;release();listing.value=null;error.value='';restoreNotice.value='';
 try{const result=await window.noteApp.prepareProjectDocuments({workstreamId:props.workstreamId});if(disposed||own!==generation){void window.noteApp.releaseProjectDocuments({catalogId:result.catalogId}).catch(()=>{});return;}catalog.value=result;busy.value=false;
  // Restored display keys are compared against freshly enumerated metadata. Never passed as a read capability.
  const restorePath=props.state.documentPath,folderKey=props.state.documentFolder,restoreScroll=props.state.documentScroll,restoreAnchor=props.state.documentAnchor,restoreQuery=query.value;await loadDirectory(result.rootDirectoryId,{query:restorePath||folderKey?'':restoreQuery});
  if(disposed||navigationIntent!==intent||catalog.value?.catalogId!==result.catalogId)return;
  if(restorePath||folderKey){restorationToken=intent;const restored=await restoreNavigation(restorePath,folderKey,restoreScroll,restoreAnchor,intent);if(!restorationCurrent(intent))return;restorationToken=null;if(!restored)restoreNotice.value='이전에 보던 문서 또는 폴더를 현재 목록에서 확인하지 못했습니다. 자동으로 다른 파일을 열지 않습니다.';else restoreNotice.value='이전 위치의 파일과 읽기 권한을 다시 확인했습니다.';}
  else {const initial=listing.value as ProjectDocumentListing|null;if(!restoreQuery&&initial?.entries.length===1&&initial.entries[0].kind==='directory')await loadDirectory(initial.entries[0].id,{query:''});}
  if(navigationIntent===intent&&(restorePath||folderKey)&&query.value===restoreQuery&&restoreQuery)await loadDirectory(result.rootDirectoryId,{query:restoreQuery});
 }catch{if(!disposed&&own===generation)error.value='프로젝트 문서 범위를 준비하지 못했습니다. 연결된 프로젝트 노트 또는 별도로 허용한 문서 폴더를 확인해 주세요.';}
 finally{if(!disposed&&own===generation)busy.value=false;}
}
function accept(){if(!confirmed.value)return;scope.accepted=true;}
async function openEntry(entry:ProjectDocumentEntry,restoring=false,restoreToken?:number){
 if(!restoring&&readingBusy.value)return;
 if(restoring){if(restoreToken===undefined||!restorationCurrent(restoreToken))return;}else cancelRestoration();
 if(entry.kind==='directory'){query.value='';await loadDirectory(entry.id,{query:''});return;}
 if(!catalog.value||opening.value)return;if(!restoring||originPageScroll===null)originPageScroll=window.scrollY??0;const own=++openGeneration;opening.value=true;error.value='';originId=entry.id;
 try{const session=await window.noteApp.openCatalogDocument({catalogId:catalog.value.catalogId,documentId:entry.id});if(disposed||own!==openGeneration||(restoring&&!restorationCurrent(restoreToken!))){void window.noteApp.releaseTaskEvidence({sessionId:session.sessionId}).catch(()=>{});return;}sessions.add(session.sessionId);if(!session.items.length){error.value='선택한 파일을 읽기 문서로 등록하지 못했습니다. 목록을 다시 확인해 주세요.';return;}const different=props.state.documentPath!==stableKey(entry);if(!restoring&&different){props.state.documentScroll=0;props.state.documentAnchor='';}openedRootKey=stableKey(entry).split('/')[0];props.state.documentPath=stableKey(entry);selection.value={session,id:session.items[0].evidenceId,navigationRoot:openedRootKey};restoreNotice.value='';await nextTick();if(disposed||own!==openGeneration||(restoring&&!restorationCurrent(restoreToken!)))return;viewerPane.value?.querySelector<HTMLElement>('[data-testid=document-viewer]')?.focus?.({preventScroll:true});}
 catch{if(!disposed&&own===openGeneration)error.value='선택한 파일이 없거나 읽기 범위가 변경되었습니다. 목록을 새로고침한 뒤 다시 선택해 주세요.';}
 finally{if(!disposed&&own===openGeneration)opening.value=false;}
}
async function closeDocument(){cancelRestoration();props.state.documentPath='';props.state.documentAnchor='';props.state.documentScroll=0;for(const sessionId of sessions)void window.noteApp.releaseTaskEvidence({sessionId}).catch(()=>{});sessions.clear();readingBusy.value=false;selection.value=null;expanded.value=false;openGeneration++;opening.value=false;await nextTick();if(disposed)return;if(originPageScroll!==null)window.scrollTo?.({top:originPageScroll,behavior:'auto'});originPageScroll=null;let focused=false;listPane.value?.querySelectorAll<HTMLElement>('[data-document-id]').forEach(button=>{if(button.dataset.documentId===originId){button.focus?.({preventScroll:true});focused=true;}});if(!focused)listPane.value?.focus?.({preventScroll:true});}
async function expand(value:boolean){if(value===expanded.value)return;if(value)beforeExpandScroll=viewerPane.value?.scrollTop??0;expanded.value=value;await nextTick();if(!value&&viewerPane.value)viewerPane.value.scrollTop=beforeExpandScroll;}
function search(event?:Event){cancelRestoration();if(composing.value||(typeof InputEvent!=='undefined'&&event instanceof InputEvent&&event.isComposing))return;if(searchTimer)clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(catalog.value)void loadDirectory(catalog.value.rootDirectoryId);},220);}
function browseDirectory(id:string){cancelRestoration();query.value='';void loadDirectory(id,{query:''});}
function refreshListing(){cancelRestoration();if(catalog.value)void loadDirectory(listing.value?.directoryId??catalog.value.rootDirectoryId,{refresh:true});else void start();}
function nextListing(){cancelRestoration();if(listing.value?.nextCursor)void loadDirectory(listing.value.directoryId,{cursor:listing.value.nextCursor});}
function savePosition(value:{path:string;navigationKey?:string;scroll:number;anchor:string;mode:'formatted'|'raw'}){if(value.navigationKey&&!value.navigationKey.startsWith('/')&&!value.navigationKey.split('/').some(part=>part==='..'||part==='.'))props.state.documentPath=value.navigationKey;props.state.documentAnchor=value.anchor;props.state.documentMode=value.mode;if(expanded.value)props.state.documentScroll=value.scroll;}
async function readRoots(){try{roots.value=await window.noteApp.getProjectDocumentRoots({projectId:props.workstreamId});}catch{scopeError.value='별도로 연결한 문서 폴더를 확인하지 못했습니다.';}}
async function chooseRoot(kind:ProjectDocumentRootKind,event:MouseEvent){
 const origin=event.currentTarget as HTMLButtonElement|null,projectId=props.workstreamId,own=++rootGeneration;
 rootTrigger=origin?{element:origin,projectId}:null;
 scopeBusy.value=true;scopeError.value='';scopeNotice.value='';rootConfirmed.value=false;let cancelled=false;
 try{const selected=await window.noteApp.selectProjectDocumentRoot({projectId,kind});if(disposed||own!==rootGeneration||!props.pickerActive||props.workstreamId!==projectId){if(selected)await window.noteApp.cancelProjectDocumentRoot({projectId,proposalId:selected.proposalId}).catch(()=>{});return;}proposal.value=selected;cancelled=!proposal.value;if(cancelled)scopeNotice.value='문서 폴더 선택을 취소했습니다. 연결 범위는 변경되지 않았습니다.';}
 catch{if(!disposed&&own===rootGeneration){cancelled=true;scopeError.value='문서 폴더를 선택하지 못했습니다. 현재 연결과 설정을 확인해 주세요.';}}
 finally{
  if(own===rootGeneration)scopeBusy.value=false;await nextTick();
  // Native dialogs may return focus to the document root while the initiator is disabled.
  // Restore only this still-active view; never steal focus from a newer control/navigation.
  const owner=origin?.ownerDocument,active=owner?.activeElement;
  if(cancelled&&own===rootGeneration&&!disposed&&props.active&&props.current&&props.workstreamId===projectId&&origin?.isConnected&&!origin.disabled&&(!active||active===owner?.body||active===owner?.documentElement||active===origin))origin.focus({preventScroll:true});
 }
}
async function cancelRoot(){const current=proposal.value,trigger=rootTrigger;rootTrigger=null;proposal.value=null;rootConfirmed.value=false;if(current)await window.noteApp.cancelProjectDocumentRoot({projectId:current.projectId,proposalId:current.proposalId}).catch(()=>{});await nextTick();const owner=trigger?.element.ownerDocument,active=owner?.activeElement;if(trigger&&!disposed&&props.active&&props.current&&props.workstreamId===trigger.projectId&&trigger.element.isConnected&&!trigger.element.disabled&&(!active||active===owner?.body||active===owner?.documentElement||active===trigger.element))trigger.element.focus({preventScroll:true});}
function invalidateCatalog(){cancelRestoration();readingBusy.value=false;generation++;openGeneration++;pendingDirectory=null;busy.value=false;opening.value=false;selection.value=null;listing.value=null;expanded.value=false;release();scope.epoch++;}
async function confirmRoot(){if(!proposal.value||!rootConfirmed.value)return;scopeBusy.value=true;scopeError.value='';scope.mutating=true;invalidateCatalog();try{roots.value=await window.noteApp.confirmProjectDocumentRoot({projectId:props.workstreamId,proposalId:proposal.value.proposalId,readOnlyConfirmed:true});proposal.value=null;rootConfirmed.value=false;if(scope.accepted)await start();}catch{scopeError.value='문서 폴더 연결을 확인하지 못했습니다. 선택을 다시 확인해 주세요.';}finally{scope.mutating=false;scopeBusy.value=false;}}
async function removeRoot(){if(!removal.value||!roots.value)return;scopeBusy.value=true;scopeError.value='';scope.mutating=true;invalidateCatalog();try{roots.value=await window.noteApp.revokeProjectDocumentRoot({projectId:props.workstreamId,rootId:removal.value.id,expectedRevision:roots.value.revision,confirmed:true});removal.value=null;selection.value=null;if(scope.accepted)await start();}catch{scopeError.value='문서 폴더 연결 해제를 확인하지 못했습니다. 현재 범위를 다시 확인해 주세요.';await readRoots();}finally{scope.mutating=false;scopeBusy.value=false;}}
watch(()=>scope.accepted,accepted=>{if(accepted)void start();else{generation++;openGeneration++;readingBusy.value=false;selection.value=null;listing.value=null;release();}});
watch(()=>props.current,current=>{if(!current){cancelRestoration();readingBusy.value=false;generation++;openGeneration++;busy.value=false;opening.value=false;selection.value=null;listing.value=null;release();error.value='현재 프로젝트 연결과 읽기 범위를 확인하지 못했습니다.';}});
watch(()=>[props.workstreamId,props.pickerActive],()=>{rootGeneration++;scopeBusy.value=false;if(proposal.value)void cancelRoot();rootTrigger=null;});
onMounted(()=>{void readRoots();if(scope.accepted)void start();});
onUnmounted(()=>{disposed=true;rootGeneration++;generation++;openGeneration++;pendingDirectory=null;if(searchTimer)clearTimeout(searchTimer);release();if(proposal.value)void cancelRoot();});
</script>
<template>
 <section class="project-documents" data-testid="project-documents" :class="{'documents-expanded':expanded}">
  <div v-show="!expanded" class="document-scope-banner"><h2>프로젝트 문서</h2><p>{{projectTitle}}에 연결된 프로젝트 노트와 별도로 허용한 문서 폴더 · 읽기 전용</p><p class="muted">Markdown·PNG·YAML·JSON을 지원합니다. 파일 이름·상대 경로만 검색하며, 선택한 문서만 읽습니다.</p>
   <details class="document-scope-settings" @toggle="($event.target as HTMLDetailsElement).open&&readRoots()"><summary>읽기 범위와 연결 폴더</summary><p>프로젝트 노트 범위는 현재 연결 설정을 따릅니다. 저장소의 docs·review 폴더는 아래에서 이 프로젝트에 별도로 연결한 경우에만 표시합니다. 전체 볼트나 다른 프로젝트로 범위를 넓히지 않습니다.</p><ul><li v-for="root in roots?.roots??[]" :key="root.id">{{root.kind==='docs'?'문서':'검토 기록'}} · {{root.path}} · {{root.available?'연결됨':'현재 접근 미확인'}} <Button label="연결 해제" text :disabled="scopeBusy" @click="removal=root"/></li></ul><div class="document-scope-actions"><Button label="docs 폴더 연결" outlined :disabled="scopeBusy||roots?.editable===false" data-testid="document-root-add-docs" @click="chooseRoot('docs',$event)"/><Button label="review 폴더 연결" outlined :disabled="scopeBusy||roots?.editable===false" data-testid="document-root-add-review" @click="chooseRoot('review',$event)"/></div>
    <div v-if="proposal" class="notice document-scope-confirmation" data-testid="document-root-proposal">
     <strong>이 프로젝트의 읽기 전용 문서 폴더로 연결</strong>
     <p class="document-scope-path" data-testid="document-root-proposal-path">{{proposal.path}}</p>
     <p>이 폴더 안의 지원 파일 이름·경로를 탐색하고 선택한 문서만 읽습니다. 원문 작성·실행·모델 전송은 포함하지 않습니다.</p>
     <label class="document-scope-confirmation-check"><input v-model="rootConfirmed" type="checkbox" data-testid="document-root-confirm-checkbox"><span>이 폴더의 읽기 범위를 확인했습니다</span></label>
     <div class="document-scope-actions"><Button label="읽기 전용으로 연결" :disabled="!rootConfirmed||scopeBusy" data-testid="document-root-confirm" @click="confirmRoot"/><Button label="취소" text :disabled="scopeBusy" @click="cancelRoot"/></div>
    </div>
    <div v-if="removal" class="notice warning document-scope-confirmation" data-testid="document-root-removal">
     <strong>이 폴더의 읽기 연결을 해제할까요?</strong>
     <p class="document-scope-path" data-testid="document-root-removal-path">{{removal.path}}</p>
     <p>이 폴더에서 열었던 문서는 다시 읽을 수 없게 됩니다. 원본 파일은 삭제하지 않습니다.</p>
     <div class="document-scope-actions"><Button label="읽기 연결 해제" :disabled="scopeBusy" @click="removeRoot"/><Button label="취소" text :disabled="scopeBusy" @click="removal=null"/></div>
    </div><p v-if="scopeNotice" role="status" data-testid="document-root-status">{{scopeNotice}}</p><p v-if="scopeError||roots?.error" role="alert">{{scopeError||roots?.error}}</p>
   </details>
  </div>
  <div v-if="!scope.accepted" class="document-consent"><h3>탐색할 범위를 먼저 확인해 주세요</h3><p>이 프로젝트에 연결된 노트 폴더와 별도로 허용한 문서 폴더 안에서만 파일 이름과 상대 경로를 탐색합니다. 문서 본문은 선택한 파일만 읽습니다.</p><p>다른 프로젝트·전체 볼트·본문 전문 검색은 포함하지 않습니다. 원문 수정, 명령 실행, 외부 열기 또는 모델 호출은 하지 않습니다.</p><label><input v-model="confirmed" type="checkbox" data-testid="document-scope-consent"> 이 프로젝트의 문서 목록 탐색 범위를 확인했습니다</label><Button label="문서 목록 열기" data-testid="document-catalog-start" :disabled="!confirmed||!current" @click="accept"/></div>
  <template v-else><p v-if="error" class="notice warning" role="alert">{{error}}<Button label="범위 다시 확인" text :disabled="busy||!current" @click="start"/></p><p v-if="restoreNotice&&!expanded" class="muted">{{restoreNotice}}</p>
   <div class="project-document-layout" :class="{'is-expanded':expanded}"><aside v-show="!expanded" ref="listPane" tabindex="-1" class="project-document-browser" aria-label="프로젝트 문서 탐색" @scroll="state.documentListScroll=($event.target as HTMLElement).scrollTop"><div class="section-heading"><h3>문서 탐색</h3><Button label="목록 새로고침" outlined data-testid="document-catalog-refresh" :disabled="busy||!current" @click="refreshListing"/></div><label class="document-search">파일명·상대 경로 검색<input v-model="query" type="search" maxlength="256" placeholder="예: review 또는 inbox/T-042" aria-label="파일명·상대 경로 검색" data-testid="document-filename-search" :disabled="!catalog" @input="search" @compositionstart="composing=true" @compositionend="composing=false;search()"></label><p class="muted">연결한 범위의 파일 이름만 찾습니다. 본문 검색은 열린 문서에서 합니다.</p>
    <div class="document-shortcuts"><Button v-for="entry in shortcuts" :key="entry.id" :label="entry.name" text :disabled="opening||readingBusy" @click="openEntry(entry)"/></div>
    <nav v-if="listing" class="document-breadcrumbs" aria-label="문서 폴더 경로"><template v-for="(crumb,index) in listing.breadcrumbs" :key="crumb.id"><span v-if="index"> / </span><button :disabled="busy" @click="browseDirectory(crumb.id)">{{crumb.name}}</button></template></nav>
    <p v-if="busy" role="status">문서 목록을 확인 중입니다</p><ul v-else-if="listing" class="project-document-list" data-testid="document-catalog-list"><li v-for="entry in listing.entries" :key="entry.id"><button :data-testid="entry.kind==='directory'?'document-folder':'document-entry'" :data-document-path="entry.relativePath" :data-document-id="entry.id" :aria-label="entry.name" :aria-pressed="entry.kind==='file'?state.documentPath===stableKey(entry):undefined" :disabled="opening||readingBusy||!current" @click="openEntry(entry)"><span class="document-entry-name"><strong>{{entry.kind==='directory'?'▱ ':'▤ '}}{{entry.name}}</strong><small v-if="query">{{entry.relativePath}}</small><small v-if="entry.scopeLabel">{{entry.scopeLabel}}</small></span><small>{{entry.kind==='directory'?'폴더 ›':entry.format?.toUpperCase()}}</small></button></li></ul><p v-if="listing&&!busy&&!listing.entries.length">{{query?'현재 탐색 범위에서 일치하는 파일 이름을 찾지 못했습니다.':'이 폴더에서 지원하는 문서를 확인하지 못했습니다.'}}</p>
    <Button v-if="listing?.nextCursor" label="다음 목록" outlined :disabled="busy" data-testid="document-catalog-next" @click="nextListing"/><p v-if="listing" class="muted">현재 목록 {{listing.entries.length}}개 · 목록 확인 {{listing.observedAt}}</p><div v-if="listing?.partial" class="notice warning" role="status">일부 목록만 확인했습니다. 파일이 없다고 판단하지 않습니다.</div><p v-for="(omission,index) in listing?.omissions??[]" :key="index" class="muted">{{omission}}</p><p class="document-scope-footnote">숨김·빌드·캐시 폴더와 심볼릭 링크는 탐색하지 않습니다. 파일목록은 내용 검증 결과가 아닙니다.</p>
   </aside><div ref="viewerPane" class="project-document-pane" @scroll="!expanded&&(state.documentScroll=($event.target as HTMLElement).scrollTop)"><DocumentViewer v-if="selection" :selection="selection" :current="current" :active="active" :expanded="expanded" :mode="state.documentMode" :restore-scroll="state.documentScroll" :restore-anchor="state.documentAnchor" @busy="readingBusy=$event" @update:expanded="expand" @close="closeDocument" @position="savePosition" @browse="expand(false)"/><div v-else class="document-empty"><h3>읽을 문서를 선택해 주세요</h3><p>왼쪽의 파일 이름을 선택하면 여기에서 읽습니다.</p><p class="muted">태스크를 선택하지 않아도 문서를 볼 수 있습니다. 태스크·DAG로 돌아가면 선택과 필터는 유지됩니다.</p></div></div></div>
  </template>
 </section>
</template>
<style scoped>
.project-documents{min-width:0}.document-scope-banner{border:1px solid var(--app-success-border,#b8cfc3);border-radius:9px;background:var(--app-success-bg,#f1f7f3);padding:14px 16px;margin-bottom:16px}.document-scope-banner h2{font-size:1rem;margin:0 0 8px}.document-scope-banner p{font-size:.8rem;margin:6px 0;line-height:1.55}.document-scope-settings{font-size:.78rem;margin-top:10px}.document-scope-settings summary{cursor:pointer}.document-scope-settings li{overflow-wrap:anywhere}.document-scope-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.document-consent{border:1px solid var(--app-border,#d5ddd5);padding:22px;border-radius:9px;max-width:740px}.document-consent label{display:flex;gap:8px;align-items:flex-start;margin:18px 0}.document-consent p{line-height:1.6}.project-document-layout{display:grid;grid-template-columns:minmax(210px,28%) minmax(0,1fr);gap:16px;align-items:start}.project-document-layout.is-expanded{grid-template-columns:minmax(0,1fr)}.project-document-browser{border:1px solid var(--app-border,#d5ddd5);border-radius:9px;padding:14px;min-width:0;max-height:78vh;overflow:auto;overscroll-behavior:contain}.project-document-browser h3{font-size:.9rem}.document-search{font-size:.75rem;display:grid;gap:6px}.document-search input{padding:10px;border:1px solid var(--app-border,#c5d1ca);border-radius:5px;background:var(--app-surface,#fff);color:inherit;width:100%;box-sizing:border-box;min-width:0}.project-document-browser .muted,.document-scope-footnote{font-size:.73rem;line-height:1.6;overflow-wrap:anywhere}.document-shortcuts{display:flex;flex-wrap:wrap;gap:4px;margin:10px 0}.document-shortcuts .p-button{font-size:.7rem;padding:4px}.document-breadcrumbs{font-size:.75rem;line-height:1.7;margin:12px 0}.document-breadcrumbs button{font:inherit;background:none;color:var(--app-primary,#47785d);border:0;text-align:left;cursor:pointer;padding:2px;overflow-wrap:anywhere}.project-document-list{list-style:none;padding:0;margin:0}.project-document-list li+li{border-top:1px solid var(--app-border,#d5ddd5)}.project-document-list button{width:100%;display:flex;justify-content:space-between;align-items:center;gap:10px;text-align:left;font:inherit;color:inherit;background:transparent;border:0;padding:10px 8px;cursor:pointer;min-width:0}.project-document-list button[aria-pressed=true]{background:var(--app-success-bg,#eef6f0);box-shadow:inset 3px 0 var(--app-primary,#47785d)}.document-entry-name{min-width:0;overflow-wrap:anywhere}.document-entry-name strong{font-size:.8rem;font-weight:500}.document-entry-name small{display:block;margin-top:4px;color:var(--app-text-muted,#657586);font-size:.68rem}.project-document-list button>small{font-size:.65rem;color:var(--app-text-muted,#657586);flex-shrink:0}.project-document-pane{min-width:0;max-height:78vh;overflow:auto;overscroll-behavior:contain;border-radius:9px}.is-expanded>.project-document-pane{max-height:none;overflow:visible}.project-document-pane :deep(.document-viewer){margin-top:0}.document-empty{padding:36px 24px;border:1px solid var(--app-border,#d5ddd5);border-radius:9px;min-height:280px}.document-empty h3{font-size:1rem}.document-empty p{font-size:.85rem;line-height:1.6}.document-scope-footnote{border-top:1px solid var(--app-border,#d5ddd5);padding-top:12px;margin-top:15px;color:var(--app-text-muted,#657586)}.project-documents button:focus-visible,.project-documents input:focus-visible{outline:2px solid var(--app-primary,#47785d);outline-offset:2px}.project-documents .p-button{font-size:.75rem;padding:.4rem .6rem}
/* A scope confirmation is a document, not the global notice's horizontal row. */
.document-scope-confirmation{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:10px;margin:12px 0 0;min-width:0}
.document-scope-confirmation>*{min-width:0;margin:0}
.document-scope-confirmation>strong{white-space:normal}
.document-scope-confirmation .document-scope-path{overflow-wrap:anywhere;word-break:normal}
.document-scope-confirmation-check{display:flex;align-items:flex-start;gap:8px;line-height:1.6}
.document-scope-confirmation-check input{flex:0 0 auto;margin:3px 0 0}
.document-scope-confirmation-check span{min-width:0}
.document-scope-confirmation .document-scope-actions{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;margin:0}
.document-scope-confirmation .document-scope-actions>button{flex:0 0 auto;max-width:100%;white-space:normal;word-break:keep-all}
@media(max-width:600px){.document-scope-confirmation .document-scope-actions{flex-direction:column;align-items:stretch}.document-scope-confirmation .document-scope-actions>button{width:100%}}
@media(max-width:1000px){.project-document-layout{grid-template-columns:minmax(0,1fr)}.project-document-browser{max-height:42vh}.project-document-pane{max-height:none;overflow:visible}.document-empty{min-height:160px}}
</style>
