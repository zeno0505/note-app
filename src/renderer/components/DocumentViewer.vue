<script setup lang="ts">
import {computed,nextTick,onMounted,onUnmounted,ref,watch,useId} from 'vue';
import Button from 'primevue/button';
import SafeMarkdown from './SafeMarkdown.vue';
import {findTextOffsets,type DocumentReference} from '../../phase2/markdown';
import type {EvidenceList,EvidenceReadView} from '../../shared/evidence';
import type {EvidenceErrorCode} from '../../phase2/evidence';

const viewerId=useId();
const props=withDefaults(defineProps<{
 selection:{session:EvidenceList;id:string;navigationRoot?:string}|null;
 current:boolean; active?:boolean; expanded?:boolean; originTask?:{id:string;title:string};
 restoreScroll?:number; restoreAnchor?:string; mode?:'formatted'|'raw';
}>(),{active:true,expanded:false,restoreScroll:0,restoreAnchor:'',mode:'formatted'});
const emit=defineEmits<{
 close:[]; 'update:expanded':[value:boolean]; browse:[]; busy:[value:boolean];
 position:[value:{path:string;navigationKey?:string;scroll:number;anchor:string;mode:'formatted'|'raw'}];
}>();
type Entry={session:EvidenceList;id:string;hash:string|null;scroll:number;expandedScroll?:number;anchor:string;path:string;label:string;navigationRoot?:string};
const view=ref<EvidenceReadView|null>(null),transitionHeight=ref(0),busy=ref(false),checking=ref(false),error=ref(''),change=ref(''),anchorNotice=ref(''),hidden=ref(false);
const anchorFeedback=ref<{anchor:string;message:string}|null>(null),anchorStatus=ref<HTMLElement|null>(null);
let anchorFeedbackGeneration=0,anchorOrigin:{element:HTMLElement|null;bodyTop:number;parentTop:number;pageTop:number}|null=null;
const history=ref<Entry[]>([]),historyIndex=ref(-1),body=ref<HTMLElement|null>(null),root=ref<HTMLElement|null>(null);
const plain=ref(props.mode==='raw'),fit=ref(true),zoom=ref(1),imageFailed=ref(false),tocOpen=ref(false),findOpen=ref(false),findQuery=ref(''),findDraft=ref(''),findIndex=ref(0),findInput=ref<HTMLInputElement|null>(null);
const outline=ref<{anchor:string;text:string;level:number}[]>([]),formattedFind=ref({count:0,limited:false,index:0});
const markdown=ref<{scrollToAnchor:(anchor:string)=>boolean;scrollToMatch:(index:number)=>boolean}|null>(null);
const referenceIssue=ref<{kind:'missing'|'ambiguous'|'out-of-scope'|'unsupported'|'resolved(archived)'|'denied'|'metadata';original:string;warnings?:string[];hint?:string[];target?:Record<string,string>;candidates:{evidenceId:string;label:string;relativePath:string;anchor?:string|null}[];session:EvidenceList|null}|null>(null),chosen=ref('');
let generation=0,disposed=false,interval:ReturnType<typeof setInterval>|undefined,outerReturnScroll=0;
const derivedSessions=new Set<string>();
// Freshness checks use the same reader/proof chain as foreground navigation.
const navigationBusy=computed(()=>busy.value||checking.value);
const activeEntry=computed(()=>history.value[historyIndex.value]??null);
const result=computed(()=>view.value?.result.ok&&!hidden.value?view.value.result:null);
const sourceText=computed(()=>result.value?.content.kind==='text'?result.value.content.text:'');
const isMarkdown=computed(()=>result.value?.content.kind==='text'&&result.value.content.mime==='text/markdown');
const extension=computed(()=>activeEntry.value?.path.split('.').pop()?.toLowerCase()??'');
// Preserve JSON integers, duplicate keys and YAML scalar spelling exactly. No parser rewrites evidence.
const displayText=computed(()=>sourceText.value);
const rawMatches=computed(()=>{const found=findTextOffsets(displayText.value,findQuery.value);return {positions:found.offsets,limited:found.limited};});
const matchCount=computed(()=>isMarkdown.value&&!plain.value?formattedFind.value.count:rawMatches.value.positions.length);
const rawSegments=computed(()=>{const parts:{text:string;match:number|null}[]=[];let start=0;for(const [index,position] of rawMatches.value.positions.entries()){parts.push({text:displayText.value.slice(start,position),match:null},{text:displayText.value.slice(position,position+findQuery.value.length),match:index});start=position+findQuery.value.length;}parts.push({text:displayText.value.slice(start),match:null});return parts;});
const errorText:Record<EvidenceErrorCode,string>={
 'invalid-registration':'문서 연결 정보를 확인할 수 없습니다', 'invalid-request':'문서 요청을 확인할 수 없습니다',unregistered:'등록되지 않은 문서입니다',
 'permission-denied':'이 문서의 읽기 허용이 없습니다. 본문을 숨겼습니다', 'unsafe-source':'현재 범위에서 안전하게 읽을 수 없는 파일입니다',
 'source-unavailable':'연결된 파일을 찾지 못했거나 읽을 수 없습니다', 'source-limit':'읽기 크기 또는 처리 한도를 넘었습니다',
 'source-changed':'원본 문서가 변경되었습니다', 'stale-source':'원본 문서가 변경되었습니다', 'unsupported-type':'지원하지 않는 파일 형식입니다',
 'invalid-content':'문자 또는 이미지 형식을 안전하게 표시할 수 없습니다',cancelled:'문서 읽기가 취소되었습니다',timeout:'문서 읽기 시간이 초과되었습니다',busy:'다른 문서 읽기를 처리하고 있습니다',retired:'이 문서 세션이 만료되었습니다. 목록에서 다시 열어 주세요',
};
function releaseChildren(read:EvidenceReadView|null){for(const session of [read?.images,read?.references?.session])if(session&&!derivedSessions.has(session.sessionId))void window.noteApp.releaseTaskEvidence({sessionId:session.sessionId}).catch(()=>{});}
function ownChildren(read:EvidenceReadView){for(const session of [read.images,read.references?.session])if(session)derivedSessions.add(session.sessionId);}
function releaseAll(){for(const sessionId of derivedSessions)void window.noteApp.releaseTaskEvidence({sessionId}).catch(()=>{});derivedSessions.clear();}
function scrollContainer():HTMLElement|null{return props.expanded?body.value:root.value?.closest?.<HTMLElement>('.task-detail,.project-document-pane')??null;}
function bodyOffset(container:HTMLElement){if(container===body.value)return 0;return body.value?.getBoundingClientRect&&container.getBoundingClientRect?body.value.getBoundingClientRect().top-container.getBoundingClientRect().top+container.scrollTop:0;}
function position(){const entry=activeEntry.value;if(!entry)return;const container=scrollContainer();if(container){entry.scroll=Math.max(0,container.scrollTop-bodyOffset(container));if(props.expanded)entry.expandedScroll=entry.scroll;}emit('position',{path:entry.path,...(entry.navigationRoot?{navigationKey:entry.navigationRoot+'/'+entry.path}:{}),scroll:entry.scroll,anchor:entry.anchor,mode:plain.value?'raw':'formatted'});}
function revealReaderHeader(focus=false){root.value?.scrollIntoView?.({block:'start',behavior:'auto'});if(focus)root.value?.focus?.({preventScroll:true});}
function restorePosition(entry:Entry){const container=scrollContainer();if(container)container.scrollTop=bodyOffset(container)+entry.scroll;}
function rememberAnchor(anchor:string){if(activeEntry.value)activeEntry.value.anchor=anchor;position();}
async function reportAnchor(result:{anchor:string;found:boolean;message:string}){
 const own=++anchorFeedbackGeneration,currentGeneration=generation;
 if(result.found){anchorFeedback.value=null;anchorOrigin=null;return;}
 const element=typeof document!=='undefined'&&typeof HTMLElement!=='undefined'&&document.activeElement instanceof HTMLElement?document.activeElement:null;
 anchorOrigin={element,bodyTop:body.value?.scrollTop??0,parentTop:root.value?.closest?.<HTMLElement>('.task-detail,.project-document-pane')?.scrollTop??0,pageTop:window.scrollY??0};
 anchorFeedback.value={anchor:result.anchor,message:result.message};
 await nextTick();if(disposed||own!==anchorFeedbackGeneration||currentGeneration!==generation)return;
 anchorStatus.value?.scrollIntoView?.({block:'nearest',behavior:'auto'});anchorStatus.value?.focus?.({preventScroll:true});
}
async function returnFromAnchorNotice(){const origin=anchorOrigin;anchorFeedbackGeneration++;anchorFeedback.value=null;anchorOrigin=null;await nextTick();if(disposed||!origin)return;if(body.value)body.value.scrollTop=origin.bodyTop;const parent=root.value?.closest?.<HTMLElement>('.task-detail,.project-document-pane');if(parent)parent.scrollTop=origin.parentTop;window.scrollTo?.({top:origin.pageTop,behavior:'auto'});if(origin.element?.isConnected)origin.element.focus({preventScroll:true});else root.value?.focus?.({preventScroll:true});position();}

function makeEntry(session:EvidenceList,id:string):Entry {const item=session.items.find(item=>item.evidenceId===id);return {session,id,hash:null,scroll:0,anchor:item?.anchor??'',path:item?.relativePath??item?.label??'',label:item?.label??'문서'};}
async function show(entry:Entry,expectedHash:string|null,restore=false){
 // A blank loading state must not shrink the page and clamp its outer scroll.
 anchorFeedbackGeneration++;anchorFeedback.value=null;anchorOrigin=null;
 transitionHeight.value=Math.max(280,root.value?.getBoundingClientRect?.().height??0);
 const own=++generation;busy.value=true;checking.value=false;emit('busy',true);error.value='';change.value='';anchorNotice.value='';hidden.value=false;referenceIssue.value=null;view.value=null;outline.value=[];findIndex.value=0;fit.value=true;zoom.value=1;imageFailed.value=false;
 try{
  await nextTick();if(disposed||own!==generation)return;revealReaderHeader(true);
  const read=await window.noteApp.readTaskEvidence({sessionId:entry.session.sessionId,evidenceId:entry.id,expectedSourceHash:expectedHash});
  if(disposed||own!==generation){releaseChildren(read);return;}
  ownChildren(read);view.value=read;
  if(read.result.ok){entry.hash=read.result.sourceHash;await nextTick();if(disposed||own!==generation)return;transitionHeight.value=0;await nextTick();if(disposed||own!==generation)return;revealReaderHeader();let anchorFound=true;if(entry.anchor)anchorFound=markdown.value?.scrollToAnchor(entry.anchor)??false;else if(restore)restorePosition(entry);position();return anchorFound;}
  else error.value=errorText[read.result.code]??'문서를 표시할 수 없습니다';
 }catch{if(!disposed&&own===generation){hidden.value=true;error.value='프로젝트 연결 또는 읽기 범위를 재확인할 수 없습니다. 목록에서 다시 열어 주세요.';}}
 finally{if(!disposed&&own===generation){transitionHeight.value=0;busy.value=false;emit('busy',false);if(error.value){await nextTick();if(!disposed&&own===generation)revealReaderHeader();}}}
}
async function navigate(session:EvidenceList,id:string,navigationRoot?:string){
 if(!props.current||navigationBusy.value)return;position();
 const restore=!history.value.length&&(props.restoreScroll>0||!!props.restoreAnchor);const entry=makeEntry(session,id);entry.navigationRoot=navigationRoot??activeEntry.value?.navigationRoot;if(!history.value.length){entry.scroll=props.restoreScroll;entry.anchor=props.restoreAnchor||entry.anchor;}history.value=history.value.slice(0,historyIndex.value+1);history.value.push(entry);
 if(history.value.length>20)history.value.shift();historyIndex.value=history.value.length-1;
 await show(entry,null,restore);
}
async function traverse(direction:number){if(navigationBusy.value)return;position();const next=historyIndex.value+direction;if(next<0||next>=history.value.length)return;historyIndex.value=next;const entry=history.value[next];await show(entry,entry.hash,true);}
let recheckPending:Promise<void>|null=null;
function recheck(){
 if(recheckPending)return recheckPending;
 const pending=performRecheck();recheckPending=pending;
 void pending.finally(()=>{if(recheckPending===pending)recheckPending=null;});return pending;
}
async function performRecheck(){
 const entry=activeEntry.value;if(!props.active||!props.current||!entry?.hash||busy.value||checking.value||hidden.value)return;
 const own=generation;checking.value=true;emit('busy',true);
 try{
  const check=await window.noteApp.readTaskEvidence({sessionId:entry.session.sessionId,evidenceId:entry.id,expectedSourceHash:entry.hash});
  if(disposed||own!==generation){releaseChildren(check);return;}
  if(check.result.ok){ownChildren(check);if(view.value){view.value.references=check.references;view.value.images=check.images;}change.value='';return;}
  releaseChildren(check);
  if(['source-changed','stale-source'].includes(check.result.code))change.value='원본 문서가 변경되었습니다. 지금 보이는 내용은 이전에 읽은 내용입니다. 다시 읽기 전까지 이 내용을 유지합니다.';
  else if(['permission-denied','unsafe-source','retired','unregistered','invalid-registration'].includes(check.result.code)){hidden.value=true;view.value=null;releaseAll();error.value=errorText[check.result.code];}
  else change.value=errorText[check.result.code]+'. 현재 보이는 내용은 이전에 읽은 내용이며, 변경 없음을 확인한 상태가 아닙니다.';
 }catch{if(!disposed&&own===generation){hidden.value=true;view.value=null;releaseAll();error.value='프로젝트 연결 또는 읽기 허용을 재확인하지 못해 본문을 숨겼습니다. 목록에서 다시 열어 주세요.';}}
 finally{if(own===generation){checking.value=false;emit('busy',false);}}
}
async function reread(){const entry=activeEntry.value;if(!entry||!props.current||navigationBusy.value)return;const anchor=entry.anchor;entry.scroll=0;entry.expandedScroll=undefined;const located=await show(entry,null);await nextTick();if(anchor&&located===false){entry.anchor='';entry.scroll=0;restorePosition(entry);anchorNotice.value='이전에 보던 제목 위치를 찾지 못해 문서 시작으로 돌아왔습니다.';position();}}
function openReference(reference:DocumentReference){
 if(navigationBusy.value)return;
 const refs=view.value?.references,target=refs?.targets.find(target=>target.href===reference.href&&target.kind===reference.kind);
 if(!refs||!target){referenceIssue.value={kind:'unsupported',original:reference.href,candidates:[],session:null};return;}
 const status=target.status??'resolved';
 if(status==='resolved'&&target.evidenceId){void navigate(refs.session,target.evidenceId);return;}
 chosen.value='';referenceIssue.value={kind:status==='resolved'?'metadata':status,original:reference.href,warnings:target.warnings,hint:target.hint,target:target.target,candidates:target.candidates??[],session:refs.session};
}
function openChosen(){if(navigationBusy.value)return;const issue=referenceIssue.value;if(issue?.session&&issue.candidates.some(candidate=>candidate.evidenceId===chosen.value))void navigate(issue.session,chosen.value);}
function cancelReference(){referenceIssue.value=null;chosen.value='';}
async function toggleExpanded(){
 const entry=activeEntry.value,own=generation;position();const expand=!props.expanded;
 // Inline detail restores its own origin. Keep the last expanded offset on this
 // exact history entry so that origin/queued inline scroll cannot overwrite it.
 const expandedPosition=entry?.expandedScroll??entry?.scroll??0;
 if(expand)outerReturnScroll=window.scrollY??0;emit('update:expanded',expand);await nextTick();
 if(disposed||own!==generation||activeEntry.value!==entry||props.expanded!==expand)return;
 if(expand){if(entry){entry.scroll=expandedPosition;restorePosition(entry);}root.value?.scrollIntoView?.({block:'start',behavior:'auto'});}
 else window.scrollTo?.({top:outerReturnScroll,behavior:'auto'});
 root.value?.querySelector<HTMLElement>(expand?'[data-testid=document-return]':'[data-testid=document-expand]')?.focus?.({preventScroll:true});
}
function dismiss(){generation++;transitionHeight.value=0;busy.value=false;checking.value=false;emit('busy',false);view.value=null;history.value=[];historyIndex.value=-1;releaseAll();emit('close');if(props.expanded)void nextTick(()=>window.scrollTo?.({top:outerReturnScroll,behavior:'auto'}));}
async function toggleFind(){findOpen.value=!findOpen.value;if(findOpen.value){await nextTick();findInput.value?.focus();}else{findQuery.value='';findDraft.value='';}}
function applyFind(event?:Event){if(typeof InputEvent!=='undefined'&&event instanceof InputEvent&&event.isComposing)return;findQuery.value=findDraft.value.slice(0,512);findIndex.value=0;}
async function moveMatch(direction:number){if(!matchCount.value)return;findIndex.value=(findIndex.value+direction+matchCount.value)%matchCount.value;await nextTick();if(isMarkdown.value&&!plain.value)markdown.value?.scrollToMatch(findIndex.value);else root.value?.querySelector<HTMLElement>('[data-find-index="'+findIndex.value+'"]')?.scrollIntoView?.({block:'nearest'});}
function jump(anchor:string){if(activeEntry.value)activeEntry.value.anchor=anchor;markdown.value?.scrollToAnchor(anchor);position();}
function keys(event:KeyboardEvent){if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'){event.preventDefault();if(!findOpen.value)void toggleFind();else findInput.value?.focus();}else if(event.key==='Escape'){if(referenceIssue.value){event.preventDefault();event.stopPropagation();cancelReference();}else if(findOpen.value){event.preventDefault();event.stopPropagation();findOpen.value=false;findQuery.value='';findDraft.value='';root.value?.focus?.();}else if(props.expanded){event.preventDefault();event.stopPropagation();void toggleExpanded();}else{event.preventDefault();event.stopPropagation();dismiss();}}}
function onFocus(){void recheck();}
function onVisibility(){if(typeof document!=='undefined'&&document.visibilityState==='visible')void recheck();}
watch(()=>props.selection,selection=>{if(!selection)return;void navigate(selection.session,selection.id,selection.navigationRoot);},{immediate:true});
watch(()=>props.current,current=>{if(!current){generation++;transitionHeight.value=0;view.value=null;hidden.value=true;busy.value=false;checking.value=false;emit('busy',false);releaseAll();error.value='프로젝트 연결 또는 읽기 범위를 확인하지 못해 문서 본문을 숨겼습니다.';}});
watch(()=>props.active,active=>{if(active)void recheck();});
watch(result,value=>{if(!value){anchorFeedbackGeneration++;anchorFeedback.value=null;anchorOrigin=null;}});
watch(plain,()=>{findIndex.value=0;position();});
watch(findQuery,async()=>{await nextTick();if(!isMarkdown.value||plain.value)root.value?.querySelector<HTMLElement>('[data-find-index="0"]')?.scrollIntoView?.({block:'nearest'});});
onMounted(()=>{window.addEventListener?.('focus',onFocus);if(typeof document!=='undefined')document.addEventListener('visibilitychange',onVisibility);interval=setInterval(()=>void recheck(),30000);});
onUnmounted(()=>{disposed=true;generation++;if(interval)clearInterval(interval);window.removeEventListener?.('focus',onFocus);if(typeof document!=='undefined')document.removeEventListener('visibilitychange',onVisibility);releaseAll();view.value=null;});
defineExpose({recheck});
</script>

<template>
 <section ref="root" class="document-viewer" :class="{'is-expanded':expanded}" data-testid="document-viewer" :style="transitionHeight?{minHeight:transitionHeight+'px'}:undefined" role="region" :aria-label="(activeEntry?.label??'문서')+' 읽기 전용 열람'" :aria-busy="navigationBusy" tabindex="-1" @keydown="keys">
  <div v-if="expanded" class="document-return-bar"><Button :label="originTask?'← '+originTask.id+' 상세로 돌아가기':'← 문서 목록으로 돌아가기'" outlined data-testid="document-return" @click="toggleExpanded"/><span class="muted">선택·필터·읽기 위치 유지</span></div>
  <div v-if="expanded&&originTask" class="document-origin"><span class="muted">출발 태스크</span> <strong>{{originTask.id}} · {{originTask.title}}</strong></div>
  <header class="document-header">
   <div class="document-title-row"><div class="document-history"><Button label="←" outlined aria-label="이전 문서" data-testid="document-back" :disabled="historyIndex<=0||navigationBusy" @click="traverse(-1)"/><Button label="→" outlined aria-label="다음 문서" data-testid="document-forward" :disabled="historyIndex>=history.length-1||navigationBusy" @click="traverse(1)"/><span class="muted">{{historyIndex+1}} / {{history.length}}</span></div><div class="document-actions"><Button v-if="!expanded" label="넓게 보기 ↗" outlined data-testid="document-expand" @click="toggleExpanded"/><Button label="닫기" outlined aria-label="문서 닫기" data-testid="document-close" @click="dismiss"/></div></div>
   <h4>{{activeEntry?.label??'문서 확인'}}</h4><p class="document-path">{{activeEntry?.path}}</p>
   <div class="document-toolbar"><div class="document-actions"><Button label="서식" :outlined="plain" :aria-pressed="!plain" data-testid="document-formatted" @click="plain=false"/><Button label="원문" :outlined="!plain" :aria-pressed="plain" data-testid="document-raw" @click="plain=true"/></div><div class="document-actions"><Button label="문서 안 찾기" outlined :disabled="!result||result.content.kind!=='text'" :aria-expanded="findOpen" data-testid="document-find-toggle" @click="toggleFind"/><Button label="목차" outlined :disabled="!isMarkdown||plain" :aria-expanded="tocOpen" data-testid="document-toc-toggle" @click="tocOpen=!tocOpen"/></div></div>
   <div v-if="findOpen" class="document-find"><label>열린 문서 안 찾기<input ref="findInput" v-model="findDraft" maxlength="512" type="search" aria-label="문서 안 찾기" data-testid="document-find-input" @input="applyFind" @compositionend="applyFind" @keydown.enter.prevent="moveMatch($event.shiftKey?-1:1)"></label><div class="document-actions"><Button label="이전 일치" outlined data-testid="document-find-previous" :disabled="!matchCount" @click="moveMatch(-1)"/><Button label="다음 일치" outlined data-testid="document-find-next" :disabled="!matchCount" @click="moveMatch(1)"/><span role="status">{{matchCount?findIndex+1:0}} / {{matchCount}}{{rawMatches.limited||formattedFind.limited?' (최대 1,000개 표시)':''}}</span></div><p v-if="isMarkdown&&!plain&&findQuery" class="muted">서식 본문 {{formattedFind.count}}개 · 전체 원문 {{rawMatches.positions.length}}개. 문법 기호와 원문 일치는 ‘원문’에서 확인합니다.</p></div>
   <div v-if="anchorFeedback" ref="anchorStatus" class="document-anchor-status" role="status" tabindex="-1" data-testid="document-anchor-notice"><strong>{{anchorFeedback.message}}</strong><p>문서 원문은 그대로 유지했습니다.</p><div class="document-actions"><Button v-if="outline.length" label="목차에서 제목 선택" outlined @click="tocOpen=true"/><Button label="읽던 위치로 돌아가기" outlined data-testid="document-anchor-return" @click="returnFromAnchorNotice"/></div></div>
  </header>
  <p v-if="busy" class="document-status" role="status">파일과 읽기 범위를 확인 중입니다. 닫으면 늦게 도착한 내용은 표시하지 않습니다.</p>
  <p v-if="checking" class="document-status" role="status">원본 변경 여부를 확인 중입니다</p>
  <p v-if="anchorNotice" class="document-status" role="status">{{anchorNotice}}</p>
  <div v-if="change" class="notice warning document-change" role="status" data-testid="document-source-change"><p>{{change}}</p><Button label="변경된 문서 다시 읽기" outlined data-testid="document-reread" :disabled="navigationBusy||!current" @click="reread"/></div>
  <div v-if="error" class="document-error" role="alert" data-testid="document-error"><strong>{{error}}</strong><p v-if="activeEntry">연결: {{activeEntry.path}}</p><p>누락이나 읽기 실패를 빈 문서 또는 검증 통과로 판단하지 않습니다.</p><div class="document-actions"><Button label="다시 확인" outlined :disabled="navigationBusy||!current" @click="reread"/><Button label="프로젝트 문서 찾기" outlined @click="emit('browse')"/><Button v-if="historyIndex>0" label="이전 문서로 돌아가기" outlined :disabled="navigationBusy" @click="traverse(-1)"/></div></div>
  <template v-if="result">
   <div class="document-snapshot"><span>{{result.origin==='synthetic'?'합성 데이터 · ':''}}문서 읽은 시점 {{result.observedAt}} · {{result.byteLength.toLocaleString()}} bytes · {{result.sourceHash.slice(0,20)}}…</span><span class="document-unverified">내용 검증 미판정</span><Button label="변경 확인" text :disabled="checking||busy||!current" data-testid="document-recheck" @click="recheck"/><details><summary>관측 기준 상세</summary><p>문서 해시: {{result.sourceHash}}</p><p v-if="result.anchor">원문 앵커: #{{result.anchor}}</p><p>목록 관측과 문서 읽기 시점은 별개입니다. 문서 읽기는 태스크 상태를 바꾸지 않습니다.</p><p v-for="(note,index) in result.omissions" :key="index">{{note}}</p></details></div>
   <div v-if="referenceIssue" class="document-reference-issue" role="status" data-testid="document-reference-issue"><h4>{{referenceIssue.kind==='ambiguous'?'어느 문서를 열지 선택해 주세요':referenceIssue.kind==='missing'?'연결된 파일을 찾지 못했습니다':referenceIssue.kind==='out-of-scope'?'프로젝트 읽기 범위 밖의 연결입니다':referenceIssue.kind==='resolved(archived)'?'보관된 태스크 연결입니다':referenceIssue.kind==='denied'?'문서 읽기가 허용되지 않았습니다':referenceIssue.kind==='metadata'?'연결 대상 메타데이터 · 파일 존재와 위치 이동은 미확인':'지원하지 않는 문서 연결입니다'}}</h4><p>원문: {{referenceIssue.original}}</p><p v-if="referenceIssue.warnings?.length">주의: {{referenceIssue.warnings.join(', ')}}</p><p v-if="referenceIssue.hint?.length">대소문자 후보: {{referenceIssue.hint.join(', ')}}</p><pre v-if="referenceIssue.target">{{JSON.stringify(referenceIssue.target,null,2)}}</pre><template v-if="referenceIssue.kind==='ambiguous'"><label v-for="candidate in referenceIssue.candidates" :key="candidate.evidenceId" class="document-candidate"><input v-model="chosen" type="radio" :value="candidate.evidenceId" :name="'document-candidate-'+viewerId">{{candidate.relativePath}}</label><p>선택은 이번 열람에만 적용됩니다. 원문 링크와 전역 규칙을 바꾸지 않습니다.</p><Button label="선택한 문서 열기" outlined :disabled="!chosen||navigationBusy" @click="openChosen"/></template><template v-else><p>파일을 자동 생성하거나 비슷한 파일로 바꾸지 않습니다.</p><Button label="프로젝트 문서 찾기" outlined @click="emit('browse')"/></template><Button label="현재 문서로 돌아가기" text @click="cancelReference"/></div>
   <div class="document-reading" :class="{'has-toc':tocOpen&&isMarkdown&&!plain}"><nav v-if="tocOpen&&isMarkdown&&!plain" class="document-toc" aria-label="문서 목차"><strong>문서 목차</strong><p v-if="!outline.length">확인된 제목이 없습니다</p><button v-for="heading in outline" :key="heading.anchor" :style="{paddingInlineStart:((heading.level-1)*10+8)+'px'}" @click="jump(heading.anchor)">{{heading.text}}</button></nav>
    <div ref="body" class="document-body" :class="{'expanded-scroll':expanded}" @scroll="position">
     <template v-if="result.content.kind==='text'"><SafeMarkdown :harness-references="view?.references?.harness===true" v-if="isMarkdown&&!plain" ref="markdown" :text="result.content.text" :find-query="findQuery" :find-index="findIndex" :disabled="navigationBusy||!current||!!change" @open-reference="openReference" @anchor-change="rememberAnchor" @anchor-result="reportAnchor" @outline="outline=$event" @find-results="formattedFind=$event"/><template v-else><p v-if="!plain" class="muted">{{extension==='json'?'JSON 원문 · 숫자와 중복 키를 그대로 보존, 실행하지 않음':extension==='yaml'||extension==='yml'?'YAML 들여쓰기 원문 · 값이나 명령을 실행하지 않음':'서식 없는 안전한 텍스트 표시'}}</p><pre class="document-raw-text" tabindex="0" aria-label="문서 원문"><template v-for="(segment,index) in rawSegments" :key="index"><mark v-if="segment.match!==null" :data-find-index="segment.match" :class="{'current-find':segment.match===findIndex}">{{segment.text}}</mark><template v-else>{{segment.text}}</template></template></pre></template></template>
     <template v-else><div class="document-actions"><Button label="화면에 맞춤" :outlined="!fit" @click="fit=true;zoom=1"/><Button label="원본 크기" :outlined="fit" @click="fit=false;zoom=1"/><Button label="−" aria-label="이미지 축소" @click="fit=false;zoom=Math.max(.25,zoom-.25)"/><Button label="+" aria-label="이미지 확대" @click="fit=false;zoom=Math.min(4,zoom+.25)"/><span>{{zoom*100}}%</span></div><div class="evidence-image-scroll"><p v-if="imageFailed" role="alert">이미지 디코딩에 실패했습니다. 근거를 표시할 수 없습니다.</p><img v-else :src="result.content.dataUrl" :alt="result.label+' · 근거 이미지, 검증 결과 미확인'" :style="fit?{maxWidth:'100%',maxHeight:'60vh',width:'auto',height:'auto'}:{width:result.content.width*zoom+'px',maxWidth:'none'}" @error="imageFailed=true"/></div></template>
     <p v-if="result.content.kind==='text'&&result.content.imageReferences.unsupportedCount" class="muted">지원하지 않는 이미지 연결 {{result.content.imageReferences.unsupportedCount}}개 · 외부 이미지는 요청하지 않습니다</p>
     <div v-if="view?.images&&(!view.references||plain)" class="document-actions"><Button v-for="item in view.images.items" :key="item.evidenceId" :label="'이미지 확인 · '+item.label" outlined :disabled="navigationBusy||!current||!!change" @click="navigate(view!.images!,item.evidenceId)"/></div>
    </div>
   </div>
  </template>
 </section>
</template>

<style scoped>
.document-viewer{scroll-margin-top:76px;min-width:0;border:1px solid var(--app-success-border,#b8cfc3);border-radius:10px;background:var(--app-surface,#fff);overflow-wrap:anywhere;margin-top:14px;outline-offset:3px}.document-header{padding:14px;background:var(--app-success-bg,#f3f8f5);border-bottom:1px solid var(--app-border,#d5ddd5)}.document-header h4{font-size:1.05rem;margin:10px 0 6px}.document-path{font-size:.8rem;margin:0 0 10px;color:var(--app-text-muted,#657586)}.document-title-row,.document-toolbar,.document-return-bar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.document-actions,.document-history{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.document-history .muted{font-size:.75rem}.document-return-bar{padding:14px;border-bottom:1px solid var(--app-border,#d5ddd5);background:var(--app-success-bg,#f3f8f5)}.document-origin{padding:12px 16px;font-size:.85rem;border-bottom:1px solid var(--app-border,#d5ddd5)}.document-origin .muted{margin-right:12px}.document-find{border-top:1px solid var(--app-border,#d5ddd5);padding-top:12px;margin-top:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}.document-find label{display:grid;gap:5px;flex:1 1 180px}.document-find input{width:100%;min-width:0;box-sizing:border-box;padding:8px;border:1px solid var(--app-border,#c5d1ca);border-radius:5px;color:inherit;background:var(--app-surface,#fff)}.document-find p{flex-basis:100%;margin:0;font-size:.8rem}.document-anchor-status{margin-top:12px;padding:12px;border:1px solid var(--app-warning-border,#e5c88c);border-radius:6px;background:var(--app-warning-bg,#fff8e6);font-size:.82rem;line-height:1.55;scroll-margin-top:76px;outline-offset:3px}.document-anchor-status p{margin:6px 0}.document-snapshot{padding:9px 14px;border-bottom:1px solid var(--app-border,#d5ddd5);font-size:.75rem;color:var(--app-text-muted,#657586);display:flex;flex-wrap:wrap;align-items:center;gap:8px}.document-snapshot details{flex-basis:100%}.document-snapshot summary{cursor:pointer}.document-unverified{color:var(--app-warning-text,#956019)}.document-reading{min-width:0}.document-reading.has-toc{display:grid;grid-template-columns:minmax(130px,20%) minmax(0,1fr)}.document-body{padding:18px;min-width:0}.document-body.expanded-scroll{height:65vh;max-height:65vh;overflow:auto;overscroll-behavior:contain}.document-toc{padding:16px 10px;background:var(--app-surface-muted,#f6f8f7);border-right:1px solid var(--app-border,#d5ddd5);min-width:0}.document-toc strong{display:block;margin:0 8px 10px;font-size:.8rem}.document-toc button{display:block;text-align:left;width:100%;padding:8px;border:0;color:inherit;background:transparent;font:inherit;cursor:pointer;overflow-wrap:anywhere}.document-toc button:hover{background:var(--app-success-bg,#eef5f0)}.document-status,.document-error,.document-reference-issue{padding:16px;margin:0}.document-error,.document-reference-issue{background:var(--app-warning-bg,#fff8e6);border-bottom:1px solid var(--app-warning-border,#f0d18c)}.document-change{border-radius:0;margin:0;padding:14px}.document-change p{margin:0 0 8px}.document-candidate{display:flex;gap:10px;padding:10px;border:1px solid var(--app-border,#d5ddd5);background:var(--app-surface,#fff)}.document-raw-text{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.65 ui-monospace,SFMono-Regular,monospace;margin:0;max-width:100%;tab-size:2}.document-raw-text mark{color:inherit;background:#ffe7a1}.document-raw-text .current-find{outline:2px solid #8f6517}.document-viewer:focus-visible,.document-viewer button:focus-visible,.document-viewer input:focus-visible{outline:2px solid var(--app-primary,#47785d);outline-offset:3px}.is-expanded{margin-top:0}.document-viewer .p-button{font-size:.8rem;padding:.45rem .65rem}
@media(max-width:760px){.document-reading.has-toc{grid-template-columns:minmax(0,1fr)}.document-toc{border-right:0;border-bottom:1px solid var(--app-border,#d5ddd5);max-height:180px;overflow:auto}.document-body{padding:14px}.document-body.expanded-scroll{height:auto;min-height:55vh;max-height:none;overflow:visible}.document-return-bar .muted{font-size:.75rem}.document-title-row{align-items:flex-start}.document-header{padding:12px}}
</style>
