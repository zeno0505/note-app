/** Test-only synthetic-file verification using the unchanged pinned production reader. */
import assert from 'node:assert/strict';
import {createDagReader} from '../../src/facts/dag-read-model';
async function main(){
 const [pythonPath,queryScriptPath,canonicalDagPath]=process.argv.slice(2);
 assert(pythonPath&&queryScriptPath&&canonicalDagPath);
 const reader=createDagReader({pythonPath,queryScriptPath,registrations:[{dagId:'created-fixture',canonicalDagPath}],requireDocumentShape:true});
 const result=await reader.read('created-fixture');assert.equal(result.ok,true,JSON.stringify(result));if(!result.ok)return;
 assert.equal(result.value.coverage.tasksTotal,0);assert.deepEqual(result.value.tasks,[]);
 console.log(JSON.stringify({pinnedReader:'passed',tasks:result.value.coverage.tasksTotal,sourceHash:result.value.sourceHash,cleanup:reader.recoveryState?.()??null}));
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
