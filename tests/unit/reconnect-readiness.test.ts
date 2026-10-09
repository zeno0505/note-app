import {it,expect} from 'vitest';
import {reconnectReadiness} from '../../src/shared/reconnect-readiness';
import type {LiveWorkspaceView} from '../../src/shared/live';
const live={connection:'connected',refreshing:false,freshness:'current',observedAt:'2026-10-07T00:00:00Z',workstreams:[{id:'exact',noteMapping:{state:'resolved',dagId:'dag'},project:{status:'active',sourceState:'available'}}],dags:[{dagId:'dag',state:'ready'}]} as LiveWorkspaceView;
it('reports readiness only for the exact selected live source and configured model',()=>{
 expect(reconnectReadiness(live,'exact',true).state).toBe('ready');expect(reconnectReadiness(live,'other',true).reason).toBe('mapping_unavailable');expect(reconnectReadiness(live,'exact',false).reason).toBe('model_unconfigured');
 expect(reconnectReadiness({...live,freshness:'stale'},'exact',true).reason).toBe('stale');expect(reconnectReadiness({...live,refreshing:true},'exact',true).reason).toBe('refreshing');expect(reconnectReadiness({...live,dags:[{...live.dags[0],state:'error'}]},'exact',true).reason).toBe('dag_unavailable');
 expect(reconnectReadiness({...live,workstreams:[{...live.workstreams[0],project:{...live.workstreams[0].project!,sourceState:'not-checked'}}]},'exact',true).reason).toBe('source_unavailable');
});
