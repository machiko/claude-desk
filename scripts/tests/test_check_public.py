"""scripts/check-public.sh 的測試：在暫存資料夾造主 repo 與 worktree，跑真的腳本。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'check-public.sh')
# 測試用的假禁用字詞；清單比對不分大小寫
BANNED = 'zorblax-internal'
SHELLS = ['sh', 'bash']


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def git(*args, cwd):
    subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True)


class CheckPublicTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.main = os.path.join(self.tmp, 'main')
        self.wt = os.path.join(self.tmp, 'wt')
        os.makedirs(self.main)
        git('init', '-q', '-b', 'main', cwd=self.main)
        git('config', 'user.email', 'test@example.com', cwd=self.main)
        git('config', 'user.name', 'test', cwd=self.main)
        write(os.path.join(self.main, '.gitignore'), '.public-denylist\n')
        write(os.path.join(self.main, 'README.md'), 'hello\n')
        os.makedirs(os.path.join(self.main, 'scripts'))
        shutil.copy(SCRIPT, os.path.join(self.main, 'scripts', 'check-public.sh'))
        git('add', '.gitignore', 'README.md', 'scripts/check-public.sh', cwd=self.main)
        git('commit', '-q', '-m', 'init', cwd=self.main)
        git('worktree', 'add', '-q', self.wt, '-b', 'feature', cwd=self.main)
        # 清單只放主 repo 根目錄（不進版控），worktree 裡沒有
        write(os.path.join(self.main, '.public-denylist'), f'# 註解\n\n{BANNED}\n')

    def run_script(self, shell='sh', cwd=None, env=None):
        cwd = cwd or self.wt
        full = {**os.environ, 'LC_ALL': 'en_US.UTF-8', 'LANG': 'en_US.UTF-8'}
        full.pop('CHECK_PUBLIC_DENYLIST', None)
        full.update(env or {})
        return subprocess.run([shell, os.path.join(cwd, 'scripts', 'check-public.sh')],
                              cwd=cwd, env=full, capture_output=True, text=True,
                              encoding='utf-8', errors='replace')  # 壞掉的 bash 會把半個多位元組字元印進錯誤訊息

    # AC-1：在 worktree 執行、清單只在主 repo，sh 與 bash 都通過
    def test_passes_in_worktree_with_denylist_in_main_repo(self):
        for shell in SHELLS:
            with self.subTest(shell=shell):
                r = self.run_script(shell)

                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertNotIn('unbound', r.stderr)
                self.assertIn('通過', r.stdout)

    # AC-2：worktree 裡的檔案命中（大小寫不同也算）→ exit 1，列出 檔案:行號
    def test_exits_1_and_lists_file_and_line_when_hit(self):
        write(os.path.join(self.wt, 'notes.md'), f'first\nsee Zorblax-Internal here\n')

        r = self.run_script()

        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn('notes.md:2:', r.stdout)

    # AC-3：主 repo 與 worktree 都沒有清單 → exit 2，說明要放在主 repo 根目錄
    def test_exits_2_when_denylist_missing(self):
        os.remove(os.path.join(self.main, '.public-denylist'))

        r = self.run_script()

        self.assertEqual(r.returncode, 2, r.stdout)
        self.assertIn('.public-denylist', r.stderr)
        self.assertIn(os.path.realpath(self.main), r.stderr)

    # AC-4：掃描範圍是執行所在的 worktree；主 repo 裡的命中不算
    def test_scans_only_the_current_worktree(self):
        write(os.path.join(self.main, 'leak.md'), f'{BANNED}\n')

        r = self.run_script()

        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn('leak.md', r.stdout)

    # AC-5：CHECK_PUBLIC_DENYLIST 指定清單路徑時優先用它；指到不存在的檔 → exit 2
    def test_env_var_overrides_denylist_path(self):
        other = os.path.join(self.tmp, 'other.txt')
        write(other, 'hello\n')

        hit = self.run_script(env={'CHECK_PUBLIC_DENYLIST': other})
        missing = self.run_script(env={'CHECK_PUBLIC_DENYLIST': os.path.join(self.tmp, 'nope.txt')})

        self.assertEqual(hit.returncode, 1, hit.stderr)
        self.assertIn('README.md:1:', hit.stdout)
        self.assertEqual(missing.returncode, 2, missing.stdout)
        self.assertIn('nope.txt', missing.stderr)


if __name__ == '__main__':
    unittest.main()
