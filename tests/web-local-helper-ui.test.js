'use strict';
/* global document, innerWidth, innerHeight */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('独立助手真实 Electron 窗口可以启动并显示配对、授权和换号入口',{skip:process.platform!=='win32',timeout:40000},async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'pivot-helper-ui-'));
    let app;
    try{
        app=await require('playwright')._electron.launch({args:[path.resolve('desktop/helper/main.js'),'--user-data-dir='+root],timeout:25000});
        const page=await app.firstWindow();
        await page.locator('#pair').waitFor();
        assert.equal(await page.locator('h1').textContent(),'Pivot 本机助手');
        assert.equal(await page.locator('#authorize').isDisabled(),true);
        assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMenuBarVisible()),false);
        for (const colorScheme of ['light','dark']) {
            await page.emulateMedia({colorScheme});
            for (const [width,height] of [[620,620],[540,600],[760,680]]) {
                const contentSize=await app.evaluate(({BrowserWindow},{width,height})=>{const window=BrowserWindow.getAllWindows()[0];window.setSize(width,height);return window.getContentSize();},{width,height});
                await page.waitForFunction(([width,height])=>innerWidth===width&&innerHeight===height,contentSize);
                await page.locator('#status').evaluate(element=>element.textContent='HTTP 明文直连 · 本机已停止；服务端撤销未确认，请在浏览器断开旧连接。');
                await page.locator('#account').evaluate(element=>{element.textContent='较长的账号名称 · https://'+ 'example'.repeat(25)+'.com';});
                const layout=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,
                    buttons:[...document.querySelectorAll('button')].map(element=>({bottom:element.getBoundingClientRect().bottom,right:element.getBoundingClientRect().right})),
                    inputHeights:[...document.querySelectorAll('input')].map(element=>element.getBoundingClientRect().height)}));
                assert.ok(layout.scrollHeight<=layout.height,JSON.stringify(layout));
                assert.ok(layout.scrollWidth<=layout.width,JSON.stringify(layout));
                assert.ok(layout.buttons.every(button=>button.bottom<=layout.height&&button.right<=layout.width));
                assert.ok(layout.inputHeights.every(height=>height===34));
            }
        }
        const finalSize=await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setSize(620,620);return window.getContentSize();});
        await page.waitForFunction(([width,height])=>innerWidth===width&&innerHeight===height,finalSize);await page.emulateMedia({colorScheme:'light'});
        await page.locator('#status').evaluate(element=>element.textContent='未配对');await page.locator('#account').evaluate(element=>element.textContent='尚未连接账号');
        await page.evaluate(()=>document.getAnimations().forEach(animation=>animation.finish()));
        await fs.mkdir(path.resolve('output/local-helper'),{recursive:true});await page.screenshot({path:path.resolve('output/local-helper/compact-ui.png')});
        await page.locator('#process').fill('custom-client.exe');assert.equal(await page.locator('#process').inputValue(),'custom-client.exe');
        assert.equal(await page.locator('#process-options option').count(),4);
        await app.evaluate(({dialog})=>{dialog.showMessageBox=async options=>{globalThis.pivotHttpConfirmation=options;return {response:1};};});
        await page.locator('#server').fill('http://remote.invalid');await page.locator('#code').fill('invalid');await page.locator('#pair').click();
        await page.getByText('已取消 HTTP 直连，未向此地址发送配对信息。',{exact:true}).waitFor();
        const confirmation=await app.evaluate(()=>globalThis.pivotHttpConfirmation);
        assert.equal(confirmation.type,'warning');assert.equal(confirmation.message,'服务地址：http://remote.invalid');
        assert.equal(confirmation.defaultId,1);assert.equal(confirmation.cancelId,1);
    }finally{if(app)await app.close();await fs.rm(root,{recursive:true,force:true});}
});

test('Windows驱动可读取、输入、点击并截取专用验收窗口',{skip:process.platform!=='win32',timeout:40000},async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'pivot-helper-native-'));let app;
    try{
        app=await require('playwright')._electron.launch({args:[path.resolve('desktop/helper/main.js'),'--user-data-dir='+root],timeout:25000});
        const page=await app.firstWindow();await page.locator('#pair').waitFor();
        await app.evaluate(async({app,BrowserWindow})=>{
            app.setAccessibilitySupportEnabled(true);
            const target=new BrowserWindow({width:600,height:400,title:'Pivot助手受控验收',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
            await target.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<title>Pivot助手受控验收</title><label>验收输入<input id="fixture-input" aria-label="验收输入"></label><button onclick="document.body.dataset.clicked=\'yes\'">记录测试</button>'));
            target.setAlwaysOnTop(true);target.show();app.focus({steal:true});target.moveTop();target.focus();
        });
        const target=app.windows().find(item=>item!==page);await target.waitForLoadState();
        await target.bringToFront();
        const {runLocalDesktopControlTask}=require('../desktop/local-desktop-control');
        const grant={windowTitle:'Pivot助手受控验收',processName:'electron.exe'};
        const execute=(toolName,input)=>runLocalDesktopControlTask({toolName,input,grant,confirmAction:async()=>true});
        await execute('desktop.inspect',{});
        await execute('desktop.type',{target:{name:'验收输入'},text:'独立助手真实驱动验收'});
        assert.equal(await target.locator('input').inputValue(),'独立助手真实驱动验收');
        await execute('desktop.click',{target:{name:'记录测试'}});
        assert.equal(await target.locator('body').getAttribute('data-clicked'),'yes');
        const shot=await execute('desktop.screenshot',{});assert.equal(shot.screenshot.mimeType,'image/jpeg');
        await fs.mkdir(path.resolve('output/local-helper'),{recursive:true});await page.screenshot({path:path.resolve('output/local-helper/standalone-ui.png')});
    }finally{if(app)await app.close();await fs.rm(root,{recursive:true,force:true});}
});

test('打包后的独立助手可从完整发行目录启动',{skip:process.platform!=='win32'||!require('node:fs').existsSync(path.resolve('dist-local-helper/latest-build.json')),timeout:35000},async()=>{
    const build=JSON.parse(await fs.readFile(path.resolve('dist-local-helper/latest-build.json'),'utf8'));
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pivot-helper-package-'));let app;
    try{
        app=await require('playwright')._electron.launch({executablePath:path.join(build.output,'win-unpacked','PivotLocalHelper.exe'),args:['--user-data-dir='+directory],timeout:25000});
        const page=await app.firstWindow();await page.locator('#pair').waitFor();assert.equal(await page.locator('h1').textContent(),'Pivot 本机助手');
        assert.equal(await page.locator('#authorize').isDisabled(),true);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight));
    }finally{if(app)await app.close();await fs.rm(directory,{recursive:true,force:true});}
});
