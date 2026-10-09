/** Bound the response of one main-owned startup read. This is not kernel IO
 * cancellation: the original operation keeps ownership of its eventual cleanup.
 * Late values/rejections are observed and discarded; no retry is started here. */
export function boundedStartup<T>(operation: Promise<T>, fallback: T): Promise<T> {
  return new Promise(resolve=>{
    let settled=false;
    const finish=(value:T)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>finish(fallback),5000);
    void operation.then(value=>finish(value),()=>finish(fallback));
  });
}
