"""启动预检不依赖真实模型或已安装的推理包。"""
import importlib.util
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "docker/speech-service/embedded_worker.py"
SPEC = importlib.util.spec_from_file_location("speech_embedded_worker", SOURCE)
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


class RuntimeCheckTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows 专用的保活管道回归")
    def test_windows_parent_pipe_allows_stdin_queries_and_detects_eof(self):
        script = textwrap.dedent("""
            import importlib.util, os, sys, threading, time
            spec = importlib.util.spec_from_file_location('worker', sys.argv[1])
            worker = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(worker)
            reader = worker.parent_reader()
            ended = threading.Event()
            def watch():
                while reader():
                    pass
                ended.set()
            threading.Thread(target=watch, daemon=True).start()
            time.sleep(0.35)
            # 原先的阻塞 CRT 读取会卡住另一个线程对 stdin 的查询。
            os.isatty(sys.stdin.fileno())
            print('READY', flush=True)
            if not ended.wait(10):
                raise RuntimeError('parent EOF was not detected')
            print('EOF', flush=True)
        """)
        with subprocess.Popen([sys.executable, "-u", "-c", script, str(SOURCE)],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True) as process, ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(process.stdout.readline)
            try:
                self.assertEqual(first.result(timeout=15).strip(), "READY")
                process.stdin.close()
                process.stdin = None
                output, errors = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, errors)
                self.assertEqual(output.strip(), "EOF")
            finally:
                if process.poll() is None:
                    process.kill()

    def test_missing_dependencies_report_safe_names(self):
        with patch.object(WORKER.importlib.util, "find_spec", return_value=None), patch.object(WORKER, "report_failure") as report:
            self.assertFalse(WORKER.check_runtime())
            code, missing = report.call_args.args
            self.assertEqual(code, "VOICE_EMBEDDED_DEPENDENCY_MISSING")
            self.assertIn("funasr", missing)
            self.assertIn("silero_vad", missing)

    def test_missing_models_have_specific_failure(self):
        with patch.object(WORKER.importlib.util, "find_spec", return_value=object()), patch.object(WORKER.os, "environ", {}), patch.object(WORKER, "report_failure") as report:
            self.assertFalse(WORKER.check_runtime())
            report.assert_called_once_with("VOICE_EMBEDDED_MODEL_MISSING")
