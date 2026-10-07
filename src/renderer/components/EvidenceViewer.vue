<script setup lang="ts">
import {ref,watch,onUnmounted} from 'vue';
import Dialog from 'primevue/dialog';
import SafeMarkdown from './SafeMarkdown.vue';
import type {DocumentReference} from '../../phase2/markdown';
import Button from 'primevue/button';
import type {EvidenceList,EvidenceReadView} from '../../shared/evidence';
const props=defineProps<{workstreamId:string;taskId:string;sourceHash:string|null;current:boolean}>();
const list=ref<EvidenceList|null>(null),view=ref<EvidenceReadView|null>(null),error=ref(''),busy=ref(false),open=ref(false),zoom=ref(1),fit=ref(true),imageFailed=ref(false),plain=ref(false);
let generation=0,disposed=false;
const sessions=new Set<string>();
const history=ref<{session:EvidenceList;id:string;hash:string|null}[]>([]);let active:{session:EvidenceList;id:string;hash:string|null}|null=null;
function release(){for(const sessionId of sessions)void window.noteApp.releaseTaskEvidence({sessionId}).catch(()=>{});sessions.clear();}
async function prepare(){const own=++generation;busy.value=false;release();active=null;history.value=[];list.value=null;view.value=null;error.value='';open.value=false;if(!props.current||!props.sourceHash)return;try{const result=await window.noteApp.prepareTaskEvidence({workstreamId:props.workstreamId,taskId:props.taskId,sourceHash:props.sourceHash});if(!disposed&&own===generation){sessions.add(result.sessionId);list.value=result;}else void window.noteApp.releaseTaskEvidence({sessionId:result.sessionId}).catch(()=>{});}catch{if(!disposed&&own===generation)error.value='등록된 근거를 확인하지 못했습니다. 새로고침 후 다시 확인해 주세요.';}}
async function read(session:EvidenceList,id:string,back=false,expectedSourceHash:string|null=null){if(busy.value)return;if(active&&!back)history.value.push(active);active={session,id,hash:expectedSourceHash};const own=++generation;busy.value=true;error.value='';open.value=true;view.value=null;fit.value=true;zoom.value=1;imageFailed.value=false;try{const result=await window.noteApp.readTaskEvidence({sessionId:session.sessionId,evidenceId:id,expectedSourceHash});if(!disposed&&own===generation){view.value=result;if(result.images)sessions.add(result.images.sessionId);if(result.references)sessions.add(result.references.session.sessionId);if(result.result.ok&&active)active.hash=result.result.sourceHash;}else for(const session of [result.images,result.references?.session])if(session)void window.noteApp.releaseTaskEvidence({sessionId:session.sessionId}).catch(()=>{});}catch{if(!disposed&&own===generation)error.value='근거가 변경되었거나 읽기 범위를 확인할 수 없습니다.';}finally{if(own===generation)busy.value=false;}}
function openReference(reference:DocumentReference){const refs=view.value?.references,match=refs?.targets.find(t=>t.href===reference.href&&t.kind===reference.kind);if(refs&&match)void read(refs.session,match.evidenceId);else error.value='이 연결은 현재 근거 범위에서 등록되지 않았습니다.';}
function back(){const previous=history.value.pop();if(previous)void read(previous.session,previous.id,true,previous.hash);}
function dismiss(){active=null;history.value=[];generation++;release();busy.value=false;view.value=null;open.value=false;void prepare();}
watch(()=>[props.workstreamId,props.taskId,props.sourceHash,props.current],prepare,{immediate:true});
onUnmounted(()=>{disposed=true;generation++;release();view.value=null;});
</script>
<template>
 <section class="task-evidence"><h4>설계·논의·이미지 근거</h4><p>등록된 로컬 연결만 읽습니다. 파일 존재나 이미지 표시가 테스트 통과를 증명하지는 않습니다.</p><div class="evidence-tools"><Button v-for="item in list?.items??[]" :key="item.evidenceId" :label="item.label" outlined :disabled="!current||busy" @click="read(list!,item.evidenceId)"/></div><p v-if="list&&!list.items.length">등록된 근거 링크가 없습니다. 원문에 연결이 없거나 현재 계약에서 확인되지 않았습니다.</p><p v-if="list?.unsupportedCount">지원하지 않는 근거 참조 {{list.unsupportedCount}}개</p><p v-if="error&&!open" role="alert">{{error}}</p>
  <Dialog :visible="open" modal :header="view?.result.ok?view.result.label:'근거 확인'" :style="{width:'min(1080px,95vw)'}" @update:visible="value=>{if(!value)dismiss()}">
   <Button v-if="history.length" label="이전 근거로" text :disabled="busy" @click="back"/><p v-if="busy" role="status">등록된 파일과 읽기 범위를 확인 중입니다</p><p v-if="error" role="alert">{{error}}</p><p v-if="view&&!view.result.ok" role="alert">파일을 표시할 수 없습니다 · {{view.result.code}}. 누락을 빈 자료나 검증 통과로 바꾸지 않습니다.</p>
   <template v-if="view?.result.ok"><p class="muted">{{view.result.origin==='synthetic'?'합성 fixture':'로컬 파일 관측'}} · {{view.result.observedAt}} · {{view.result.byteLength}} bytes · 검증 판정 미수행</p><p v-if="view.result.anchor">앵커 #{{view.result.anchor}} · 연결 문자 그대로 보존, 위치 일치 미검증</p>
    <template v-if="view.result.content.kind==='text'"><label v-if="view.result.content.mime==='text/markdown'"><input v-model="plain" type="checkbox"> 서식 없는 원문</label><SafeMarkdown v-if="view.result.content.mime==='text/markdown'&&!plain" :text="view.result.content.text" :anchor="view.result.anchor" :disabled="busy||!current" @open-reference="openReference"/><pre v-else class="evidence-text">{{view.result.content.text}}</pre></template>
    <template v-else><div class="evidence-tools"><Button label="화면에 맞춤" :outlined="!fit" @click="fit=true;zoom=1"/><Button label="원본 크기" :outlined="fit" @click="fit=false;zoom=1"/><Button label="−" aria-label="이미지 축소" @click="fit=false;zoom=Math.max(.25,zoom-.25)"/><Button label="+" aria-label="이미지 확대" @click="fit=false;zoom=Math.min(4,zoom+.25)"/><span>{{zoom*100}}%</span></div><div class="evidence-image-scroll"><p v-if="imageFailed" role="alert">이미지 디코딩에 실패했습니다. 근거를 표시할 수 없습니다.</p><img v-else @error="imageFailed=true" :src="view.result.content.dataUrl" :alt="view.result.label+' · 근거 이미지, 검증 결과 미확인'" :style="fit?{maxWidth:'100%',maxHeight:'60vh',width:'auto',height:'auto'}:{width:view.result.content.width*zoom+'px',maxWidth:'none'}"/></div></template>
    <p v-if="view.result.content.kind==='text'&&view.result.content.imageReferences.unsupportedCount">지원하지 않는 이미지 연결 {{view.result.content.imageReferences.unsupportedCount}}개 · 외부 이미지는 요청하지 않습니다</p><div v-if="view.images&&(!view.references||plain)" class="evidence-tools"><Button v-for="image in view.images.items" :key="image.evidenceId" :label="'이미지 확인 · '+image.label" @click="read(view!.images!,image.evidenceId)"/></div><p v-for="(note,i) in view.result.omissions" :key="i" class="muted">{{note}}</p><details><summary>파일 출처 해시</summary><p>{{view.result.sourceHash}}</p></details>
   </template>
  </Dialog>
 </section>
</template>
