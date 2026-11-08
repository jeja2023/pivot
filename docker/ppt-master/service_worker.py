"""每次制作动作在独立进程执行，不接收服务密钥或网络权限。"""
import ctypes
import ctypes.util
import errno
import os
import resource
import sys
from service_sandbox import restrict_filesystem


def restrict():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_FSIZE, (160 * 1024**2, 160 * 1024**2))
    restrict_filesystem()
    library = ctypes.util.find_library("seccomp")
    if not library:
        raise RuntimeError("缺少制作动作的网络隔离组件。")
    seccomp = ctypes.CDLL(library)
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_syscall_resolve_name.restype = ctypes.c_int
    seccomp.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]

    class Comparison(ctypes.Structure):
        _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_uint), ("datum_a", ctypes.c_uint64), ("datum_b", ctypes.c_uint64)]

    context = seccomp.seccomp_init(0x7FFF0000)
    if not context:
        raise RuntimeError("不能创建制作隔离策略。")
    try:
        # 允许LibreOffice本地Unix socket，拒绝动作进程创建其他网络连接。
        for name in [b"socket", b"socketpair"]:
            number = seccomp.seccomp_syscall_resolve_name(name)
            comparison = Comparison(0, 1, 1, 0)
            if number < 0 or seccomp.seccomp_rule_add_array(context, 0x00050000 | errno.EPERM, number, 1, ctypes.byref(comparison)):
                raise RuntimeError("不能登记制作动作网络隔离。")
        for name in [b"ptrace", b"process_vm_readv", b"process_vm_writev", b"kcmp", b"perf_event_open", b"bpf"]:
            number = seccomp.seccomp_syscall_resolve_name(name)
            if number >= 0 and seccomp.seccomp_rule_add_array(context, 0x00050000 | errno.EPERM, number, 0, None):
                raise RuntimeError("不能登记动作进程访问隔离。")
        for name in [b"kill", b"tgkill", b"tkill"]:
            number = seccomp.seccomp_syscall_resolve_name(name)
            comparison = Comparison(0, 4, os.getppid(), 0)
            if number >= 0 and seccomp.seccomp_rule_add_array(context, 0x00050000 | errno.EPERM, number, 1, ctypes.byref(comparison)):
                raise RuntimeError("不能保护制作服务进程。")
        if seccomp.seccomp_load(context):
            raise RuntimeError("不能启用制作动作网络隔离。")
    finally:
        seccomp.seccomp_release(context)


if __name__ == "__main__":
    restrict()
    os.execv(sys.executable, [sys.executable, "/runner/runner.py"])
