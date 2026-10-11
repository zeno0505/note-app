const status=document.querySelector('#status');const result=document.querySelector('#result');
for(const button of document.querySelectorAll('button[data-scenario]'))button.addEventListener('click',async()=>{
 for(const item of document.querySelectorAll('button'))item.disabled=true;
 status.textContent='Verifying cache';result.textContent='';
 try{const value=await window.cacheTest.run(button.dataset.scenario);result.textContent=JSON.stringify(value,null,2);status.textContent=value.status;}
 catch(error){status.textContent='Cache check failed';result.textContent=String(error.message);}
 finally{for(const item of document.querySelectorAll('button'))item.disabled=false;}
});
