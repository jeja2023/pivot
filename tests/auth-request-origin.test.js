'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { allowsAuthRequestOrigin } = require('../server/services/auth-request-origin');

test('认证入口拒绝跨站表单及不透明来源，允许同源和原生请求', () => {
    const request = headers => ({ headers: { host: 'pivot.example:9006', ...headers }, socket: { remoteAddress: '10.1.2.3' } });
    assert.equal(allowsAuthRequestOrigin(request({ origin: 'http://pivot.example:9006' }), {}), true);
    for (const origin of ['https://attacker.example', 'null', 'http://pivot.example:9006.attacker.example', 'file://']) {
        assert.equal(allowsAuthRequestOrigin(request({ origin }), {}), false);
    }
    assert.equal(allowsAuthRequestOrigin(request({ 'sec-fetch-site': 'cross-site' }), {}), false);
    assert.equal(allowsAuthRequestOrigin(request({}), {}), true);
    assert.equal(allowsAuthRequestOrigin(request({ origin: 'https://public.example' }), { PUBLIC_URL: 'https://public.example' }), true);
    assert.equal(allowsAuthRequestOrigin(request({ origin: 'https://frontend.example' }), { CORS_ORIGIN: 'https://frontend.example' }), true);
    assert.equal(allowsAuthRequestOrigin(request({ origin: 'https://untrusted.invalid' }), { CORS_ORIGIN: '*' }), false);
});

test('只有登记的反向代理可提供认证来源转发头', () => {
    const previous = process.env.TRUSTED_PROXY_IPS;
    const req = { headers: { host: 'internal:3000', origin: 'https://external.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'external.example' }, socket: { remoteAddress: '10.2.3.4' } };
    try {
        process.env.TRUSTED_PROXY_IPS = '';
        assert.equal(allowsAuthRequestOrigin(req, {}), false);
        process.env.TRUSTED_PROXY_IPS = '10.2.3.4';
        assert.equal(allowsAuthRequestOrigin(req, {}), true);
    } finally { if (previous === undefined) delete process.env.TRUSTED_PROXY_IPS; else process.env.TRUSTED_PROXY_IPS = previous; }
});

test('真实认证写入口在解析跨站表单后仍拒绝访问，伪造 Bearer 不绕过来源门禁', async () => {
    const express=require('express'),app=express();let accepted=0;
    app.use(express.urlencoded({extended:false}));app.use('/api',require('../server/auth').csrfMiddleware);
    app.post('/api/auth/login',(_req,res)=>{accepted++;res.json({ok:true});});
    const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
    const url=`http://127.0.0.1:${server.address().port}`;
    try {
        for(const extra of [{},{Authorization:'Bearer fabricated'}]){
            const denied=await fetch(url+'/api/auth/login',{method:'POST',headers:{Origin:'https://untrusted.invalid','Content-Type':'application/x-www-form-urlencoded',...extra},body:'username=test&password=fixture'});
            assert.equal(denied.status,403);assert.equal((await denied.json()).code,'AUTH_ORIGIN_DENIED');
        }
        assert.equal(accepted,0);
        const allowed=await fetch(url+'/api/auth/login',{method:'POST',headers:{Origin:url,'Content-Type':'application/x-www-form-urlencoded'},body:'username=test'});
        assert.equal(allowed.status,200);assert.equal(accepted,1);
    }finally{await new Promise(resolve=>server.close(resolve));}
});
