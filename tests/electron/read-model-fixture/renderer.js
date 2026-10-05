const status=document.querySelector('#status'),result=document.querySelector('#result');
const messages={
 'codeburn-normal':'Quota data unavailable does not mean the agent is unavailable. Cost remains approximate; budget windows are unknown.',
 'codeburn-errors':'Failed and malformed observations remain explicit failures. They cannot establish zero usage.',
 'codeburn-timeout':'A bounded timeout ends the subprocess. A subsequent fixed query succeeds.',
 'codeburn-slow':'Cancellation ends the owned subprocess. A subsequent fixed query succeeds.',
 'dag-first':'1000 declared tasks. External dependency preserved; unmet and undeclared E2E differ; commit references remain unverified.',
 'dag-cache':'Identical content hash reuses the detached read model with no query launch or YAML parse.',
 'dag-unselected':'Unselected task edit changes the upstream DAG hash, but selected projection evidence stays identical and requires no summary refresh.',
 'dag-changed':'A changed content hash triggers a new external query. Original DAG bytes remain unchanged by the reader.',
 'dag-slow':'The external Python query runs asynchronously while the window and main-process IPC remain responsive.',
 'dag-cancel':'Cancellation settles the request; cleanup checks tracked subprocesses and private temporary snapshots.'};
for(const button of document.querySelectorAll('[data-scenario]'))button.addEventListener('click',async()=>{for(const b of document.querySelectorAll('[data-scenario]'))b.disabled=true;document.querySelector('#pulse-result').textContent='IPC ready';status.textContent='Reading '+button.dataset.scenario;result.textContent='Read in progress';document.querySelector('#interpretation').textContent=messages[button.dataset.scenario];try{const value=await window.readModelTest.run(button.dataset.scenario);result.textContent=JSON.stringify(value,null,2);status.textContent=value.status;}catch(error){status.textContent='Integration check failed';result.textContent=error.message;}finally{for(const b of document.querySelectorAll('[data-scenario]'))b.disabled=false;}});
document.querySelector('#pulse').addEventListener('click',async()=>{const value=await window.readModelTest.pulse();document.querySelector('#pulse-result').textContent=value.running?'Main process responsive during read':'Main process responsive';});
document.querySelector('#cancel').addEventListener('click',()=>window.readModelTest.cancel());
