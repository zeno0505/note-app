/** Only one graph information popup owns Escape at a time. No graph data held. */
let owner:(()=>void)|null=null;
export function claimGraphTooltip(close:()=>void){if(owner!==close){owner?.();owner=close;}}
export function releaseGraphTooltip(close:()=>void){if(owner===close)owner=null;}
