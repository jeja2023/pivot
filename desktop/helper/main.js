'use strict';
const {app,BrowserWindow,ipcMain,dialog,safeStorage,net} = require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHelperRuntime}=require('./runtime');
app.setName('Pivot Local Helper');
app.setPath('userData',app.commandLine.hasSwitch('user-data-dir')?path.resolve(app.commandLine.getSwitchValue('user-data-dir')):path.join(app.getPath('appData'),'PivotLocalHelper'));
let window,runtime,closing=false,busy=false;
const stateFile=()=>path.join(app.getPath('userData'),'connection.bin');
function save(){const value=runtime.snapshot();if(!value){fs.rmSync(stateFile(),{force:true});return;}if(!safeStorage.isEncryptionAvailable())throw new Error('系统安全存储不可用，无法保存助手凭据。');fs.mkdirSync(app.getPath('userData'),{recursive:true});fs.writeFileSync(stateFile(),safeStorage.encryptString(JSON.stringify(value)),{mode:0o600});}
function trusted(event){if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('拒绝非助手界面请求。');}
if(!app.requestSingleInstanceLock())app.quit();else{
    app.on('second-instance',()=>{window?.show();window?.focus();});
    app.whenReady().then(async()=>{
        if(process.platform!=='win32')throw new Error('独立助手当前支持 Windows。');
        window=new BrowserWindow({width:620,height:620,minWidth:540,minHeight:600,show:false,title:'Pivot 本机助手',webPreferences:{preload:path.join(__dirname,'preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
        window.removeMenu();
        window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
        runtime=createHelperRuntime({request:(url,options)=>net.fetch(url,{...options,credentials:'omit'}),deviceName:os.hostname(),approve:async value=>{
            const action=value.title==='确认原生桌面应用操作';
            const http=value.kind==='http_transport';
            const answer=await dialog.showMessageBox({type:http?'warning':'question',title:value.title,message:value.message,detail:value.detail+(action?'\n允许后请在3秒内切回授权应用；目标不匹配时操作会停止。':''),buttons:[http?'继续使用此 HTTP 地址':'允许','取消'],defaultId:1,cancelId:1,noLink:true});
            if(answer.response!==0)return false;
            if(action)await new Promise(resolve=>setTimeout(resolve,3000));
            return true;
        },changed:()=>{if(!window.isDestroyed())window.webContents.send('helper:changed');}});
        ipcMain.handle('helper:status',event=>{trusted(event);return runtime.status();});
        ipcMain.handle('helper:action',async(event,action,input={})=>{trusted(event);if(busy)return {error:'助手正在处理操作，请稍后重试。'};busy=true;try{
            if(!safeStorage.isEncryptionAvailable())throw new Error('系统安全存储不可用，助手暂不可配对。');
            if(action==='pair')await runtime.pair(input.server,String(input.code||'').trim());
            else if(action==='authorize')await runtime.authorize(input);
            else if(action==='revoke')await runtime.revokeGrant();
            else if(action==='disconnect')await runtime.disconnect();
            else throw new Error('助手操作未登记。');save();return {status:runtime.status()};
        }catch(error){return {error:error.message,status:runtime.status()};}finally{busy=false;}});
        await window.loadFile(path.join(__dirname,'index.html'));window.show();
        if(fs.existsSync(stateFile())&&safeStorage.isEncryptionAvailable()){try{runtime.restore(JSON.parse(safeStorage.decryptString(fs.readFileSync(stateFile()))));}catch(_){fs.rmSync(stateFile(),{force:true});}}
    }).catch(error=>{dialog.showErrorBox('助手启动失败',error.message);app.quit();});
    app.on('window-all-closed',()=>app.quit());
    app.on('before-quit',event=>{if(closing||!runtime)return;event.preventDefault();closing=true;runtime.disconnect().finally(()=>{save();app.quit();});});
}
