"""Pivot 内置语音进程：动态回环端口、父进程退出清理，模型只加载一次。"""
from contextlib import asynccontextmanager
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time

REQUIRED_PACKAGES = ["torch", "torchaudio", "numpy", "fastapi", "uvicorn", "funasr", "silero_vad", "transformers", "websockets"]


def parent_reader():
    if os.name != "nt":
        return lambda: sys.stdin.buffer.read(1)
    # 避免阻塞读取 stdin 与 Windows SciPy/Fortran DLL 初始化互锁。
    # 专用管道只用于保活，非阻塞探测断开即可，无需消费输入。
    import ctypes
    from ctypes import wintypes
    import msvcrt
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    peek_pipe = kernel.PeekNamedPipe
    peek_pipe.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                          ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
                          ctypes.POINTER(wintypes.DWORD)]
    peek_pipe.restype = wintypes.BOOL
    handle = msvcrt.get_osfhandle(sys.stdin.fileno())

    def read():
        time.sleep(0.25)
        return bool(peek_pipe(handle, None, 0, None, None, None))

    return read


def report_failure(code, missing=None):
    print("PIVOT_SPEECH_ERROR " + json.dumps({"code": code, "missing": missing or []}), flush=True)


def check_runtime():
    missing = [name for name in REQUIRED_PACKAGES if importlib.util.find_spec(name) is None]
    if missing:
        report_failure("VOICE_EMBEDDED_DEPENDENCY_MISSING", missing)
        return False
    for name in ["SPEECH_MODEL_DIR", "SPEECH_STREAM_MODEL_DIR", "SPEECH_PUNC_MODEL_DIR"]:
        directory = Path(os.environ.get(name, ""))
        if not os.environ.get(name) or any(not (directory / file).is_file() for file in ["model.pt", "config.yaml"]):
            report_failure("VOICE_EMBEDDED_MODEL_MISSING")
            return False
    return True


def main():
    if not check_runtime():
        return 1
    try:
        import uvicorn
        from app import create_app
    except ModuleNotFoundError as error:
        report_failure("VOICE_EMBEDDED_DEPENDENCY_MISSING", [str(error.name).split(".")[0]])
        return 1
    except Exception:
        report_failure("VOICE_EMBEDDED_LOAD_FAILED")
        return 1
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    listener.set_inheritable(True)
    application = create_app()
    original_lifespan = application.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        try:
            async with original_lifespan(app):
                print("PIVOT_SPEECH_READY " + json.dumps({"port": listener.getsockname()[1],
                      "streaming": app.state.engine.streaming}), flush=True)
                yield
        except ModuleNotFoundError as error:
            report_failure("VOICE_EMBEDDED_DEPENDENCY_MISSING", [str(error.name).split(".")[0]])
            raise
        except Exception:
            report_failure("VOICE_EMBEDDED_LOAD_FAILED")
            raise

    application.router.lifespan_context = lifespan
    server = uvicorn.Server(uvicorn.Config(application, host="127.0.0.1", workers=1,
        access_log=False, log_level="error", ws_max_size=65536, timeout_graceful_shutdown=3))
    read_parent = parent_reader()

    def watch_parent():
        # 该专用 stdin 只用于保活；父进程崩溃或正常关闭都会触发 EOF。
        try:
            while read_parent():
                pass
        finally:
            server.should_exit = True
            # 模型初始化或本地算子阻塞时，父进程已退出也不能遗留孤儿进程。
            deadline = threading.Timer(5, lambda: os._exit(0))
            deadline.daemon = True
            deadline.start()

    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        server.run(sockets=[listener])
    finally:
        listener.close()


if __name__ == "__main__":
    sys.exit(main())
