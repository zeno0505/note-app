import {createPublicReadingHarness,publicInputHash,type PublicReadingPack,type ModelAdapter} from '../summary/reading/model-harness';
import type {createModelReadingStorage,LatestModelReadingView} from '../summary/reading/model-reading-storage';
export interface PublicModelView {
  state:'disabled'|'idle'|'running'|'failed'|'cancelled';message:string;inputHash:string;sourceSha:string;
  latest:LatestModelReadingView;
}
/** One compiled public pack only. No renderer paths, prompts, project IDs or provider choices. */
export function createPublicModelController(pack:PublicReadingPack,storage:ReturnType<typeof createModelReadingStorage>,adapter?:ModelAdapter,timeoutMs=120000){
  const inputHash=publicInputHash(pack),harness=adapter?createPublicReadingHarness(adapter,storage.ledger(pack),timeoutMs):undefined;
  let state:PublicModelView['state']=adapter?'idle':'disabled',message=adapter?'승인된 공개 note-app 입력만 수동으로 요약합니다.':'공개 note-app 수동 AI 실행이 설정되지 않았습니다.';
  let flight:Promise<PublicModelView>|undefined,generation=0,disposed=false;
  async function view():Promise<PublicModelView>{return {state,message,inputHash,sourceSha:pack.sourceSha,latest:await storage.readLatest(pack.project,inputHash)};}
  return {
    view,
    run():Promise<PublicModelView>{
      if(disposed||!harness)return view();
      if(flight)return flight;
      const own=++generation;state='running';message='공개 근거의 한국어 요약을 생성하고 있습니다.';
      const work=(async()=>{try{const result=await harness.summarize(pack);if(own===generation&&!disposed){state=result.status==='model'?'idle':result.status==='cancelled'?'cancelled':'failed';message=result.status==='model'?'최신 성공 요약을 저장했습니다. 같은 입력은 모델을 다시 호출하지 않습니다.':'요약을 완료하지 못했습니다. 이전 성공 결과를 보존합니다. 불확실한 요청은 자동 재전송하지 않습니다.';}}catch{if(own===generation&&!disposed){state='failed';message='요약 실행을 확인하지 못했습니다. 이전 결과와 호출 방지 기록을 보존합니다.';}}return view();})();flight=work;
      void work.finally(()=>{if(flight===work)flight=undefined;}).catch(()=>{});return work;
    },
    cancel(){generation++;harness?.cancel();state=adapter?'cancelled':'disabled';message='현재 요청을 취소했습니다. 늦은 결과는 게시하지 않습니다.';return view();},
    dispose(){disposed=true;generation++;harness?.cancel();},
    settle(){return flight??Promise.resolve();},
  };
}
