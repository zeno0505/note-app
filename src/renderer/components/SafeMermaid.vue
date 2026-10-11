<script setup lang="ts">
import { computed } from 'vue';
import { layoutSafeMermaid, parseSafeMermaid } from '../../phase2/mermaid';
const props = defineProps<{ source: string; showSource?: boolean }>();
const graph = computed(() => parseSafeMermaid(props.source));
const layout = computed(() => graph.value.ok ? layoutSafeMermaid(graph.value) : null);
const reason = computed(() => graph.value.ok ? '' : graph.value.reason === 'unsupported-syntax' ? '이 Mermaid 문법은 안전한 도식으로 표시하지 못했습니다' : 'Mermaid 도식 크기 제한을 넘었습니다');
</script>
<template>
  <figure class="safe-mermaid" aria-label="읽기 전용 Mermaid 도식">
    <figcaption>제한된 Mermaid 흐름도 · flowchart/graph의 기본 노드·화살표·그룹을 표시합니다</figcaption>
    <p class="mermaid-support-note">ER 등 지원하지 않는 도식·문법은 전체 원문으로 표시합니다. 배치는 단순화됩니다</p>
    <p v-if="graph.ok && graph.notices.includes('styles-omitted')" class="mermaid-style-notice" role="status">원문의 classDef 색상·서식은 적용하지 않았습니다. 분류 이름은 노드에 텍스트로 표시하며 전체 스타일 선언은 원문에서 확인할 수 있습니다</p>
    <div v-if="layout" class="mermaid-scroll" tabindex="0" role="region" aria-label="Mermaid 도식 스크롤">
      <svg :viewBox="`0 0 ${layout.width} ${layout.height}`" :width="layout.width" :height="layout.height" role="img" aria-label="문서의 흐름도">
        <g v-for="group in layout.groups" :key="`group-${group.id}`" class="mermaid-group">
          <title>{{ group.label }}</title>
          <rect :x="group.x" :y="group.y" :width="group.width" :height="group.height" rx="8" />
          <text :x="group.x + 16" :y="group.y + 23"><tspan v-for="(line, index) in group.lines" :key="index" :x="group.x + 16" :dy="index ? 18 : 0">{{ line }}</tspan></text>
        </g>
        <g v-for="(edge, index) in layout.edges" :key="`edge-${index}`" class="mermaid-edge">
          <path v-if="edge.path" :d="edge.path" fill="none" :stroke-width="edge.style === 'thick' ? 4 : 2" :stroke-dasharray="edge.style === 'dashed' ? '6 4' : undefined" />
          <line v-else :x1="edge.x1" :y1="edge.y1" :x2="edge.x2" :y2="edge.y2" :stroke-width="edge.style === 'thick' ? 4 : 2" :stroke-dasharray="edge.style === 'dashed' ? '6 4' : undefined" />
          <polygon v-if="edge.arrow" :points="edge.arrowPoints" />
          <text v-if="edge.label" :x="(edge.x1 + edge.x2) / 2" :y="(edge.y1 + edge.y2) / 2 - 7" text-anchor="middle"><tspan v-for="(line, labelIndex) in edge.labelLines" :key="labelIndex" :x="(edge.x1 + edge.x2) / 2" :dy="labelIndex ? 16 : 0">{{ line }}</tspan></text>
        </g>
        <g v-for="node in layout.nodes" :key="node.id" class="mermaid-node">
          <title>{{ node.label }}</title>
          <polygon v-if="node.shape === 'diamond'" :points="`${node.x + node.width / 2},${node.y} ${node.x + node.width},${node.y + node.height / 2} ${node.x + node.width / 2},${node.y + node.height} ${node.x},${node.y + node.height / 2}`" />
          <ellipse v-else-if="node.shape === 'circle'" :cx="node.x + node.width / 2" :cy="node.y + node.height / 2" :rx="node.width / 2" :ry="node.height / 2" />
          <rect v-else :x="node.x" :y="node.y" :width="node.width" :height="node.height" :rx="node.shape === 'rounded' ? 18 : 4" />
          <text :x="node.x + node.width / 2" :y="node.y + node.height / 2 - node.classLines.length * 8 - (node.lines.length - 1) * 9" text-anchor="middle" dominant-baseline="middle"><tspan v-for="(line, index) in node.lines" :key="index" :x="node.x + node.width / 2" :dy="index ? 18 : 0">{{ line }}</tspan></text>
          <text v-if="node.classLines.length" class="mermaid-node-classes" :x="node.x + node.width / 2" :y="node.y + node.height - node.classLines.length * 16 + 3" text-anchor="middle"><tspan v-for="(line, index) in node.classLines" :key="index" :x="node.x + node.width / 2" :dy="index ? 16 : 0">{{ line }}</tspan></text>
        </g>
      </svg>
    </div>
    <p v-else role="status">{{ reason }}<template v-if="!graph.ok && graph.line"> ({{ graph.line }}행)</template>. 실행하지 않고 전체 원문을 표시합니다</p>
    <details :open="!layout || showSource"><summary>Mermaid 원문</summary><pre><slot><code>{{ source }}</code></slot></pre></details>
  </figure>
</template>
<style scoped>
.safe-mermaid { margin: 1em 0; padding: .8em; border: 1px solid var(--p-content-border-color, #888); border-radius: .5em; }
.mermaid-group rect { fill: var(--p-content-background, #fff); fill-opacity: .7; stroke: var(--p-content-border-color, #aaa); stroke-width: 2; stroke-dasharray: 5 3; }
.mermaid-group text { font-weight: 600; }
.mermaid-node-classes { font-size: 11px; }
.mermaid-style-notice { font-size: .85rem; padding: .5em; border-left: 3px solid var(--p-primary-color, #2d76a8); }
.mermaid-support-note { font-size: .82rem; opacity: .8; }
figcaption { font-size: .82rem; opacity: .8; margin-bottom: .5em; }
.mermaid-scroll { overflow: auto; max-height: 65vh; }
svg { display: block; }
.mermaid-edge line, .mermaid-edge path { stroke: var(--p-text-muted-color, #7a8696); }
.mermaid-edge polygon { fill: var(--p-text-muted-color, #7a8696); }
.mermaid-node rect, .mermaid-node polygon, .mermaid-node ellipse { fill: var(--p-content-background, #fff); stroke: var(--p-primary-color, #2d76a8); stroke-width: 2; }
text { fill: var(--p-text-color, #172a3a); font: 13px system-ui, sans-serif; }
.mermaid-edge text { paint-order: stroke; stroke: var(--p-content-background, #fff); stroke-width: 4px; stroke-linejoin: round; }
pre { max-height: 55vh; overflow: auto; white-space: pre; }
summary { cursor: pointer; margin-top: .5em; }
.mermaid-scroll:focus-visible, summary:focus-visible { outline: 2px solid var(--p-primary-color, #2d76a8); outline-offset: 2px; }
</style>
