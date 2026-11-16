'use strict';
const { asyncHandler } = require('../../http');
const rateLimit = require('express-rate-limit');
const helper = require('../../services/web-local-helper');
function mountWebLocalHelperRoutes(router,authMiddleware) {
    const limit = rateLimit({windowMs:60000,max:120,standardHeaders:true,legacyHeaders:false,message:{error:'助手请求过于频繁，请稍后重试。'}});
    router.use('/mcp/helper',limit,(_req,res,next) => {res.set('Cache-Control','no-store');next();});
    router.post('/mcp/helper/pairings',authMiddleware,asyncHandler(async(req,res)=>res.json(await helper.create(req.user,req))));
    router.post('/mcp/helper/touch',authMiddleware,asyncHandler(async(req,res)=>res.json(await helper.touchBrowser(req.user,req,req.body || {}))));
    router.get('/mcp/helper/pairings',authMiddleware,asyncHandler(async(req,res)=>res.json({pairs:await helper.repository.visible(req.user.id,helper.helperBrowserKey(req,req.user))})));
    router.post('/mcp/helper/revoke',authMiddleware,asyncHandler(async(req,res)=>{ const pair = (await helper.repository.visible(req.user.id,helper.helperBrowserKey(req,req.user))).find(row=>row.id===req.body?.id); if(!pair) throw helper.error('助手配对不存在。');res.json({revoked:await helper.repository.revoke(req.user.id,{id:pair.id})}); }));
    router.post('/mcp/helper/offer',asyncHandler(async(req,res)=>res.json(await helper.offer(req.body?.code))));
    router.post('/mcp/helper/exchange',asyncHandler(async(req,res)=>res.json(await helper.exchange(req.body || {}))));
    router.post('/mcp/helper/challenge',asyncHandler(async(req,res)=>res.json(await helper.challenge(req))));
    router.post('/mcp/helper/channel',asyncHandler(async(req,res)=>res.json(await helper.channel(req))));
}
module.exports={mountWebLocalHelperRoutes};
