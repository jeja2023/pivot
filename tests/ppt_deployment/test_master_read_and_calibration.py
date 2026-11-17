"""完整制作工具读取范围和文字校准权限边界回归。"""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'docker' / 'ppt-master'))
import runner  # noqa: E402
from tool_catalog import command  # noqa: E402


class MasterToolTests(unittest.TestCase):
    def test_read_honors_length_and_preserves_unicode_offsets(self):
        engine = ROOT / 'artifacts' / 'ppt-master-runtime'
        if not (engine / 'manifest.json').exists():
            self.skipTest('未准备固定 PPT Master 运行包')
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = '甲🧭乙' * 20000
            (workspace / 'source.md').write_text(source, encoding='utf-8')
            with patch.object(runner, 'ENGINE', engine), patch.object(runner, 'SKILL', engine / 'skill'), patch.object(runner, 'WORKSPACE', workspace), patch.object(runner, 'run', return_value={'exitCode': 0}):
                first = runner.main({'action': 'read', 'path': 'source.md', 'offset': 7, 'length': 1000})
                self.assertEqual(first['text'], source[7:1007])
                self.assertEqual(first['nextOffset'], 1007)
                last = runner.main({'action': 'read', 'path': 'source.md', 'offset': 59990, 'length': 50})
                self.assertEqual(last['text'], source[59990:])
                self.assertIsNone(last['nextOffset'])

    def test_calibration_only_allows_confined_project_and_fixed_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / 'skill'
            (skill / 'scripts').mkdir(parents=True)
            (skill / 'scripts' / 'text_measure.py').write_text('', encoding='utf-8')
            workspace = root / 'workspace'
            (workspace / 'project').mkdir(parents=True)
            (workspace / 'inputs').mkdir()
            self.assertEqual(command('text_measure', ['calibrate', 'project', '--outline'], skill, workspace)[1:], ['calibrate', 'project', '--outline'])
            for args in [['calibrate', '../outside', '--outline'], ['calibrate', 'inputs', '--outline'], ['calibrate', 'project', '--output', 'x'], ['measure', 'project', '--outline']]:
                with self.assertRaises(ValueError):
                    command('text_measure', args, skill, workspace)


if __name__ == '__main__':
    unittest.main()
