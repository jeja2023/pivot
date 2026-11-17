'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { queryOne, execute } = require('../server/db/client');

test('进程退出后的加密消费记录可恢复，重复恢复不重复计量，审计满载不丢弃', async () => {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    process.env.PIVOT_DB_WRITE_QUEUE_DISABLED = 'false';
    process.env.PIVOT_DB_AUDIT_QUEUE_MAX = '2';
    const id = crypto.randomUUID();
    const record = { deliveryId:id,userId:987654321,modelId:987654322,tokenCount:17,inputTokens:10,outputTokens:7,source:'恢复回归',createdAt:'2026-11-17 12:00:00' };
    const child = spawnSync(process.execPath,['-e',"require('./server/services/critical-write-journal').save('modelUsageEvents',JSON.parse(process.argv[1])).then(()=>process.exit(0)).catch(()=>process.exit(1))",JSON.stringify(record)],{cwd:path.resolve(__dirname,'..'),env:process.env,encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
    const file=path.join(process.env.DATA_DIR,'critical-write-journal','modelUsageEvents',id+'.json');
    assert.equal((await fs.readFile(file,'utf8')).includes('恢复回归'),false);
    const queue=require('../server/services/db-write-queue'),journal=require('../server/services/critical-write-journal');
    try {
        await queue.recoverCriticalWrites();await queue.flushAllWrites();
        await journal.save('modelUsageEvents',record);
        await queue.recoverCriticalWrites();await queue.flushAllWrites();
        assert.equal((await queryOne('SELECT COUNT(*) AS n FROM model_usage_events WHERE delivery_id=?',[id])).n,1);
        assert.equal((await queryOne('SELECT token_count FROM model_daily_consumption WHERE user_id=? AND model_id=?',[record.userId,record.modelId])).token_count,17);
        for(let index=0;index<5;index++)await queue.enqueueAuditLog({action:'恢复回归_'+id,details:String(index)});
        await queue.flushAllWrites();
        assert.equal((await queryOne('SELECT COUNT(*) AS n FROM audit_logs WHERE action=?',['恢复回归_'+id])).n,5);
        assert.equal(queue.getQueueDiagnostics().auditLogs.dropped,0);
        await assert.rejects(fs.access(file));
    }finally{
        await queue.flushAllWrites();
        await execute('DELETE FROM model_usage_events WHERE delivery_id=?',[id]);
        await execute('DELETE FROM model_daily_consumption WHERE user_id=?',[record.userId]);
        await execute('DELETE FROM audit_logs WHERE action=?',['恢复回归_'+id]);
    }
});

test('业务响应等待审计持久确认，失败时不返回成功正文', async () => {
    const {criticalWriteResponse,trackCriticalWrite}=require('../server/services/critical-write-response');
    for(const fail of [false,true]){
        let finish,body;
        const req={},res={end(value){body=value;},removeHeader(){},setHeader(){}};
        criticalWriteResponse(req,res,()=>{});
        const pending=new Promise((resolve,reject)=>{finish=()=>fail?reject(new Error('模拟存储失败')):resolve();});
        trackCriticalWrite(req,pending);res.end('成功');
        assert.equal(body,undefined);finish();await new Promise(resolve=>setImmediate(resolve));
        if(fail){assert.equal(res.statusCode,503);assert.match(body,/AUDIT_PERSISTENCE_UNAVAILABLE/);}
        else assert.equal(body,'成功');
    }
});
