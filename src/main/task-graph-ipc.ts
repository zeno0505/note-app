import type {TaskGraphBridge} from '../shared/task-graph-contract';
/** Single production registration point. Tests use the same handlers with a synthetic IPC bus. */
export function registerTaskGraphIpc<Event>(ipc:{handle:(channel:string,handler:(event:Event,...args:unknown[])=>unknown)=>unknown},runtime:TaskGraphBridge,check:(event:Event)=>void,available:()=>boolean,track:<T>(promise:Promise<T>)=>Promise<T>) {
  for(const [channel,operation] of [['session','getTaskGraphSession'],['read','readTaskGraph'],['chunk','readTaskGraphChunk'],['detail','readTaskGraphDetail'],['cancel','cancelTaskGraph']] as const) {
    ipc.handle('note-app:graph-'+channel,(event,...args)=>{
      check(event);if(args.length!==1||!available())throw Error('Graph unavailable');
      // Input validation belongs to the runtime at this boundary, never to TS or renderer trust.
      return track(Promise.resolve((runtime[operation] as (request:unknown)=>unknown)(args[0])));
    });
  }
}
