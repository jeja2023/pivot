'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { sanitizeSvg } = require('../server/services/document-rendering/image-renderer');

test('隔离 Docker 内认证 MCP 扫描和真实 Mermaid、Graphviz 生成安全 SVG', { skip: !process.env.PIVOT_OFFLINE_TOOLS_CONTAINER && '需要鉴权工具与 Kroki/Mermaid 容器；运行 npm run test:offline-tools:integration 补测。', timeout: 150000 }, async () => {
    const script = `
import asyncio,json
from pathlib import Path
import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
async def main():
 token=Path('/run/secrets/offline_tools_token').read_text().strip()
 async with httpx.AsyncClient() as client:
  anonymous=await client.post('http://127.0.0.1:8501/mcp',json={})
  print(json.dumps({'anonymous':anonymous.status_code}),flush=True)
 async with streamablehttp_client('http://127.0.0.1:8501/mcp',headers={'Authorization':'Bearer '+token},timeout=65) as (read,write,_):
  async with ClientSession(read,write) as session:
   await session.initialize()
   for name,args in [('run_ast_audit',{'source_code':'import os as o\\no.system(value)'}),('render_diagram',{'source':'graph TD; A-->B','diagram_type':'mermaid'}),('render_diagram',{'source':'digraph G { A -> B }','diagram_type':'graphviz'})]:
    result=await session.call_tool(name,args)
    print(json.dumps({'name':name,'type':args.get('diagram_type'),'isError':result.isError,'data':result.structuredContent,'error':[c.text for c in result.content] if result.isError else []}),flush=True)
asyncio.run(main())`;
    const output = await new Promise((resolve, reject) => {
        const child = spawn('docker', ['exec', '-i', process.env.PIVOT_OFFLINE_TOOLS_CONTAINER, 'python', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-2000))));
        child.stdin.end(script);
    });
    const lines = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(lines[0].anonymous, 401);
    assert.equal(lines.length, 4);
    for (const result of lines.slice(1)) {
        assert.equal(result.isError, false, JSON.stringify(result.error));
        const artifact = result.data.pivotArtifact;
        if (artifact.kind === 'audit') assert.equal(artifact.data.issues_count, 1);
        else assert.match(sanitizeSvg(artifact.svg), /<svg/);
    }
});
