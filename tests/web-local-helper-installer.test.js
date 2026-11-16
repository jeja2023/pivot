'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const execFile=require('node:util').promisify(require('node:child_process').execFile);
test('独立助手安装包可安装、启动并通过卸载器退出安装目录',{skip:process.platform!=='win32'||process.env.PIVOT_HELPER_INSTALLER_ACCEPTANCE!=='true',timeout:120000},async()=>{
    const build=JSON.parse(await fs.readFile(path.resolve('dist-local-helper/latest-build.json'),'utf8'));
    const installer=path.join(build.output,`PivotLocalHelper-${build.unsigned?'Dev-':''}Setup-${build.version}.exe`);
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'pivot-helper-install-')),directory=path.join(root,'app'),profile=path.join(root,'profile');let app,installed=false;
    try{
        await execFile(installer,['/S','/D='+directory],{windowsHide:true,timeout:60000});installed=true;
        const executable=path.join(directory,'PivotLocalHelper.exe');assert.ok((await fs.stat(executable)).size>0);
        app=await require('playwright')._electron.launch({executablePath:executable,args:['--user-data-dir='+profile],timeout:25000});
        const page=await app.firstWindow();await page.locator('#pair').waitFor();assert.equal(await page.locator('h1').textContent(),'Pivot 本机助手');
        await app.evaluate(({dialog})=>{dialog.showMessageBox=async options=>{if(options.title!=='确认 HTTP 直连')throw new Error('未触发 HTTP 地址确认');return {response:1};};});
        await page.locator('#server').fill('http://remote.invalid');await page.locator('#code').fill('invalid');await page.locator('#pair').click();
        await page.getByText('已取消 HTTP 直连，未向此地址发送配对信息。',{exact:true}).waitFor();
        await app.close();app=null;
    }finally{
        if(app)await app.close();
        if(installed){const name=(await fs.readdir(directory)).find(value=>/^Uninstall .*\.exe$/.test(value));assert.ok(name,'缺少卸载器');
            const uninstallTemp=path.join(root,'uninstall-temp');await fs.mkdir(uninstallTemp,{recursive:true});
            await execFile(path.join(directory,name),['/S'],{windowsHide:true,timeout:60000,env:{...process.env,TEMP:uninstallTemp,TMP:uninstallTemp}});}
        assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('pivot-helper-install-'));
        await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
    }
});
