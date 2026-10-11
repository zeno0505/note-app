import {mkdir,writeFile,readFile,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {createPhase1Fixture} from '../phase1-fixture/setup.mjs';

/** Representative dimensions only: every body and filename here is invented. */
export async function createPhase4Fixture(){
 const base=await createPhase1Fixture();
 const directories=['design','inbox/T-042','reviews','assets','duplicate'];
 for(const directory of directories)await mkdir(path.join(base.scope,directory),{recursive:true});
 const docs={
  'context.md':'# Fictional Atlas requirements\n\n## Requirements\nThe developer must distinguish declarations from observed verification.\n\n[Document viewer design](design/viewer.md)\n[[e2e-checklist|Review checklist]]\n',
  'e2e-checklist.md':'# Fictional review checklist\n\n- [ ] Check requirements\n- [ ] Review implementation\n- [ ] Record remaining uncertainty\n',
  'design/viewer.md':'# Document viewer design\n\n## Acceptance\nKeep task context while reading related documents.\n\n| Source | Relationship |\n| --- | --- |\n| [[context\\|Requirements]] | Project common |\n\n[Requirements](../context.md#requirements)\n[Review record](../inbox/T-042/review-1.md)\n[Missing document](missing.md)\n[[review|Ambiguous review]]\n[Missing heading](#does-not-exist)\n[[context#^block-id|Unsupported block]]\n[Outside scope](../../private.md)\n![Synthetic UI](../assets/viewer.png)\n![Remote blocked](https://example.invalid/do-not-request.png)\n\n```mermaid\nflowchart LR\n  A[Requirements] --> B[Implementation]\n  B --> C[Review]\n```\n\n<script>globalThis.__phase4Executed=true</script>\n[Executable blocked](javascript:alert(1))\n',
  'design/review.md':'# Local review candidate\nThis is the source-document-relative candidate.\n',
  'review.md':'# Project review candidate\nThis is the note-root-relative candidate.\n',
  'inbox/T-042/assignment.md':'# Viewer task assignment\nRead the design and review without opening an external editor.\n',
  'inbox/T-042/implementation.md':'# Viewer implementation declaration\nImplementation is declared. This text does not establish a test pass.\n',
  'inbox/T-042/review-1.md':'# Viewer review\n\n## Unverified\nNative platform behavior has not been assessed by this document.\n\n[Back to design](../../design/viewer.md#acceptance)\n',
  'reviews/state.json':JSON.stringify({fixture:true,status:'not-assessed',items:Array.from({length:16},(_,i)=>({id:i,declared:true}))},null,2),
 };
 const complexNodes=Array.from({length:19},(_,i)=>`N${i+1}["Synthetic task ${i+1}<br/>Unverified"]`);
 docs['diagram-complex.md']='# Synthetic review diagram\n\n```mermaid\nflowchart TD\n'+['subgraph plan[Requirements]',...complexNodes.slice(0,6),'end','subgraph build[Implementation]',...complexNodes.slice(6,12),'end','subgraph review[Review]',...complexNodes.slice(12),'end',...Array.from({length:19},(_,i)=>`N${i+1} --> N${i===18?1:i+2}`),'classDef declared fill:#eef,color:#112233','class N10,N19 declared'].join('\n')+'\n```\n';
 docs['diagram-unsupported.md']='# Unsupported diagram source\n\n```mermaid\nerDiagram\n  PERSON ||--o{ ITEM : reads\n```\n';
 docs['reviews/lexical.json']='{"id":9007199254740993,"state":1,"state":2,"text":"İ test 한글"}';
 for(const [name,body]of Object.entries(docs))await writeFile(path.join(base.scope,name),body);
 const largeMarkdown='# Large synthetic review\n\n'+Array.from({length:5300},(_,i)=>`Review observation ${i}: this fictional line is a declaration, with no implied test success or approval.\n`).join('')+'\n## Final marker\nPHASE4_FULL_MARKDOWN_END\n';
 await writeFile(path.join(base.scope,'dag.md'),largeMarkdown);
 const tasks=Array.from({length:54},(_,i)=>({id:`T-${String(i+1).padStart(3,'0')}`,title:i===41?'Read related documents':'Fictional document task '+(i+1),status:i<29?'in_review':i<52?'pending':'done',description:i===41?'Inspect requirements, design and review evidence while keeping task context.':'Fictional task declaration',acceptance_criteria:['Preserve source meaning','Never infer verification from file existence'],design:i===41?['[[design/viewer|Viewer design]]']:[],discussion:i===41?['[[inbox/T-042/review-1|Viewer review]]']:[],depends_on:i?[`T-${String(i).padStart(3,'0')}`]:[]}));
 const dag={project:{name:'Fictional Atlas'},phases:[{id:'phase4',tasks}],fixture_padding:'Synthetic inert source padding. '.repeat(73500),fixture_end:'PHASE4_FULL_DAG_END'};
 const dagBytes=JSON.stringify(dag);await writeFile(base.dagPath,dagBytes);
 const largeYaml='fixture: true\nobservations:\n'+Array.from({length:27000},(_,i)=>`  - id: ${i}\n    state: not-assessed\n    declaration: synthetic source only\n`).join('')+'final_marker: PHASE4_FULL_YAML_END\n';
 await writeFile(path.join(base.scope,'reviews/large-source.yaml'),largeYaml);
 for(let i=0;i<313;i++)await writeFile(path.join(base.scope,'reviews',`fictional-review-${String(i).padStart(3,'0')}.md`),`# Synthetic review ${i}\n\nOnly a declaration. No real account or project body.\n`);
 function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}return(crc^0xffffffff)>>>0;}
 function chunk(name,body){const result=Buffer.alloc(body.length+12);result.writeUInt32BE(body.length);result.write(name,4);body.copy(result,8);result.writeUInt32BE(crc32(result.subarray(4,-4)),result.length-4);return result;}
 const width=320,height=180,header=Buffer.alloc(13),pixels=Buffer.alloc(height*(width*3+1));header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const offset=y*(width*3+1)+1+x*3;pixels[offset]=40+x%180;pixels[offset+1]=80+y%140;pixels[offset+2]=130;}
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
 await writeFile(path.join(base.scope,'assets/viewer.png'),png);
 for(let i=0;i<62;i++)await writeFile(path.join(base.scope,'assets',`synthetic-${i}.png`),png);
 await writeFile(path.join(base.scope,'.hidden.md'),'Must not be catalogued');
 const outside=path.join(base.root,'outside-secret.md');await writeFile(outside,'OUTSIDE_SCOPE_MUST_NOT_BE_READ');await symlink(outside,path.join(base.scope,'escape.md'));
 const extraRoot=path.join(base.worktrees[0],'docs','review');await mkdir(extraRoot,{recursive:true});await writeFile(path.join(extraRoot,'source-review.md'),'# Explicit source review\nSynthetic source directory, requiring a separate project-bound grant.\n');
 const config=JSON.parse(await readFile(base.configPath,'utf8'));config.summarySelections=[];await writeFile(base.configPath,JSON.stringify(config));
 return {...base,extraRoot,tasks,dagBytes,largeMarkdown,largeYaml,dimensions:{tasks:54,markdownBytes:Buffer.byteLength(largeMarkdown),dagBytes:Buffer.byteLength(dagBytes),yamlBytes:Buffer.byteLength(largeYaml),reviewMarkdownFiles:313,pngFiles:63},sourceHash:createHash('sha256').update(dagBytes).digest('hex')};
}
