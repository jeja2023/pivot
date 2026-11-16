'use strict';
/* global window */
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const express=require('express');
const {queryOne,execute}=require('../server/db/client');
const helper=require('../server/services/web-local-helper');
const {mountWebLocalHelperRoutes}=require('../server/routes/mcp/web-local-helper');
const {createHelperRuntime}=require('../desktop/helper/runtime');
const connector=require('../server/services/agent-local-connector');
const path=require('node:path');
const {runWithRequestContext,getRequestContext}=require('../server/services/request-context');
test('浏览器配对到独立助手，签名任务可执行，其他浏览器拒绝且撤销后失效',{skip:!process.env.DATABASE_URL,timeout:30000},async()=>{
    const user=await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const cookie='pivot_device_id='+crypto.randomBytes(24).toString('base64url');
    const req={headers:{cookie}},browserKey=helper.helperBrowserKey(req,user);
    const app=express();app.use(express.json());app.use((req,_res,next)=>runWithRequestContext({},next));
    const fixtureAuth=(req,res,next)=>{if(req.headers.cookie!==cookie)return res.status(401).json({error:'未登录'});req.user=user;getRequestContext().helperBrowserKey=browserKey;next();};
    mountWebLocalHelperRoutes(app,fixtureAuth);
    app.get('/normal',require('../server/auth').authMiddleware,(_req,res)=>res.json({ok:true}));
    require('../server/routes/mcp/local-connector').mountLocalConnectorRoutes(app,fixtureAuth);
    app.get('/fixture',(_req,res)=>res.send('<!doctype html><title>助手浏览器验收</title>'));
    app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const origin='http://127.0.0.1:'+server.address().port;
    let deviceId,pair,connected,secondUser,secondPair,secondDevice,browser,page;
    try{
        browser=await require('playwright').chromium.launch({headless:true});page=await browser.newPage();
        await page.context().addCookies([{name:'pivot_device_id',value:cookie.slice('pivot_device_id='.length),url:origin}]);
        await page.goto(origin+'/fixture');await page.addScriptTag({path:path.resolve('client/chat/pivot-core.js')});
        await page.evaluate(userId=>{window.API_BASE='';window.apiFetch=(url,options)=>fetch(url,options);window.Pivot.legacy.currentUser={id:userId};},user.id);
        await page.addScriptTag({path:path.resolve('client/chat/local-helper.js')});
        pair=await page.evaluate(()=>window.Pivot.moduleApi('local.helper').create());
        assert.ok(pair.code);
        // 助手使用 /api 路径，测试装置保留相同路径语义。
        const originalFetch=fetch;
        const transport=(url,options)=>originalFetch(String(url).replace('/api/mcp/','/mcp/'),options);
        connected=createHelperRuntime({request:transport,approve:async()=>true,execute:async()=>({controls:[],verified:true})});
        await connected.pair(origin,pair.code);deviceId=connected.status().deviceId;
        await assert.rejects(()=>helper.offer(pair.code));
        const scopedToken=connected.snapshot().connection.token;
        assert.equal((await fetch(origin+'/normal',{headers:{Authorization:'Bearer '+scopedToken}})).status,401);
        const denied=await fetch(origin+'/mcp/helper/challenge',{method:'POST',headers:{Authorization:'Bearer '+scopedToken+'wrong','Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
        await connected.authorize({windowTitle:'合成验收窗口',processName:'fixture.exe'});
        const browserStatus=await page.evaluate(()=>window.Pivot.moduleApi('local.helper').status());assert.equal(browserStatus.provider,'helper');assert.equal(browserStatus.deviceId,deviceId);
        const c=connected.snapshot().connection;
        const challengeResponse=await transport(origin+'/api/mcp/helper/challenge',{method:'POST',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:'{}'});
        const challenge=await challengeResponse.json(),payload={};
        const signature=crypto.sign(null,Buffer.from(helper.channelPayload(challenge.nonce,'status',payload)),c.privateKey).toString('base64');
        const signedBody=JSON.stringify({action:'status',payload,nonce:challenge.nonce,signature});
        const signedOptions={method:'POST',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:signedBody};
        assert.equal((await transport(origin+'/api/mcp/helper/channel',signedOptions)).status,200);
        assert.equal((await transport(origin+'/api/mcp/helper/channel',signedOptions)).status,409);
        const task=await runWithRequestContext({},async()=>{getRequestContext().helperBrowserKey=browserKey;return connector.createConnectorTask('desktop.inspect',{deviceId},user);});
        const result=await connector.waitForConnectorTask(task.id,user,10000).catch(error=>{throw new Error(error.message+' 助手状态：'+connected.status().status);});assert.equal(result.verified,true);
        await assert.rejects(()=>connector.createConnectorTask('desktop.inspect',{deviceId},user),{code:'LOCAL_HELPER_BINDING_REQUIRED'});
        await page.evaluate(()=>window.Pivot.moduleApi('local.helper').revoke());
        assert.equal(await helper.repository.activeDevice(user.id,browserKey,deviceId),null);
        await connected.disconnect();
        assert.equal(connected.status().paired,false);assert.equal(connected.status().grant,null);
        assert.equal((await transport(origin+'/api/mcp/helper/challenge',{method:'POST',headers:{Authorization:'Bearer '+scopedToken,'Content-Type':'application/json'},body:'{}'})).status,403);
        secondUser=await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'unused','user','active') RETURNING *",['helper-switch-'+crypto.randomBytes(6).toString('hex')]);
        const secondReq={headers:{cookie:'pivot_device_id='+crypto.randomBytes(24).toString('base64url')}};
        secondPair=await helper.create(secondUser,secondReq);
        await connected.pair(origin,secondPair.code);secondDevice=connected.status().deviceId;
        assert.notEqual(secondDevice,deviceId);assert.equal(connected.status().grant,null);assert.equal(connected.status().account,secondUser.username);
        await assert.rejects(()=>helper.touchBrowser(user,req,{id:secondPair.id,binding:secondPair.binding}));
        const secondKey=helper.helperBrowserKey(secondReq,secondUser);
        assert.ok(await helper.repository.activeDevice(secondUser.id,secondKey,secondDevice));
        await execute("UPDATE web_local_helper_pairs SET browser_seen_at=NOW()-INTERVAL '1 minute' WHERE id=?",[secondPair.id]);
        assert.equal(await helper.repository.activeDevice(secondUser.id,secondKey,secondDevice),null);
        const secondToken=connected.snapshot().connection.token;
        const offlineChallenge=await transport(origin+'/api/mcp/helper/challenge',{method:'POST',headers:{Authorization:'Bearer '+secondToken,'Content-Type':'application/json'},body:'{}'});assert.equal(offlineChallenge.status,200);
        await execute('UPDATE users SET token_version=COALESCE(token_version,0)+1 WHERE id=?',[secondUser.id]);
        assert.equal((await transport(origin+'/api/mcp/helper/challenge',{method:'POST',headers:{Authorization:'Bearer '+secondToken,'Content-Type':'application/json'},body:'{}'})).status,403);
        await connected.disconnect();
    }finally{
        if(connected)await connected.disconnect(false);
        if(browser)await browser.close();
        for(const current of [pair,secondPair])if(current?.id)await execute('DELETE FROM web_local_helper_pairs WHERE id=?',[current.id]);
        for(const device of [deviceId,secondDevice])if(device){await execute('DELETE FROM agent_local_connector_tasks WHERE device_id=?',[device]);await execute('DELETE FROM agent_local_connector_grants WHERE device_id=?',[device]);await execute('DELETE FROM agent_local_device_nonces WHERE device_id=?',[device]);await execute('DELETE FROM agent_local_devices WHERE device_id=?',[device]);}
        if(secondUser)await execute('DELETE FROM users WHERE id=?',[secondUser.id]);
        server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    }
});

test('普通浏览器退出会撤销配对，助手凭据不能作为普通账号令牌',{skip:!process.env.DATABASE_URL},async()=>{
    const auth=require('../server/auth'),{createAuthRouter}=require('../server/routes/auth');
    const user=await queryOne('SELECT * FROM users ORDER BY id LIMIT 1'),deviceCookie=crypto.randomBytes(24).toString('base64url');
    const cookie=`pivot_device_id=${deviceCookie}; ${auth.AUTH_COOKIE_NAME}=${auth.generateAccessToken(user,{sessionIp:'127.0.0.1'})}`;
    const app=express();app.use(express.json());app.use((req,_res,next)=>runWithRequestContext({},next));
    const pass=(_req,_res,next)=>next();
    app.use('/api',createAuthRouter({authMiddleware:auth.authMiddleware,loginLimiter:pass,registerLimiter:pass,isPublicRegistrationEnabled:()=>false,logAction:()=>{},publicUrl:''}));
    app.get('/api/normal',auth.authMiddleware,(_req,res)=>res.json({ok:true}));
    app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),origin='http://127.0.0.1:'+server.address().port;
    let pair;
    try{
        pair=await helper.create(user,{headers:{cookie}});
        assert.equal((await fetch(origin+'/api/normal',{headers:{cookie}})).status,200);
        const logout=await fetch(origin+'/api/auth/logout',{method:'POST',headers:{cookie}});assert.equal(logout.status,200);
        await assert.rejects(()=>helper.offer(pair.code));
        const normal=await fetch(origin+'/api/normal',{headers:{Authorization:'Bearer '+crypto.randomBytes(32).toString('base64url')}});assert.equal(normal.status,401);
    }finally{if(pair)await execute('DELETE FROM web_local_helper_pairs WHERE id=?',[pair.id]);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('未确认的远程 HTTP 仍被拒绝，地址不接受用户信息和额外路径',()=>{
    const {endpoint}=require('../desktop/helper/runtime');
    assert.equal(endpoint('https://pivot.example/'),'https://pivot.example');
    for(const url of ['http://remote.example','https://user:pass@pivot.example/','https://pivot.example/api','file:///tmp'])assert.throws(()=>endpoint(url));
});

test('异步执行从持久任务恢复助手绑定，覆盖外部上下文且并发任务互不污染',async()=>{
    const wrap=require('../server/services/agent-runtime/helper-context').withHelperBrowserContext;
    const run=wrap(async()=>{await Promise.resolve();return getRequestContext().helperBrowserKey;},async id=>({helper_browser_key:id==='first'?'a'.repeat(64):null}));
    const values=await runWithRequestContext({helperBrowserKey:'forged'},()=>Promise.all([run('first',{id:1}),run('second',{id:1})]));
    assert.deepEqual(values,['a'.repeat(64),'']);
});

test('后台任务只持久化服务端浏览器绑定，不接受调用方伪造的绑定元数据',{skip:!process.env.DATABASE_URL},async()=>{
    const user=await queryOne('SELECT * FROM users ORDER BY id LIMIT 1'),ids=[];
    const model=await queryOne("INSERT INTO models(user_id,name,url,model_name,status) VALUES (?,'助手任务绑定','https://example.invalid/v1/chat/completions','helper-test','active') RETURNING id",[user.id]);
    const create=require('../server/services/agent-runtime/run-creation').createAgentRunFactory();
    const input={user,modelId:model.id,goal:'读取已授权本机窗口',metadata:{autoPersonalSkill:false,helperBrowserKey:'f'.repeat(64)}};
    try{
        const noBinding=await create(input);ids.push(noBinding.id);assert.equal(noBinding.helper_browser_key,null);
        const bound=await runWithRequestContext({helperBrowserKey:'a'.repeat(64)},()=>create(input));ids.push(bound.id);
        assert.equal(bound.helper_browser_key,'a'.repeat(64));
    }finally{for(const id of ids)await execute('DELETE FROM agent_runs WHERE id=?',[id]);await execute('DELETE FROM models WHERE id=?',[model.id]);}
});

test('重新配对撤销旧码，过期配对被拒绝且并发兑换只成功一次',{skip:!process.env.DATABASE_URL},async()=>{
    const user=await queryOne('SELECT * FROM users ORDER BY id LIMIT 1'),req={headers:{cookie:'pivot_device_id='+crypto.randomBytes(24).toString('base64url')}};
    const ids=[],devices=[];
    try{
        const first=await helper.create(user,req);ids.push(first.id);
        const expired=await helper.create(user,req);ids.push(expired.id);await assert.rejects(()=>helper.offer(first.code));
        await execute("UPDATE web_local_helper_pairs SET expires_at=NOW()-INTERVAL '1 second' WHERE id=?",[expired.id]);await assert.rejects(()=>helper.offer(expired.code));
        const pair=await helper.create(user,req);ids.push(pair.id);const offer=await helper.offer(pair.code);
        const keys=crypto.generateKeyPairSync('ed25519'),deviceId='webhelper-'+crypto.randomBytes(16).toString('hex');devices.push(deviceId);
        const publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString(),signature=crypto.sign(null,Buffer.from(`helper-pair:${pair.id}:${offer.nonce}:${deviceId}`),keys.privateKey).toString('base64');
        const values=await Promise.allSettled([helper.exchange({code:pair.code,deviceId,publicKey,signature}),helper.exchange({code:pair.code,deviceId,publicKey,signature})]);
        assert.equal(values.filter(item=>item.status==='fulfilled').length,1);
        await helper.repository.revoke(user.id,{id:pair.id});
    }finally{for(const id of ids)await execute('DELETE FROM web_local_helper_pairs WHERE id=?',[id]);for(const device of devices)await execute('DELETE FROM agent_local_devices WHERE device_id=?',[device]);}
});
