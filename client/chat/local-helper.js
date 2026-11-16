/* global window, document, sessionStorage, apiFetch, API_BASE */
(function(){
    'use strict';
    let busy=false;
    const actor=()=>window.Pivot?.legacy?.currentUser?.id;
    const key=()=>`pivot_web_helper_${actor()}`;
    const read=()=>{try{return JSON.parse(sessionStorage.getItem(key())||'null');}catch(_){return null;}};
    async function request(path,body){const response=await apiFetch(API_BASE+'/mcp/helper/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw new Error(data.error||'助手连接失败。');return data;}
    async function create(){if(!actor())throw new Error('请先登录。');const value=await request('pairings',{});sessionStorage.setItem(key(),JSON.stringify({id:value.id,binding:value.binding}));return value;}
    async function touch(){const pair=read();if(!actor()||!pair||busy)return;busy=true;const owner=actor();try{await request('touch',pair);}catch(_){if(owner===actor())sessionStorage.removeItem(key());}finally{busy=false;}}
    async function status(){if(!actor())return null;await touch();const {pairs}=await request('pairings');const pair=read(),active=pairs.find(item=>item.id===pair?.id&&item.state==='active');if(!active)return null;
        const response=await apiFetch(API_BASE+'/mcp/local-device/connector/status');if(!response.ok)return null;const data=await response.json(),device=data.devices.find(item=>item.deviceId===active.device_id);return {available:Boolean(device),provider:'helper',mode:'web',deviceName:active.device_name||'本机助手',deviceId:active.device_id,supportedTypes:['local_desktop_control'],grants:device?.grants||{},message:device?'独立助手已配对并在线，每次操作需本机确认。':'独立助手已配对，请启动助手并在本机授权目标应用。'};}
    async function revoke(){const pair=read();if(pair)await request('revoke',{id:pair.id});sessionStorage.removeItem(key());}
    window.Pivot.exposeModule('local.helper',{create,status,revoke,touch});
    window.setInterval(()=>{if(!window.pivotDesktop)void touch();},15000);
})();
