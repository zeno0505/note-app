import {it,expect,afterEach,vi} from 'vitest';
import {ref,nextTick} from 'vue';
import {createRouter,createMemoryHistory} from 'vue-router';
import {createProjectSelection} from '../../src/renderer/project-selection';
import type {LiveWorkstreamView} from '../../src/shared/live';
const row=(id:string):LiveWorkstreamView=>({id,title:id,projectName:null,branch:null,archived:false,terminalConnected:null,terminalCount:null,agentState:'unknown',projectMapping:'missing-project-id',noteMapping:{state:'unresolved',reason:null,dagId:null}});
const disposals:(()=>void)[]=[];afterEach(()=>disposals.splice(0).forEach(stop=>stop()));
async function setup(query:Record<string,string|string[]>={}){
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{}}]});await router.push({path:'/',query});await router.isReady();
  const rows=ref([row('one'),row('two')]);const route={get query(){return router.currentRoute.value.query;}};
  const selection=createProjectSelection(route,router,rows);disposals.push(selection.dispose);return {router,rows,selection};
}
it('uses navigation selection and back history without copying stale summaries',async()=>{
  const {router,rows,selection}=await setup();expect(selection.selected.value).toBeNull();
  await router.push({query:{project:'one'}});expect(selection.selected.value?.id).toBe('one');
  await router.push({query:{project:'two'}});expect(selection.selected.value?.id).toBe('two');router.back();await vi.waitFor(()=>expect(selection.selected.value?.id).toBe('one'));
  rows.value=[{...row('one'),title:'new observed title'},row('two')];await nextTick();expect(selection.selected.value?.title).toBe('new observed title');
  await selection.close();expect(selection.selected.value).toBeNull();router.back();await vi.waitFor(()=>expect(selection.selected.value?.id).toBe('one'));
});
it('clears a filtered-out selection without replacing it with a different project',async()=>{
  const {rows,selection,router}=await setup({project:'one'});expect(selection.selected.value?.id).toBe('one');rows.value=[row('two')];await nextTick();
  expect(selection.selected.value).toBeNull();expect(selection.notice.value).toContain('현재 표시 범위');await vi.waitFor(()=>expect(router.currentRoute.value.query.project).toBeUndefined());
  await router.push({query:{project:'two'}});await nextTick();expect(selection.selected.value?.id).toBe('two');expect(selection.notice.value).toBe('');
});
it('rejects a missing deep link and does not interpret an array query as an identity',async()=>{
  const absent=await setup({project:'missing'});await vi.waitFor(()=>expect(absent.router.currentRoute.value.query.project).toBeUndefined());expect(absent.selection.selected.value).toBeNull();
  const array=await setup({project:['one','two']});expect(array.selection.selected.value).toBeNull();
});
