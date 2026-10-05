const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('readModelTest',Object.freeze({run:(...args)=>ipcRenderer.invoke('read-model:run',...args),pulse:(...args)=>ipcRenderer.invoke('read-model:pulse',...args),cancel:(...args)=>ipcRenderer.invoke('read-model:cancel',...args),cleanup:(...args)=>ipcRenderer.invoke('read-model:cleanup',...args)}));
