import type {ProjectDraft} from '../shared/project-draft';
import type {ProjectWorkspaceOption,ProjectWorkspaceOptions} from '../shared/project-workspaces';
/** Select one current observation only; draft fields never authorize filesystem access. */
export function matchProjectCreationWorkspace(draft:ProjectDraft,view:ProjectWorkspaceOptions):ProjectWorkspaceOption|null{
 if(view.state!=='ready'||draft.input.repositories.length!==1)return null;
 const repository=draft.input.repositories[0];if(repository.workspace.mode!=='existing')return null;
 const candidates=view.options.filter(option=>option.worktreeId===repository.workspace.worktreeId&&option.path===repository.workspace.path&&(option.branch??'')===repository.workspace.branch);
 return candidates.length===1?candidates[0]:null;
}
