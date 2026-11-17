'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../server/db/client');
const { register, login } = require('../server/auth');

test('管理员删除与密码重置在中途失败时原子回滚全部已写入状态', async () => {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const user = await register('atomic_'+crypto.randomBytes(5).toString('hex'),'Pivot-Atomic-123!','事务回归','QA');
    const session='atomic_'+crypto.randomUUID();
    await login(user.username,'Pivot-Atomic-123!',{clientIp:'127.0.0.1'});
    await db.execute('INSERT INTO sessions(id,user_id,title) VALUES (?,?,?)',[session,user.id,'事务回归']);
    const before=await db.queryOne('SELECT password_hash,token_version FROM users WHERE id=?',[user.id]);
    const routePath=require.resolve('../server/routes/admin-users');
    const cached=require.cache[routePath];
    const original=db.transaction;
    let failPattern;
    db.transaction=fn=>original(trx=>fn({...trx,execute:async(sql,params)=>{
        if(failPattern.test(sql)) throw new Error('模拟中途写入故障');
        return trx.execute(sql,params);
    }}));
    delete require.cache[routePath];
    try {
        const pass=(_req,_res,next)=>next();
        const router=require('../server/routes/admin-users').createAdminUsersRouter({authMiddleware:pass,adminMiddleware:pass,upload:{single:()=>pass},logAction(){}});
        const invoke=(path,method,body={})=>new Promise((resolve,reject)=>{
            const handlers=router.stack.find(layer=>layer.route?.path===path&&layer.route.methods[method]).route.stack;
            handlers.at(-1).handle({params:{id:String(user.id)},body,user:{id:1,username:'admin',role:'admin'}},{status(){return this;},json:resolve},reject);
        });
        for(const pattern of [/UPDATE messages/, /UPDATE users SET username/]){
            failPattern=pattern;
            await assert.rejects(invoke('/admin/users/:id','delete'),/模拟中途/);
            const current=await db.queryOne('SELECT username,deleted_at,status FROM users WHERE id=?',[user.id]);
            assert.equal(current.username,user.username);assert.equal(current.deleted_at,null);assert.equal(current.status,'active');
            assert.equal((await db.queryOne('SELECT deleted_at FROM sessions WHERE id=?',[session])).deleted_at,null);
            assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id=?',[user.id])).n,1);
        }
        failPattern=/DELETE FROM refresh_tokens/;
        await assert.rejects(invoke('/admin/users/:id/password','post',{password:'New-Atomic-Password-234!'}),/模拟中途/);
        assert.deepEqual(await db.queryOne('SELECT password_hash,token_version FROM users WHERE id=?',[user.id]),before);
    }finally{
        db.transaction=original;
        if(cached)require.cache[routePath]=cached;else delete require.cache[routePath];
        await db.execute('DELETE FROM refresh_tokens WHERE user_id=?',[user.id]);
        await db.execute('DELETE FROM sessions WHERE user_id=?',[user.id]);
        await db.execute('DELETE FROM users WHERE id=?',[user.id]);
    }
});
