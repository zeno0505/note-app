import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createGraphPan} from '../../src/renderer/task-graph-pan';
function fixture(){
 const captured=new Set<number>();
 const pane={scrollLeft:100,scrollTop:150,clientWidth:500,clientHeight:400,clientLeft:1,clientTop:1,
 getBoundingClientRect:()=>({left:0,top:0}),setPointerCapture:vi.fn((id:number)=>captured.add(id)),hasPointerCapture:(id:number)=>captured.has(id),releasePointerCapture:vi.fn((id:number)=>captured.delete(id)),
 scrollTo:vi.fn()};
 const measure=vi.fn(),pan=createGraphPan(()=>pane as unknown as HTMLElement,measure);
 const event=(extra:Record<string,unknown>={})=>({pointerId:1,pointerType:'mouse',isPrimary:true,button:0,clientX:100,clientY:100,preventDefault:vi.fn(),...extra} as unknown as PointerEvent);
 return {pane,pan,event,measure};
}
describe('graph gesture ownership',()=>{
 it('retains clicks under threshold, pans both axes and suppresses only the resulting pointer click',()=>{
  const {pan,pane,event,measure}=fixture();pan.start(event());pan.move(event({clientX:102}));expect(pane.scrollTo).not.toHaveBeenCalled();pan.end(event());expect(pan.blockedClick({detail:1} as MouseEvent)).toBe(false);
  pan.start(event());pan.move(event({clientX:40,clientY:20}));expect(pane.scrollTo).toHaveBeenCalledWith({left:160,top:230});expect(measure).toHaveBeenCalledOnce();pan.end(event());expect(pane.releasePointerCapture).toHaveBeenCalledWith(1);
  expect(pan.blockedClick({detail:0} as MouseEvent)).toBe(false);expect(pan.blockedClick({detail:1} as MouseEvent)).toBe(true);expect(pan.blockedClick({detail:1} as MouseEvent)).toBe(false);
 });
 it.each([{pointerType:'touch'},{isPrimary:false},{button:2},{ctrlKey:true},{metaKey:true},{altKey:true}])('leaves native or modified gestures alone: %j',extra=>{
  const {pan,pane,event}=fixture();pan.start(event(extra));pan.move(event({clientX:20}));expect(pane.scrollTo).not.toHaveBeenCalled();expect(pane.setPointerCapture).not.toHaveBeenCalled();
 });
 it('excludes controls and native scrollbar tracks, but admits graph nodes',()=>{
  const {pan,pane,event}=fixture();const control={matches:()=>false};pan.start(event({target:{closest:()=>control}}));pan.move(event({clientX:20}));expect(pane.scrollTo).not.toHaveBeenCalled();
  pan.start(event({clientX:505}));pan.move(event({clientX:20}));expect(pane.scrollTo).not.toHaveBeenCalled();
  pan.start(event({target:{closest:()=>({matches:()=>true})}}));pan.move(event({clientX:20}));expect(pane.scrollTo).toHaveBeenCalledOnce();
 });
 it.each(['pointercancel','lostpointercapture'])('ends a moved drag on %s and ignores subsequent motion',type=>{
  const {pan,pane,event}=fixture();pan.start(event());pan.move(event({clientX:20}));pan.end(event({type}));pan.move(event({clientX:10}));expect(pane.scrollTo).toHaveBeenCalledOnce();expect(pan.blockedClick({detail:1} as MouseEvent)).toBe(true);
  pan.start(event());pan.end(event());expect(pan.blockedClick({detail:1} as MouseEvent)).toBe(false);
 });
 it('cancels an uncaptured exit and resets captured ownership on lifecycle cleanup',()=>{
  const {pan,pane,event}=fixture();pan.start(event());pan.leave(event());pan.move(event({clientX:20}));expect(pane.scrollTo).not.toHaveBeenCalled();
  pan.start(event());pan.move(event({clientX:20}));pan.reset();pan.move(event({clientX:10}));expect(pane.scrollTo).toHaveBeenCalledOnce();expect(pane.releasePointerCapture).toHaveBeenCalledOnce();
 });
 it('ignores unrelated pointer endings and releases on a secondary pointer',()=>{
  const {pan,pane,event}=fixture();pan.start(event());pan.end(event({pointerId:2}));pan.move(event({clientX:20}));expect(pane.scrollTo).toHaveBeenCalledOnce();pan.start(event({isPrimary:false,pointerId:2}));pan.move(event({clientX:10}));expect(pane.scrollTo).toHaveBeenCalledOnce();
 });
 it('preserves native touch pan while binding dedicated graph zoom in both actual component sources',()=>{
  for(const name of ['TaskGraphOverview','TaskGraphWorkspace']){
   const source=readFileSync(new URL(`../../src/renderer/components/${name}.vue`,import.meta.url),'utf8');
   expect(source).toContain('touch-action:pan-x pan-y;');expect(source).not.toContain('touch-action:none');expect(source).toContain('gestureZoom.bind(el)');expect(source).toContain('@lostpointercapture=');
  }
 });
});
