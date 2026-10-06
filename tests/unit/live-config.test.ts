import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,writeFile,rm,symlink,mkdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadLiveConfiguration,parseLiveConfiguration} from '../../src/main/live-config';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const minimal={schemaVersion:1,orcaExecutablePath:'/usr/local/bin/orca'};
const scoped={...minimal,localHostId:'host',noteScopes:[{scopeId:'project',hostId:'host',vaultRootPath:'/notes',scopePath:'/notes/project',dagRelativePaths:['dag.yaml']}],dagQuery:{pythonPath:'/usr/bin/python3',queryScriptPath:'/trusted/query.py'},summarySelections:[{scopeId:'project',dagRelativePath:'dag.yaml',taskIds:['T-1']}]};
describe('explicit startup configuration',()=>{
  it('permits only exact public note-app startup registration, with no token/repository/URL route',()=>{
    const entry={scopeId:'project',dagRelativePath:'dag.yaml',worktreePath:'/work/note-app',branch:'feat/phase1-foundation'};
    expect(parseLiveConfiguration({...scoped,publicGitHub:[entry]}).publicGitHub).toEqual([entry]);
    for(const value of [{...entry,repository:'example/other'},{...entry,token:'secret'},
      {...entry,scopeId:'foreign'},{...entry,dagRelativePath:'../dag.yaml'},{...entry,branch:'main?other=x'},
      {...entry,worktreePath:'relative'}])expect(()=>parseLiveConfiguration({...scoped,publicGitHub:[value]})).toThrow();
    expect(()=>parseLiveConfiguration({...minimal,publicGitHub:[entry]})).toThrow();
    expect(()=>parseLiveConfiguration({...scoped,publicGitHub:[entry,entry]})).toThrow();
  });
  it('allows note-link capability only with explicit local scoped and Git authority configuration',()=>{
    const noteLink={gitExecutablePath:'/usr/bin/git',allowedCommonGitDirs:['/work/repository/.git']};
    expect(parseLiveConfiguration({...scoped,noteLink}).noteLink).toEqual(noteLink);
    for(const value of [{...minimal,noteLink},{...scoped,noteLink:{...noteLink,gitExecutablePath:'git'}},
      {...scoped,noteLink:{...noteLink,allowedCommonGitDirs:['/work/.git','/work/.git']}},
      {...scoped,noteLink:{...noteLink,allowedCommonGitDirs:Array.from({length:9},(_,i)=>`/work/${i}/.git`)}},
      {...scoped,noteLink:{...noteLink,command:'shell'}}])expect(()=>parseLiveConfiguration(value)).toThrow();
  });
  it('defaults to disconnected configuration and blocked summary transport',async()=>{
    expect(await loadLiveConfiguration(undefined)).toMatchObject({configuration:null,view:{state:'unconfigured',summaryTransport:'blocked'}});
    expect(parseLiveConfiguration(minimal)).toEqual({...minimal,noteScopes:[],summarySelections:[]});
    expect(parseLiveConfiguration(scoped)).toEqual(scoped);
  });
  it.each([null,{}, {...minimal,command:'status'}, {...minimal,orcaExecutablePath:'orca'}, {...minimal,orcaExecutablePath:'/bin/../bin/orca'},
    {...scoped,localHostId:'other'}, {...scoped,localHostId:undefined}, {...scoped,dagQuery:undefined},
    {...scoped,summarySelections:[{scopeId:'other',dagRelativePath:'dag.yaml',taskIds:['T-1']}]},
    {...scoped,summarySelections:[{scopeId:'project',dagRelativePath:'../dag.yaml',taskIds:['T-1']}]},
    {...scoped,summarySelections:[{scopeId:'project',dagRelativePath:'dag.yaml',taskIds:['T-1','T-1']}]},
    {...scoped,summarySelections:[{scopeId:'project',dagRelativePath:'dag.yaml',taskIds:Array.from({length:33},(_,i)=>`T-${i}`)}]},
    {...scoped,noteScopes:[{...scoped.noteScopes[0],scopePath:'/notes'}]},
    {...scoped,noteScopes:[{...scoped.noteScopes[0],scopePath:'/notes-other/project'}]},
    {...scoped,noteScopes:[{...scoped.noteScopes[0],dagRelativePaths:['a','b','c','d','e','f','g','h','i']}]},
  ])('rejects unexpected, broad or unregistered configuration %#',value=>expect(()=>parseLiveConfiguration(value)).toThrow());
  it('loads only bounded regular JSON files and safely reports failure without raw paths',async()=>{
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'note-config-')));roots.push(root);
    const filename=path.join(root,'config.json');
    await writeFile(filename,JSON.stringify(scoped));
    expect(await loadLiveConfiguration(filename)).toMatchObject({configuration:scoped,view:{state:'ready',noteScopeCount:1,dagQueryConfigured:true}});
    await symlink(filename,path.join(root,'alias.json'));
    await mkdir(path.join(root,'directory'));
    for(const file of [path.join(root,'alias.json'),path.join(root,'missing'),path.join(root,'directory')]){
      const result=await loadLiveConfiguration(file);expect(result.view.state).toBe('invalid');expect(JSON.stringify(result)).not.toContain(root);
    }
    await writeFile(filename,' '.repeat(65537));expect((await loadLiveConfiguration(filename)).view.state).toBe('invalid');
    await writeFile(filename,'not json');expect((await loadLiveConfiguration(filename)).view.state).toBe('invalid');
  });
});

it('accepts exact bounded excerpt registrations only within a registered summary DAG selection',()=>{
  const excerpt={id:'goal',kind:'goal-document',relativePath:'goal.md',startLine:1,endLine:3};
  const configured={...scoped,summarySelections:[{...scoped.summarySelections[0],excerpts:[excerpt]}]};
  expect(parseLiveConfiguration(configured).summarySelections[0].excerpts).toEqual([excerpt]);
  for(const invalid of [{...excerpt,relativePath:'../vault.md'},{...excerpt,endLine:0},{...excerpt,command:'cat'},{...excerpt,kind:'source-code'}])
    expect(()=>parseLiveConfiguration({...scoped,summarySelections:[{...scoped.summarySelections[0],excerpts:[invalid]}]})).toThrow();
});
