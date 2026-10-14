/** Mouse/pen grab-to-pan. Touch and wheel remain native, including inertia and pinch.
 * Capture only after the threshold so an ordinary node click keeps its target.
 */
export function createGraphPan(getPane:()=>HTMLElement|null, measure:()=>void=()=>{}) {
 let drag:{pane:HTMLElement;pointer:number;x:number;y:number;left:number;top:number;moved:boolean}|null=null;
 let suppressClick=false;
 function release(){const prior=drag;drag=null;if(prior?.pane.hasPointerCapture?.(prior.pointer))prior.pane.releasePointerCapture(prior.pointer);}
 function reset(){release();suppressClick=false;}
 function start(event:PointerEvent){
  if(event.isPrimary===false){release();return;}
  reset();
  // Never compete with native touch scrolling or multi-touch zoom.
  if(event.pointerType==='touch'||event.button!==0||event.ctrlKey||event.metaKey||event.altKey)return;
  const pane=getPane();if(!pane)return;
  const target=event.target as Element|null;
  const control=target?.closest?.('button,a,input,select,textarea,[contenteditable="true"],[role="button"]');
  if(control&&!control.matches('[data-graph-task],.group-open'))return;
  // Leave the browser's scrollbar track/thumb alone.
  const rect=pane.getBoundingClientRect();
  if(event.clientX>=rect.left+pane.clientLeft+pane.clientWidth||event.clientY>=rect.top+pane.clientTop+pane.clientHeight)return;
  drag={pane,pointer:event.pointerId,x:event.clientX,y:event.clientY,left:pane.scrollLeft,top:pane.scrollTop,moved:false};
 }
 function move(event:PointerEvent){
  if(!drag||drag.pointer!==event.pointerId)return;
  const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
  if(!drag.moved&&Math.hypot(dx,dy)<5)return;
  drag.moved=true;drag.pane.setPointerCapture?.(event.pointerId);event.preventDefault();
  drag.pane.scrollTo({left:Math.max(0,drag.left-dx),top:Math.max(0,drag.top-dy)});measure();
 }
 function end(event:PointerEvent){if(!drag||drag.pointer!==event.pointerId)return;suppressClick=drag.moved||event.type==='pointercancel';release();}
 function leave(event:PointerEvent){if(drag&&!drag.moved)end(event);}
 function blockedClick(event:MouseEvent){if(event.detail===0)return false;const blocked=suppressClick;suppressClick=false;return blocked;}
 return {start,move,end,leave,reset,blockedClick};
}
