"""每次扫描使用独立进程，避免复杂语法树阻塞 MCP 服务。"""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audit import audit_source

try:
    payload = json.loads(sys.stdin.buffer.read(524289))
    result = audit_source(**payload)
except (ValueError, TypeError, RecursionError, MemoryError):
    result = {"status": "not_scanned", "reason": "输入无效或超过扫描资源限制。"}
sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode())
