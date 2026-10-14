import {PROJECT_DAG_LIMITS} from '../shared/project-dag';
import type {ProjectWorkspaceOptions} from '../shared/project-workspaces';

class ProjectCreationObservationError extends Error {
 constructor(readonly reason:'cancelled'|'timeout'|'source_changed'){super(reason);}
}
/** Refresh the authorized read-only observation after a human-owned native picker.
 * Picker time is unbounded; this is only a bounded UI response wait, not a
 * claim that the full collector can always finish within five seconds. A timeout or
 * abort does not pretend to cancel the live runtime's owned/coalesced read; its
 * eventual settlement stays observed, and normal runtime cleanup still owns it.
 * This grants no source authority: the existing fresh-source comparison runs next.
 */
export function refreshAfterProjectPicker(observation:Pick<ProjectWorkspaceOptions,'state'|'reason'>,refresh:()=>Promise<unknown>,signal:AbortSignal):Promise<void> {
 if(signal.aborted)return Promise.reject(new ProjectCreationObservationError('cancelled'));
 // Fresh observations retain the existing validation path without triggering the
 // entire collector. Disconnection/other failures also remain fail-closed there.
 if(observation.state!=='unavailable'||!['stale','refreshing'].includes(observation.reason??''))return Promise.resolve();
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(error?:ProjectCreationObservationError)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(error)reject(error);else resolve();};
  const abort=()=>finish(new ProjectCreationObservationError('cancelled'));
  const timer=setTimeout(()=>finish(new ProjectCreationObservationError('timeout')),PROJECT_DAG_LIMITS.timeoutMs);
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted){abort();return;}
  void Promise.resolve().then(()=>{if(signal.aborted)throw new ProjectCreationObservationError('cancelled');return refresh();}).then(()=>finish(),()=>finish(new ProjectCreationObservationError(signal.aborted?'cancelled':'source_changed')));
 });
}
