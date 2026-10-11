const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('harness', Object.freeze({ping: input => ipcRenderer.invoke('harness:ping', input)}));
