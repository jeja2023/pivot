"""独立服务的任务目录、输入快照、执行租约与取消。"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

KEY = re.compile(r"[a-f0-9]{64}\Z")
REQUEST = re.compile(r"[a-f0-9]{32}\Z")
ACTIONS = {"health", "read_runtime", "list", "read", "write", "run", "copy", "copy_template", "validate_template", "deliver_template", "deliver", "native_inspect", "native_patch", "native_video_prepare", "native_video_clip", "native_video_finish"}


class ServiceError(Exception):
    def __init__(self, message, status=400, code="PPT_SERVICE_INVALID"):
        super().__init__(message)
        self.status, self.code = status, code


def atomic(file, value):
    temporary = file.with_name(file.name + ".new")
    with temporary.open("x", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, file)


class Jobs:
    def __init__(self, root, runtime_id, concurrency=2, timeout=120):
        supplied_root = Path(root)
        if supplied_root.is_symlink():
            raise RuntimeError("服务数据目录不能是链接。")
        self.root = supplied_root.resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.runtime_id, self.timeout = runtime_id, timeout
        self.slots = threading.BoundedSemaphore(concurrency)
        self.active, self.guard = {}, threading.Lock()
        self.stop = threading.Event()
        self.verified_health = None

    def directory(self, key, create=False):
        if not KEY.fullmatch(key):
            raise ServiceError("任务标识无效。")
        directory = self.root / key
        if create:
            if not directory.exists() and sum(1 for item in self.root.iterdir() if item.is_dir()) >= 200:
                raise ServiceError("服务任务容量已满，请稍后或清理过期任务。", 429, "PPT_SERVICE_CAPACITY")
            directory.mkdir(exist_ok=True, mode=0o700)
        if not directory.is_dir() or directory.is_symlink():
            raise ServiceError("服务任务不存在，请重新创建。", 404, "PPT_SERVICE_JOB_MISSING")
        os.utime(directory)
        return directory

    @contextlib.contextmanager
    def locked(self, key, create=False, allow_old=False):
        directory = self.directory(key, create)
        with (directory / ".lock").open("a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ServiceError("当前任务仍在执行，请等待或停止后重试。", 409, "PPT_SERVICE_BUSY") from None
            metadata = directory / ".job.json"
            if not metadata.exists():
                if not create:
                    raise ServiceError("服务任务未初始化。", 404, "PPT_SERVICE_JOB_MISSING")
                atomic(metadata, {"runtimeId": self.runtime_id, "createdAt": time.time()})
            if not allow_old and json.loads(metadata.read_text())["runtimeId"] != self.runtime_id:
                raise ServiceError("服务已更新，请保留已有结果并新建任务，不能混用旧检查点。", 409, "PPT_SERVICE_RUNTIME_CHANGED")
            yield directory

    def open(self, key):
        with self.locked(key, create=True):
            return {"runtimeId": self.runtime_id}

    def put_input(self, key, name, data):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,120}", name) or len(data) > 50 * 1024**2:
            raise ServiceError("输入文件名无效或超过50MiB。", 413)
        with self.locked(key) as root:
            workspace = root / "workspace"
            directory = workspace / "inputs"
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            target = directory / name
            if target.exists():
                if target.is_symlink() or not target.is_file() or target.read_bytes() != data:
                    raise ServiceError("不能覆盖已经保存的输入快照。", 409, "PPT_SERVICE_INPUT_CHANGED")
            else:
                if sum(item.stat().st_size for item in workspace.rglob("*") if item.is_file()) + len(data) > 250 * 1024**2 or shutil.disk_usage(self.root).free < len(data) + 128 * 1024**2:
                    raise ServiceError("任务文件或服务磁盘容量不足。", 413, "PPT_SERVICE_STORAGE")
                with target.open("xb") as output:
                    output.write(data)
                target.chmod(0o400)
            return {"path": "inputs/" + name, "sha256": hashlib.sha256(data).hexdigest(), "byteSize": len(data)}

    def output(self, key, name):
        if name not in {"presentation.pptx", "project.zip", "manifest.json", "video.mp4", "video-first.png"} and not re.fullmatch(r"preview-(?:[1-9]|[1-3]\d|40)\.png", name):
            raise ServiceError("交付文件名无效。")
        with self.locked(key) as root:
            workspace = root / "workspace"
            file = workspace / "native-preview" / name.replace("preview-", "slide-") if name.startswith("preview-") else workspace / "delivery" / name
            if not file.is_file() or file.is_symlink() or file.resolve() != file.absolute() or any(parent.is_symlink() for parent in file.parents if parent != root.parent) or file.stat().st_size > 120 * 1024**2:
                raise ServiceError("交付文件不存在、已变化或超过大小上限。", 404, "PPT_SERVICE_OUTPUT_MISSING")
            return file.read_bytes()

    def input(self, key, name):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,120}", name):
            raise ServiceError("输入文件名无效。")
        with self.locked(key) as root:
            file = root / "workspace" / "inputs" / name
            if not file.is_file() or file.is_symlink() or file.stat().st_size > 50 * 1024**2:
                raise ServiceError("输入快照不存在或过大。", 404)
            return file.read_bytes()

    def execute(self, key, request_id, expected, operation):
        if not REQUEST.fullmatch(request_id) or expected != self.runtime_id:
            raise ServiceError("制作服务身份已变化，请重新查询并创建任务。", 409, "PPT_SERVICE_RUNTIME_CHANGED")
        if not isinstance(operation, dict) or operation.get("action") not in ACTIONS:
            raise ServiceError("执行动作未登记。")
        if not self.slots.acquire(blocking=False):
            raise ServiceError("制作服务繁忙，请稍后重试。", 429, "PPT_SERVICE_CAPACITY")
        try:
            with self.locked(key) as root:
                work = root / "workspace"
                work.mkdir(exist_ok=True, mode=0o700)
                temporary = root / "tmp"
                temporary.mkdir(exist_ok=True, mode=0o700)
                journal = root / ("operation-" + request_id + ".json")
                encoded = json.dumps(operation, ensure_ascii=False, separators=(",", ":")).encode()
                digest = hashlib.sha256(encoded).hexdigest()
                if journal.exists():
                    previous = json.loads(journal.read_text())
                    if previous["digest"] != digest:
                        raise ServiceError("同一动作标识不能替换请求内容。", 409, "PPT_SERVICE_REQUEST_CHANGED")
                    if "response" in previous:
                        return previous["response"]
                    raise ServiceError("上次动作被中断，请先核对任务文件再继续，不能自动重放。", 409, "PPT_SERVICE_INTERRUPTED")
                journals = list(root.glob("operation-*.json"))
                if len(journals) >= 1600 or sum(file.stat().st_size for file in journals) > 128 * 1024**2:
                    raise ServiceError("任务动作记录超过上限，请保存已有结果后新建任务。", 413, "PPT_SERVICE_STORAGE")
                if (root / ("cancel-" + request_id)).exists() or self.stop.is_set():
                    raise ServiceError("制作动作已取消。", 409, "PPT_SERVICE_CANCELLED")
                if operation == {"action": "health"} and self.verified_health:
                    response = {"ok": True, "revision": self.verified_health["revision"], "runtimeId": self.runtime_id, "serviceProtocol": 1, "result": self.verified_health}
                    atomic(journal, {"digest": digest, "response": response})
                    return response
                atomic(journal, {"digest": digest})
                environment = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "LANG": "C.UTF-8", "PIVOT_MASTER_WORKSPACE": str(work),
                               "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1", "HOME": str(temporary), "TMPDIR": str(temporary), "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1"}
                child = subprocess.Popen([sys.executable, "/runner/service_worker.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         cwd=work, env=environment, start_new_session=True)
                with self.guard:
                    self.active[(key, request_id)] = child
                try:
                    if (root / ("cancel-" + request_id)).exists():
                        self.kill(child)
                    output, error = child.communicate(encoded, timeout=self.timeout)
                    if len(output) > 1024**2 or child.returncode or self.stop.is_set() or (root / ("cancel-" + request_id)).exists():
                        raise ServiceError("制作动作未完成或已取消，请核对任务后重试。", 409, "PPT_SERVICE_OPERATION_FAILED")
                    response = json.loads(output)
                    response["runtimeId"] = self.runtime_id
                    response["serviceProtocol"] = 1
                    if not response.get("ok"):
                        response["error"] = str(response.get("error", "制作失败"))[:2000]
                    atomic(journal.with_name(journal.name + ".done"), {"digest": digest, "response": response})
                    os.replace(journal.with_name(journal.name + ".done"), journal)
                    return response
                except subprocess.TimeoutExpired:
                    self.kill(child)
                    child.communicate()
                    raise ServiceError("制作动作超时，请缩小任务后重试。", 504, "PPT_SERVICE_TIMEOUT") from None
                finally:
                    self.kill(child)
                    with self.guard:
                        self.active.pop((key, request_id), None)
        finally:
            self.slots.release()

    @staticmethod
    def kill(child):
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def cancel(self, key, request_id):
        if not REQUEST.fullmatch(request_id):
            raise ServiceError("动作标识无效。")
        root = self.directory(key)
        marker = root / ("cancel-" + request_id)
        marker.touch(exist_ok=True)
        with self.guard:
            child = self.active.get((key, request_id))
            if child:
                self.kill(child)
        return {"cancelled": True}

    def delete(self, key):
        try:
            with self.locked(key, allow_old=True) as root:
                shutil.rmtree(root)
        except ServiceError as error:
            if error.status != 404:
                raise
        return {"deleted": True}

    def cleanup(self):
        for root in self.root.iterdir():
            if root.is_dir() and KEY.fullmatch(root.name) and not root.is_symlink() and time.time() - root.stat().st_mtime > 86400:
                try:
                    self.delete(root.name)
                except ServiceError:
                    pass

    def shutdown(self):
        self.stop.set()
        with self.guard:
            for child in self.active.values():
                self.kill(child)
