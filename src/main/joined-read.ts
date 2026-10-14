import {ModelDiagnosticError} from './model-diagnostics';

/** Shares an equivalent in-flight read and serializes distinct reads of the same owner.
 * Authority and result publication stay with each caller. */
export function createJoinedRead<T>(maximum=32,maximumConsumers=64){
 type Flight={controller:AbortController;promise:Promise<T>;consumers:Set<symbol>;settled:boolean};
 const owners=new WeakMap<object,number>(),tails=new WeakMap<object,Promise<void>>(),flights=new Map<string,Flight>();let nextOwner=0;
 function read(owner:object,key:string,signal:AbortSignal,operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(signal.aborted)return Promise.reject(new ModelDiagnosticError('request_cancelled'));
  let ownerId=owners.get(owner);if(ownerId===undefined){ownerId=++nextOwner;owners.set(owner,ownerId);}
  const id=JSON.stringify([ownerId,key]);let flight=flights.get(id);
  if(flight?.controller.signal.aborted)return Promise.reject(new ModelDiagnosticError('request_busy'));
  if(!flight){
   if(flights.size>=maximum)return Promise.reject(new ModelDiagnosticError('request_busy'));
   const controller=new AbortController(),previous=tails.get(owner)??Promise.resolve();
   flight={controller,consumers:new Set(),settled:false,promise:previous.then(()=>{if(controller.signal.aborted)throw new ModelDiagnosticError('request_cancelled');return operation(controller.signal);})};flights.set(id,flight);
   // The tail follows physical response settlement, not an individual consumer's cancellation.
   // A retired DAG reader still owns its kernel cleanup and rejects subsequent reads itself.
   tails.set(owner,flight.promise.then(()=>{},()=>{}));
   const current=flight,finish=()=>{current.settled=true;if(flights.get(id)===current)flights.delete(id);};current.promise.then(finish,finish);
  }
  if(flight.consumers.size>=maximumConsumers)return Promise.reject(new ModelDiagnosticError('request_busy'));
  const current=flight,consumer=Symbol();current.consumers.add(consumer);
  return new Promise<T>((resolve,reject)=>{
   let done=false;
   const finish=()=>{done=true;signal.removeEventListener('abort',cancel);current.consumers.delete(consumer);};
   const cancel=()=>{if(done)return;finish();if(!current.settled&&!current.consumers.size)current.controller.abort();reject(new ModelDiagnosticError('request_cancelled'));};
   signal.addEventListener('abort',cancel,{once:true});if(signal.aborted){cancel();return;}
   current.promise.then(value=>{if(done)return;finish();if(current.controller.signal.aborted){reject(new ModelDiagnosticError('request_cancelled'));return;}try{resolve(structuredClone(value));}catch(error){reject(error);}},error=>{if(done)return;finish();reject(error);});
  });
 }
 return {read,abortAll(){for(const flight of flights.values())flight.controller.abort();}};
}
