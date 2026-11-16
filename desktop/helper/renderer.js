/* global window, document */
'use strict';
const byId=id=>document.getElementById(id);
let lastError='';
async function refresh(){const status=await window.pivotHelper.status(),text=lastError||`${status.insecureTransport?'HTTP 明文直连 · ':''}${status.status}`;byId('status').textContent=text;byId('status').title=text;byId('account').textContent=status.paired?`${status.account} · ${status.server}`:'尚未连接账号';byId('account').title=status.paired?`${status.account} · ${status.server} · ${status.deviceId}`:'尚未连接账号';byId('authorize').disabled=!status.paired;byId('revoke').disabled=!status.grant;byId('disconnect').disabled=!status.paired;}
async function action(name,input={}){lastError='';for(const button of document.querySelectorAll('button'))button.disabled=true;try{const result=await window.pivotHelper.action(name,input);lastError=result.error||'';if(name==='pair'&&!result.error)byId('code').value='';await refresh();}finally{byId('pair').disabled=false;}}
byId('pair').onclick=()=>action('pair',{server:byId('server').value,code:byId('code').value});byId('disconnect').onclick=()=>action('disconnect');byId('authorize').onclick=()=>action('authorize',{windowTitle:byId('title').value,processName:byId('process').value});byId('revoke').onclick=()=>action('revoke');window.pivotHelper.onChange(refresh);void refresh();
