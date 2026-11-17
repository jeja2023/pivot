'use strict';
/* global navigator, window -- 浏览器测试回调在页面上下文运行。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

test('多标签页共享刷新与 CSRF 状态，HTTP 的 IndexedDB 回退同样只轮换一次', async () => {
    const app=express();let refreshes=0;
    app.get('/',(_req,res)=>res.type('html').send('<!doctype html><script>window.Pivot={legacy:{}};</script><script src="/coordinator.js"></script><script src="/config.js"></script>'));
    app.get('/coordinator.js',(_req,res)=>res.sendFile(path.resolve('client/chat/auth-session-coordinator.js')));
    app.get('/config.js',(_req,res)=>res.sendFile(path.resolve('client/chat/config.js')));
    app.get('/api/auth/me',(req,res)=>res.json({authenticated:req.headers.cookie?.includes('audit_access=fresh')===true,csrfToken:'x'.repeat(32)}));
    app.post('/api/auth/refresh',async(req,res)=>{
        refreshes++;await new Promise(resolve=>setTimeout(resolve,50));
        if(refreshes>1)return res.status(401).json({error:'重复轮换'});
        res.cookie('audit_access','fresh');res.cookie('pivot_csrf_token','x'.repeat(32));res.json({csrfToken:'x'.repeat(32)});
    });
    const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
    const browser=await chromium.launch({headless:true});
    try{
        for(const fallback of [false,true]){
            refreshes=0;const context=await browser.newContext();
            if(fallback)await context.addInitScript(()=>Object.defineProperty(navigator,'locks',{value:undefined}));
            const pages=await Promise.all([context.newPage(),context.newPage()]);
            await Promise.all(pages.map(page=>page.goto(`http://127.0.0.1:${server.address().port}`)));
            await Promise.all(pages.map(page=>page.evaluate(()=>window.Pivot.api.refreshAccessToken())));
            assert.equal(refreshes,1);
            for(const page of pages)assert.equal(await page.evaluate(()=>window.Pivot.api.authHeaders()['X-CSRF-Token']),'x'.repeat(32));
            await context.close();
        }
    }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});

test('附件读取后切换账号必须重新鉴权，浏览器不得复用受控正文', async () => {
    const {queryOne,execute}=require('../server/db/client');
    const crypto=require('node:crypto'),session=crypto.randomUUID();
    const user=await queryOne("INSERT INTO users(username,password_hash,role) VALUES (?,'fixture','user') RETURNING id",['cache_'+session]);
    const file=path.join(process.env.PIVOT_UPLOAD_DIR,String(user.id),session,'file.txt');
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'受控附件正文');
    await execute('INSERT INTO sessions(id,user_id,title) VALUES (?,?,?)',[session,user.id,'缓存测试']);
    await execute('INSERT INTO attachments(user_id,session_id,file_path,file_name) VALUES (?,?,?,?)',[user.id,session,`uploads/${user.id}/${session}/file.txt`,'file.txt']);
    const app=express(),pass=(_req,_res,next)=>next();let checks=0;
    app.get('/',(_req,res)=>res.type('html').send('<!doctype html>缓存测试'));
    app.use(require('../server/routes/attachments').createAttachmentsRouter({authMiddleware(req,res,next){checks++;if(req.headers.cookie==='identity=A'){req.user={id:user.id};next();}else res.status(403).end();},uploadLimiter:pass,upload:{single:()=>pass},normalizePage:x=>x,normalizeLimit:x=>x,logAction(){}}));
    const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
    const browser=await chromium.launch({headless:true});
    try{
        const context=await browser.newContext(),page=await context.newPage(),url=`http://127.0.0.1:${server.address().port}`;
        await context.addCookies([{name:'identity',value:'A',url}]);await page.goto(url);
        const target=`/uploads/${user.id}/${session}/file.txt`;
        assert.equal(await page.evaluate(async target=>(await fetch(target)).status,target),200);
        await context.addCookies([{name:'identity',value:'B',url}]);
        assert.equal(await page.evaluate(async target=>(await fetch(target)).status,target),403);
        assert.equal(checks,2);
    }finally{
        await browser.close();await new Promise(resolve=>server.close(resolve));
        await execute('DELETE FROM attachments WHERE session_id=?',[session]);await execute('DELETE FROM sessions WHERE id=?',[session]);await execute('DELETE FROM users WHERE id=?',[user.id]);
        await fs.unlink(file);
    }
});
