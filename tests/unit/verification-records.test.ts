import {afterEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEvidenceReader} from '../../src/phase2/evidence';
import {createTaskVerificationReader,parseVerificationMarkdown,type VerificationEvidenceBridge} from '../../src/phase2/verification-records';
import type {EvidenceList,EvidenceReadView} from '../../src/shared/evidence';

const selection={workstreamId:'synthetic',taskId:'T-042',sourceHash:'dag-source'};
const relationship={kind:'task-record' as const,label:'contract',taskId:'T-042',observedAt:'now',verification:'not-assessed' as const};
function item(relativePath:string,id=relativePath,anchor:string|null=null):EvidenceList['items'][number]{return {evidenceId:id,registrationId:id,label:'source',anchor,origin:'synthetic',relativePath,relationships:[relationship]};}
function view(text:string,id='source'):EvidenceReadView{return {result:{ok:true,scopeId:'synthetic',evidenceId:id,label:'source',anchor:null,origin:'synthetic',sourceHash:'sha256:'+'a'.repeat(64),observedAt:'2026-10-10T00:00:00Z',byteLength:text.length,content:{kind:'text',mime:'text/markdown',text,rendering:'plain-text',imageReferences:{targets:[],unsupportedCount:0}},verification:'not-assessed',omissions:[]}};}
function fixture(items:EvidenceList['items'],bodies:Record<string,string>={}){
  let serial=0;
  const bridge={prepareTaskEvidence:vi.fn(async()=>({sessionId:'session-'+ ++serial,items,unsupportedCount:0})),readTaskEvidence:vi.fn(async({evidenceId}:{evidenceId:string})=>view(bodies[evidenceId]??'# Document\nNo verification declaration.',evidenceId)),releaseTaskEvidence:vi.fn(async()=>{})};
  return {bridge,reader:createTaskVerificationReader(bridge)};
}
describe('Markdown verification source parser',()=>{
  it('preserves source claims without interpreting PASS, done, reviewer or SHA',()=>{
    const text='PASS · done · bot approved\nReviewer: independent\nSHA: deadbeef';
    expect(parseVerificationMarkdown('# T-042 Task\n## Verification\n'+text+'\n## Next\nOther','T-042',true,false)).toEqual({verification:text,review:null,issues:[]});
  });
  it('does not mistake fenced, indented, quoted or list headings for declarations',()=>{
    expect(parseVerificationMarkdown('```md\n## Verification\nPASS\n```\n    ## Verification\n> ## Verification\n- ## Verification','T-042',true,false)).toEqual({verification:null,review:null,issues:[]});
  });
  it.each(['## Verification\nPASS\n## Verification\nFAIL','## Verification\n','## Verification: PASS\ntext','## 검증: PASS\ntext','## 검증 기록: PASS\ntext','```\n## Verification\nPASS'])('keeps malformed/repeated declarations unknown: %s',text=>{
    expect(parseVerificationMarkdown(text,'T-042',true,false).issues.length).toBeGreaterThan(0);
  });
  it('limits common linked prose to the exact task heading subtree',()=>{
    const parsed=parseVerificationMarkdown('# Project\n## T-042 Work\n### Verification\nclaimed check\n## T-043 Other\n### Verification\nother task PASS','T-042',false,false);
    expect(parsed).toEqual({verification:'claimed check',review:null,issues:[]});
  });
  it('rejects a different task nested beneath the current task heading',()=>{
    expect(parseVerificationMarkdown('# T-042 Current\n## T-043 Other\n### Verification\nother claim','T-042',false,false)).toEqual({verification:null,review:null,issues:['conflicting-task-heading']});
  });
  it.each(['# T-0420 Other\n## Verification\nPASS','# T-043 Other\n## Verification\nPASS','# Project\n[T-042](inbox/T-042/review-1.md)','# Review\nTask mentioned: T-042'])('does not treat a mention, common link or another heading as ownership',text=>{
    expect(parseVerificationMarkdown(text,'T-042',false,false).issues).toContain('task-association-unconfirmed');
  });
  it('rejects repeated exact task headings and conflicting contract headings',()=>{
    expect(parseVerificationMarkdown('# T-042 One\n# T-042 Two','T-042',false,false).issues).toContain('repeated-task-declaration');
    expect(parseVerificationMarkdown('# T-043 Other\n## Verification\nPASS','T-042',true,true).issues).toContain('conflicting-task-heading');
  });
  it('recognizes formatted headings and rejects missing heading separators',()=>{
    expect(parseVerificationMarkdown('## **Verification**\nclaimed test','T-042',true,false).verification).toBe('claimed test');
    expect(parseVerificationMarkdown('##Verification\nclaimed test','T-042',true,false).issues).toContain('malformed-verification-declaration');
  });
  it('marks bounded parse failures unknown rather than absent',()=>{
    expect(parseVerificationMarkdown('x'.repeat(8*1024*1024+1),'T-042',true,false).issues).toContain('malformed-or-limited-markdown');
  });
});
describe('opaque capability verification read model',()=>{
  it('counts one review per file across multiple anchors and preserves provenance',async()=>{
    const file='inbox/T-042/review-1.md',f=fixture([item(file,'a','first'),item(file,'b','second')],{a:'# Review\nbot says PASS'});
    const result=await f.reader.load(selection);expect(result.state).toBe('present');expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({kind:'review',text:'# Review\nbot says PASS',anchors:['first','second'],assessment:'not-assessed',reviewerIdentity:'unconfirmed',targetSha:'unconfirmed',independence:'unconfirmed',sourceHash:'sha256:'+'a'.repeat(64)});
    expect(f.bridge.readTaskEvidence).toHaveBeenCalledExactlyOnceWith({sessionId:'session-1',evidenceId:'a',expectedSourceHash:null});
  });
  it('returns none only after complete discovery and successful absence parsing',async()=>{
    const f=fixture([item('inbox/T-042/assignment.md')]);expect(await f.reader.load(selection)).toMatchObject({state:'none',records:[],issues:[]});
    expect(f.bridge.prepareTaskEvidence).toHaveBeenCalledWith({...selection,discoverTaskRecords:true});
  });
  it('does not read project-common links or infer reviews from done status',async()=>{
    const common=item('context.md');common.relationships=[{kind:'project-link',label:'common',observedAt:'now',verification:'not-assessed'}];
    const f=fixture([common],{'context.md':'[Review](inbox/T-042/review-1.md)\ndone PASS'});
    expect(await f.reader.load(selection)).toMatchObject({state:'none',records:[]});expect(f.bridge.readTaskEvidence).not.toHaveBeenCalled();
  });
  it('refuses another exact task contract even if misleadingly labeled current',async()=>{
    const f=fixture([item('inbox/T-043/review-1.md')]);expect(await f.reader.load(selection)).toMatchObject({state:'unknown',records:[],issues:['other-task-contract']});expect(f.bridge.readTaskEvidence).not.toHaveBeenCalled();
  });
  it('refuses mixed task relationships for one file',async()=>{
    const a=item('docs/review.md','a'),b=item('docs/review.md','b');b.relationships=[{...relationship,taskId:'T-043'}];const f=fixture([a,b]);expect((await f.reader.load(selection)).issues).toContain('conflicting-task-relationship');expect(f.bridge.readTaskEvidence).not.toHaveBeenCalled();
  });
  it('requires an exact task heading for a declared noncontract document',async()=>{
    const f=fixture([item('docs/review.md')]);expect(await f.reader.load(selection)).toMatchObject({state:'unknown',issues:['task-association-unconfirmed']});
  });
  it('keeps discovery limitations unknown while retaining observed claims',async()=>{
    const file='inbox/T-042/review-1.md',f=fixture([item(file)],{[file]:'claim'});f.bridge.prepareTaskEvidence.mockResolvedValueOnce({sessionId:'partial',items:[item(file)],unsupportedCount:1});
    const result=await f.reader.load(selection);expect(result.state).toBe('unknown');expect(result.records).toHaveLength(1);expect(result.issues).toContain('discovery-incomplete');
  });
  it.each(['permission-denied','stale-source','source-changed','retired'] as const)('preserves read failure %s as unknown',async code=>{
    const f=fixture([item('inbox/T-042/assignment.md')]);f.bridge.readTaskEvidence.mockResolvedValueOnce({result:{ok:false,code,omitted:true}});
    expect(await f.reader.load(selection)).toMatchObject({state:'unknown',issues:['read-'+code],records:[]});
  });
  it('distinguishes unavailable discovery and thrown revocation from absence',async()=>{
    const f=fixture([]);f.bridge.prepareTaskEvidence.mockRejectedValueOnce(Error('revoked'));expect((await f.reader.load(selection)).issues).toEqual(['discovery-unavailable']);
    const g=fixture([item('inbox/T-042/assignment.md')]);g.bridge.readTaskEvidence.mockRejectedValueOnce(Error('revoked'));expect((await g.reader.load(selection)).issues).toEqual(['read-unavailable']);
  });
  it('withdraws earlier claims when a later capability read reports revocation',async()=>{
    const f=fixture([item('inbox/T-042/review-1.md','first'),item('inbox/T-042/review-2.md','second')],{first:'first claim'});
    f.bridge.readTaskEvidence.mockResolvedValueOnce(view('first claim','first')).mockResolvedValueOnce({result:{ok:false,code:'permission-denied',omitted:true}});
    expect(await f.reader.load(selection)).toMatchObject({state:'unknown',records:[],issues:['read-permission-denied']});
  });
  it('refreshes retired capabilities and reads changed source on every reload',async()=>{
    const file='inbox/T-042/implementation.md',f=fixture([item(file)],{[file]:'## Verification\nfirst claim'});
    expect((await f.reader.load(selection)).records[0].text).toBe('first claim');f.bridge.readTaskEvidence.mockResolvedValueOnce(view('## Verification\nchanged claim'));
    expect((await f.reader.load(selection)).records[0].text).toBe('changed claim');expect(f.bridge.releaseTaskEvidence).toHaveBeenCalledWith({sessionId:'session-1'});expect(f.bridge.readTaskEvidence.mock.calls[1][0]).toMatchObject({sessionId:'session-2'});
  });
  it('discards late reads after fast task switching',async()=>{
    const f=fixture([item('inbox/T-042/review-1.md')]);let complete!:(view:EvidenceReadView)=>void;
    f.bridge.readTaskEvidence.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const first=f.reader.load(selection);await vi.waitFor(()=>expect(complete).toBeDefined());
    f.bridge.prepareTaskEvidence.mockResolvedValueOnce({sessionId:'second',items:[],unsupportedCount:0});expect((await f.reader.load({...selection,taskId:'T-043'})).state).toBe('none');
    complete(view('old claim'));expect(await first).toMatchObject({state:'unknown',records:[],issues:['superseded']});expect(f.bridge.releaseTaskEvidence).toHaveBeenCalledWith({sessionId:'session-1'});
  });
  it('releases late prepared sessions after disposal',async()=>{
    const f=fixture([]);let complete!:(list:EvidenceList)=>void;f.bridge.prepareTaskEvidence.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const pending=f.reader.load(selection);await f.reader.dispose();complete({sessionId:'late',items:[],unsupportedCount:0});expect((await pending).issues).toEqual(['superseded']);expect(f.bridge.releaseTaskEvidence).toHaveBeenCalledWith({sessionId:'late'});
  });
  it('does not follow derived links and releases unused child capabilities',async()=>{
    const f=fixture([item('inbox/T-042/assignment.md')]);f.bridge.readTaskEvidence.mockResolvedValueOnce({...view('## Verification\n[Claim](review.md)'),references:{session:{sessionId:'child',items:[],unsupportedCount:0},targets:[]}});
    expect((await f.reader.load(selection)).state).toBe('present');expect(f.bridge.readTaskEvidence).toHaveBeenCalledTimes(1);expect(f.bridge.releaseTaskEvidence).toHaveBeenCalledWith({sessionId:'child'});
  });
});

describe('existing evidence reader integration with synthetic local Markdown',()=>{
  const roots:string[]=[],readers:ReturnType<typeof createTaskVerificationReader>[]=[];
  afterEach(async()=>{for(const reader of readers.splice(0))await reader.dispose();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
  async function localFixture(){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'verification-sources-')));roots.push(root);
    const relativePath='inbox/T-042/review-1.md';await fs.mkdir(path.join(root,'inbox/T-042'),{recursive:true});const filename=path.join(root,relativePath);
    await fs.writeFile(filename,'# T-042 Review\n## Verification\nSource claims PASS');
    let allowed=true,serial=0;const sessions=new Map<string,Awaited<ReturnType<typeof createEvidenceReader>>>();
    const bridge:VerificationEvidenceBridge={
      async prepareTaskEvidence(){const reader=await createEvidenceReader({scopeId:'synthetic-only',canonicalRootPath:root,registrations:[{id:'a',relativePath,anchor:'one'},{id:'b',relativePath,anchor:'two'}],authorize:()=>allowed});const sessionId='local-'+ ++serial;sessions.set(sessionId,reader);return {sessionId,items:reader.list().map(item=>({...item,relativePath,relationships:[relationship]})),unsupportedCount:0};},
      async readTaskEvidence({sessionId,evidenceId,expectedSourceHash}){const reader=sessions.get(sessionId);if(!reader)throw Error('retired');return {result:await reader.read({evidenceId,expectedSourceHash})};},
      async releaseTaskEvidence({sessionId}){sessions.get(sessionId)?.retire();sessions.delete(sessionId);}
    };
    const reader=createTaskVerificationReader(bridge);readers.push(reader);return {reader,bridge,filename,root,sessions,revoke(){allowed=false;}};
  }
  it('binds source claims to actual byte hashes and updates them on fresh capability reload',async()=>{
    const f=await localFixture(),first=await f.reader.load(selection);expect(first.state).toBe('present');expect(first.records.filter(r=>r.kind==='review')).toHaveLength(1);
    await fs.writeFile(f.filename,'# T-042 Review\n## Verification\nChanged source claim');const second=await f.reader.load(selection);
    expect(second.records.find(r=>r.kind==='verification')?.text).toBe('Changed source claim');expect(second.records[0].sourceHash).not.toBe(first.records[0].sourceHash);expect(f.sessions.size).toBe(1);
  });
  it('returns unknown after actual permission revocation and retires the active session',async()=>{
    const f=await localFixture();expect((await f.reader.load(selection)).state).toBe('present');f.revoke();expect(await f.reader.load(selection)).toMatchObject({state:'unknown',records:[],issues:['discovery-unavailable']});expect(f.sessions.size).toBe(0);
  });
  it('rejects symlink replacement through the existing reader without reading outside the scope',async()=>{
    const f=await localFixture(),outside=path.join(f.root,'outside.md');await fs.writeFile(outside,'outside source claim');const prepare=f.bridge.prepareTaskEvidence;
    f.bridge.prepareTaskEvidence=async request=>{const list=await prepare(request);await fs.unlink(f.filename);await fs.symlink(outside,f.filename);return list;};
    expect(await f.reader.load(selection)).toMatchObject({state:'unknown',records:[],issues:['read-unsafe-source']});
  });
});
