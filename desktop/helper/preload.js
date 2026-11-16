'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('pivotHelper',{status:()=>ipcRenderer.invoke('helper:status'),action:(action,input)=>ipcRenderer.invoke('helper:action',action,input),onChange:callback=>ipcRenderer.on('helper:changed',()=>callback())});
