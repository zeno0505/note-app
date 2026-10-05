const status=document.querySelector('#status');const result=document.querySelector('#result');
for(const button of document.querySelectorAll('button[data-scenario]'))button.addEventListener('click',async()=>{
 for(const item of document.querySelectorAll('button'))item.disabled=true;
 status.textContent='Verifying contract';result.textContent='';
 try{const value=await window.summaryTest.run(button.dataset.scenario);result.textContent=JSON.stringify(value,null,2);status.textContent=value.status;
 const summaries={'bounded-context':'One included record · one excluded source · hostile text remains plain data · transport still gated','prompt-ceiling':'Context alone fits the ceiling; the complete prompt is rejected before transport','claims-lifecycle':'Synthetic approval only · 3 stale claims, 3 current claims · prior approved text survives failure and replacement candidate','late-response':'Both superseded requests and old context versions are rejected','unsupported-citation':'Unsupported quotes and manifest-only sources cannot establish a claim','provider-budget':'Unknown usage requires choice · explicit override remains advisory · known cap blocks override · no provider invoked'};document.querySelector('#scope').textContent=summaries[value.scenario];}
 catch(error){status.textContent='Contract check failed';result.textContent=String(error.message);}
 finally{for(const item of document.querySelectorAll('button'))item.disabled=false;}
});
