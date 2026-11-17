'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {isolatedStorageEnvironment}=require('../scripts/test_support/test-environment');

test('测试存储覆盖所有显式业务目录，数据库备份不能退回 public',()=>{
    const root=path.resolve('test-fixture-only');
    const values=isolatedStorageEnvironment(root,'pivot_test_isolation');
    assert.equal(values.DB_BACKUP_SCHEMA,'pivot_test_isolation');
    for(const [key,value]of Object.entries(values)){
        if(key==='DB_BACKUP_SCHEMA')continue;
        const relative=path.relative(root,value);
        assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),key);
    }
    for(const key of ['DATA_DIR','PIVOT_UPLOAD_DIR','UPLOAD_DIR','PIVOT_ARTIFACT_CAS_DIR','PIVOT_DOCUMENT_PROCESSING_DIR','AGENT_BLOB_DIR','PIVOT_RUNTIME_PACK_ROOT','AGENT_SKILL_ROOT','DB_BACKUP_DIR'])assert.ok(values[key]);
    assert.throws(()=>isolatedStorageEnvironment('relative','public'),/受控绝对目录/);
    assert.throws(()=>isolatedStorageEnvironment(root,'public'),/专用 Schema/);
});
