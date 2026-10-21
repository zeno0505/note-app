import {createHash} from 'node:crypto';
import type {DagReadModel} from '../facts/dag-read-model';
import {TASK_GRAPH_LIMITS as L, TASK_GRAPH_CONTRACT_VERSION, graphEdgeId, sameGraphIdentity, type GraphSourceNode, type GraphSourceEdge, type GraphChunk, type GraphSnapshotMetadata, type TaskGraphIdentity, type GraphReadResult, type GraphChunkResult, type GraphDetailResult, type GraphDetailSnapshot, type GraphReadError} from '../shared/task-graph-contract';
import {graphEncodedBytes, parseGraphReadRequest, parseGraphChunkRequest, parseGraphCancelRequest, parseGraphDetailRequest, parseGraphDetailResult, assembleGraphSnapshot} from '../shared/task-graph-transport';

/** Iterative Kosaraju: no recursive stack overflow on a maximum-length chain. */
function cycles(nodes: readonly GraphSourceNode[], edges: readonly GraphSourceEdge[]): string[][] {
  const forward=new Map(nodes.map(n=>[n.id,[] as string[]])), reverse=new Map(nodes.map(n=>[n.id,[] as string[]]));
  for(const e of edges)if(e.from.kind==='node'&&e.to.kind==='node'){forward.get(e.from.id)!.push(e.to.id);reverse.get(e.to.id)!.push(e.from.id);}
  const visited=new Set<string>(), order:string[]=[];
  for(const n of nodes){if(visited.has(n.id))continue;visited.add(n.id);const stack:[string,number][]=[[n.id,0]];
    while(stack.length){const top=stack[stack.length-1],next=forward.get(top[0])!;if(top[1]<next.length){const id=next[top[1]++];if(!visited.has(id)){visited.add(id);stack.push([id,0]);}}else{order.push(top[0]);stack.pop();}}}
  visited.clear();const result:string[][]=[];
  for(const id of order.reverse()){if(visited.has(id))continue;const component:string[]=[],stack=[id];visited.add(id);while(stack.length){const n=stack.pop()!;component.push(n);for(const p of reverse.get(n)!)if(!visited.has(p)){visited.add(p);stack.push(p);}}
    if(component.length>1||forward.get(id)!.includes(id))result.push(component.sort());}
  return result.sort((a,b)=>a[0].localeCompare(b[0]));
}
const bounded=(s:unknown,max:number):s is string=>typeof s==='string'&&s.length>0&&s.length<=max;
/** Main-side allowlist projection of the full admitted source, never displayTasks. */
export function produceTaskGraph(model:DagReadModel, base:Omit<TaskGraphIdentity,'sourceHash'|'revision'>):{metadata:GraphSnapshotMetadata;chunks:GraphChunk[]} {
  if(model.tasks.length>L.sourceNodes)throw Error('unsupported');
  const counts=new Map<string,number>();let declarations=0;
  for(const t of model.tasks){if(t.phaseProjectionOmissions||!bounded(t.id,L.idCharacters)||t.title!==null&&(!bounded(t.title,L.titleCharacters))||t.status!==null&&!bounded(t.status,L.statusCharacters)||!Array.isArray(t.dependencies))throw Error('unsupported');
    declarations+=t.dependencies.length;if(declarations>L.sourceEdges)throw Error('unsupported');counts.set(t.id,(counts.get(t.id)??0)+1);}
  const duplicateIds=[...counts].filter(([,n])=>n>1).map(([id])=>id).sort();
  const nodes:GraphSourceNode[]=model.tasks.filter(t=>counts.get(t.id)===1).map(t=>({id:t.id,title:t.title,declaredStatus:t.status,phase:t.phase??null}));
  const edgeMap=new Map<string,GraphSourceEdge>();
  const endpoint=(id:string):GraphSourceEdge['from']=>counts.get(id)===1?{kind:'node',id}:{kind:'unresolved',id,reason:counts.has(id)?'duplicate':'missing'};
  for(const t of model.tasks)for(const d of t.dependencies){if(!bounded(d.id,L.idCharacters)||!['internal','external'].includes(d.scope))throw Error('unsupported');const id=graphEdgeId(d.id,t.id,d.scope),old=edgeMap.get(id);if(old){old.declarations++;continue;}
    edgeMap.set(id,{id,from:d.scope==='external'?{kind:'unresolved',id:d.id,reason:'external'}:endpoint(d.id),to:endpoint(t.id),scope:d.scope,declarations:1});}
  const edges=[...edgeMap.values()], identity={...base,sourceHash:model.sourceHash,revision:createHash('sha256').update(JSON.stringify([TASK_GRAPH_CONTRACT_VERSION,model.sourceHash,nodes,edges])).digest('hex')};
  const chunks:GraphChunk[]=[];let chunk:GraphChunk={contractVersion:1,identity,index:0,nodes:[],edges:[],byteLength:0};
  // Reserve decimal widths of index/byteLength. Count every record once, avoiding
  // quadratic repeated stringify of a growing high-degree chunk.
  const baseBytes=graphEncodedBytes(chunk)+32;let estimated=baseBytes;
  const flush=()=>{if(!chunk.nodes.length&&!chunk.edges.length)return;let n=graphEncodedBytes(chunk);while(n!==chunk.byteLength){chunk.byteLength=n;n=graphEncodedBytes(chunk);}if(n>L.chunkBytes)throw Error('unsupported');chunks.push(chunk);chunk={contractVersion:1,identity,index:chunks.length,nodes:[],edges:[],byteLength:0};estimated=baseBytes;};
  for(const n of nodes){const bytes=graphEncodedBytes(n)+1;if(chunk.nodes.length>=L.chunkNodes||estimated+bytes>L.chunkBytes)flush();if(estimated+bytes>L.chunkBytes)throw Error('unsupported');(chunk.nodes as GraphSourceNode[]).push(n);estimated+=bytes;}
  for(const e of edges){const bytes=graphEncodedBytes(e)+1;if(chunk.edges.length>=L.chunkEdges||estimated+bytes>L.chunkBytes)flush();if(estimated+bytes>L.chunkBytes)throw Error('unsupported');(chunk.edges as GraphSourceEdge[]).push(e);estimated+=bytes;}
  flush();const graphCounts={sourceTaskRows:model.tasks.length,uniqueNodes:nodes.length,uniqueEdges:edges.length,unresolvedEdges:edges.filter(e=>e.from.kind!=='node'||e.to.kind!=='node').length};
  const metadata:GraphSnapshotMetadata={contractVersion:1,identity,observedAt:model.observedAt,coverage:duplicateIds.length?{state:'partial',counts:graphCounts,reasons:['duplicate-id']}:{state:'complete',counts:graphCounts,reasons:[]},diagnostics:{duplicateIds,cycles:cycles(nodes,edges),repeatedDeclarations:declarations-edges.length},chunkCount:chunks.length,byteLength:chunks.reduce((s,c)=>s+c.byteLength,0)};
  if(chunks.length>L.chunkCount||metadata.byteLength>L.snapshotBytes||graphEncodedBytes(metadata)>L.chunkBytes)throw Error('unsupported');
  assembleGraphSnapshot(metadata,chunks);return {metadata,chunks};
}
export interface GraphAuthority {projectId:string;dagId:string;sessionKey:string}
/** At most four physical operations/snapshots, including abandoned work. Ten-second leases. */
export function createTaskGraphService(options:{current:(projectId:string)=>GraphAuthority|null;read:(authority:GraphAuthority,signal:AbortSignal)=>Promise<DagReadModel>;now?:()=>number;timeoutMs?:number}) {
  const now=options.now??Date.now,timeout=options.timeoutMs??L.timeoutMs;
  type Entry={authority:GraphAuthority;controller:AbortController;expires:number;timer:ReturnType<typeof setTimeout>;snapshot?:ReturnType<typeof produceTaskGraph>;busy:boolean};
  const entries=new Map<string,Entry>();let physical=0;
  const unavailable=(requestId:string,reason:GraphReadError)=>({state:'unavailable' as const,requestId,reason});
  function release(id:string,expected?:Entry){const e=entries.get(id);if(e&&(!expected||e===expected)){clearTimeout(e.timer);e.controller.abort();entries.delete(id);}}
  const valid=(a:GraphAuthority)=>JSON.stringify(options.current(a.projectId))===JSON.stringify(a);
  async function boundedRead(e:Entry){if(e.busy||physical>=4)throw Error('unsupported');e.busy=true;physical++;
    const work=Promise.resolve().then(()=>{if(e.controller.signal.aborted)throw Error('cancelled');return options.read(e.authority,e.controller.signal);}).finally(()=>{physical--;e.busy=false;});
    let abort:()=>void=()=>{};const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(Error(now()>=e.expires?'timeout':'cancelled'));e.controller.signal.addEventListener('abort',abort,{once:true});if(e.controller.signal.aborted)abort();});
    try{const model=await Promise.race([work,cancelled]);if(e.controller.signal.aborted)throw Error('cancelled');if(!valid(e.authority))throw Error('stale-session');return model;}finally{e.controller.signal.removeEventListener('abort',abort);}}
  const reason=(error:unknown):GraphReadError=>error instanceof Error&&['timeout','cancelled','stale-session','source-changed','unsupported'].includes(error.message)?error.message as GraphReadError:'source-unavailable';
  return {
    async read(raw:unknown):Promise<GraphReadResult>{let request;try{request=parseGraphReadRequest(raw);}catch{return unavailable('', 'invalid-request');}
      const {requestId}=request,authority=options.current(request.projectId);if(!authority)return unavailable(requestId,'unauthorized');if(authority.dagId!==request.dagId||authority.sessionKey!==request.sessionKey)return unavailable(requestId,'stale-session');
      if(entries.has(requestId)||entries.size>=4||physical>=4)return unavailable(requestId,'unsupported');
      const e:Entry={authority,controller:new AbortController(),expires:now()+timeout,timer:setTimeout(()=>release(requestId,e),timeout),busy:false};e.timer.unref?.();entries.set(requestId,e);
      try{const model=await boundedRead(e);if(model.dagId!==authority.dagId)throw Error('source-changed');const snapshot=produceTaskGraph(model,authority);if(now()>=e.expires)throw Error('timeout');if(request.expectedRevision!==null&&request.expectedRevision!==snapshot.metadata.identity.revision)throw Error('source-changed');e.snapshot=snapshot;return {state:'snapshot',metadata:structuredClone(snapshot.metadata)};}catch(error){release(requestId,e);return unavailable(requestId,reason(error));}},
    async chunk(raw:unknown):Promise<GraphChunkResult>{let r;try{r=parseGraphChunkRequest(raw);}catch{return unavailable('','invalid-request');}const e=entries.get(r.requestId);
      if(!e?.snapshot)return unavailable(r.requestId,'cancelled');if(!valid(e.authority)){release(r.requestId);return unavailable(r.requestId,'stale-session');}if(!sameGraphIdentity(e.snapshot.metadata.identity,r.identity)||r.index>=e.snapshot.chunks.length)return unavailable(r.requestId,'invalid-request');
      try{const model=await boundedRead(e);if(model.sourceHash!==r.identity.sourceHash||model.dagId!==r.identity.dagId)throw Error('source-changed');if(now()>=e.expires)throw Error('timeout');return {state:'chunk',requestId:r.requestId,chunk:structuredClone(e.snapshot.chunks[r.index])};}catch(error){release(r.requestId,e);return unavailable(r.requestId,reason(error));}},
    async detail(raw:unknown):Promise<GraphDetailResult>{
      let request;try{request=parseGraphDetailRequest(raw);}catch{return unavailable('','invalid-request');}
      const {requestId,identity,taskId}=request,authority=options.current(identity.projectId);
      if(!authority)return unavailable(requestId,'unauthorized');
      if(authority.dagId!==identity.dagId||authority.sessionKey!==identity.sessionKey)return unavailable(requestId,'stale-session');
      if(entries.has(requestId)||entries.size>=4||physical>=4)return unavailable(requestId,'unsupported');
      const e:Entry={authority,controller:new AbortController(),expires:now()+timeout,timer:setTimeout(()=>release(requestId,e),timeout),busy:false};
      e.timer.unref?.();entries.set(requestId,e);
      try{
        // The same registered source read revalidates mapping, read grant and source before/after I/O.
        const model=await boundedRead(e);
        if(model.dagId!==identity.dagId||model.sourceHash!==identity.sourceHash)throw Error('source-changed');
        const snapshot=produceTaskGraph(model,authority);
        if(!sameGraphIdentity(snapshot.metadata.identity,identity))throw Error('source-changed');
        const matches=model.tasks.filter(task=>task.id===taskId);
        if(matches.length!==1)throw Error('unsupported');
        const task=matches[0];
        const result:GraphDetailSnapshot={state:'detail',requestId,identity:snapshot.metadata.identity,observedAt:model.observedAt,
          task:{...(task.harness?{harness:task.harness}:{}),id:task.id,title:task.title,status:task.status,rawType:task.rawType??null,rawFeature:task.rawFeature??null,phase:task.phase??null,
            details:task.details??{description:null,acceptanceCriteria:[],targetFiles:[],discussion:[],design:[],omissions:0},
            dependencies:task.dependencies,e2e:task.e2e,commitReferences:task.commitReferences,
            commitReferencesUnsupported:task.commitReferencesUnsupported??0,commitVerification:task.commitVerification,
            displayOmissions:{dependencies:0,commitReferences:0,e2eReferences:0}},policies:model.policies??[]};
        // Fail closed, never trim lists or mistake projection omissions for absent declarations.
        let decoded:GraphDetailResult;try{decoded=parseGraphDetailResult(result);}catch{throw Error('unsupported');}
        if(now()>=e.expires)throw Error('timeout');
        if(e.controller.signal.aborted)throw Error('cancelled');
        if(!valid(authority))throw Error('stale-session');
        return decoded;
      }catch(error){return unavailable(requestId,reason(error));}
      finally{release(requestId,e);}
    },
    cancel(raw:unknown){const id=parseGraphCancelRequest(raw);release(id);},
    invalidate(){for(const id of entries.keys())release(id);},
  };
}
