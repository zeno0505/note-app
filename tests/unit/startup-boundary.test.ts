import {afterEach,describe,expect,it,vi} from 'vitest';
import {boundedStartup} from '../../src/main/startup-boundary';
afterEach(()=>vi.useRealTimers());
describe('one-shot startup IO response boundary',()=>{
  it('returns timely observations and clears its deadline',async()=>{
    vi.useFakeTimers();expect(await boundedStartup(Promise.resolve('ready'),'unavailable')).toBe('ready');expect(vi.getTimerCount()).toBe(0);
  });
  it('returns unavailable after five seconds without retrying or accepting a late result',async()=>{
    vi.useFakeTimers();let complete!:(value:string)=>void;
    const source=new Promise<string>(resolve=>{complete=resolve;}),pending=boundedStartup(source,'unavailable');
    await vi.advanceTimersByTimeAsync(5000);expect(await pending).toBe('unavailable');complete('late ready');await Promise.resolve();expect(await pending).toBe('unavailable');expect(vi.getTimerCount()).toBe(0);
  });
  it('observes late rejection and does not replace the fallback',async()=>{
    vi.useFakeTimers();let reject!:(error:Error)=>void;
    const pending=boundedStartup(new Promise<string>((_,fail)=>{reject=fail;}),'unavailable');
    await vi.advanceTimersByTimeAsync(5000);expect(await pending).toBe('unavailable');reject(new Error('late IO failure'));await Promise.resolve();expect(await pending).toBe('unavailable');
  });
  it('returns unavailable for an immediate IO failure',async()=>{
    expect(await boundedStartup(Promise.reject(new Error('denied')),'unavailable')).toBe('unavailable');
  });
});
