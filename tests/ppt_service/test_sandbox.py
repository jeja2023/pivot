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
        setup = "import os,sys,tempfile,socket;from pathlib import Path;sys.path.insert(0," + repr(str(MODULE)) + ");from service_worker import restrict;own=tempfile.mkdtemp();other=tempfile.mkdtemp();Path(other,'secret').write_text('其他任务');os.environ['PIVOT_MASTER_WORKSPACE']=own;os.environ['TMPDIR']=own;restrict();\n"
        result = subprocess.run([sys.executable, '-c', setup + checks], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_only_own_task_and_temporary_directory_can_be_written(self):
        self.run_child("Path(own,'result').write_text('已保存');assert Path(own,'result').read_text()=='已保存'\ntry:\n Path(other,'secret').read_text()\n raise Exception('不应读取其他任务')\nexcept PermissionError: pass\ntry:\n Path('/tmp/other-job-write').write_text('不允许')\n raise Exception('不应写出任务范围')\nexcept PermissionError: pass")

    def test_service_credentials_and_internet_socket_are_not_accessible(self):
        self.run_child("for target in ['/proc/1/environ',other+'/secret']:\n try:\n  Path(target).read_bytes()\n  raise Exception('不应读取服务凭据或其他任务')\n except PermissionError: pass\ntry:\n socket.socket(socket.AF_INET,socket.SOCK_STREAM)\n raise Exception('不应创建网络连接')\nexcept PermissionError: pass\nlocal=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);local.close()")


if __name__ == '__main__':
    unittest.main()
