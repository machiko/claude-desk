"""scripts/test-timing.py 的測試：在暫存資料夾造 claude plugin test 的輸出檔，跑真的腳本。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'test-timing.py')
TIME_FLAGS = ['--max-cpu', '--max-wall', '--max-test-ms', '--max-slow']


def output(files, wall='[2.50s]', fail=0, skip=0, todo=0, ran=None, noise=''):
    """files：{檔名: [(狀態, 名稱, 時間字串)]}；回傳一份 claude plugin test 的輸出。"""
    rows = [t for tests in files.values() for t in tests]
    parts = []
    for name, tests in files.items():
        parts.append(f'{name}:')
        parts += [f'({status}) {test} [{time}]' for status, test, time in tests]
        parts.append('')
    parts.append(noise)
    passed = sum(1 for t in rows if t[0] == 'pass')
    parts += [f' {passed} pass', f' {fail} fail']
    if skip:
        parts.append(f' {skip} skip')
    if todo:
        parts.append(f' {todo} todo')
    count = len(rows) if ran is None else ran
    n_files = len(files)
    parts.append(f'Ran {count} tests across {n_files} file{"" if n_files == 1 else "s"}. {wall}')
    return '\n'.join(parts) + '\n'


def section(stdout, title):
    """取出某個標題底下縮排的那幾行（去掉前後空白）。"""
    lines = stdout.split(title + '\n', 1)[1].splitlines()
    rows = []
    for line in lines:
        if not line.startswith('  '):
            break
        rows.append(line.strip())
    return rows


GOOD = {
    'tests/a.test.ts': [('pass', 'adds numbers', '1.20ms'), ('pass', 'adds [bracketed] numbers', '120.00ms')],
    'tests/b.test.tsx': [('pass', 'renders the pane', '600.50ms'), ('pass', 'renders the band', '1.20s')],
}


def slow_suite():
    """跟現在整套差不多慢：460 支、加總 185 秒、最慢一支 2.5 秒、≥ 500 ms 的 178 支。"""
    tests = [('pass', 'slowest one', '2.50s')]
    tests += [('pass', f'slow {i}', '1000.00ms') for i in range(177)]
    # 剩下 5.5 秒平分給 282 支快的
    tests += [('pass', f'quick {i}', f'{5500 / 282:.4f}ms') for i in range(282)]
    return {'tests/slow.test.tsx': tests}


class TestTimingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def write(self, name, text):
        path = os.path.join(self.tmp, name)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text)
        return path

    def run_script(self, text, *args):
        path = self.write('out.txt', text)
        return subprocess.run([sys.executable, SCRIPT, path, *args], capture_output=True, text=True, encoding='utf-8')

    def assert_fails_with(self, r, *phrases):
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        for phrase in phrases:
            self.assertIn(phrase, r.stdout)

    # AC-3：全部通過、在門檻內 → 0，摘要照印
    def test_all_pass_within_limits_exits_0_and_prints_summary(self):
        r = self.run_script(output(GOOD), '--min-tests', '4', '--max-cpu', '10', '--max-wall', '10',
                            '--max-test-ms', '2000', '--max-slow', '2')

        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn('支數：4（2 檔）', r.stdout)
        self.assertIn('各支時間加總：1.9 秒', r.stdout)
        self.assertIn('實際時間：2.5 秒', r.stdout)
        self.assertIn('≥ 500 ms：2 支', r.stdout)
        self.assertIn('最慢 10 支', r.stdout)
        self.assertIn('各檔加總前 10 名', r.stdout)
        self.assertIn('load average：', r.stdout)
        self.assertIn('全部符合', r.stdout)

    # AC-1：最慢 10 支依時間排序，[1.20s] 算成 1200 ms
    def test_slowest_tests_are_sorted_and_seconds_are_converted(self):
        r = self.run_script(output(GOOD))

        slowest = r.stdout.split('最慢 10 支：\n')[1].split('各檔加總')[0].splitlines()
        self.assertIn('1200.0 ms', slowest[0])
        self.assertIn('renders the band', slowest[0])
        self.assertIn('renders the pane', slowest[1])

    # AC-1：各檔加總前 10 名列出檔名與加總，依加總由大到小
    def test_per_file_totals_are_listed_and_sorted(self):
        r = self.run_script(output(GOOD))

        self.assertEqual(section(r.stdout, '各檔加總前 10 名：'), [
            '1.8 秒  tests/b.test.tsx',
            '0.1 秒  tests/a.test.ts',
        ])

    # AC-1：超過 10 支、超過 10 檔時，兩份排行都只列最大的 10 個
    def test_rankings_list_only_the_top_ten(self):
        files = {f'tests/f{i:02}.test.ts': [('pass', f'test {i}', f'{(i + 1) * 100}.00ms')] for i in range(12)}

        r = self.run_script(output(files))

        slowest = section(r.stdout, '最慢 10 支：')
        self.assertEqual(len(slowest), 10)
        self.assertEqual(slowest[0], '1200.0 ms  tests/f11.test.ts  test 11')
        self.assertEqual(slowest[-1], '300.0 ms  tests/f02.test.ts  test 2')
        per_file = section(r.stdout, '各檔加總前 10 名：')
        self.assertEqual(len(per_file), 10)
        self.assertEqual(per_file[0], '1.2 秒  tests/f11.test.ts')
        self.assertEqual(per_file[-1], '0.3 秒  tests/f02.test.ts')

    # AC-2：很慢但不給時間旗標 → 時間只印不擋
    def test_slow_output_passes_without_time_flags(self):
        text = output(slow_suite(), wall='[22.00s]')

        r = self.run_script(text, '--min-tests', '460')

        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn('支數：460', r.stdout)
        self.assertIn('各支時間加總：185.0 秒', r.stdout)
        self.assertIn('實際時間：22.0 秒', r.stdout)
        self.assertIn('≥ 500 ms：178 支', r.stdout)
        self.assertIn('2500.0 ms', r.stdout)

    # AC-2：同一份輸出加上任一個時間旗標而且超過 → 1
    def test_slow_output_fails_with_time_flag(self):
        text = output(slow_suite(), wall='[22.00s]')
        cases = {
            '--max-cpu': ('90', '各支時間加總 185.0 秒 超過 90 秒（多 95.0 秒）'),
            '--max-wall': ('12', '實際時間 22.0 秒 超過 12 秒（多 10.0 秒）'),
            '--max-test-ms': ('2000', '單支 2500.0 ms 超過 2000 ms（多 500.0 ms）：tests/slow.test.tsx  slowest one'),
            '--max-slow': ('100', '≥ 500 ms 有 178 支，超過 100 支（多 78 支）'),
        }
        self.assertEqual(sorted(cases), sorted(TIME_FLAGS))
        for flag, (limit, phrase) in cases.items():
            with self.subTest(flag=flag):
                self.assert_fails_with(self.run_script(text, '--min-tests', '460', flag, limit), phrase)

    # AC-3：一支 fail → 1 並點名
    def test_failed_test_exits_1_and_names_it(self):
        files = {**GOOD, 'tests/c.test.ts': [('fail', 'breaks', '3.00ms')]}

        r = self.run_script(output(files, fail=1))

        self.assert_fails_with(r, '沒通過（fail）：tests/c.test.ts  breaks', '總結行：1 fail')

    # AC-3：skip、todo 也算沒過
    def test_skipped_or_todo_test_exits_1(self):
        for status in ('skip', 'todo'):
            with self.subTest(status=status):
                files = {**GOOD, 'tests/c.test.ts': [(status, 'later', '0.10ms')]}

                r = self.run_script(output(files, **{status: 1}))

                self.assert_fails_with(r, f'沒通過（{status}）：tests/c.test.ts  later', f'總結行：1 {status}')

    # AC-3：沒有 Ran 總結行（輸出被截斷）→ 1
    def test_missing_ran_line_exits_1(self):
        text = output(GOOD).split('Ran ')[0]

        r = self.run_script(text)

        self.assert_fails_with(r, '輸出不完整')

    # AC-3：Ran 行寫的支數跟解析到的不同 → 1
    def test_ran_count_mismatch_exits_1(self):
        r = self.run_script(output(GOOD, ran=5))

        self.assert_fails_with(r, '解析到 4 支，總結行寫 5 支')

    # AC-3：支數不足 → 1 並說差多少
    def test_too_few_tests_exits_1(self):
        r = self.run_script(output(GOOD), '--min-tests', '460')

        self.assert_fails_with(r, '支數 4 少於 460（少 456 支）')

    # AC-3：名單上的測試沒出現 → 1 並點名
    def test_baseline_test_missing_exits_1(self):
        baseline = self.write('baseline.txt', 'tests/a.test.ts\tadds numbers\ntests/a.test.ts\tgone test\n')

        r = self.run_script(output(GOOD), '--baseline', baseline)

        self.assert_fails_with(r, '名單上的測試沒出現：tests/a.test.ts  gone test')
        self.assertNotIn('adds numbers\n- ', r.stdout)

    # AC-3：名單上的測試在但沒通過 → 1 並點名
    def test_baseline_test_failing_exits_1(self):
        files = {'tests/a.test.ts': [('pass', 'adds numbers', '1.00ms'), ('fail', 'flaky', '5.00ms')]}
        baseline = self.write('baseline.txt', 'tests/a.test.ts\tadds numbers\ntests/a.test.ts\tflaky\n')

        r = self.run_script(output(files, fail=1), '--baseline', baseline)

        self.assert_fails_with(r, '名單上的測試沒通過：tests/a.test.ts  flaky')

    # AC-3：同名測試照出現次數比
    def test_baseline_counts_duplicate_names(self):
        files = {'tests/a.test.ts': [('pass', 'same', '1.00ms')]}
        baseline = self.write('baseline.txt', 'tests/a.test.ts\tsame\ntests/a.test.ts\tsame\n')

        r = self.run_script(output(files), '--baseline', baseline)

        self.assert_fails_with(r, '名單上的測試沒出現：tests/a.test.ts  same')

    # AC-3：名單全部在而且通過 → 0
    def test_baseline_all_present_exits_0(self):
        names = self.run_script(output(GOOD), '--names').stdout
        baseline = self.write('baseline.txt', names)

        r = self.run_script(output(GOOD), '--min-tests', '4', '--baseline', baseline)

        self.assertEqual(r.returncode, 0, r.stdout)

    # AC-3：--names 只印「檔名 TAB 測試名稱」一行一支
    def test_names_prints_file_tab_name_only(self):
        r = self.run_script(output(GOOD), '--names')

        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), [
            'tests/a.test.ts\tadds numbers',
            'tests/a.test.ts\tadds [bracketed] numbers',
            'tests/b.test.tsx\trenders the pane',
            'tests/b.test.tsx\trenders the band',
        ])

    # AC-3：stderr 雜訊（zz-preview 印的畫面）與「across 1 file」不影響解析
    def test_noise_and_single_file_summary_are_parsed(self):
        noise = '==== pane 40 ====\n desk 9.9.9 教學模式\n ▎ ◆ 教學：會員折扣\n  Error: printed by a test\ntests/: not a header\n'
        text = output({'tests/b.test.tsx': GOOD['tests/b.test.tsx']}, noise=noise)

        r = self.run_script(text, '--min-tests', '2')

        self.assertIn('Ran 2 tests across 1 file.', text)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn('支數：2（1 檔）', r.stdout)


if __name__ == '__main__':
    unittest.main()
