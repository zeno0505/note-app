const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('cacheTest',Object.freeze({run:(...args)=>ipcRenderer.invoke('cache-test:run',...args)}));
