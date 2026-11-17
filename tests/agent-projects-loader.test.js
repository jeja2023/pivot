'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');

test('项目模块迟到加载不能在切号或关闭后打开旧会话',async()=>{
    const modules={},listeners=new Map();let complete,opened=0;
    const pivot={legacy:{currentUser:{id:1}},exposeModule:(name,api)=>modules[name]=api,moduleApi:name=>modules[name],loadScriptOnce:()=>new Promise(resolve=>{complete=()=>{modules['agent.projects']={open:()=>opened++};resolve();};})};
    vm.runInNewContext(fs.readFileSync(path.resolve('client/chat/agent-projects-loader.js'),'utf8'),{window:{Pivot:pivot},document:{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}});
    const pending=modules['agent.projects'].open();modules['agent.projects'].reset();pivot.legacy.currentUser={id:2};complete();await pending;
    assert.equal(opened,0);assert.equal(listeners.has('click'),false);
});
