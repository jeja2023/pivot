"""离线绘图服务错误边界回归。"""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

import httpx

spec = importlib.util.spec_from_file_location("offline_tools_app", Path(__file__).resolve().parents[2] / "docker/offline-tools/app.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class FailingClient:
    def __init__(self, error):
        self.error = error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def stream(self, *_args, **_kwargs):
        raise self.error


class DiagramTests(unittest.IsolatedAsyncioTestCase):
    async def test_timeout_has_actionable_message(self):
        with patch.object(app.httpx, "AsyncClient", return_value=FailingClient(httpx.ReadTimeout(""))):
            with self.assertRaisesRegex(ValueError, "响应超时"):
                await app.render_diagram("graph TD; A-->B")

    async def test_network_failure_has_actionable_message(self):
        with patch.object(app.httpx, "AsyncClient", return_value=FailingClient(httpx.ConnectError(""))):
            with self.assertRaisesRegex(ValueError, "无法连接"):
                await app.render_diagram("digraph G { A -> B }", "graphviz")


if __name__ == "__main__":
    unittest.main()
