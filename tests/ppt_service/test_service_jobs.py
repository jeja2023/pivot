"""独立PPT服务的身份隔离、只读输入、恢复与取消回归。"""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
if os.name != 'posix':
    raise unittest.SkipTest('PPT独立服务在Linux容器运行')
sys.path.insert(0, str(ROOT / 'docker' / 'ppt-master'))
from service_jobs import Jobs, ServiceError


class JobsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ppt-service-test-')
        self.jobs = Jobs(Path(self.temp.name), 'sha256:' + 'a' * 64)
        self.key = 'b' * 64
        self.jobs.open(self.key)

    def tearDown(self):
        self.jobs.shutdown()
        self.temp.cleanup()

    def test_input_is_immutable_and_path_cannot_escape(self):
        result = self.jobs.put_input(self.key, 'source.pptx', b'original')
        self.assertEqual(result['sha256'], hashlib.sha256(b'original').hexdigest())
        self.assertEqual(self.jobs.input(self.key, 'source.pptx'), b'original')
        self.jobs.put_input(self.key, 'source.pptx', b'original')
        with self.assertRaises(ServiceError):
            self.jobs.put_input(self.key, 'source.pptx', b'changed')
        with self.assertRaises(ServiceError):
            self.jobs.put_input(self.key, '../outside', b'changed')
        with self.assertRaises(ServiceError):
            self.jobs.input('c' * 64, 'source.pptx')

    def test_same_runtime_can_restart_old_tasks_but_new_runtime_rejects(self):
        same = Jobs(Path(self.temp.name), self.jobs.runtime_id)
        same.open(self.key)
        changed = Jobs(Path(self.temp.name), 'sha256:' + 'f' * 64)
        with self.assertRaisesRegex(ServiceError, '不能混用旧检查点'):
            changed.open(self.key)
        changed.delete(self.key)

    def test_cancel_before_start_blocks_operation_and_replay_is_not_implicit(self):
        request = 'd' * 32
        self.jobs.cancel(self.key, request)
        with patch('service_jobs.subprocess.Popen') as spawn, self.assertRaises(ServiceError):
            self.jobs.execute(self.key, request, self.jobs.runtime_id, {'action': 'list'})
        spawn.assert_not_called()
        root = self.jobs.directory(self.key)
        request = 'e' * 32
        operation = {'action': 'list'}
        digest = hashlib.sha256(json.dumps(operation, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        (root / ('operation-' + request + '.json')).write_text(json.dumps({'digest': digest}))
        with self.assertRaisesRegex(ServiceError, '不能自动重放'):
            self.jobs.execute(self.key, request, self.jobs.runtime_id, operation)

    def test_active_cancel_kills_only_matching_process_and_completed_result_replays(self):
        child = object()
        self.jobs.active[(self.key, 'f' * 32)] = child
        with patch.object(self.jobs, 'kill') as kill:
            self.jobs.cancel(self.key, 'f' * 32)
            kill.assert_called_once_with(child)
        self.jobs.active.clear()
        operation = {'action': 'list'}
        digest = hashlib.sha256(json.dumps(operation, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        response = {'ok': True, 'result': {'files': []}, 'runtimeId': self.jobs.runtime_id, 'serviceProtocol': 1}
        file = self.jobs.directory(self.key) / ('operation-' + 'e' * 32 + '.json')
        file.write_text(json.dumps({'digest': digest, 'response': response}))
        self.assertEqual(self.jobs.execute(self.key, 'e' * 32, self.jobs.runtime_id, operation), response)
        with self.assertRaisesRegex(ServiceError, '不能替换'):
            self.jobs.execute(self.key, 'e' * 32, self.jobs.runtime_id, {'action': 'read'})

    def test_no_arbitrary_command_or_output_path(self):
        for operation in [{'action': 'shell', 'command': 'echo bad'}, {'action': 'exec'}, []]:
            with self.assertRaises(ServiceError):
                self.jobs.execute(self.key, 'd' * 32, self.jobs.runtime_id, operation)
        for name in ['../../etc/passwd', 'other.py', '.job.json']:
            with self.assertRaises(ServiceError):
                self.jobs.output(self.key, name)

    def test_health_query_reuses_readonly_runtime_verification_without_new_worker(self):
        self.jobs.verified_health = {'status': 'ready', 'revision': 'verified-revision'}
        with patch('service_jobs.subprocess.Popen') as spawn:
            response = self.jobs.execute(self.key, 'e' * 32, self.jobs.runtime_id, {'action': 'health'})
        spawn.assert_not_called()
        self.assertEqual(response['result']['status'], 'ready')

    @unittest.skipIf(os.name == 'nt', 'Linux链接边界在容器执行')
    def test_symlink_output_cannot_leave_workspace(self):
        root = self.jobs.directory(self.key)
        delivery = root / 'workspace' / 'delivery'
        delivery.mkdir(parents=True)
        (delivery / 'presentation.pptx').symlink_to('/etc/passwd')
        with self.assertRaises(ServiceError):
            self.jobs.output(self.key, 'presentation.pptx')

    @unittest.skipIf(os.name == 'nt', 'Linux链接边界在容器执行')
    def test_input_parent_symlink_cannot_read_service_environment_or_write_another_job(self):
        root = self.jobs.directory(self.key)
        workspace = root / 'workspace'
        workspace.mkdir()
        (workspace / 'inputs').symlink_to('/proc/1', target_is_directory=True)
        with self.assertRaises(ServiceError):
            self.jobs.input(self.key, 'environ')
        with self.assertRaises(ServiceError):
            self.jobs.put_input(self.key, 'pollution', b'rejected')


if __name__ == '__main__':
    unittest.main()
