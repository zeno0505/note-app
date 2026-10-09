const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('collectorTest',Object.freeze({run:scenario=>ipcRenderer.invoke('collector:run',scenario),cancel:()=>ipcRenderer.invoke('collector:cancel'),ping:()=>ipcRenderer.invoke('collector:ping'),cleanup:()=>ipcRenderer.invoke('collector:cleanup')}));
