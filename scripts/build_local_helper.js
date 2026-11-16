'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json');
require('dotenv').config({path:path.join(root,'.env'),quiet:true});
async function main(){
    const unsigned=process.argv.includes('--unsigned');
    const {applyWindowsUpdateSigningProfile}=require('./desktop_update_signing');
    const signing={build:{win:{}}};
    applyWindowsUpdateSigningProfile(signing,{required:!unsigned,env:process.env});
    const stage=path.join(root,'.tmp','helper-package-'+Date.now());fs.mkdirSync(stage,{recursive:true});
    const files=['desktop/helper/main.js','desktop/helper/preload.js','desktop/helper/runtime.js','desktop/helper/renderer.js','desktop/helper/index.html','desktop/helper/helper.css','desktop/local-desktop-control.js','server/services/local-desktop-control-tools.js','client/common/styles/theme.css'];
    for(const file of files){const target=path.join(stage,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,file),target);}
    fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({name:'pivot-local-helper',version:pkg.version,description:'Pivot Windows 本机助手',author:'Pivot',main:'desktop/helper/main.js'},null,2));
    const output=path.join(root,'dist-local-helper','build-'+Date.now());
    const config={appId:'com.pivot.localhelper',productName:'Pivot Local Helper',asar:true,electronVersion:require('electron/package.json').version,electronDist:path.dirname(require('electron')),directories:{output},files:['desktop/**','server/**','client/**','package.json'],win:{target:['nsis'],executableName:'PivotLocalHelper',...signing.build.win,...(unsigned?{signExecutable:false}:{})},nsis:{oneClick:false,perMachine:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:true,runAfterFinish:false,artifactName:unsigned?'PivotLocalHelper-Dev-Setup-${version}.${ext}':'PivotLocalHelper-Setup-${version}.${ext}'}};
    const configFile=path.join(stage,'electron-builder.json');fs.writeFileSync(configFile,JSON.stringify(config,null,2));
    const args=[path.join(root,'node_modules/electron-builder/cli.js'),'--projectDir',stage,'--config',configFile,'--win','--x64'];
    if(process.argv.includes('--dir'))args.push('--dir');
    const result=cp.spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true,env:{...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'}});
    if(result.error)throw result.error;if(result.status!==0)throw new Error('独立助手打包失败。');
    fs.writeFileSync(path.join(root,'dist-local-helper','latest-build.json'),JSON.stringify({version:pkg.version,output,unsigned},null,2));
    console.log('独立助手构建完成：'+output+(unsigned?'（未签名开发验证包）':''));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
