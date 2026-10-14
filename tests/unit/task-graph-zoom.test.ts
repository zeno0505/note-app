import {describe,it,expect,vi} from 'vitest';
import {createGraphZoom,type GraphZoomView} from '../../src/renderer/task-graph-zoom';
function fixture(){
 let current:GraphZoomView={scale:1,left:300,top:400};const listeners=new Map<string,EventListener>();
 const pane={clientWidth:800,clientHeight:600,clientLeft:2,clientTop:2,getBoundingClientRect:()=>({left:100,top:50}),addEventListener:vi.fn((name:string,fn:EventListener)=>listeners.set(name,fn)),removeEventListener:vi.fn((name:string)=>listeners.delete(name))};
 const applied:GraphZoomView[]=[],resolve:(()=>void)[]=[];
 const apply=vi.fn((v:GraphZoomView)=>{applied.push(v);return new Promise<void>(r=>resolve.push(()=>{current=v;r();}));});
 const zoom=createGraphZoom(()=>pane as unknown as HTMLElement,()=>current,apply);
 const wheel=(props={})=>({ctrlKey:true,deltaY:-10,deltaMode:0,clientX:302,clientY:252,preventDefault:vi.fn(),...props} as unknown as WheelEvent);
 const touch=(points:number[][])=>({touches:points.map(([identifier,clientX,clientY])=>({identifier,clientX,clientY})),preventDefault:vi.fn()} as unknown as TouchEvent);
 return {zoom,pane,apply,applied,resolve,wheel,touch,listeners};
}
describe('graph-owned anchored zoom',()=>{
 it('leaves ordinary wheel unchanged and intercepts explicit Ctrl-wheel only',()=>{
  const {zoom,wheel,apply}=fixture(),ordinary=wheel({ctrlKey:false});zoom.wheel(ordinary);expect(ordinary.preventDefault).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
  const pinch=wheel();zoom.wheel(pinch);expect(pinch.preventDefault).toHaveBeenCalledOnce();expect(apply).toHaveBeenCalledOnce();
 });
 it('preserves world point under the cursor, including pane border offset',()=>{
  const {zoom,wheel,applied}=fixture();zoom.wheel(wheel());const v=applied[0];expect((v.left+200)/v.scale).toBeCloseTo(500);expect((v.top+200)/v.scale).toBeCloseTo(600);expect(v.scale).toBeCloseTo(Math.exp(.1));
 });
 it('accumulates rapid events against pending view before DOM commits',async()=>{
  const {zoom,wheel,applied,resolve}=fixture();zoom.wheel(wheel());zoom.wheel(wheel());const v=applied[1];expect(v.scale).toBeCloseTo(Math.exp(.2));expect((v.left+200)/v.scale).toBeCloseTo(500);resolve[0]();await Promise.resolve();zoom.wheel(wheel());expect(applied[2].scale).toBeCloseTo(Math.exp(.3));
 });
 it.each([{deltaMode:0,deltaY:-16},{deltaMode:1,deltaY:-1}])('normalizes line/pixel deltas %j',props=>{const {zoom,wheel,applied}=fixture();zoom.wheel(wheel(props));expect(applied[0].scale).toBeCloseTo(Math.exp(.16));});
 it('caps extreme/page deltas and honors existing zoom bounds',()=>{const {zoom,wheel,applied}=fixture();zoom.wheel(wheel({deltaMode:2,deltaY:-1}));expect(applied[0].scale).toBe(2);zoom.zoomTo(100);expect(applied[1].scale).toBe(2);zoom.zoomTo(0);expect(applied[2].scale).toBe(.00001);});
 it('anchors button zoom/reset to viewport center',()=>{const {zoom,applied}=fixture();zoom.zoomTo(1.5);expect(applied[0]).toEqual({scale:1.5,left:650,top:750});zoom.zoomTo(1);expect(applied[1]).toEqual({scale:1,left:300,top:400});});
 it('leaves single touch native, then owns two-touch pinch and midpoint translation',()=>{
  const {zoom,touch,applied}=fixture(),single=touch([[1,252,252]]);zoom.start(single);zoom.move(single);expect(single.preventDefault).not.toHaveBeenCalled();
  const start=touch([[1,252,252],[2,352,252]]);zoom.start(start);expect(start.preventDefault).toHaveBeenCalledOnce();zoom.move(touch([[1,232,272],[2,432,272]]));const v=applied[0];expect(v.scale).toBe(2);expect((v.left+230)/v.scale).toBeCloseTo(500);expect((v.top+220)/v.scale).toBeCloseTo(600);
 });
 it('two-finger translation at fixed spacing pans without changing scale',()=>{const {zoom,touch,applied}=fixture();zoom.start(touch([[1,252,252],[2,352,252]]));zoom.move(touch([[1,302,292],[2,402,292]]));expect(applied[0]).toEqual({scale:1,left:250,top:360});});
 it('tracks touch IDs despite reordering and clamps pinch scale',()=>{const {zoom,touch,applied}=fixture();zoom.start(touch([[1,252,252],[2,352,252]]));zoom.move(touch([[2,452,252],[1,152,252]]));expect(applied[0].scale).toBe(2);});
 it('requires fresh touch after pinch end and blocks pointer clicks but permits keyboard activation',()=>{
  const {zoom,touch,apply}=fixture();zoom.start(touch([[1,252,252],[2,352,252]]));const remaining=touch([[1,252,252]]);zoom.end(remaining);zoom.move(remaining);expect(remaining.preventDefault).toHaveBeenCalledTimes(2);expect(apply).not.toHaveBeenCalled();
  const click={detail:1,preventDefault:vi.fn(),stopPropagation:vi.fn()} as unknown as MouseEvent;zoom.click(click);expect(click.preventDefault).toHaveBeenCalledOnce();zoom.click({...click,detail:0});expect(click.preventDefault).toHaveBeenCalledOnce();zoom.start(touch([[3,252,252]]));zoom.click(click);expect(click.preventDefault).toHaveBeenCalledOnce();
 });
 it('resets ownership on cancellation/unbind and removes all nonpassive listeners',()=>{
  const {zoom,pane,touch,listeners,apply}=fixture(),unbind=zoom.bind(pane as unknown as HTMLElement);expect(pane.addEventListener).toHaveBeenCalledWith('wheel',zoom.wheel,{passive:false});expect(listeners.size).toBe(7);
  zoom.start(touch([[1,252,252],[2,352,252]]));zoom.end(touch([]));zoom.move(touch([[1,152,252],[2,452,252]]));expect(apply).not.toHaveBeenCalled();unbind();expect(listeners.size).toBe(0);
 });
 it('allows a fresh mouse or pen click after a pinch without requiring another touch',()=>{
  const {zoom,touch}=fixture();zoom.start(touch([[1,252,252],[2,352,252]]));zoom.end(touch([]));
  zoom.pointer({pointerType:'mouse'} as PointerEvent);const click={detail:1,preventDefault:vi.fn(),stopPropagation:vi.fn()} as unknown as MouseEvent;zoom.click(click);expect(click.preventDefault).not.toHaveBeenCalled();
 });
 it('does not zoom missing pane and releases pending view on reset',()=>{const apply=vi.fn(async()=>{}),zoom=createGraphZoom(()=>null,()=>({scale:1,left:0,top:0}),apply);zoom.zoomTo(2);expect(apply).not.toHaveBeenCalled();zoom.reset();});
});
