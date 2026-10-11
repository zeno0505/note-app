const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('summaryTest',Object.freeze({run:(...args)=>ipcRenderer.invoke('summary-test:run',...args)}));
