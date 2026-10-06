import {build} from 'esbuild';
import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import path from 'node:path';import {pathToFileURL} from 'node:url';
const {values}=parseArgs({options:{result:{type:'string'},pack:{type:'string'},directory:{type:'string'},output:{type:'string'}}});
for(const value of Object.values(values))if(!value||!path.isAbsolute(value))throw Error('Explicit absolute migration paths required');
if(Object.keys(values).length!==4)throw Error('result, pack, directory and output required');
await mkdir(values.output,{mode:0o700,recursive:true});
async function json(file,max){const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>max)throw Error('Invalid bounded legacy file');return {value:JSON.parse(await readFile(file,'utf8')),stat:s};}
const result=await json(values.result,256000),evidence=await json(values.pack,64000),review=JSON.parse(await readFile('src/shared/public-model-review.json','utf8'));
if(result.value.inputHash!==review.inputHash||evidence.value.inputHash!==review.inputHash||result.value.first.status!=='model'||result.value.sha!==review.sourceSha)throw Error('Only the manually reviewed approved public experiment may migrate');
const compiled=path.join(values.output,'migration-storage.mjs');await build({entryPoints:['src/summary/reading/model-reading-storage.ts'],outfile:compiled,platform:'node',format:'esm',bundle:true,target:'node24'});
const {createModelReadingStorage}=await import(pathToFileURL(compiled));const storage=createModelReadingStorage(values.directory);
await storage.importSuccessfulPublicResult(evidence.value.pack,result.value.first,review.manualReview.note,new Date(result.stat.mtimeMs).toISOString());
const view=await storage.readLatest('zeno0505/note-app');if(view.state!=='ready')throw Error('Migrated latest not ready');
const report={status:'migrated-public-result',directory:values.directory,inputHash:review.inputHash,sourceSha:review.sourceSha,latestBodyCount:1,newModelCalls:0,legacyFilesPreserved:true,validation:view.latest.validation,observedGeneratedAt:view.latest.generatedAt};
await writeFile(path.join(values.output,'migration-report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
