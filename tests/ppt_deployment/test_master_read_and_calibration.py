"""完整制作工具读取范围和文字校准权限边界回归。"""
import sys
import shutil
import stat
import subprocess
import tempfile
import unittest
from zipfile import ZipFile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'docker' / 'ppt-master'))
import runner  # noqa: E402
from tool_catalog import command  # noqa: E402


class MasterToolTests(unittest.TestCase):
    def test_readonly_template_copy_keeps_source_and_allows_task_cleanup(self):
        engine = ROOT / 'artifacts' / 'ppt-master-runtime'
        if not (engine / 'manifest.json').exists():
            self.skipTest('未准备固定 PPT Master 运行包')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'skill/templates/example'
            nested = source / 'templates'
            nested.mkdir(parents=True)
            (nested / 'design_spec.md').write_text('模板示例', encoding='utf-8')
            workspace = root / 'workspace'
            workspace.mkdir()
            for folder in (nested, source):
                folder.chmod(0o555)
            try:
                with patch.object(runner, 'ENGINE', engine), patch.object(runner, 'SKILL', root / 'skill'), patch.object(runner, 'WORKSPACE', workspace), patch.object(runner, 'run', return_value={'exitCode': 0}):
                    result = runner.main({'action': 'copy_template', 'source': 'templates/example', 'path': 'selected-template'})
                target = workspace / result['path']
                self.assertEqual((target / 'templates/design_spec.md').read_text(encoding='utf-8'), '模板示例')
                if sys.platform != 'win32':
                    self.assertFalse(nested.stat().st_mode & stat.S_IWUSR)
                    self.assertTrue((target / 'templates').stat().st_mode & stat.S_IWUSR)
                shutil.rmtree(target)
            finally:
                for folder in (nested, source):
                    folder.chmod(0o755)

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
            roles = ['calibrate', 'project', '--role', 'title:Arial:32:bold', '--role=body:Microsoft YaHei:20', '--sample', 'عنوان العرض']
            self.assertEqual(command('text_measure', roles, skill, workspace)[1:], [
                'calibrate', 'project', '--role=title:Arial:32:bold', '--role=body:Microsoft YaHei:20', '--sample=عنوان العرض'
            ])
            rejected = [
                ['calibrate', '../outside', '--outline'], ['calibrate', 'inputs', '--outline'],
                ['calibrate', 'project', '--output', 'x'], ['measure', 'project', '--outline'],
                ['calibrate', 'project', '--role', 'title:../fonts/a:32'], ['calibrate', 'project', '--role', 'title:Arial:0'],
                ['calibrate', 'project', '--role', '--outline'], ['calibrate', 'project', '--sample', '只有短文本']
            ]
            for args in rejected:
                with self.assertRaises(ValueError):
                    command('text_measure', args, skill, workspace)

    def test_quick_calibration_and_bundled_icon_sync_use_the_pinned_scripts(self):
        skill = ROOT / 'artifacts' / 'ppt-master-runtime' / 'skill'
        if not (skill / 'SKILL.md').exists():
            self.skipTest('未准备固定 PPT Master 运行包')
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            project = workspace / 'project'
            project.mkdir()
            icon = 'tabler-outline/home'
            for args in [['project', '../outside'], ['project', 'unregistered/home'], ['project', 'tabler-outline/../home'], ['.', icon]]:
                with self.assertRaises(ValueError):
                    command('icon_sync', args, skill, workspace)
            for tool, args in [
                ('text_measure', ['calibrate', 'project', '--role', 'title:Arial:32:bold', '--sample', 'عنوان العرض']),
                ('icon_sync', ['project', icon])
            ]:
                result = subprocess.run([sys.executable, '-B', *command(tool, args, skill, workspace)],
                                        cwd=workspace, capture_output=True, encoding='utf-8', timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((project / 'validation' / 'text_calibration.json').is_file())
            self.assertEqual((project / 'icons' / f'{icon}.svg').read_bytes(),
                             (skill / 'templates' / 'icons' / f'{icon}.svg').read_bytes())
            with self.assertRaises(ValueError):
                command('apply_template', ['project', '--skip-validation'], skill, workspace)

    def test_page_checks_and_native_roundtrip_are_confined(self):
        skill = ROOT / 'artifacts' / 'ppt-master-runtime' / 'skill'
        if not skill.exists():
            self.skipTest('未准备固定 PPT Master 运行包')
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            for project in ('deck', 'other'):
                pages = workspace / project / 'svg_output'
                pages.mkdir(parents=True)
                (pages / 'p01.svg').touch()
            for page in ('p01.svg', 'svg_output/p01.svg', 'deck/svg_output/p01.svg'):
                args = command('check_svg', ['deck', '--stage', 'page', '--page', page], skill, workspace)
                self.assertEqual(args[-1], 'deck/svg_output/p01.svg')
            with self.assertRaises(ValueError):
                command('check_svg', ['deck', '--stage', 'page', '--page', 'other/svg_output/p01.svg'], skill, workspace)
            self.assertEqual(command('check_svg', ['deck', '--roundtrip', '--json'], skill, workspace)[-2:], ['--roundtrip', '--json'])
            self.assertEqual(command('import_native', ['source.pptx', '-o', 'deck', '--inheritance-mode=both', '--roundtrip'],
                                     skill, workspace)[-3:], ['--inheritance-mode', 'both', '--roundtrip'])
            with self.assertRaises(ValueError):
                command('import_native', ['source.pptx', '-o', 'deck', '--inheritance-mode=other'], skill, workspace)

    def test_project_archive_respects_bound_and_excludes_previous_exports(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            exported = workspace / 'project' / 'exports'
            exported.mkdir(parents=True)
            (exported / 'old.pptx').write_bytes(b'old')
            source = workspace / 'project' / 'design_spec.md'
            source.write_text('设计规范', encoding='utf-8')
            delivery = workspace / 'delivery'
            delivery.mkdir()
            with patch.object(runner, 'WORKSPACE', workspace):
                digest, size = runner.build_project_archive({'sourceBundleLimit': 2048}, delivery)
                self.assertEqual(len(digest), 64)
                self.assertLess(size, 2048)
                with ZipFile(delivery / 'project.zip') as data:
                    self.assertEqual(data.namelist(), ['project/design_spec.md'])
                source.write_bytes(bytes(range(256)) * 4 + bytes(reversed(range(256))) * 4)
                (workspace / 'project' / ('a' * 100 + '.txt')).write_bytes(bytes(range(255, 15, -1)))
                # 多个独立项目条目的压缩数据与目录索引总和超过限额。
                for index in range(12):
                    (workspace / 'project' / f'fixture-{index}.md').write_bytes(bytes(range(256)))
                self.assertIsNone(runner.build_project_archive({'sourceBundleLimit': 1024}, delivery))
                self.assertEqual(list(delivery.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
