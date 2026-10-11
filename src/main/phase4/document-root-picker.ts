import {refreshAfterProjectPicker} from '../project-creation-refresh';
import type {ProjectWorkspaceOptions} from '../../shared/project-workspaces';
import type {ProjectDocumentRootProposal} from '../../shared/project-document-roots';

/** A human can leave the native picker open beyond collector freshness. Refresh
 * only the observation, then compare the exact project identity captured before
 * the picker. Refreshing never authorizes rebinding the chosen folder to a new
 * mapping. A proposal that crosses a late window/mapping change is cancelled. */
export async function prepareDocumentRootAfterPicker(options:{
  expectedProjectIdentity:string;
  observation:Pick<ProjectWorkspaceOptions,'state'|'reason'>;
  currentProjectIdentity:()=>string|null;
  refresh:()=>Promise<unknown>;
  isActive:()=>boolean;
  signal:AbortSignal;
  prepare:()=>Promise<ProjectDocumentRootProposal>;
  cancel:(proposal:ProjectDocumentRootProposal)=>void;
}):Promise<ProjectDocumentRootProposal>{
  const active=()=>!options.signal.aborted&&options.isActive();
  if(!active())throw Error('문서 폴더 선택이 취소되었습니다.');
  await refreshAfterProjectPicker(options.observation,options.refresh,options.signal);
  if(!active())throw Error('문서 폴더 선택이 취소되었습니다.');
  if(!options.expectedProjectIdentity||options.currentProjectIdentity()!==options.expectedProjectIdentity)throw Error('폴더를 선택하는 동안 프로젝트 연결이 변경되었습니다. 다시 선택해 주세요.');
  const proposal=await options.prepare();
  if(!active()||options.currentProjectIdentity()!==options.expectedProjectIdentity){options.cancel(proposal);throw Error('폴더를 선택하는 동안 프로젝트 연결이 변경되거나 선택이 취소되었습니다.');}
  return proposal;
}
