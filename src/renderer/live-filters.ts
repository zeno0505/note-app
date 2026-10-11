import type {LiveWorkstreamView} from '../shared/live';

export type LiveScope='activity'|'observed'|'retained';
export const repositoryKey=(w:LiveWorkstreamView)=>w.repository?.key??'unknown';
export function inLiveScope(w:LiveWorkstreamView,scope:LiveScope):boolean {
  if(scope==='retained')return !!w.project;
  if(w.archived===true||w.observation?.worktree!=='observed')return false;
  if(scope==='observed')return true;
  // Sidebar activity includes terminals, browsers and agents; selection alone is not activity.
  return w.observation.sidebarActivity===true;
}
export function filterLiveWorkstreams(rows:LiveWorkstreamView[],options:{scope:LiveScope;repository:string;project:'active'|'completed'|'all';search:string}) {
  const search=options.search.trim().toLocaleLowerCase();
  return rows.filter(w=>inLiveScope(w,options.scope)
    &&(options.repository==='all'||repositoryKey(w)===options.repository)
    &&(!w.project||options.project==='all'||w.project.status===options.project)
    &&`${w.title} ${w.projectName??''} ${w.branch??''} ${w.repository?.label??''}`.toLocaleLowerCase().includes(search));
}
