import {TASK_GRAPH_LIMITS as L, type TaskGraphBridge, type GraphChunk, type GraphSnapshotMetadata} from '../shared/task-graph-contract';
import {parseGraphMetadata, parseGraphChunk, assembleGraphSnapshot} from '../shared/task-graph-transport';

/** The caller publishes only the fulfilled value. One active read per mounted workspace.
 * Call cancel on workspace changes, background and unmount. No source/URL/Git access. */
export function createTaskGraphClient(bridge:TaskGraphBridge) {
  let generation=0,active:AbortController|null=null,serial=0;
  const prefix=globalThis.crypto.randomUUID();
  function cancel(){generation++;active?.abort();active=null;}
  return {cancel,async read(projectId:string,options:{signal?:AbortSignal;expectedRevision?:string|null}={}) {
    cancel();const epoch=generation,controller=new AbortController();active=controller;
    const deadline=AbortSignal.timeout(L.timeoutMs),signal=options.signal?AbortSignal.any([controller.signal,deadline,options.signal]):AbortSignal.any([controller.signal,deadline]);
    const requestId=`${prefix}:${++serial}`;
    const current=()=>{if(epoch!==generation||signal.aborted)throw Error(deadline.aborted?'timeout':'cancelled');};
    let onAbort:()=>void=()=>{};
    const stop=new Promise<never>((_,reject)=>{onAbort=()=>{void bridge.cancelTaskGraph({requestId}).catch(()=>{});reject(Error(deadline.aborted?'timeout':'cancelled'));};signal.addEventListener('abort',onAbort,{once:true});});
    // Attach immediately, including a caller-provided already-aborted signal.
    void stop.catch(()=>{});
    const invoke=async<T>(work:Promise<T>)=>{const value=await Promise.race([work,stop]);current();return value;};
    try {
      current();const session=await invoke(bridge.getTaskGraphSession({projectId}));
      if(!session||session.projectId!==projectId)throw Error('source-unavailable');
      const result=await invoke(bridge.readTaskGraph({...session,requestId,expectedRevision:options.expectedRevision??null}));
      if(result.state!=='snapshot')throw Error(result.reason);
      const metadata:GraphSnapshotMetadata=parseGraphMetadata(result.metadata);
      if(metadata.identity.projectId!==projectId||metadata.identity.dagId!==session.dagId||metadata.identity.sessionKey!==session.sessionKey)throw Error('stale-session');
      if(options.expectedRevision!=null&&metadata.identity.revision!==options.expectedRevision)throw Error('source-changed');
      const chunks:GraphChunk[]=[];
      for(let index=0;index<metadata.chunkCount;index++){
        const response=await invoke(bridge.readTaskGraphChunk({requestId,identity:metadata.identity,index}));
        if(response.state!=='chunk')throw Error(response.reason);
        if(response.requestId!==requestId)throw Error('invalid-schema');
        const chunk=parseGraphChunk(response.chunk);if(chunk.index!==index)throw Error('invalid-schema');chunks.push(chunk);
      }
      const snapshot=assembleGraphSnapshot(metadata,chunks);
      const finalSession=await invoke(bridge.getTaskGraphSession({projectId}));
      if(JSON.stringify(finalSession)!==JSON.stringify(session))throw Error('stale-session');current();
      const objects:object[]=[snapshot];while(objects.length){const value=objects.pop()!;if(Object.isFrozen(value))continue;for(const child of Object.values(value))if(child&&typeof child==='object')objects.push(child);Object.freeze(value);}
      return snapshot;
    }finally{signal.removeEventListener('abort',onAbort);if(active===controller)active=null;void bridge.cancelTaskGraph({requestId}).catch(()=>{});}
  }};
}
