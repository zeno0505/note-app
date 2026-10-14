import {it,expect,vi} from 'vitest';
import {createJoinedRead} from '../../src/main/joined-read';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
it('shares only current identical owner/key flights and clones results per consumer',async()=>{
 const reads=createJoinedRead<{rows:number[]}>(),owner={},gate=deferred<{rows:number[]}>(),run=vi.fn(()=>gate.promise),a=new AbortController(),b=new AbortController();
 const x=reads.read(owner,'project/mapping/revision',a.signal,run),y=reads.read(owner,'project/mapping/revision',b.signal,run);await Promise.resolve();expect(run).toHaveBeenCalledTimes(1);gate.resolve({rows:[1]});const [r,s]=await Promise.all([x,y]);r.rows.push(2);expect(s.rows).toEqual([1]);await reads.read(owner,'project/mapping/revision',a.signal,run);expect(run).toHaveBeenCalledTimes(2);
});
it('cancels one consumer without aborting the shared physical read or other consumer',async()=>{
 const reads=createJoinedRead<number>(),owner={},gate=deferred<number>(),a=new AbortController(),b=new AbortController();let physical!:AbortSignal;
 const run=vi.fn((signal:AbortSignal)=>{physical=signal;return gate.promise;});const x=reads.read(owner,'key',a.signal,run),y=reads.read(owner,'key',b.signal,run);const rejected=expect(x).rejects.toMatchObject({code:'request_cancelled'});await Promise.resolve();a.abort();await rejected;expect(physical.aborted).toBe(false);gate.resolve(7);expect(await y).toBe(7);
});
it('retains an abandoned reservation until physical settlement; no replacement or unhandled rejection',async()=>{
 const reads=createJoinedRead<number>(),owner={},gate=deferred<number>(),a=new AbortController();let physical!:AbortSignal;const run=vi.fn((signal:AbortSignal)=>{physical=signal;return gate.promise;});const x=reads.read(owner,'key',a.signal,run);const rejected=expect(x).rejects.toMatchObject({code:'request_cancelled'});await Promise.resolve();a.abort();await rejected;expect(physical.aborted).toBe(true);await expect(reads.read(owner,'key',new AbortController().signal,run)).rejects.toMatchObject({code:'request_busy'});expect(run).toHaveBeenCalledTimes(1);gate.resolve(0);await new Promise<void>(resolve=>setImmediate(resolve));await reads.read(owner,'key',new AbortController().signal,run);expect(run).toHaveBeenCalledTimes(2);
});
it('does not join different readers, mappings or revisions and bounds outstanding reservations',async()=>{
 const reads=createJoinedRead<number>(3),owner={},gate=deferred<number>(),signal=new AbortController().signal,run=vi.fn(()=>gate.promise);const flights=[reads.read(owner,'mapping/revision1',signal,run),reads.read(owner,'changed-mapping/revision1',signal,run),reads.read({},'mapping/revision1',signal,run)];await Promise.resolve();expect(run).toHaveBeenCalledTimes(2);await expect(reads.read(owner,'mapping/revision2',signal,run)).rejects.toMatchObject({code:'request_busy'});gate.resolve(1);await Promise.all(flights);expect(run).toHaveBeenCalledTimes(3);expect(await reads.read(owner,'mapping/revision2',signal,run)).toBe(1);
});
it('never starts a read for an already canceled consumer and aborts outstanding reads on disconnect',async()=>{
 const reads=createJoinedRead<number>(),owner={},gate=deferred<number>(),a=new AbortController();a.abort();const run=vi.fn(()=>gate.promise);await expect(reads.read(owner,'key',a.signal,run)).rejects.toMatchObject({code:'request_cancelled'});expect(run).not.toHaveBeenCalled();let physical!:AbortSignal;const pending=reads.read(owner,'key',new AbortController().signal,signal=>{physical=signal;return gate.promise;});await Promise.resolve();reads.abortAll();expect(physical.aborted).toBe(true);const rejected=expect(pending).rejects.toMatchObject({code:'request_cancelled'});gate.resolve(1);await rejected;
});

it('bounds consumers as well as physical flights without canceling existing consumers',async()=>{
 const reads=createJoinedRead<number>(1,2),owner={},gate=deferred<number>(),signal=new AbortController().signal,run=vi.fn(()=>gate.promise);const a=reads.read(owner,'key',signal,run),b=reads.read(owner,'key',signal,run);await expect(reads.read(owner,'key',signal,run)).rejects.toMatchObject({code:'request_busy'});expect(run).toHaveBeenCalledTimes(1);gate.resolve(1);expect(await Promise.all([a,b])).toEqual([1,1]);
});

 it('serializes distinct revisions while preserving fresh work and separate owner progress',async()=>{
  const reads=createJoinedRead<number>(),owner={},a=gateNumber(),signals=new AbortController(),calls:string[]=[];const first=reads.read(owner,'old',signals.signal,async()=>{calls.push('old');return a.promise;}),next=reads.read(owner,'new',signals.signal,async()=>{calls.push('new');return 2;});await Promise.resolve();expect(calls).toEqual(['old']);expect(await reads.read({},'independent',signals.signal,async()=>3)).toBe(3);a.resolve(1);expect(await first).toBe(1);expect(await next).toBe(2);expect(calls).toEqual(['old','new']);
 });
 it('cancels a queued read before starting IO without canceling the current read or future reads',async()=>{
  const reads=createJoinedRead<number>(),owner={},a=gateNumber(),queued=new AbortController(),signal=new AbortController().signal,run=vi.fn(async()=>2);const first=reads.read(owner,'old',signal,()=>a.promise),second=reads.read(owner,'queued',queued.signal,run),cancelled=expect(second).rejects.toMatchObject({code:'request_cancelled'});queued.abort();await cancelled;expect(run).not.toHaveBeenCalled();const third=reads.read(owner,'new',signal,async()=>3);a.resolve(1);expect(await first).toBe(1);expect(await third).toBe(3);expect(run).not.toHaveBeenCalled();
 });
 function gateNumber(){return deferred<number>();}
