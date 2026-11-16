'use strict';
/* global window */
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const express=require('express');
const {queryOne,execute}=require('../server/db/client');
const auth=require('../server/auth');
const {runWithRequestContext}=require('../server/services/request-context');
const helper=require('../server/services/web-local-helper');
const connector=require('../server/services/agent-local-connector');
for(const remoteHttp of [false,true])test(`真实浏览器通过${remoteHttp?'远程 HTTP 直连':'本机 HTTP'}配对独立助手并完成 Windows 字段输入`,{skip:process.platform!=='win32'||!process.env.DATABASE_URL,timeout:60000},async()=>{
    const user=await queryOne('SELECT * FROM users ORDER BY id LIMIT 1'),csrf=crypto.randomBytes(24).toString('hex');
    const app=express();app.use(express.json());app.use((_req,_res,next)=>runWithRequestContext({},next));
    app.use('/api',auth.csrfMiddleware);
    const router=express.Router();require('../server/routes/mcp/web-local-helper').mountWebLocalHelperRoutes(router,auth.authMiddleware);
    require('../server/routes/mcp/local-connector').mountLocalConnectorRoutes(router,auth.authMiddleware);
    router.post('/fixture-task',auth.authMiddleware,async(req,res,next)=>{try{res.json(await connector.createConnectorTask('desktop.type',{deviceId:req.body.deviceId,target:{name:'验收字段'},text:'浏览器到独立助手端到端验收'},req.user));}catch(error){next(error);}});
    app.use('/api',router);app.get('/fixture',(_req,res)=>res.send('<!doctype html><title>浏览器助手验收</title>'));
    app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),origin=`http://${remoteHttp?'pivot-http.invalid':'127.0.0.1'}:${server.address().port}`;
    const resolverArgs=remoteHttp?['--host-resolver-rules=MAP pivot-http.invalid 127.0.0.1','--no-proxy-server']:[];
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pivot-helper-full-'));
    let browser,electron,pair,deviceId;
    try{
        const {chromium,_electron}=require('playwright');browser=await chromium.launch({headless:true,args:resolverArgs});const page=await browser.newPage();
        await page.context().addCookies([{name:auth.AUTH_COOKIE_NAME,value:auth.generateAccessToken(user,{sessionIp:'127.0.0.1'}),url:origin},{name:'pivot_device_id',value:crypto.randomBytes(24).toString('base64url'),url:origin},{name:auth.CSRF_COOKIE_NAME,value:csrf,url:origin}]);
        await page.goto(origin+'/fixture');
        if(remoteHttp)assert.equal(await page.evaluate(()=>window.isSecureContext),false);
        await page.addScriptTag({path:path.resolve('client/chat/pivot-core.js')});
        await page.evaluate(({userId,csrf})=>{window.API_BASE='/api';window.apiFetch=(url,options={})=>fetch(url,{...options,headers:{...options.headers,'x-csrf-token':csrf}});window.Pivot.legacy.currentUser={id:userId};},{userId:user.id,csrf});
        await page.addScriptTag({path:path.resolve('client/chat/local-helper.js')});pair=await page.evaluate(()=>window.Pivot.moduleApi('local.helper').create());
        electron=await _electron.launch({args:[path.resolve('desktop/helper/main.js'),'--user-data-dir='+directory,...resolverArgs],timeout:25000});const ui=await electron.firstWindow();
        // 只在测试主进程替换原生确认；正式安装包仍使用本机确认弹窗。
        await electron.evaluate(({dialog,BrowserWindow,app})=>{globalThis.pivotFixtureDialogs=[];dialog.showMessageBox=async options=>{globalThis.pivotFixtureDialogs.push(options);if(options.title==='确认原生桌面应用操作'){const target=BrowserWindow.getAllWindows().find(value=>value.getTitle()==='Pivot助手链路验收');if(target){target.setAlwaysOnTop(true);app.focus({steal:true});target.moveTop();target.focus();}}return {response:0};};});
        await ui.locator('#server').fill(origin);await ui.locator('#code').fill(pair.code);await ui.locator('#pair').click();await ui.locator('#authorize:not([disabled])').waitFor();
        assert.equal(await ui.evaluate(()=>window.pivotHelper.status()).then(value=>value.insecureTransport),remoteHttp);
        if(remoteHttp){const confirmations=await electron.evaluate(()=>globalThis.pivotFixtureDialogs);assert.equal(confirmations[0].title,'确认 HTTP 直连');assert.equal(confirmations[0].message,'服务地址：'+origin);await ui.getByText(/HTTP 明文直连 ·/).waitFor();}
        await ui.locator('#title').fill('Pivot助手链路验收');await ui.locator('#process').fill('electron.exe');await ui.locator('#authorize').click();
        await ui.locator('#revoke:not([disabled])').waitFor();
        if(remoteHttp){
            assert.ok(await ui.evaluate(()=>window.document.documentElement.scrollHeight<=window.innerHeight));
            await fs.mkdir(path.resolve('output/local-helper'),{recursive:true});
            await ui.screenshot({path:path.resolve('output/local-helper/remote-http-connected.png')});
        }
        const status=await page.evaluate(()=>window.Pivot.moduleApi('local.helper').status());deviceId=status.deviceId;assert.ok(deviceId);
        await electron.evaluate(async({app,BrowserWindow})=>{app.setAccessibilitySupportEnabled(true);const target=new BrowserWindow({width:600,height:350,title:'Pivot助手链路验收'});await target.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<title>Pivot助手链路验收</title><label>验收字段<input aria-label="验收字段"></label>'));target.setAlwaysOnTop(true);target.show();app.focus({steal:true});target.moveTop();target.focus();const focus=setInterval(()=>{if(!target.isDestroyed())target.focus();},100);target.on('closed',()=>clearInterval(focus));});
        const target=electron.windows().find(value=>value!==ui);await target.bringToFront();
        const task=await page.evaluate(async deviceId=>{const response=await window.apiFetch('/api/fixture-task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId})});return response.json();},deviceId);
        const result=await connector.waitForConnectorTask(task.id,user,12000);assert.ok(result.chars>0);
        assert.equal(await target.locator('input').inputValue(),'浏览器到独立助手端到端验收');
        await page.evaluate(()=>window.Pivot.moduleApi('local.helper').revoke());
        assert.equal(await helper.repository.credential(helper.hash('invalid')),null);
    }finally{
        if(electron)await electron.close();if(browser)await browser.close();
        if(pair)await execute('DELETE FROM web_local_helper_pairs WHERE id=?',[pair.id]);
        if(deviceId){for(const table of ['agent_local_connector_tasks','agent_local_connector_grants','agent_local_device_nonces'])await execute(`DELETE FROM ${table} WHERE device_id=?`,[deviceId]);await execute('DELETE FROM agent_local_devices WHERE device_id=?',[deviceId]);}
        server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});
    }
});
