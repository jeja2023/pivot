'use strict';
const crypto = require('node:crypto');
const {runLocalDesktopControlTask} = require('../local-desktop-control');
const {isLocalDesktopControlTool} = require('../../server/services/local-desktop-control-tools');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function endpoint(value, {allowRemoteHttp = false} = {}) {
    const url = new URL(String(value));
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['https:','http:'].includes(url.protocol)) throw new Error('请填写 HTTP 或 HTTPS 服务根地址，不要包含账号、查询参数或额外路径。');
    if (remoteHttp(url.origin) && !allowRemoteHttp) throw new Error('远程 HTTP 地址需要先在本机确认。');
    return url.origin;
}
function remoteHttp(server) {const url = new URL(server);return url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname);}
function createHelperRuntime({request = fetch, approve = async () => false, changed = () => {}, execute = runLocalDesktopControlTask, deviceName = 'Windows 本机助手'} = {}) {
    let connection = null, grant = null, controller = null, loop = null, state = {status:'未配对'};
    function update(value) {state={...state,...value};changed(status());}
    function status() {return {...state,paired:Boolean(connection),insecureTransport:Boolean(connection && remoteHttp(connection.server)),account:connection?.account || '',server:connection?.server || '',deviceId:connection?.deviceId || '',grant:grant ? {...grant} : null};}
    async function json(server,path,body,token,signal) {
        const response = await request(server+'/api/mcp/helper/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(token || 'pairingrequestwithoutbrowsercookies')},body:JSON.stringify(body),signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),redirect:'error'});
        const value=await response.json();if(!response.ok)throw new Error(typeof value.error==='string'?value.error:'助手服务请求失败。');return value;
    }
    async function channel(c,action,payload={},signal) {
        const challenge=await json(c.server,'challenge',{},c.token,signal);
        const text=`helper:${challenge.nonce}:${action}:${hash(JSON.stringify(payload))}`;
        const signature=crypto.sign(null,Buffer.from(text),c.privateKey).toString('base64');
        return json(c.server,'channel',{action,payload,nonce:challenge.nonce,signature},c.token,signal);
    }
    async function disconnect(revoke=true) {
        const old=connection; controller?.abort(); if(loop)await loop.catch(()=>{}); loop=null;controller=null;
        connection=null;grant=null;
        let revokeFailed=false;
        if(old&&revoke)await channel(old,'revoke').catch(()=>{revokeFailed=true;});
        update({status:revokeFailed?'本机已停止；服务端撤销未确认，请在浏览器断开旧连接。':'未配对'});
    }
    async function pair(server,code) {
        server=endpoint(server,{allowRemoteHttp:true});
        const insecureTransport=remoteHttp(server);
        if(insecureTransport && !await approve({kind:'http_transport',title:'确认 HTTP 直连',message:`服务地址：${server}`,detail:'HTTP 不加密传输，配对凭据、截图和操作内容可能被窃听或篡改。请确认你信任此服务地址和网络。\n本次确认仅适用于此地址；设备签名、账号绑定和每次操作的本机确认仍保留。'}))throw new Error('已取消 HTTP 直连，未向此地址发送配对信息。');
        await disconnect();
        const offer=await json(server,'offer',{code});
        if(!await approve({title:'确认助手配对',message:`连接 ${server}`,detail:`账号：${offer.account}（${offer.username}）\n请确认这是当前浏览器中的账号。`}))throw new Error('已取消配对。');
        const keys=crypto.generateKeyPairSync('ed25519'),deviceId='webhelper-'+crypto.randomBytes(16).toString('hex');
        const privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
        const signature=crypto.sign(null,Buffer.from(`helper-pair:${offer.id}:${offer.nonce}:${deviceId}`),privateKey).toString('base64');
        const result=await json(server,'exchange',{code,deviceId,deviceName,publicKey,signature});
        connection={...result,server,privateKey,httpConsentOrigin:insecureTransport?server:null};grant=null;update({status:'已配对，请授权应用'});return snapshot();
    }
    async function authorize(value) {
        if(!connection)throw new Error('请先配对助手。');
        const {normalizeDesktopControlGrant}=require('../../server/services/local-desktop-control-tools');
        const next=normalizeDesktopControlGrant(value);if(!next.windowTitle||!next.processName)throw new Error('请填写准确的窗口标题和进程名。');
        if(!await approve({title:'确认本机应用授权',message:next.windowTitle,detail:`进程：${next.processName}\n服务：${connection.server}${remoteHttp(connection.server)?'（HTTP 明文直连）':''}\n仅允许对此前台应用执行已登记的操作。`}))return status();
        await revokeGrant();grant=next;await channel(connection,'heartbeat',{grants:{local_desktop_control:{...grant,authorized:true}}});update({status:'已授权，等待任务'});start();return status();
    }
    async function run(c,signal) {
        while(!signal.aborted&&connection===c) {
            try {
                await channel(c,'heartbeat',{grants:{local_desktop_control:grant?{...grant,authorized:true}:{authorized:false}}},signal);
                if(grant) {
                    const claimed=await channel(c,'claim',{},signal);
                    if(claimed.status==='claimed') {
                        const task=claimed.task,snapshot=JSON.stringify(grant);
                        if(!isLocalDesktopControlTool(task.toolName)||hash(JSON.stringify(task.input || {}))!==task.inputDigest)throw new Error('助手任务协议或摘要不匹配。');
                        update({status:'正在处理：'+task.toolName});
                        try {
                            const result=await execute({toolName:task.toolName,input:task.input,grant,signal,confirmAction:detail=>approve({title:detail.title,message:detail.message,detail:`账号：${c.account}\n服务：${c.server}${remoteHttp(c.server)?'（HTTP 明文直连）':''}\n应用：${detail.application}\n目标：${detail.target?.name || detail.target?.automationId || '授权窗口'}${detail.text ? '\n填写内容：'+detail.text : ''}`}),assertAuthorization:async()=>{
                                if(connection!==c||JSON.stringify(grant)!==snapshot)throw new Error('账号或本机授权已变化。');
                                await channel(c,'preflight',{taskId:task.id,claimToken:claimed.claimToken},signal);
                            }});
                            if(signal.aborted)break;
                            await channel(c,'result',{taskId:task.id,claimToken:claimed.claimToken,success:true,result},signal);
                        } catch(error) {
                            if(signal.aborted)break;
                            await channel(c,'result',{taskId:task.id,claimToken:claimed.claimToken,success:false,error:{message:error.message}},signal).catch(()=>{});
                            update({status:error.message});
                        }
                    }
                }
                update({status:grant?'已连接，等待任务':'已连接，请授权应用'});
            }catch(error){if(signal.aborted)break;update({status:error.message});}
            await new Promise(resolve=>{const timer=setTimeout(done,3000);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});
        }
    }
    function start(){if(connection&&!loop){controller=new AbortController();loop=run(connection,controller.signal);}return status();}
    async function revokeGrant(){controller?.abort();if(loop)await loop.catch(()=>{});loop=null;controller=null;grant=null;if(connection)await channel(connection,'heartbeat',{grants:{}}).catch(()=>{});update({status:'应用授权已撤销'});return status();}
    function snapshot(){return connection?{connection:{...connection},grant:grant?{...grant}:null}:null;}
    function restore(value){
        let restored=null;
        if(value?.connection){
            const server=endpoint(value.connection.server,{allowRemoteHttp:true});
            if(remoteHttp(server)&&value.connection.httpConsentOrigin!==server)throw new Error('远程 HTTP 地址尚未在本机确认，请重新配对。');
            restored={...value.connection,server,httpConsentOrigin:remoteHttp(server)?server:null};
        }
        connection=restored;grant=restored?value.grant||null:null;return start();
    }
    return {pair,authorize,disconnect,revokeGrant,start,status,snapshot,restore};
}
module.exports={createHelperRuntime,endpoint};
