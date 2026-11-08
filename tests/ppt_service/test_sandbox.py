"""在真实Linux子进程验证目录、网络与服务凭据隔离。"""
import os
from pathlib import Path
import subprocess
import sys
import unittest

if os.name != 'posix':
    raise unittest.SkipTest('隔离测试在Linux容器执行')

MODULE = Path(__file__).resolve().parents[2] / 'docker' / 'ppt-master'


class SandboxTests(unittest.TestCase):
    def run_child(self, checks):
        base = os.environ.get('PPT_SANDBOX_TEST_ROOT')
        setup = "import os,sys,tempfile,socket;from pathlib import Path;sys.path.insert(0," + repr(str(MODULE)) + ");from service_worker import restrict;own=tempfile.mkdtemp(dir=" + repr(base) + ");other=tempfile.mkdtemp(dir=" + repr(base) + ");Path(other,'secret').write_text('其他任务');os.environ['PIVOT_MASTER_WORKSPACE']=own;os.environ['TMPDIR']=own;restrict();\n"
        result = subprocess.run([sys.executable, '-c', setup + checks], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_only_own_task_and_temporary_directory_can_be_written(self):
        self.run_child("Path(own,'result').write_text('已保存');assert Path(own,'result').read_text()=='已保存'\ntry:\n Path(other,'secret').read_text()\n raise Exception('不应读取其他任务')\nexcept PermissionError: pass\ntry:\n Path('/tmp/other-job-write').write_text('不允许')\n raise Exception('不应写出任务范围')\nexcept PermissionError: pass")

    def test_service_credentials_and_internet_socket_are_not_accessible(self):
        self.run_child("for target in ['/proc/1/environ',other+'/secret']:\n try:\n  Path(target).read_bytes()\n  raise Exception('不应读取服务凭据或其他任务')\n except PermissionError: pass\ntry:\n socket.socket(socket.AF_INET,socket.SOCK_STREAM)\n raise Exception('不应创建网络连接')\nexcept PermissionError: pass\nlocal=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);local.close()")

    @unittest.skipUnless(os.environ.get('PPT_SANDBOX_TEST_ROOT'), '在独立数据挂载中验证删除边界')
    def test_ipc_exception_does_not_allow_other_task_delete_or_directory_listing(self):
        self.run_child("try:\n Path(other,'secret').unlink()\n raise Exception('不应删除其他任务文件')\nexcept PermissionError: pass\ntry:\n list(Path('/tmp').iterdir())\n raise Exception('不应枚举其他IPC名称')\nexcept PermissionError: pass\nlocal=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);local.bind('/tmp/office-ipc-boundary-test');local.close();Path('/tmp/office-ipc-boundary-test').unlink()")


if __name__ == '__main__':
    unittest.main()
