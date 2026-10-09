import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createPublicGitHubObserver,PUBLIC_REPOSITORY} from '../../src/summary/reading/github';
import {parsePullObservation,type PullObservationResult} from '../../src/summary/reading/pulls';
const HEAD='a'.repeat(40),MERGE='b'.repeat(40),OLD='c'.repeat(40),at='2026-10-06T00:00:00.000Z';
const selection={workstreamId:'worktree',dagId:'dag'},registration={dagId:'dag',branch:'feat/phase1-foundation'};
const response=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers});
const run=(id=1,conclusion='success',head=HEAD)=>({id,workflow_id:4,head_sha:head,status:'completed',conclusion,event:'push'});
function setup(options:{pulls?:number[];route?:(path:string)=>Response|Promise<Response>}={}) {
 const requests:string[]=[],fetcher=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=String(input),path=url.split(`https://api.github.com/repos/${PUBLIC_REPOSITORY}`)[1];requests.push(path);
  expect(url.startsWith(`https://api.github.com/repos/${PUBLIC_REPOSITORY}/`)).toBe(true);expect(init?.method).toBe('GET');expect(init?.redirect).toBe('error');expect(init?.credentials).toBe('omit');
  expect(Object.keys(init?.headers??{}).some(k=>/authorization|cookie/i.test(k))).toBe(false);
  const override=options.route?.(path);if(override)return override;
  if(path.startsWith('/git/ref/heads/'))return response({ref:`refs/heads/${registration.branch}`,object:{type:'commit',sha:HEAD}});
  if(path.startsWith('/pulls?'))return response((options.pulls??[]).map(number=>({number})));
  if(path.startsWith('/actions/runs?'))return response({total_count:1,workflow_runs:[run()]});
  if(/^\/pulls\/\d+$/.test(path))return response({number:Number(path.split('/')[2]),state:'closed',merged:true,merge_commit_sha:MERGE,head:{sha:HEAD},base:{repo:{full_name:PUBLIC_REPOSITORY}}});
  if(path.endsWith('/reviews?per_page=32'))return response([{id:1,state:'APPROVED',commit_id:OLD,user:{login:'coderabbitai[bot]'}}]);
  throw new Error('Unexpected route');
 });
 const adapter=createPublicGitHubObserver({registrations:[registration],fetch:fetcher as typeof fetch,refreshIntervalMs:0,manualIntervalMs:0});
 return {adapter,fetcher,requests};
}
const signal=()=>new AbortController().signal;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(at);});afterEach(()=>vi.useRealTimers());
describe('fixed public note-app GitHub observer',()=>{
 it('uses a five-minute scheduled cache and a bounded manual bypass without repeating burst requests',async()=>{
  const f=setup(),adapter=createPublicGitHubObserver({registrations:[registration],fetch:f.fetcher as typeof fetch});
  const first=await adapter.read(selection,signal());await vi.advanceTimersByTimeAsync(20_000);
  expect(await adapter.read(selection,signal())).toEqual(first);expect(f.fetcher).toHaveBeenCalledTimes(4);
  await adapter.read(selection,signal(),'manual');expect(f.fetcher).toHaveBeenCalledTimes(8);await adapter.read(selection,signal(),'manual');expect(f.fetcher).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(300_000);await adapter.read(selection,signal());expect(f.fetcher).toHaveBeenCalledTimes(12);
 });
 it('observes direct push CI and no PRs without inventing review or task bindings',async()=>{
  const f=setup(),value=parsePullObservation(await f.adapter.read(selection,signal()),selection);
  expect(value).toMatchObject({repository:PUBLIC_REPOSITORY,pulls:[],coverage:'complete',branch:{headSha:HEAD,ciFreshness:'current',ci:[{id:1,sha:HEAD,state:'success',event:'push'}]}});
  expect(f.fetcher).toHaveBeenCalledTimes(4);expect(value.issues).toEqual([]);
 });
 it('rejects mixed observation if branch head changes during API collection',async()=>{
  let refs=0;const f=setup({route:path=>path.startsWith('/git/ref')?response({ref:`refs/heads/${registration.branch}`,object:{type:'commit',sha:++refs===1?HEAD:OLD}}):undefined as any});
  await expect(f.adapter.read(selection,signal())).rejects.toThrow('head-changed');expect(f.fetcher).toHaveBeenCalledTimes(4);
 });
 it('bounds multi-PR fanout while preserving a partial result and final head validation',async()=>{
  const f=setup({pulls:[1,2,3,4],route:path=>/^\/pulls\/\d+$/.test(path)?response({number:Number(path.split('/')[2]),state:'closed',merged:true,merge_commit_sha:MERGE,head:{sha:OLD},base:{repo:{full_name:PUBLIC_REPOSITORY}}}):path.startsWith('/actions')&&path.includes(OLD)?response({total_count:1,workflow_runs:[run(2,'success',OLD)]}):undefined as any});
  const result=await f.adapter.read(selection,signal()) as PullObservationResult;expect(f.fetcher.mock.calls.length).toBeLessThanOrEqual(12);expect(result.coverage).toBe('partial');expect(result.issues).toContain('pr-request-limit');
  expect(f.requests.at(-1)).toContain('/git/ref/heads/');
 });
 it('uses actual merged state, leaves squash correlation unknown and keeps older review SHA',async()=>{
  const f=setup({pulls:[7]}),value=parsePullObservation(await f.adapter.read(selection,signal()),selection);
  expect(value.pulls[0]).toMatchObject({number:7,state:'merged',mergeSha:MERGE,mapping:'squash-unverified',taskIds:[],reviews:[{sha:OLD,state:'approved',reviewer:'coderabbit'}]});
  expect(f.fetcher).toHaveBeenCalledTimes(6); // Reuses branch/head CI in this observation.
 });
 it('ignores comments and removes approval after a later dismissed formal review',async()=>{
  const f=setup({pulls:[7],route:path=>path.includes('/reviews?')?response([
   {id:1,state:'APPROVED',commit_id:HEAD,user:{login:'coderabbitai[bot]'}},
   {id:2,state:'DISMISSED',commit_id:HEAD,user:{login:'coderabbitai[bot]'}},
   {id:3,state:'COMMENTED',commit_id:HEAD,user:{login:'other-bot'}},
  ]):undefined as any});
  const value=await f.adapter.read(selection,signal()) as PullObservationResult;
  expect(value.pulls[0].reviews.map(r=>r.state)).toEqual(['unknown','commented']);expect(f.requests.some(p=>p.includes('comments'))).toBe(false);
 });
 it('does not describe an unmerged preview SHA as merged',async()=>{
  const f=setup({pulls:[7],route:path=>path==='/pulls/7'?response({number:7,state:'open',merged:false,merge_commit_sha:MERGE,head:{sha:HEAD},base:{repo:{full_name:PUBLIC_REPOSITORY}}}):undefined as any});
  expect((await f.adapter.read(selection,signal()) as PullObservationResult).pulls[0]).toMatchObject({state:'open',mergeSha:null,mapping:'unresolved'});
 });
 it('uses latest attempt per workflow, never another head SHA',async()=>{
  const f=setup({route:path=>path.startsWith('/actions')?response({total_count:2,workflow_runs:[run(2,'failure'),run(1)]}):undefined as any});
  expect((await f.adapter.read(selection,signal()) as PullObservationResult).branch?.ci).toMatchObject([{id:2,state:'failure'}]);
  const other=setup({route:path=>path.startsWith('/actions')?response({total_count:1,workflow_runs:[run(1,'success',OLD)]}):undefined as any});
  expect((await other.adapter.read(selection,signal()) as PullObservationResult)).toMatchObject({coverage:'partial',branch:{ci:[],ciFreshness:'unknown'},issues:['branch-ci-unavailable']});
 });
 it('shows pagination as partial and never picks latest reviews from truncated history',async()=>{
  const f=setup({pulls:[7],route:path=>path.includes('/reviews?')?response([{id:1,state:'APPROVED',commit_id:HEAD,user:{login:'coderabbitai[bot]'}}],200,{link:'<https://api.github.com/repos/zeno0505/note-app/pulls/7/reviews?page=2>; rel="next"'}):undefined as any});
  const value=await f.adapter.read(selection,signal()) as PullObservationResult;expect(value.coverage).toBe('partial');expect(value.pulls[0].reviews).toEqual([]);
 });
 it('keeps same-SHA CI explicitly historical on a partial error and never transfers it to a new head',async()=>{
  let failed=false,newHead=false;
  const f=setup({route:path=>path.startsWith('/actions')&&failed?response({message:'private raw error'},503):path.startsWith('/git/ref')&&newHead?response({ref:`refs/heads/${registration.branch}`,object:{type:'commit',sha:OLD}}):undefined as any});
  await f.adapter.read(selection,signal());failed=true;const value=await f.adapter.read(selection,signal()) as PullObservationResult;
  expect(value).toMatchObject({coverage:'partial',branch:{headSha:HEAD,ciFreshness:'historical',ci:[{sha:HEAD,state:'success'}]}});expect(JSON.stringify(value)).not.toContain('private raw error');
  newHead=true;expect((await f.adapter.read(selection,signal()) as PullObservationResult).branch).toMatchObject({headSha:OLD,ciFreshness:'unknown',ci:[]});
 });
 it('does not copy historical branch CI into a fresh PR success claim',async()=>{
  let failed=false;const f=setup({pulls:[7],route:path=>failed&&path.startsWith('/actions')?response({},503):undefined as any});
  await f.adapter.read(selection,signal());failed=true;const value=await f.adapter.read(selection,signal()) as PullObservationResult;
  expect(value.branch?.ciFreshness).toBe('historical');expect(value.pulls[0].ci).toEqual([]);expect(value.coverage).toBe('partial');
 });
 it.each([429,403])('honors %s rate-limit cooldown with no automatic retry',async status=>{
  const f=setup({route:()=>response({},status,{'x-ratelimit-remaining':'0','retry-after':'300'})});
  await expect(f.adapter.read(selection,signal())).rejects.toThrow('rate-limit');await expect(f.adapter.read(selection,signal())).rejects.toThrow('rate-limit');expect(f.fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300_001);await expect(f.adapter.read(selection,signal())).rejects.toThrow('rate-limit');expect(f.fetcher).toHaveBeenCalledTimes(2);
 });
 it('joins duplicate requests, rejects foreign registration and bounds deadline despite ignored cancellation',async()=>{
  let finish!:(r:Response)=>void;
  const fetcher=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;}));
  const adapter=createPublicGitHubObserver({registrations:[registration],fetch:fetcher as typeof fetch,deadlineMs:20});
  const work=adapter.read(selection,signal());expect(adapter.read(selection,signal())).toBe(work);
  const rejected=expect(work).rejects.toThrow('cancelled');await vi.advanceTimersByTimeAsync(21);await rejected;
  finish(response({ref:`refs/heads/${registration.branch}`,object:{type:'commit',sha:HEAD}}));await Promise.resolve();
  await expect(adapter.read(selection,signal())).rejects.toThrow('retired');await expect(adapter.read({...selection,dagId:'foreign'},signal())).rejects.toThrow('scope');expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('bounds streamed/content-length response bytes and prevents redirect/auth inheritance',async()=>{
  for(const large of [response('x'.repeat(262_145)),response({},200,{'content-length':'262145'})]) {
   const f=setup({route:()=>large});await expect(f.adapter.read(selection,signal())).rejects.toThrow('response-limit');
  }
  const f=setup({route:()=>new Response('',{status:302,headers:{location:'https://other.invalid/'}})});await expect(f.adapter.read(selection,signal())).rejects.toThrow('http-302');expect(f.fetcher).toHaveBeenCalledTimes(1);
 });
 it('cancels pending requests and publishes no late observation',async()=>{
  let finish!:(r:Response)=>void;const f=setup({route:()=>new Promise(resolve=>{finish=resolve;})});const abort=new AbortController();
  const work=f.adapter.read(selection,abort.signal);const rejected=expect(work).rejects.toThrow('cancelled');abort.abort();await rejected;finish(response({}));await Promise.resolve();
  expect(f.fetcher).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
});
