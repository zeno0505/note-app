export function quotaGraph(used:number) {
  return {width:Math.min(100,Math.max(0,used)),remaining:Math.max(0,Math.round((100-used)*100)/100)};
}
// A period comparison has no budget denominator. Each provider keeps its own scale.
export function costWidth(cost:number,costs:number[]):number {
  const max=Math.max(0,...costs);
  return max>0?Math.min(100,Math.max(0,cost/max*100)):0;
}
