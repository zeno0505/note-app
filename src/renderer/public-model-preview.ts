import type {LiveWorkstreamView} from '../shared/live';
/** Main derives repository projectId from its verified Orca repo/project join. */
export function isApprovedPublicPreview(workstream:LiveWorkstreamView){
  return workstream.repository?.projectId==='github:zeno0505/note-app'&&workstream.repository.label==='zeno0505/note-app';
}
