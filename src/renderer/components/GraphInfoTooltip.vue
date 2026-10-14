<script setup lang="ts">
import {ref, nextTick, onBeforeUnmount, onMounted, useId} from 'vue';
import {claimGraphTooltip,releaseGraphTooltip} from '../graph-tooltip-owner';
const props=defineProps<{label:string; kind?:'status'|'date'}>();
const id=useId(),open=ref(false),trigger=ref<HTMLButtonElement|null>(null),panel=ref<HTMLElement|null>(null);
const position=ref({left:'0px',top:'0px'});
let hovered=false,touchWasOpen=false;
let timer:ReturnType<typeof setTimeout>|undefined;
function cancelClose(){if(timer)clearTimeout(timer);timer=undefined;}
async function show(){cancelClose();claimGraphTooltip(close);open.value=true;await nextTick();place();}
function place(){if(!open.value||!trigger.value||!panel.value)return;const a=trigger.value.getBoundingClientRect(),b=panel.value.getBoundingClientRect(),margin=12;const top=props.kind==='date'&&a.top>b.height+margin?a.top-b.height-10:Math.min(a.bottom+10,window.innerHeight-b.height-margin);position.value={left:Math.max(margin,Math.min(a.left+a.width/2-b.width/2,window.innerWidth-b.width-margin))+'px',top:Math.max(margin,top)+'px'};}
function close(){cancelClose();open.value=false;releaseGraphTooltip(close);}
function scheduleClose(){cancelClose();timer=setTimeout(()=>{if(!hovered&&document.activeElement!==trigger.value)close();},160);}
function blur(){scheduleClose();}
function key(event:KeyboardEvent){if(event.key==='Escape'&&open.value){event.preventDefault();event.stopPropagation();close();}}
function pointer(event:PointerEvent){if(event.pointerType==='touch')touchWasOpen=open.value;}
function toggle(event:MouseEvent){if(touchWasOpen){close();touchWasOpen=false;}else void show();}
function outside(event:PointerEvent){if(open.value&&!trigger.value?.contains(event.target as Node)&&!panel.value?.contains(event.target as Node))close();}
function enter(){hovered=true;void show();}
function leave(){hovered=false;scheduleClose();}
onMounted(()=>{document.addEventListener('keydown',key);document.addEventListener('pointerdown',outside);window.addEventListener('resize',place);window.addEventListener('scroll',place,true);});
onBeforeUnmount(()=>{close();document.removeEventListener('keydown',key);document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);});
</script>
<template>
 <span class="graph-info" :class="kind">
  <button ref="trigger" type="button" class="graph-info-target" :aria-label="label" :aria-describedby="id" @mouseenter="enter" @mouseleave="leave" @pointerdown="pointer" @focus="show" @blur="blur" @click="toggle" @keydown="key"><slot/></button>
  <Teleport to="body"><div v-show="open" :id="id" ref="panel" role="tooltip" class="graph-info-panel" :style="position" @mouseenter="enter" @mouseleave="leave" @keydown="key"><slot name="content"/></div></Teleport>
 </span>
</template>
<style scoped>
.graph-info{display:block}.graph-info-target{display:block;min-height:24px;width:100%;border:0;background:transparent;color:var(--app-text-muted);padding:8px 0;text-align:left}.graph-info.date .graph-info-target{padding:5px;font-size:12px}.graph-info-target:focus-visible{outline:2px solid var(--app-primary);border-radius:3px}.graph-info-panel{position:fixed;z-index:1200;width:max-content;max-width:min(380px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:15px 17px;border:1px solid var(--app-success-border);border-radius:11px;background:var(--app-surface);color:var(--app-text);box-shadow:0 4px 0 var(--app-shadow-color);font-size:13px;line-height:1.7;overflow-wrap:anywhere}.graph-info-panel :deep(strong){font-size:15px}.graph-info-panel :deep(small){color:var(--app-text-muted)}
</style>
