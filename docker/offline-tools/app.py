"""带身份验证、大小上限与进程隔离的离线 MCP 服务。"""
import asyncio
import hmac
import json
import os
from pathlib import Path
import sys
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import JSONResponse
import uvicorn
import httpx

ROOT = Path(__file__).resolve().parent
mcp = FastMCP("pivot-offline-tools", host="0.0.0.0", stateless_http=True, json_response=True,
              transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=True,
                  allowed_hosts=["offline-tools:8501", "127.0.0.1:*", "localhost:*"], allowed_origins=[]))
slots = asyncio.Semaphore(2)


@mcp.tool()
async def render_diagram(source: str, diagram_type: str = "mermaid") -> dict[str, Any]:
    """将 Mermaid、PlantUML 或 Graphviz 文本转换成受控矢量图产物。"""
    if diagram_type not in {"mermaid", "plantuml", "graphviz"} or not source.strip() or len(source.encode()) > 65536:
        raise ValueError("图形类型不支持、源码为空或超过 64 KiB。")
    try:
        async with slots, httpx.AsyncClient(timeout=45, trust_env=False, follow_redirects=False) as client:
            async with client.stream("POST", f"http://kroki:8000/{diagram_type}/svg", params={"flowchart_html-labels": "false", "html-labels": "false"}, content=source.encode(),
                                     headers={"Content-Type": "text/plain", "Accept": "image/svg+xml"}) as response:
                if response.status_code != 200 or not response.headers.get("content-type", "").startswith("image/svg+xml"):
                    raise ValueError("离线绘图引擎返回失败或不支持的内容类型。")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 1048576:
                        raise ValueError("图形输出超过 1 MiB。")
    except httpx.TimeoutException as error:
        raise ValueError("离线绘图引擎响应超时，请检查绘图服务是否就绪。") from error
    except httpx.RequestError as error:
        raise ValueError("无法连接离线绘图引擎，请检查服务和内部网络。") from error
    return {"pivotArtifact": {"kind": "diagram", "svg": body.decode("utf-8")}}


@mcp.tool()
async def run_ast_audit(source_code: str, file_name: str = "inline.py") -> dict[str, Any]:
    """只检查 Python 源码中的有限危险调用规则，不执行源码，不提供合规保证。"""
    if len(source_code.encode("utf-8")) > 262144:
        raise ValueError("源码超过 256 KiB 限制。")
    async with slots:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-I", str(ROOT / "worker.py"), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            output, _ = await asyncio.wait_for(process.communicate(json.dumps(
                {"source_code": source_code, "file_name": file_name}, ensure_ascii=True).encode()), timeout=5)
            if process.returncode or len(output) > 1048576:
                raise ValueError("扫描进程失败或输出超限。")
            result = json.loads(output)
            return {**result, "pivotArtifact": {"kind": "audit", "data": result}}
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()


class AuthenticatedApp:
    def __init__(self, app, token):
        if len(token) < 32:
            raise ValueError("离线工具服务密钥至少需要 32 个字符。")
        self.app, self.token = app, token.encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if scope["path"] == "/health" and scope["method"] == "GET":
            return await JSONResponse({"status": "ok"})(scope, receive, send)
        headers = dict(scope["headers"])
        supplied = headers.get(b"authorization", b"")
        if not hmac.compare_digest(supplied, b"Bearer " + self.token):
            return await JSONResponse({"error": "工具服务身份验证失败。"}, status_code=401)(scope, receive, send)
        # 完整读取有限请求后再交给 SDK，流式分块也受同一上限约束。
        body = bytearray()
        while True:
            try:
                event = await asyncio.wait_for(receive(), timeout=10)
            except TimeoutError:
                return await JSONResponse({"error": "请求读取超时。"}, status_code=408)(scope, receive, send)
            if event["type"] == "http.disconnect":
                return
            body.extend(event.get("body", b""))
            if len(body) > 524288:
                return await JSONResponse({"error": "请求体超过限制。"}, status_code=413)(scope, receive, send)
            if not event.get("more_body", False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()
        await self.app(scope, replay, send)


def create_app(token):
    return AuthenticatedApp(mcp.streamable_http_app(), token)


if __name__ == "__main__":
    token_file = os.environ.get("PIVOT_TOOLS_TOKEN_FILE", "/run/secrets/offline_tools_token")
    secret = Path(token_file).read_text(encoding="utf-8").strip()
    uvicorn.run(create_app(secret), host="0.0.0.0", port=8501, access_log=False, limit_concurrency=16)
