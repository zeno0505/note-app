import {parsePullObservation, type PullObservationAdapter, type PullObservation, type PullObservationResult} from './pulls';

export const PUBLIC_REPOSITORY = 'zeno0505/note-app';
const API = `https://api.github.com/repos/${PUBLIC_REPOSITORY}`;
export interface PublicGitHubRegistration {dagId: string; branch: string}
export interface PublicGitHubOptions {
  registrations: readonly PublicGitHubRegistration[];
  /** Test-only HTTP seam; never renderer configuration or a credential resolver. */
  fetch?: typeof fetch;
  now?: () => number;
  deadlineMs?: number;
  /** Test-only clock interval controls; production always uses 5m / manual 15s. */
  refreshIntervalMs?: number;
  manualIntervalMs?: number;
}
class ObservationFailure extends Error {constructor(readonly kind: string) {super(`Public GitHub observation unavailable (${kind}).`);}}
function obj(value: unknown): Record<string, any> {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new ObservationFailure('schema');
  return value as Record<string,any>;
}
function list(value: unknown, limit: number): any[] {
  if(!Array.isArray(value)||value.length>limit)throw new ObservationFailure('schema');return value;
}
function sha(value: unknown): string {
  if(typeof value!=='string'||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value))throw new ObservationFailure('sha');return value;
}
function integer(value: unknown): number {
  if(!Number.isSafeInteger(value)||(value as number)<1)throw new ObservationFailure('schema');return value as number;
}
function state(status: unknown, conclusion: unknown): 'success'|'failure'|'pending'|'unknown' {
  if(status==='queued'||status==='in_progress'||status==='waiting'||status==='pending'||status==='requested')return 'pending';
  if(status!=='completed')return 'unknown';
  if(conclusion==='success')return 'success';
  if(['failure','timed_out','cancelled','action_required','startup_failure'].includes(conclusion as string))return 'failure';
  return 'unknown';
}
function nextPage(response: Response): boolean {return /rel="next"/.test(response.headers.get('link')??'');}

/** Public fixed-host GET only. No token, gh, connector auth, cookies, redirects,
 * repository discovery, comments, model calls or persistent permission changes.
 */
export function createPublicGitHubObserver(options: PublicGitHubOptions): PullObservationAdapter {
  const registrations=new Map<string,string>();
  for(const entry of options.registrations) {
    if(!entry.dagId || entry.dagId.length>1024 || registrations.has(entry.dagId)
      || typeof entry.branch!=='string'||entry.branch.length>128||!entry.branch.trim()||/[\u0000-\u0020\u007f?#]/u.test(entry.branch))throw new Error('Invalid public GitHub registration');
    registrations.set(entry.dagId,entry.branch);
  }
  if(registrations.size<1||registrations.size>8)throw new Error('Invalid public GitHub registration count');
  const get=options.fetch??fetch, now=options.now??Date.now, deadline=options.deadlineMs??4500;
  const interval=options.refreshIntervalMs??300_000,manualInterval=options.manualIntervalMs??15_000;
  if(!Number.isSafeInteger(deadline)||deadline<1||deadline>4500)throw new Error('Invalid public GitHub deadline');
  if(!Number.isSafeInteger(interval)||interval<0||interval>300_000||!Number.isSafeInteger(manualInterval)||manualInterval<0||manualInterval>15_000)throw new Error('Invalid public GitHub interval');
  let cooldownUntil=0;
  let retired=false;
  let flight:{key:string;promise:Promise<unknown>}|null=null;
  const lastCI=new Map<string,{ci:NonNullable<PullObservationResult['branch']>['ci'];observedAt:string}>();
  let snapshot:{dagId:string;branch:string;value:PullObservationResult;at:number}|null=null;
  return {
    read(selection,signal,intent='scheduled') {
      const branch=registrations.get(selection.dagId);
      if(!branch||typeof selection.workstreamId!=='string'||!selection.workstreamId||selection.workstreamId.length>1024)return Promise.reject(new ObservationFailure('scope'));
      if(signal.aborted)return Promise.reject(new ObservationFailure('cancelled'));
      if(retired)return Promise.reject(new ObservationFailure('retired'));
      if(now()<cooldownUntil)return Promise.reject(new ObservationFailure('rate-limit'));
      if(snapshot?.dagId===selection.dagId&&snapshot.branch===branch&&now()-snapshot.at<(intent==='manual'?manualInterval:interval))return Promise.resolve({...structuredClone(snapshot.value),...selection});
      const key=JSON.stringify([selection.workstreamId,selection.dagId,branch]);
      if(flight)return flight.key===key?flight.promise:Promise.reject(new ObservationFailure('busy'));
      const owned=new AbortController();const abort=()=>owned.abort();signal.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(()=>{retired=true;owned.abort();},deadline);
      const operation=(async()=>{
        let requests=0,totalBytes=0;
        const issues=new Set<string>();
        const active=()=>{if(owned.signal.aborted||signal.aborted)throw new ObservationFailure('cancelled');};
        async function request(suffix: string,finalCheck=false): Promise<{data:unknown;partial:boolean}> {
          active();if(now()<cooldownUntil)throw new ObservationFailure('rate-limit');
          if(requests>=(finalCheck?12:11))throw new ObservationFailure('request-limit');requests++;
          // suffix is constructed only in this closure from validated branch/SHA/number.
          const response=await get(API+suffix,{method:'GET',headers:{Accept:'application/vnd.github+json','User-Agent':'note-app-public-observer','X-GitHub-Api-Version':'2022-11-28'},redirect:'error',credentials:'omit',signal:owned.signal});
          if(owned.signal.aborted||signal.aborted){await response.body?.cancel().catch(()=>{});active();}
          if(response.status===429||response.status===403) {
            const retry=Number(response.headers.get('retry-after'));
            const reset=Number(response.headers.get('x-ratelimit-reset'))*1000;
            cooldownUntil=now()+Math.min(3_600_000,Math.max(60_000,Number.isFinite(retry)&&retry>0?retry*1000:Number.isFinite(reset)&&reset>now()?reset-now():900_000));
            await response.body?.cancel();throw new ObservationFailure('rate-limit');
          }
          if(!response.ok){await response.body?.cancel();throw new ObservationFailure(`http-${response.status}`);}
          const length=Number(response.headers.get('content-length'));
          if(Number.isFinite(length)&&length>262_144){await response.body?.cancel();throw new ObservationFailure('response-limit');}
          if(!response.body)throw new ObservationFailure('empty-body');
          const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
          try {
            while(true) {
              const item=await reader.read();active();if(item.done)break;
              bytes+=item.value.byteLength;totalBytes+=item.value.byteLength;
              if(bytes>262_144||totalBytes>1_048_576)throw new ObservationFailure('response-limit');chunks.push(item.value);
            }
          } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
          active();const body=Buffer.concat(chunks);
          let data:unknown;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{throw new ObservationFailure('json');}
          return {data,partial:nextPage(response)};
        }
        async function workflows(head: string): Promise<{ci:NonNullable<PullObservationResult['branch']>['ci'];partial:boolean}> {
          const r=await request(`/actions/runs?head_sha=${sha(head)}&per_page=16`),root=obj(r.data),runs=list(root.workflow_runs,16);
          if(!Number.isSafeInteger(root.total_count)||root.total_count<runs.length)throw new ObservationFailure('schema');
          const latest=new Map<number,any>();
          for(const run of runs){obj(run);if(sha(run.head_sha)!==head)throw new ObservationFailure('foreign-ci');const workflow=integer(run.workflow_id),id=integer(run.id);if(!latest.has(workflow)||latest.get(workflow).id<id)latest.set(workflow,run);}
          const ci=[...latest.values()].map(run=>({id:integer(run.id),sha:head,state:state(run.status,run.conclusion),event:run.event==='push'?'push' as const:run.event==='pull_request'?'pull_request' as const:'other' as const}));
          return {ci,partial:r.partial||root.total_count>runs.length};
        }
        const ref=obj((await request(`/git/ref/heads/${encodeURIComponent(branch)}`)).data);
        if(ref.ref!==`refs/heads/${branch}`||obj(ref.object).type!=='commit')throw new ObservationFailure('foreign-ref');
        const head=sha(ref.object.sha);
        const listed=await request('/pulls?state=all&per_page=4'),pullsList=list(listed.data,4);
        if(listed.partial)issues.add('pr-list-partial');
        let ci:NonNullable<PullObservationResult['branch']>['ci']=[],ciFreshness:'current'|'historical'|'unknown'='unknown',ciObservedAt:string|null=null;
        try {
          const result=await workflows(head);ci=result.ci;ciFreshness='current';ciObservedAt=new Date(now()).toISOString();
          if(result.partial)issues.add('branch-ci-partial');else {lastCI.clear();lastCI.set(head,{ci:structuredClone(ci),observedAt:ciObservedAt});}
        } catch(error) {active();issues.add('branch-ci-unavailable');if(error instanceof ObservationFailure&&error.kind==='rate-limit')issues.add('rate-limit');const prior=lastCI.get(head);if(prior){ci=structuredClone(prior.ci);ciFreshness='historical';ciObservedAt=prior.observedAt;}}
        const pulls:PullObservation[]=[];
        for(const candidate of pullsList) {
          active();
          if(requests>=11){issues.add('pr-request-limit');break;}
          let p:Record<string,any>;
          try {
            const number=integer(obj(candidate).number);p=obj((await request(`/pulls/${number}`)).data);
            if(p.number!==number||obj(obj(p.base).repo).full_name!==PUBLIC_REPOSITORY)throw new ObservationFailure('foreign-pr');
            if(typeof p.merged!=='boolean'||!['open','closed'].includes(p.state))throw new ObservationFailure('schema');
            const pullHead=sha(obj(p.head).sha),isMerged=p.merged===true;
            const record:PullObservation={number,state:isMerged?'merged':p.state,headSha:pullHead,
              mergeSha:isMerged&&p.merge_commit_sha!==null?sha(p.merge_commit_sha):null,
              taskIds:[],mapping:isMerged?'squash-unverified':'unresolved',ci:[],reviews:[]};
            // DAG/task correlation has no declared authority in this adapter. Even a
            // merged PR cannot verify squash/original commit correspondence here.
            try {const result=pullHead===head?{ci:ciFreshness==='current'?ci:[],partial:ciFreshness!=='current'}:await workflows(pullHead);
              record.ci=result.ci.map(c=>({sha:c.sha,state:c.state}));if(result.partial)issues.add('pr-ci-partial');
            } catch(error) {active();issues.add('pr-ci-unavailable');if(error instanceof ObservationFailure&&error.kind==='rate-limit')issues.add('rate-limit');}
            try {
              const result=await request(`/pulls/${number}/reviews?per_page=32`),reviews=list(result.data,32);
              if(result.partial){issues.add('reviews-partial');} // Don't choose "latest" from a truncated history.
              else {
                const latest=new Map<string,any>();
                for(const review of reviews){obj(review);const login=obj(review.user).login;if(typeof login!=='string'||login.length>128)throw new ObservationFailure('schema');const id=integer(review.id);if(!latest.has(login)||latest.get(login).id<id)latest.set(login,review);}
                record.reviews=[...latest].slice(0,32).map(([login,r])=>({sha:sha(r.commit_id),reviewer:login==='coderabbitai[bot]'?'coderabbit':'human',
                  state:r.state==='APPROVED'?'approved':r.state==='CHANGES_REQUESTED'?'changes-requested':r.state==='COMMENTED'?'commented':'unknown'}));
              }
            } catch(error) {active();issues.add('reviews-unavailable');if(error instanceof ObservationFailure&&error.kind==='rate-limit')issues.add('rate-limit');}
            pulls.push(record);
          } catch(error) {active();issues.add('pr-detail-unavailable');if(error instanceof ObservationFailure&&error.kind==='rate-limit')issues.add('rate-limit');}
        }
        const finalRef=obj((await request(`/git/ref/heads/${encodeURIComponent(branch)}`,true)).data);
        if(finalRef.ref!==ref.ref||obj(finalRef.object).type!=='commit'||sha(finalRef.object.sha)!==head)throw new ObservationFailure('head-changed');
        active();const result=parsePullObservation({...selection,repository:PUBLIC_REPOSITORY,observedAt:new Date(now()).toISOString(),
          coverage:issues.size?'partial':'complete',pulls,branch:{name:branch,headSha:head,ci,ciFreshness,ciObservedAt},issues:[...issues]},selection);
        snapshot={dagId:selection.dagId,branch,value:structuredClone(result),at:now()};return result;
      })();
      let abortResponse:(()=>void)|undefined;
      const cancelled=new Promise<never>((_,reject)=>{
        abortResponse=()=>{retired=true;reject(new ObservationFailure('cancelled'));};
        owned.signal.addEventListener('abort',abortResponse,{once:true});if(owned.signal.aborted)abortResponse();
      });
      const promise=Promise.race([operation,cancelled]).finally(()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);if(abortResponse)owned.signal.removeEventListener('abort',abortResponse);if(flight?.promise===promise)flight=null;});
      flight={key,promise};return promise;
    },
  };
}
