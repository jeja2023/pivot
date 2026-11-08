"""用Landlock把动作文件访问限制在只读运行库和自己的任务目录。"""
import ctypes
import os
from pathlib import Path


def restrict_filesystem():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    abi = libc.syscall(444, 0, 0, 1)
    if abi < 1:
        raise RuntimeError("Linux内核未启用Landlock，请使用支持Landlock的服务节点。")
    handled = (1 << 13) - 1
    if abi >= 2:
        handled |= 1 << 13
    if abi >= 3:
        handled |= 1 << 14

    class Ruleset(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64)]

    class PathRule(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int)]

    ruleset = Ruleset(handled)
    descriptor = libc.syscall(444, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0)
    if descriptor < 0:
        raise RuntimeError("不能创建动作目录隔离策略。")

    def allow(file, access):
        source = Path(file)
        if not source.exists():
            return
        flags = os.O_PATH | os.O_CLOEXEC
        parent = os.open(source, flags)
        try:
            if not source.is_dir():
                access &= (1 << 0) | (1 << 1) | (1 << 2) | (1 << 14)
            rule = PathRule(access, parent)
            if libc.syscall(445, descriptor, 1, ctypes.byref(rule), 0):
                raise RuntimeError("不能登记动作目录访问规则。")
        finally:
            os.close(parent)

    try:
        readonly = (1 << 0) | (1 << 2) | (1 << 3)
        for file in ["/usr", "/lib", "/lib64", "/bin", "/etc", "/engine", "/runner", "/var/cache/fontconfig", "/proc/meminfo", "/proc/cpuinfo", "/proc/self"]:
            allow(file, readonly)
        for file in ["/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"]:
            allow(file, (1 << 1) | (1 << 2))
        writable = handled & ~((1 << 6) | (1 << 10))
        allow(os.environ["PIVOT_MASTER_WORKSPACE"], writable)
        allow(os.environ["TMPDIR"], writable)
        # no_new_privs是无特权Landlock的前提，规则随exec和所有子进程继承。
        if libc.prctl(38, 1, 0, 0, 0) or libc.syscall(446, descriptor, 0):
            raise RuntimeError("不能启用动作目录隔离。")
    finally:
        os.close(descriptor)
