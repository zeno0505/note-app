<script setup lang="ts">
import {computed, ref, watch, useId, nextTick, onBeforeUnmount} from 'vue';
import type {GraphLayout} from '../../shared/task-graph-layout';
import type {GraphDateReadResult} from '../../shared/task-graph-dates';
import {graphGroupLabels,graphGroupDateSummaries,graphDeclaredStatus,graphDateYearContext,graphDateShortLabel} from '../task-graph-overview';
import {linkedDateKst} from '../../shared/linked-date-format';
import GraphInfoTooltip from './GraphInfoTooltip.vue';
import {createGraphPan} from '../task-graph-pan';
import {createGraphZoom} from '../task-graph-zoom';
import {routeOverviewGroups,overviewBoardHeight} from '../task-graph-overview-routes';
const props=defineProps<{layout:GraphLayout;dates:GraphDateReadResult|null;orderedGroupKeys?:readonly string[]}>();
const emit=defineEmits<{openGroup:[key:string]}>();
const pane=ref<HTMLElement|null>(null);
const pan=createGraphPan(()=>pane.value);
const zoom=ref(1),boardWidth=ref(900);
let zoomTicket=0,observer:ResizeObserver|undefined,unbindZoom:(()=>void)|undefined;
const gestureZoom=createGraphZoom(()=>pane.value,()=>({scale:zoom.value,left:pane.value?.scrollLeft??0,top:pane.value?.scrollTop??0}),async view=>{
 const el=pane.value,ticket=++zoomTicket;zoom.value=view.scale;await nextTick();if(ticket===zoomTicket&&el===pane.value)el?.scrollTo({left:view.left,top:view.top});
},value=>Math.max(.1,Math.min(2,value)));
watch(pane,el=>{unbindZoom?.();observer?.disconnect();if(!el)return;const measure=()=>{boardWidth.value=Math.max(900,el.clientWidth);};measure();observer=new ResizeObserver(measure);observer.observe(el);unbindZoom=gestureZoom.bind(el);});
onBeforeUnmount(()=>{zoomTicket++;pan.reset();unbindZoom?.();observer?.disconnect();});
function resetZoom(){gestureZoom.zoomTo(1);}
defineExpose({resetZoom});
function openGroup(key:string,event:MouseEvent){if(!pan.blockedClick(event))emit('openGroup',key);}
const marker=useId().replace(/:/g,'');
const datesByGroup=computed(()=>graphGroupDateSummaries(props.layout,props.dates));
const year=computed(()=>graphDateYearContext([...datesByGroup.value.values()]));
const labels=computed(()=>graphGroupLabels(props.layout));
const cards=computed(()=>{
 // Source order is meaningful; do not hardcode private snapshot group names.
 const keys=props.orderedGroupKeys??[...new Set(props.layout.index.groupById.values())];
 const rank=new Map(keys.map((key,index)=>[key,index]));
 return [...props.layout.groups].sort((a,b)=>(rank.get(a.key)??0)-(rank.get(b.key)??0)).map((group,index)=>({...group,label:labels.value.get(group.key)??'그룹 미확인',x:48+(index%3)*420,y:60+Math.floor(index/3)*300,date:datesByGroup.value.get(group.key),statuses:group.declaredStatusCounts.map(item=>({...item,...graphDeclaredStatus(item.status)})).sort((a,b)=>{const rank=['done','deferred','superseded','pending','running','unknown'];return rank.indexOf(a.tone)-rank.indexOf(b.tone);})}));
});
const dense=computed(()=>props.layout.groups.length>120||props.layout.groupLinks.length>2000);
const groupPage=ref(0);
watch(()=>props.layout,()=>{groupPage.value=0;zoomTicket++;gestureZoom.reset();pan.reset();zoom.value=1;});
const shownCards=computed(()=>(dense.value?cards.value.slice(groupPage.value*30,(groupPage.value+1)*30):cards.value).map((card,index)=>({...card,x:48+(index%3)*420,y:60+Math.floor(index/3)*300})));
const height=computed(()=>overviewBoardHeight(shownCards.value,links.value));
const links=computed(()=>routeOverviewGroups(cards.value,dense.value?[]:props.layout.groupLinks).map(link=>({...link,from:labels.value.get(link.fromGroupKey),to:labels.value.get(link.toGroupKey)})));
const count=computed(()=>props.layout.groups.reduce((n,g)=>n+g.nodeCount,0));
const crossCount=computed(()=>props.layout.groupLinks.reduce((n,g)=>n+g.uniqueEdgeCount,0));
</script>
<template>
 <section class="graph-overview" data-testid="graph-overview">
  <header class="overview-heading"><h3>전체 <small>{{cards.length}}그룹 · {{count}}개 작업</small></h3><span v-if="year" class="year-context">{{year}}</span></header>
  <p v-if="dense" role="status" class="overview-density">그룹 {{cards.length}}개·방향 묶음 {{layout.groupLinks.length}}개입니다. 개요 그림의 렌더링 안전 상한을 넘어 그룹 목록을 30개씩 표시합니다. 그룹을 열면 전체 작업 관계를 탐색할 수 있습니다.</p>
  <nav v-if="dense" class="group-pages" aria-label="그룹 목록 페이지"><button :disabled="groupPage===0" @click="groupPage--">이전 그룹</button><span>{{groupPage+1}} / {{Math.ceil(cards.length/30)}}</span><button :disabled="(groupPage+1)*30>=cards.length" @click="groupPage++">다음 그룹</button></nav>
  <div class="overview-zoom-controls" role="group" aria-label="개요 그래프 확대 축소"><button aria-label="개요 그래프 축소" @click="gestureZoom.zoomTo(zoom/1.25)">−</button><button aria-label="개요 그래프 배율 초기화" @click="resetZoom">{{Math.round(zoom*100)}}%</button><button aria-label="개요 그래프 확대" @click="gestureZoom.zoomTo(zoom*1.25)">+</button></div>
  <div ref="pane" class="overview-scroll" :style="{height:height+2+'px'}" @pointerdown="pan.start" @pointermove="pan.move" @pointerup="pan.end" @pointercancel="pan.end" @lostpointercapture="pan.end" @pointerleave="pan.leave" tabindex="0" aria-label="그룹 개요, 가로 스크롤 가능">
   <div :style="{width:boardWidth*zoom+'px',height:height*zoom+'px',position:'relative',overflow:'hidden'}"><div class="overview-board" :style="{height:height+'px',width:boardWidth+'px',transform:`scale(${zoom})`,transformOrigin:'0 0'}">
    <svg preserveAspectRatio="none" class="group-links" :viewBox="`0 0 1300 ${height}`" aria-label="그룹 간 선행에서 후속 관계"><defs><marker :id="marker+'forward'" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--app-success-text)"/></marker><marker :id="marker+'reverse'" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--app-info-text)"/></marker></defs><g v-for="link in links" :key="JSON.stringify([link.fromGroupKey,link.toGroupKey])"><title>{{link.from}} → {{link.to}} · {{link.uniqueEdgeCount}}개 관계 (그룹 집계)</title><path :d="link.path" fill="none" :stroke="link.reverse?'var(--app-info-text)':'var(--app-success-text)'" stroke-width="2" stroke-dasharray="6 6" :marker-end="`url(#${marker+(link.reverse?'reverse':'forward')})`"/><rect class="route-count-background" :x="link.x-(String(link.uniqueEdgeCount).length*8+12)/2" :y="link.y-25" :width="String(link.uniqueEdgeCount).length*8+12" height="17" rx="3"/><text :x="link.x" :y="link.y-12" text-anchor="middle" :fill="link.reverse?'var(--app-info-text)':'var(--app-success-text)'">{{link.uniqueEdgeCount}}</text></g></svg>
    <article v-for="card in shownCards" :key="card.key" class="group-card" :style="{left:card.x/13+'%',top:card.y+'px'}" :aria-label="card.label+' 그룹'">
     <button class="group-open" :aria-label="card.label+' 그룹 '+card.nodeCount+'개 작업 열기'" @click="openGroup(card.key,$event)"><strong>{{card.label}}</strong><b>{{card.nodeCount}}개 작업</b><small>내부 관계 {{card.internalEdgeCount}}</small></button>
     <GraphInfoTooltip class="group-date" kind="date" :label="card.label+' 최근 연결 커밋 날짜 '+graphDateShortLabel(card.date,year)">
      {{graphDateShortLabel(card.date,year)}}
      <template #content><strong>최근 연결 커밋</strong><template v-if="card.date?.latest"><p class="date-exact">{{linkedDateKst(card.date.latest.committerAtUtc)}}</p><p>{{card.date.latest.taskId}} · {{card.date.latest.sha}}</p><small>{{card.date.latest.repository.host}}/{{card.date.latest.repository.owner}}/{{card.date.latest.repository.name}}</small><p class="commit-source">{{card.date.latest.verifiedCommitUrl}}</p></template><p v-else>확인된 연결 커밋 없음</p><template v-if="card.date"><p>날짜 확인 {{card.date.coverage.tasks.resolved}}/{{card.date.coverage.tasks.total}}개 · 참조 없음 {{card.date.coverage.tasks.noReference}} · 미확인 {{card.date.coverage.tasks.unresolved}}</p><p>참조 확인 {{card.date.coverage.references.resolved}}/{{card.date.coverage.references.total}}개 · 미해결 {{card.date.coverage.references.unresolved}}</p><small>{{card.date.state==='partial'?'일부 확인 · ':''}}{{card.date.coverage.inspection==='complete'?'확인된 연결 기록 기준':'참조 조사 미완료'}} · 작업일·완료일 아님</small></template><small v-else>날짜 근거를 확인하지 못했습니다</small></template>
     </GraphInfoTooltip>
     <GraphInfoTooltip kind="status" :label="card.label+' 선언 상태, 총 '+card.nodeCount+'개. '+card.statuses.map(s=>s.label+' '+s.count).join(', ')">
      <span class="status-bar" aria-hidden="true"><i v-for="status in card.statuses" :key="JSON.stringify(status.status)" :class="'tone-'+status.tone" :style="{width:status.count/card.nodeCount*100+'%'}"/></span>
      <template #content><div class="status-heading"><strong>{{card.label}} 상태</strong><small>총 {{card.nodeCount}}개</small></div><ul class="status-counts"><li v-for="status in card.statuses" :key="JSON.stringify(status.status)"><i :class="'tone-'+status.tone"/>{{status.label}} {{status.count}}<span v-if="status.status&&status.label!==status.status" class="raw-status"> ({{status.status}})</span></li></ul><small>선언 상태 · 실행 검증 결과 아님</small></template>
     </GraphInfoTooltip>
    </article>
    <footer><span>선행 → 후속</span><span>그룹 간 관계 {{crossCount}}</span></footer>
   </div></div>
  </div>
 </section>
</template>
<style scoped>
.overview-zoom-controls{display:flex;justify-content:flex-end;gap:8px;margin:8px 0}.overview-zoom-controls button{padding:8px 12px;border:1px solid var(--app-border);border-radius:6px;background:var(--app-surface);color:var(--app-text)}.overview-density{font-size:13px;margin:12px 0}.group-pages{display:flex;gap:12px;align-items:center;margin:12px 0}.group-pages button{padding:8px 12px;background:var(--app-surface);color:var(--app-text);border:1px solid var(--app-border);border-radius:6px}.overview-heading{display:flex;align-items:center;justify-content:space-between;margin:24px 0 16px}.overview-heading h3{font-size:22px;margin:0}.overview-heading small{font-size:14px;color:var(--app-text-muted);font-weight:400;margin-left:12px}.year-context{font-size:12px;color:var(--app-text-muted)}.overview-scroll{overflow:auto;touch-action:pan-x pan-y;overscroll-behavior-x:contain;cursor:grab;border:1px solid var(--app-border);border-radius:13px;background:var(--app-surface-muted)}.overview-board{position:relative;min-width:900px;width:100%;min-height:320px}.route-count-background{fill:var(--app-surface-muted)}.group-links{position:absolute;width:100%;height:100%;inset:0;font-size:13px}.group-card{position:absolute;width:23.076923%;height:164px;border:1px solid var(--app-border);border-radius:13px;background:var(--app-surface);padding:17px 18px}.group-open{display:flex;flex-direction:column;gap:7px;padding:0;border:0;background:none;text-align:left;color:var(--app-text);width:100%;height:108px}.group-open strong{font-size:28px;color:var(--app-primary);max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.group-open b{font-size:19px}.group-open small{font-size:12px;color:var(--app-text-muted)}.group-open:focus-visible{outline:2px solid var(--app-primary);outline-offset:7px}.group-date{position:absolute;right:17px;top:22px}.status-bar{display:flex;height:7px;border-radius:1px;overflow:hidden;width:100%}.status-bar i{height:100%;display:block}.tone-done{background:#619b7d}.tone-deferred{background:#c9a246}.tone-superseded{background:#a9b1ad}.tone-pending{background:#c5ced1}.tone-running{background:#739fc6}.tone-unknown{background:#948aa8}.status-heading{display:flex;justify-content:space-between;gap:60px}.status-counts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 22px;padding:0;margin:12px 0 7px;list-style:none}.status-counts li{display:flex;align-items:center;gap:7px}.status-counts i{display:inline-block;width:8px;height:8px;border-radius:2px;flex-shrink:0}.raw-status{font-size:10px;color:var(--app-text-muted)}.date-exact{font-weight:700;font-size:17px}.commit-source{font-size:11px;color:var(--app-text-muted)}footer{position:absolute;bottom:20px;left:24px;right:24px;display:flex;justify-content:space-between;font-size:12px;color:var(--app-text-muted)}
</style>
