import {computed,ref,watch,type Ref} from 'vue';
import type {RouteLocationNormalizedLoaded,Router} from 'vue-router';
import type {LiveWorkstreamView} from '../shared/live';

/** Selection is a navigation state, bound to the currently visible filtered rows. */
export function createProjectSelection(route:Pick<RouteLocationNormalizedLoaded,'query'>|undefined,router:Pick<Router,'push'|'replace'>|undefined,rows:Ref<LiveWorkstreamView[]>){
  const notice=ref('');
  const selectedId=computed(()=>typeof route?.query.project==='string'?route.query.project:null);
  const selected=computed(()=>rows.value.find(w=>w.id===selectedId.value)??null);
  const stop=watch([selectedId,rows],([id,visible])=>{
    if(id&&!visible.some(w=>w.id===id)){
      notice.value='선택한 프로젝트가 현재 표시 범위에 없습니다. 프로젝트 상태·저장소·검색 필터를 확인해 주세요.';
      void router?.replace({path:'/',query:{...route?.query,project:undefined}});
    }else if(id)notice.value='';
  },{immediate:true});
  return {selected,selectedId,notice,close:()=>router?.push({path:'/',query:{...route?.query,project:undefined}}),dispose:stop};
}
