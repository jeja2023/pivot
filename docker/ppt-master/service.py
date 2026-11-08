"""PPT Master独立内网服务；只开放受控制作协议，不接收任意命令。"""
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import threading
import time
from urllib.parse import urlsplit

from service_jobs import Jobs, ServiceError


def runtime_identity():
    digest = hashlib.sha256()
    for file in sorted(Path("/runner").glob("*.py")) + sorted(Path("/runner").glob("*requirements.lock")) + [Path("/runner/engine-lock.json"), Path("/engine/manifest.json")]:
        digest.update(file.name.encode())
        digest.update(file.read_bytes())
    return "sha256:" + digest.hexdigest()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 32

    def __init__(self, address, jobs, token, health):
        self.jobs, self.token, self.health = jobs, token, health
        self.requests = threading.BoundedSemaphore(32)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.requests.acquire(blocking=False):
            request.close()
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.requests.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "PPTMasterService/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def send(self, status, data, binary=False):
        encoded = data if binary else json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream" if binary else "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        if binary:
            self.send_header("X-Content-SHA256", hashlib.sha256(encoded).hexdigest())
        self.end_headers()
        self.wfile.write(encoded)
        self.close_connection = True

    def body(self, maximum, json_body=False):
        if self.headers.get("Transfer-Encoding") or not re.fullmatch(r"[0-9]{1,10}", self.headers.get("Content-Length", "")):
            raise ServiceError("请求必须提供明确长度，不能使用分块传输。", 411)
        length = int(self.headers["Content-Length"])
        if length > maximum:
            raise ServiceError("请求内容超过上限。", 413)
        data = self.rfile.read(length)
        if len(data) != length:
            raise ServiceError("请求尚未完整传输。")
        if not json_body:
            return data
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            raise ServiceError("请求必须使用JSON。", 415)
        try:
            value = json.loads(data)
        except (ValueError, UnicodeDecodeError):
            raise ServiceError("请求JSON无效。") from None
        if not isinstance(value, dict):
            raise ServiceError("请求JSON必须是对象。")
        return value

    def route(self, method):
        path = urlsplit(self.path)
        if path.query or path.fragment or "%" in path.path or len(path.path) > 400:
            raise ServiceError("请求路径无效。")
        if path.path == "/healthz" and method == "GET":
            return {"ready": not self.server.jobs.stop.is_set(), "serviceProtocol": 1}
        authorization = self.headers.get("Authorization", "")
        if not hmac.compare_digest(authorization.encode(), ("Bearer " + self.server.token).encode()):
            raise ServiceError("服务访问密钥无效。", 401, "PPT_SERVICE_UNAUTHORIZED")
        if path.path == "/v1/info" and method == "GET":
            return self.server.health
        match = re.fullmatch(r"/v1/jobs/([a-f0-9]{64})(?:/(inputs|outputs|operations)(?:/([A-Za-z0-9_.-]+))?(?:/(cancel))?)?", path.path)
        if not match:
            raise ServiceError("接口不存在。", 404)
        key, kind, name, cancel = match.groups()
        jobs = self.server.jobs
        if kind is None:
            if method == "POST":
                request = self.body(4096, True)
                if set(request) != {"runtimeId"} or request["runtimeId"] != jobs.runtime_id:
                    raise ServiceError("制作服务已更新，请重新创建任务。", 409, "PPT_SERVICE_RUNTIME_CHANGED")
                return jobs.open(key)
            if method == "DELETE":
                return jobs.delete(key)
        if kind == "inputs" and name and not cancel:
            if method == "PUT":
                return jobs.put_input(key, name, self.body(50 * 1024**2))
            if method == "GET":
                return jobs.input(key, name)
        if kind == "outputs" and name and not cancel and method == "GET":
            return jobs.output(key, name)
        if kind == "operations" and name and method == "POST":
            if cancel:
                self.body(4096)
                return jobs.cancel(key, name)
            request = self.body(1024**2, True)
            if set(request) != {"runtimeId", "operation"}:
                raise ServiceError("制作请求含未登记字段。")
            return jobs.execute(key, name, request["runtimeId"], request["operation"])
        raise ServiceError("操作未登记。", 405)

    def handle_method(self, method):
        try:
            result = self.route(method)
            self.send(200, result, isinstance(result, bytes))
        except ServiceError as error:
            self.send(error.status, {"error": {"code": error.code, "message": str(error)}})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:
            self.send(500, {"error": {"code": "PPT_SERVICE_FAILED", "message": "制作服务未完成本次操作，请检查服务状态后重试。"}})

    def do_GET(self):
        self.handle_method("GET")

    def do_POST(self):
        self.handle_method("POST")

    def do_PUT(self):
        self.handle_method("PUT")

    def do_DELETE(self):
        self.handle_method("DELETE")


def main():
    token_file = os.environ.get("PPT_MASTER_TOKEN_FILE")
    token = Path(token_file).read_text().strip() if token_file else os.environ.get("PPT_MASTER_TOKEN", "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
        raise RuntimeError("请配置至少32位的PPT_MASTER_TOKEN服务密钥。")
    runtime = runtime_identity()
    jobs = Jobs(os.environ.get("PPT_MASTER_DATA_DIR", "/data/jobs"), runtime)
    probe_key = "0" * 64
    jobs.open(probe_key)
    try:
        health = jobs.execute(probe_key, "0" * 32, runtime, {"action": "health"})
        if not health.get("ok") or health.get("result", {}).get("status") != "ready":
            raise RuntimeError("制作运行包启动检查失败，请检查镜像。")
        health = {**health["result"], "runtimeId": runtime, "serviceProtocol": 1, "version": json.loads(Path("/runner/engine-lock.json").read_text())["skillVersion"],
                  "capabilities": ["files", "operations", "cancel", "native", "templates"], "network": "worker_network_denied"}
    finally:
        jobs.delete(probe_key)
    # 完整包在只读镜像启动时已校验；任务健康查询复用同一运行身份的结果。
    jobs.verified_health = health
    server = Server(("0.0.0.0", int(os.environ.get("PPT_MASTER_PORT", "8502"))), jobs, token, health)

    def shutdown(_signal, _frame):
        jobs.shutdown()
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    def cleanup():
        while not jobs.stop.wait(600):
            jobs.cleanup()
    threading.Thread(target=cleanup, daemon=True).start()
    print("PPT Master独立服务已就绪。", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        jobs.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
