"""card.py 跨 Agent 雙向協作與狀態推播（emit / read / wait / send）測試。

執行：python3 -m unittest discover -s skills/card/tests -p test_agent_bridge.py
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts', 'card.py')

SAMPLE_CARD = """# 任務：跨 Agent 測試

<!-- DESK -->
- 狀態：實作完成
- 檢查：`npm test`
- 等你：無
- 下一步：執行審查
- 關卡：無
<!-- /DESK -->

## 規格
"""


class AgentBridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.proj_dir = os.path.join(self.root, 'handoffs')
        self.wt = os.path.join(self.root, 'wt', 'alpha')
        os.makedirs(os.path.join(self.wt, '.desk'), exist_ok=True)
        os.makedirs(os.path.join(self.wt, '.task'), exist_ok=True)
        os.makedirs(self.proj_dir, exist_ok=True)
        self.card_path = os.path.join(self.wt, '.desk', 'CARD.md')
        with open(self.card_path, 'w', encoding='utf-8') as f:
            f.write(SAMPLE_CARD)
        self.reg_path = os.path.join(self.proj_dir, 'projects-scope.md')
        with open(self.reg_path, 'w', encoding='utf-8') as f:
            f.write(f'# 任務登錄表\n\n| Project | 卡片路徑 |\n| --- | --- |\n| 跨 Agent 測試 | `{self.card_path}` |\n')
        self.settings_path = os.path.join(self.proj_dir, 'dispatch.json')
        with open(self.settings_path, 'w', encoding='utf-8') as f:
            json.dump({
                'user': 'Alice',
                'card': {
                    'registry': self.reg_path,
                    'worktrees': os.path.join(self.root, 'wt'),
                },
            }, f)

    def tearDown(self):
        self.tmp.cleanup()

    def run_card(self, *args):
        env = {
            **os.environ,
            'DESK_PROJECT_DIR': self.proj_dir,
            'DESK_SETTINGS': self.settings_path,
        }
        return subprocess.run(
            [sys.executable, SCRIPT, *args],
            cwd=self.wt,
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )

    def test_emit_writes_osc7501_and_beacon_and_read_retrieves_it(self):
        r = self.run_card(
            'emit', 'alpha', 'blocked', '需要確認資料庫權限',
            '--agent', 'agy', '--wait', 'permission', '--pid', str(os.getpid()),
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('\x1b]7501;state=blocked;agent=agy;wait=permission;msg=需要確認資料庫權限\x1b\\', r.stdout)

        beacon_file = os.path.join(self.wt, '.task', 'agent-state.json')
        self.assertTrue(os.path.isfile(beacon_file))
        with open(beacon_file, encoding='utf-8') as f:
            beacon = json.load(f)
        self.assertEqual(beacon['state'], 'blocked')
        self.assertEqual(beacon['agent'], 'agy')
        self.assertEqual(beacon['waitsFor'], 'permission')
        self.assertEqual(beacon['message'], '需要確認資料庫權限')

        # read --source out --json 應能讀到剝除 ANSI 後的內容與 OSC 7501 狀態
        read_res = self.run_card('read', 'alpha', '--source', 'out', '--json')
        self.assertEqual(read_res.returncode, 0, read_res.stderr)
        payload = json.loads(read_res.stdout)
        self.assertEqual(payload['state'], 'blocked')
        self.assertEqual(payload['osc7501']['state'], 'blocked')
        self.assertEqual(payload['osc7501']['waitsFor'], 'permission')
        self.assertTrue(any('需要確認資料庫權限' in l for l in payload['lines']))

    def test_wait_until_done_and_early_return_on_blocked(self):
        # 1. 先設為 working，背景執行緒 0.2 秒後改為 done
        self.run_card('emit', 'alpha', 'working', '正在執行審查', '--agent', 'agy', '--pid', str(os.getpid()))

        def mark_done():
            time.sleep(0.2)
            self.run_card('emit', 'alpha', 'done', '審查完成，無阻擋問題', '--agent', 'agy')

        t = threading.Thread(target=mark_done)
        t.start()
        wait_res = self.run_card('wait', 'alpha', '--until', 'done', '--interval', '0.05', '--timeout', '3', '--json')
        t.join()
        self.assertEqual(wait_res.returncode, 0, wait_res.stderr)
        wait_json = json.loads(wait_res.stdout)
        self.assertEqual(wait_json['status'], 'done')

        # 2. 等待 done 時若目標變成 blocked，應提前以 exit code 2 返回，不盲等逾時
        self.run_card('emit', 'alpha', 'blocked', '卡在權限確認', '--agent', 'agy', '--wait', 'permission', '--pid', str(os.getpid()))
        blocked_res = self.run_card('wait', 'alpha', '--until', 'done', '--interval', '0.05', '--timeout', '2', '--json')
        self.assertEqual(blocked_res.returncode, 2)
        blocked_json = json.loads(blocked_res.stdout)
        self.assertEqual(blocked_json['status'], 'blocked')
        self.assertEqual(blocked_json['waitsFor'], 'permission')

    def test_send_executes_command_and_updates_beacon_and_output(self):
        # 同步模式執行 --to cmd
        r = self.run_card('send', 'alpha', '--to', 'cmd', 'echo "Reviewing files..."; echo "All checks green"', '--json')
        self.assertEqual(r.returncode, 0, r.stderr)
        res = json.loads(r.stdout)
        self.assertEqual(res['state'], 'done')
        self.assertEqual(res['exitCode'], 0)
        self.assertIn('All checks green', res['lastLine'])

        # 背景模式 (--bg) 搭配 wait --until done 與 read --source out
        bg_res = self.run_card('send', 'alpha', '--to', 'cmd', 'sleep 0.15; echo "BG Review Done"', '--bg', '--json')
        self.assertEqual(bg_res.returncode, 0, bg_res.stderr)
        bg_json = json.loads(bg_res.stdout)
        self.assertTrue(bg_json['background'])
        self.assertGreater(bg_json['pid'], 0)

        wait_res = self.run_card('wait', 'alpha', '--until', 'done', '--interval', '0.05', '--timeout', '5', '--json')
        self.assertEqual(wait_res.returncode, 0, wait_res.stderr)
        out_res = self.run_card('read', 'alpha', '--source', 'out', '--lines', '5')
        self.assertEqual(out_res.returncode, 0)
        self.assertIn('BG Review Done', out_res.stdout)


if __name__ == '__main__':
    unittest.main()
