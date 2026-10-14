import {clampGraphZoom} from './task-graph-navigation';
export interface GraphZoomView {scale:number;left:number;top:number}
/** Own only explicit zoom gestures; ordinary wheel and single-touch pan stay native. */
export function createGraphZoom(getPane:()=>HTMLElement|null,getView:()=>GraphZoomView,apply:(view:GraphZoomView)=>Promise<void>,clamp=clampGraphZoom){
 let pending:GraphZoomView|null=null,epoch=0;
 let pinch:{ids:[number,number];distance:number;scale:number;worldX:number;worldY:number}|null=null;
 let suppressClick=false;
 const view=()=>pending??getView();
 function point(clientX:number,clientY:number){const el=getPane()!;const rect=el.getBoundingClientRect();return {x:clientX-rect.left-el.clientLeft,y:clientY-rect.top-el.clientTop};}
 function commit(scale:number,left:number,top:number){const next={scale,left:Math.max(0,left),top:Math.max(0,top)},ticket=++epoch;pending=next;void apply(next).finally(()=>{if(ticket===epoch)pending=null;});}
 function zoomTo(scale:number,client?:{x:number;y:number}){
  const el=getPane();if(!el)return;const old=view(),p=client?point(client.x,client.y):{x:el.clientWidth/2,y:el.clientHeight/2},next=clamp(scale);
  commit(next,(old.left+p.x)/old.scale*next-p.x,(old.top+p.y)/old.scale*next-p.y);
 }
 function wheel(event:WheelEvent){
  if(!event.ctrlKey||!getPane())return;
  event.preventDefault();
  const unit=event.deltaMode===1?16:event.deltaMode===2?getPane()!.clientHeight:1;
  const delta=Math.max(-100,Math.min(100,event.deltaY*unit));
  zoomTo(view().scale*Math.exp(-delta*.01),{x:event.clientX,y:event.clientY});
 }
 function start(event:TouchEvent){
  if(event.touches.length===1){suppressClick=false;pinch=null;return;}
  if(event.touches.length!==2||!getPane()){pinch=null;return;}
  event.preventDefault();suppressClick=true;
  const [a,b]=Array.from(event.touches),p=point((a.clientX+b.clientX)/2,(a.clientY+b.clientY)/2),old=view();
  pinch={ids:[a.identifier,b.identifier],distance:Math.max(1,Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)),scale:old.scale,worldX:(old.left+p.x)/old.scale,worldY:(old.top+p.y)/old.scale};
 }
 function move(event:TouchEvent){
  if(!pinch){if(suppressClick)event.preventDefault();return;}event.preventDefault();
  const touches=Array.from(event.touches),a=touches.find(t=>t.identifier===pinch!.ids[0]),b=touches.find(t=>t.identifier===pinch!.ids[1]);if(!a||!b)return;
  const p=point((a.clientX+b.clientX)/2,(a.clientY+b.clientY)/2),scale=clamp(pinch.scale*Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)/pinch.distance);
  commit(scale,pinch.worldX*scale-p.x,pinch.worldY*scale-p.y);
 }
 function end(event:TouchEvent){
  // Once a pinch ends, require a fresh contact before native single-finger pan.
  // This prevents remaining-finger jumps and accidental activation.
  if(suppressClick&&event.touches.length)event.preventDefault();
  pinch=null;
 }
 function pointer(event:PointerEvent){if(event.pointerType!=='touch')suppressClick=false;}
 function click(event:MouseEvent){if(suppressClick&&event.detail!==0){event.preventDefault();event.stopPropagation();}}
 function reset(){epoch++;pending=null;pinch=null;suppressClick=false;}
 function bind(el:HTMLElement){
  el.addEventListener('pointerdown',pointer);el.addEventListener('wheel',wheel,{passive:false});el.addEventListener('touchstart',start,{passive:false});el.addEventListener('touchmove',move,{passive:false});el.addEventListener('touchend',end,{passive:false});el.addEventListener('touchcancel',end,{passive:false});el.addEventListener('click',click,true);
  return ()=>{el.removeEventListener('pointerdown',pointer);el.removeEventListener('wheel',wheel);el.removeEventListener('touchstart',start);el.removeEventListener('touchmove',move);el.removeEventListener('touchend',end);el.removeEventListener('touchcancel',end);el.removeEventListener('click',click,true);reset();};
 }
 return {zoomTo,wheel,start,move,end,click,pointer,reset,bind};
}
