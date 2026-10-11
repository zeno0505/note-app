const show=state=>document.querySelector('#state').textContent=JSON.stringify(state,null,2);
window.pollTest.subscribe(show);document.querySelector('#start').addEventListener('click',async()=>show(await window.pollTest.start()));
