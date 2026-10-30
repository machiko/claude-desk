"""card.py 的測試：在暫存資料夾造主 repo、登錄表與卡片，跑真的子指令。

執行：python3 -m unittest discover -s skills/card/tests
"""
import datetime
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts', 'card.py')
SPEC_CASES = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), 'tests', 'spec-cases.mjs')
TEMPLATE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), 'templates', 'DESK-template.md')
CARD_TS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), 'hooks', 'card.ts')


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def write(path, text, mode='w'):
    with open(path, mode, encoding='utf-8') as f:
        f.write(text)


def git(*args, cwd):
    subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True)


# 與 hooks/project.ts 的 projectKey 同一張表（tests/project.test.tsx 的 KEY_CASES）
KEY_CASES = [
    ('/home/u/shop/.git', 'shop'),
    ('/srv/git/shop.git', 'shop'),
    ('/home/u/My Project/.git', 'My Project'),
    ('/home/u/訂單平台/.git', '訂單平台'),
    ('/home/u/shop/.bare', 'shop'),
    ('/home/u/shop/.git/modules/lib', 'lib'),
    ('/home/u/.hidden/.git', ''),
]


def load_card():
    """把 card.py 當模組載入（不跑子指令）。"""
    os.environ['DESK_PROJECT_DIR'] = ''
    try:
        spec = importlib.util.spec_from_file_location('card_under_test', SCRIPT)
        card = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(card)
    finally:
        os.environ.pop('DESK_PROJECT_DIR', None)
    return card


class ProjectKeyTest(unittest.TestCase):
    def test_same_keys_as_the_panel(self):
        card = load_card()
        for common, key in KEY_CASES:
            self.assertEqual(card.project_key(common), key, common)


class RegistryTemplateTest(unittest.TestCase):
    def test_same_empty_registry_as_the_panel(self):
        # 面板的「建立空的登錄表」寫 hooks/card.ts 的 REGISTRY_TEMPLATE；跟 /desk:card new 建的要一樣
        card = load_card()
        m = re.search(r"^export const REGISTRY_TEMPLATE = '([^']*)'$", read(CARD_TS), re.M)
        self.assertIsNotNone(m, 'hooks/card.ts 找不到 REGISTRY_TEMPLATE')
        self.assertEqual(m.group(1).replace('\\n', '\n'), card.REGISTRY_TEMPLATE)


class SpecRulesTest(unittest.TestCase):
    def test_filled_ac_matches_shared_spec_cases(self):
        # 與 hooks/card.ts 的 filledAc 同一份範例（tests/card.test.ts 的 filled AC follows the same shared spec cases as card.py）
        card = load_card()
        # 跟 TS 測試共用的 .mjs：行首的 `export default` 之後是純 JSON（註解裡的不算）
        cases = json.loads(read(SPEC_CASES).split('\nexport default ', 1)[1])
        self.assertTrue(cases)
        for c in cases:
            self.assertEqual(card.filled_ac(c['card']), c['ac'], c['name'])


class CardScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.t = self.tmp.name
        # 主 repo：一個 commit、一個本地的 origin，new 才能 fetch。
        self.origin = os.path.join(t, 'origin.git')
        self.main = os.path.join(t, 'shop')
        subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', self.origin], check=True)
        os.makedirs(self.main)
        git('init', '-q', '-b', 'main', cwd=self.main)
        git('config', 'user.email', 't@example.com', cwd=self.main)
        git('config', 'user.name', 't', cwd=self.main)
        write(os.path.join(self.main, 'README.md'), 'x\n')
        git('add', 'README.md', cwd=self.main)
        git('commit', '-q', '-m', 'init', cwd=self.main)
        git('remote', 'add', 'origin', self.origin, cwd=self.main)
        git('push', '-q', 'origin', 'main', cwd=self.main)
        self.reg = os.path.join(t, 'registry.md')
        write(self.reg, '# 登錄\n\n| 任務名 | 卡片 |\n| --- | --- |\n')
        self.settings = os.path.join(t, 'dispatch.json')
        self.write_settings({})

    def tearDown(self):
        self.tmp.cleanup()

    def write_settings(self, extra):
        card = {'main': self.main, 'registry': self.reg, 'archive': os.path.join(self.t, 'archive'), **extra.pop('card', {})}
        write(self.settings, json.dumps({'card': card, **extra}, ensure_ascii=False))

    def run_card(self, *args, cwd=None, detect=False):
        # 預設不認專案（DESK_PROJECT_DIR 空白），只用 DESK_SETTINGS；detect=True 時 HOME 指到暫存資料夾、依 cwd 的 repo 找專案。
        env = {**os.environ, 'DESK_SETTINGS': self.settings, 'DESK_PROJECT_DIR': ''}
        for k in ('DESK_CARD_MAIN', 'DESK_CARD_REGISTRY', 'DESK_CARD_TEMPLATE', 'DESK_CARD_ARCHIVE'):
            env.pop(k, None)
        if detect:
            env.pop('DESK_PROJECT_DIR')
            env['HOME'] = self.t
        return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, env=env, cwd=cwd)

    def card_path(self, slug='order-export'):
        return os.path.join(self.main + '-worktrees', slug, '.desk', 'CARD.md')

    def fill_spec(self, path):
        s = read(path)
        s = s.replace('| AC-1 | <前提：角色、資料、狀態> | <操作或事件> | <看得到的結果：畫面、回應、資料、log> | `<測試名稱>` |', '| AC-1 | 管理員 | 匯出訂單 | 下載 CSV | `export csv`（新） |')
        s = s.replace('| AC-2 | | | | |', '| AC-2 | 一般會員 | 匯出訂單 | 403 | `export forbidden`（新） |')
        write(path, s)

    def fill_plan(self, path):
        s = read(path)
        s = s.replace('| `<路徑>` | <改什麼、為什麼> |', '| `api/export.py` | 加 CSV 匯出與權限檢查 |')
        write(path, s)

    def test_new_creates_worktree_card_registry_row_and_excludes(self):
        self.write_settings({'card': {'check': 'make test SLUG={slug}'}})
        r = self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        self.assertEqual(r.returncode, 0, r.stderr)
        card = self.card_path()
        self.assertTrue(os.path.isfile(card))
        self.assertIn('# 訂單匯出 DESK', read(card))
        self.assertIn(f'| 訂單匯出 | `{card}` |', read(self.reg))
        exclude = read(os.path.join(self.main, '.git', 'info', 'exclude'))
        self.assertIn('.desk/\n', exclude)
        self.assertIn('.task/\n', exclude)
        self.assertIn('建議完成檢查：make test SLUG=order-export', r.stdout)
        self.assertIn('/desk:card spec order-export', r.stdout)
        # 同一個分支再開一次要拒絕
        self.assertNotEqual(self.run_card('new', 'feature/order-export', '訂單匯出').returncode, 0)

    def test_new_fills_card_name_when_custom_template_uses_legacy_placeholder(self):
        """0.24.0 以前的自訂模板（card.template）卡名佔位是舊的寫法，開卡時照樣換成卡名。"""
        legacy = '<案名>'  # LEGACY_NAME_SLOT：0.24.0 以前模板的卡名佔位
        tpl = os.path.join(self.t, 'old-template.md')
        write(tpl, read(TEMPLATE).replace('<任務名>', legacy))
        self.write_settings({'card': {'template': tpl}})

        r = self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')

        self.assertEqual(r.returncode, 0, r.stderr)
        card = read(self.card_path())
        self.assertIn('# 訂單匯出 DESK', card)
        self.assertNotIn(legacy, card)

    def test_project_comes_from_the_repo_and_worktrees_share_it(self):
        # 全域設定只有人名；主 repo 寫在專案的 dispatch.json，登錄表還不存在
        write(self.settings, json.dumps({'user': 'Alex'}))
        project = os.path.join(self.t, '.claude', 'handoffs', 'shop')
        os.makedirs(project)
        write(os.path.join(project, 'dispatch.json'), json.dumps({'card': {'main': self.main}}))
        # 專案設定用記事本這類編輯器存成帶 BOM 的 UTF-8 也要讀得到
        write(os.path.join(project, 'dispatch.json'), '\ufeff' + read(os.path.join(project, 'dispatch.json')))
        r = self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main', cwd=self.main, detect=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        registry = os.path.join(project, 'projects-scope.md')
        self.assertIn(f'| 訂單匯出 | `{self.card_path()}` |', read(registry))
        # 在 worktree 裡也是同一個專案、同一份登錄表，全域與專案設定都有
        info = self.run_card('card', 'order-export', cwd=os.path.dirname(os.path.dirname(self.card_path())), detect=True)
        self.assertEqual(info.returncode, 0, info.stderr)
        self.assertIn('user: Alex', info.stdout)
        self.assertIn('branch: feature/order-export', info.stdout)

    def test_outside_a_repo_says_to_run_inside_one(self):
        write(self.settings, json.dumps({}))
        outside = os.path.join(self.t, 'notes')
        os.makedirs(outside)
        r = self.run_card('card', 'x', cwd=outside, detect=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('不在 git repo 裡', r.stderr)

    def test_new_without_main_says_how_to_set_it(self):
        write(self.settings, json.dumps({'card': {'registry': self.reg}}))
        r = self.run_card('new', 'feature/x', 'X')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('card', r.stderr)
        self.assertIn('main', r.stderr)

    def test_spec_flow_gate_then_ok_writes_decision_with_configured_user(self):
        self.write_settings({'user': 'Alex', 'card': {'specRules': ['寫入操作要有稽核紀錄']}})
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        card = self.card_path()
        info = self.run_card('card', 'order-export').stdout
        self.assertIn('format: DESK', info)
        self.assertIn('branch: feature/order-export', info)
        self.assertIn('user: Alex', info)
        self.assertIn('rule: 寫入操作要有稽核紀錄', info)
        self.assertEqual(self.run_card('spec-init', 'order-export').stdout.strip(), f'已有「## 規格」：{card}')
        # 關卡不是 spec：拒絕；AC 還空著：拒絕
        self.assertNotEqual(self.run_card('spec-ok', 'order-export').returncode, 0)
        self.run_card('gate', 'order-export', 'spec：待確認規格')
        self.assertIn('沒有填好的驗收情境', self.run_card('spec-ok', 'order-export').stderr)
        self.fill_spec(card)
        self.fill_plan(card)
        r = self.run_card('spec-ok', '訂單')
        self.assertEqual(r.returncode, 0, r.stderr)
        text = read(card)
        self.assertIn('- 關卡：無', text)
        self.assertIn('- 狀態：規格已確認（AC-1～AC-2），可派實作', text)
        self.assertRegex(text, r'- D-02 \d{4}-\d{2}-\d{2} Alex：確認規格（AC-1～AC-2，共 2 條）與實作計畫（1 項）')

    def test_spec_ok_refuses_without_plan(self):
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        card = self.card_path()
        # 拿掉規格段，讓 spec-init 從模板插入空白規格段（含「### 實作計畫」範本）
        s = read(card)
        start, end = s.index('## 規格'), s.index('## Scope')
        write(card, s[:start] + s[end:])
        self.assertIn('已插入空白規格段', self.run_card('spec-init', 'order-export').stdout)
        self.assertIn('### 實作計畫', read(card))
        self.run_card('gate', 'order-export', 'spec：待確認規格（AC-1～AC-2）')
        self.fill_spec(card)
        before = read(card)
        r = self.run_card('spec-ok', 'order-export')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('沒有實作計畫', r.stderr)
        self.assertEqual(read(card), before)
        self.fill_plan(card)
        r = self.run_card('spec-ok', 'order-export')
        self.assertEqual(r.returncode, 0, r.stderr)
        text = read(card)
        self.assertIn('- 關卡：無', text)
        self.assertRegex(text, r'- D-\d+ \d{4}-\d{2}-\d{2} \S+：確認規格（AC-1～AC-2，共 2 條）與實作計畫（1 項）')

    def test_spec_ok_counts_plan_rows_without_relying_on_header_text(self):
        """計畫表的表頭不是「檔案」（自訂模板改了欄名）：表格第一列一律當表頭，不算成一項。"""
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        card = self.card_path()
        self.run_card('gate', 'order-export', 'spec：待確認規格（AC-1～AC-2）')
        self.fill_spec(card)
        self.fill_plan(card)
        write(card, read(card).replace('| 檔案 | 改什麼 |', '| 路徑 | 做什麼 |'))

        r = self.run_card('spec-ok', 'order-export')

        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertRegex(read(card), r'- D-\d+ \d{4}-\d{2}-\d{2} \S+：確認規格（AC-1～AC-2，共 2 條）與實作計畫（1 項）')

    def test_spec_ok_replaces_placeholder_next(self):
        """下一步還是範本佔位 `<…>`：確認規格時一起改成「依規格與實作計畫實作」。"""
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        card = self.card_path()
        self.assertRegex(read(card), r'- 下一步：<[^>\n]+>')
        self.run_card('gate', 'order-export', 'spec：待確認規格（AC-1～AC-2）')
        self.fill_spec(card)
        self.fill_plan(card)

        r = self.run_card('spec-ok', 'order-export')

        self.assertEqual(r.returncode, 0, r.stderr)
        text = read(card)
        self.assertIn('- 下一步：依規格與實作計畫實作', text)
        self.assertIn('- 狀態：規格已確認（AC-1～AC-2），可派實作', text)
        self.assertIn('- 關卡：無', text)

    def test_spec_ok_keeps_real_next(self):
        """下一步已經是具體的一句：確認規格時不動它。"""
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        card = self.card_path()
        write(card, re.sub(r'^- 下一步：.*$', '- 下一步：先做 CSV 匯出', read(card), count=1, flags=re.M))
        self.run_card('gate', 'order-export', 'spec：待確認規格（AC-1～AC-2）')
        self.fill_spec(card)
        self.fill_plan(card)

        r = self.run_card('spec-ok', 'order-export')

        self.assertEqual(r.returncode, 0, r.stderr)
        text = read(card)
        self.assertIn('- 下一步：先做 CSV 匯出', text)
        self.assertNotIn('依規格與實作計畫實作', text)

    def confirmed_card_with_commit(self):
        """規格已確認、分支有一個新 commit 的卡；回傳 (卡片路徑, worktree)。"""
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        card = self.card_path()
        wt = os.path.dirname(os.path.dirname(card))
        self.run_card('gate', 'order-export', 'spec：待確認規格')
        self.fill_spec(card)
        self.fill_plan(card)
        self.assertEqual(self.run_card('spec-ok', 'order-export').returncode, 0)
        git('config', 'user.email', 't@example.com', cwd=wt)
        git('config', 'user.name', 't', cwd=wt)
        write(os.path.join(wt, 'export.py'), 'x = 1\n')
        git('add', 'export.py', cwd=wt)
        git('commit', '-q', '-m', 'feat: 匯出', cwd=wt)
        return card, wt

    def review_file(self, wt, after_head):
        """寫 .task/REVIEW.md，修改時間在 HEAD 的 commit 之後（after_head）或之前。"""
        path = os.path.join(wt, '.task', 'REVIEW.md')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write(path, '# 審查\n')
        head_at = int(subprocess.run(['git', 'log', '-1', '--format=%ct'], cwd=wt, capture_output=True, text=True).stdout.strip())
        at = head_at + 60 if after_head else head_at - 60
        os.utime(path, (at, at))

    def test_done_writes_status_next_and_history(self):
        card, wt = self.confirmed_card_with_commit()
        write(card, read(card).replace('- 等你：無', '- 等你：要不要分頁？'))
        write(card, re.sub(r'^- 檢查：.*$', '- 檢查：`make test`', read(card), count=1, flags=re.M))
        before = read(card)
        block = lambda s: s[s.index('<!-- DESK'):s.index('<!-- /DESK -->')]
        sha = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=wt, capture_output=True, text=True).stdout.strip()

        r = self.run_card('done', 'order-export', 'CSV', '匯出做完，測試綠')

        self.assertEqual(r.returncode, 0, r.stderr)
        text = read(card)
        self.assertIn('- 狀態：CSV 匯出做完，測試綠\n', text)
        self.assertIn('- 下一步：到面板按 v 執行完成檢查\n', text)
        for name in ('等你', '關卡', '檢查'):
            line = re.search(rf'^- {name}：.*$', block(before), re.M).group(0)
            self.assertIn(line, block(text), name)
        history = text[text.index('## History'):]
        today = datetime.date.today().isoformat()
        self.assertIn(f'- {today}：/desk:card done（feature/order-export {sha}）：CSV 匯出做完，測試綠\n', history)
        self.assertNotIn('未提交', history)

    def test_done_after_passed_review_says_the_flow_rechecks(self):
        # done-next-step AC-1：審查已過關、審查檔之後有新 commit，流程會自動重新檢查與審查；沒動靜才按 v。
        card, wt = self.confirmed_card_with_commit()
        self.review_file(wt, after_head=False)
        self.run_card('gate', 'order-export', 'review：CRITICAL 0、HIGH 0、MEDIUM 2、LOW 1；過關')
        write(card, read(card).replace('- 等你：無', '- 等你：要不要分頁？'))
        write(card, re.sub(r'^- 檢查：.*$', '- 檢查：`make test`', read(card), count=1, flags=re.M))
        before = read(card)
        block = lambda s: s[s.index('<!-- DESK'):s.index('<!-- /DESK -->')]
        sha = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=wt, capture_output=True, text=True).stdout.strip()

        r = self.run_card('done', 'order-export', '修好審查提到的 MEDIUM')

        self.assertEqual(r.returncode, 0, r.stderr)
        text = read(card)
        self.assertIn('- 狀態：修好審查提到的 MEDIUM\n', text)
        self.assertIn('- 下一步：等自動重新檢查與審查；沒動靜就到面板按 v\n', text)
        self.assertIn('  下一步：等自動重新檢查與審查；沒動靜就到面板按 v\n', r.stdout)
        for name in ('等你', '關卡', '檢查'):
            line = re.search(rf'^- {name}：.*$', block(before), re.M).group(0)
            self.assertIn(line, block(text), name)
        today = datetime.date.today().isoformat()
        self.assertIn(f'- {today}：/desk:card done（feature/order-export {sha}）：修好審查提到的 MEDIUM\n', text[text.index('## History'):])

    def test_done_after_passed_review_without_new_commit_points_to_merge(self):
        # done-next-step AC-5：審查過關但審查檔之後沒有新 commit，或沒有審查檔（關卡是對話自己寫的）：面板停在合併段，不會重新檢查。
        merge = '到面板照「輪到你」開 PR 或合併'
        card, wt = self.confirmed_card_with_commit()
        self.review_file(wt, after_head=True)
        self.run_card('gate', 'order-export', 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；過關')
        for how in ('審查後沒有新 commit', '沒有審查檔'):
            with self.subTest(how):
                if how == '沒有審查檔':
                    os.remove(os.path.join(wt, '.task', 'REVIEW.md'))

                r = self.run_card('done', 'order-export', '只更新卡片')

                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn(f'- 下一步：{merge}\n', read(card))
                self.assertIn(f'  下一步：{merge}\n', r.stdout)

    def test_done_with_blocking_review_still_says_press_v(self):
        # done-next-step AC-2：審查有擋的、結論缺分級，下一步照舊叫你按 v。
        card, _ = self.confirmed_card_with_commit()
        for gate in ('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；要修', 'review：CRITICAL 1、HIGH 0、MEDIUM 0、LOW 0；要修', 'review：CRITICAL 0、HIGH 0、MEDIUM 1；過關', 'review：過關'):
            self.run_card('gate', 'order-export', gate)
            r = self.run_card('done', 'order-export', '修好一半')
            self.assertEqual(r.returncode, 0, r.stderr)
            text = read(card)
            self.assertIn('- 下一步：到面板按 v 執行完成檢查\n', text, gate)
            self.assertIn('  下一步：到面板按 v 執行完成檢查\n', r.stdout, gate)
            self.assertIn(f'- 關卡：{gate}\n', text, gate)

    def test_done_refuses_before_spec_confirmed(self):
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        card = self.card_path()
        # 關卡是 spec：…（AC 已填）
        self.run_card('gate', 'order-export', 'spec：待確認規格')
        self.fill_spec(card)
        before = read(card)
        r = self.run_card('done', 'order-export', '做完了')
        self.assertEqual(r.returncode, 1)
        self.assertIn('先確認規格（按 t 或 /desk:card spec order-export ok）', r.stderr)
        self.assertEqual(read(card), before)
        # 關卡是無，但規格段認不到填好的 AC
        self.run_card('gate', 'order-export', '無')
        write(card, read(card).replace('| AC-1 | 管理員 | 匯出訂單 | 下載 CSV |', '| AC-1 | | | |').replace('| AC-2 | 一般會員 | 匯出訂單 | 403 |', '| AC-2 | | | |'))
        before = read(card)
        r = self.run_card('done', 'order-export', '做完了')
        self.assertEqual(r.returncode, 1)
        self.assertIn('先確認規格（按 t 或 /desk:card spec order-export ok）', r.stderr)
        self.assertEqual(read(card), before)

    def test_done_refuses_status_with_commit_or_ac_codes(self):
        # one-next-step AC-4：狀態只寫發生了什麼；commit、AC／D 編號寫在 History。
        card, _ = self.confirmed_card_with_commit()
        before = read(card)
        for status in ('MEDIUM 照 D-04 修好（52d89ce）', 'AC-3 做完', '修好 a1b2c3d 那次的問題'):
            r = self.run_card('done', 'order-export', status)
            self.assertNotEqual(r.returncode, 0, status)
            self.assertIn('狀態不放 commit／AC／D 編號（寫在 History）', r.stderr)
            self.assertEqual(read(card), before, status)

        r = self.run_card('done', 'order-export', '修好審查提到的 MEDIUM；本機測試全過')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('- 狀態：修好審查提到的 MEDIUM；本機測試全過\n', read(card))

    def test_new_card_rules_say_status_is_what_happened(self):
        # one-next-step AC-5 的範本那半：開新卡的「卡片規則」與派工提示（hooks/dispatch.ts）寫同一句。
        rule = '狀態只寫發生了什麼，不寫下一步，也不寫 commit 編號、AC／D 編號'
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        text = read(self.card_path())
        rules = text[text.index('## 卡片規則'):text.index('## 規格')]
        self.assertIn(rule, rules)
        self.assertIn(rule, read(os.path.join(os.path.dirname(os.path.dirname(TEMPLATE)), 'hooks', 'dispatch.ts')))

    def test_done_notes_uncommitted_files(self):
        card, wt = self.confirmed_card_with_commit()
        write(os.path.join(wt, 'export.py'), 'x = 2\n')
        write(os.path.join(wt, 'new.py'), 'y = 1\n')

        r = self.run_card('done', 'order-export', '匯出做一半')

        self.assertEqual(r.returncode, 0, r.stderr)
        text = read(card)
        self.assertIn('- 狀態：匯出做一半\n', text)
        self.assertRegex(text[text.index('## History'):], r'- \d{4}-\d{2}-\d{2}：/desk:card done（feature/order-export [0-9a-f]+）：匯出做一半；有 2 個檔未提交\n')

    def test_old_card_gate_bumps_rev(self):
        os.makedirs(os.path.join(self.t, 'old', '.console'))
        old = os.path.join(self.t, 'old', '.console', 'STATUS.md')
        write(old, '# Old\n\n<!-- CARD -->\n- 更新：2026-10-01 09:00 · rev 3 · x\n- 狀態：a\n- 關卡：無\n<!-- /CARD -->\n')
        write(self.reg, f'| 舊案 | `{old}` |\n', 'a')
        self.assertEqual(self.run_card('gate', '舊案', 'spec：待確認規格').returncode, 0)
        text = read(old)
        self.assertIn('- 關卡：spec：待確認規格', text)
        self.assertRegex(text, r'- 更新：.* · rev 4 · desk-card')

    def test_archive_copies_card_and_reviews_and_moves_registry_row(self):
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        task = os.path.join(self.main + '-worktrees', 'order-export', '.task')
        write(os.path.join(task, 'REVIEW.md'), '- [LOW] x\n')
        r = self.run_card('archive', 'order-export')
        self.assertEqual(r.returncode, 0, r.stderr)
        archive = os.path.join(self.t, 'archive')
        self.assertTrue(os.path.isfile(os.path.join(archive, 'order-export-CARD.md')))
        self.assertTrue(os.path.isfile(os.path.join(archive, 'order-export-REVIEW.md')))
        reg = read(self.reg)
        self.assertNotIn('| 訂單匯出 |', reg)
        self.assertIn('## 已歸檔的卡', reg)
        self.assertIn('worktree remove', r.stdout)
        # worktree 不會被刪
        self.assertTrue(os.path.isdir(os.path.join(self.main + '-worktrees', 'order-export')))
        # 沒有 PLAN／REPORT 時照常成功，不多出檔案
        self.assertFalse(os.path.exists(os.path.join(archive, 'order-export-PLAN.md')))
        self.assertFalse(os.path.exists(os.path.join(archive, 'order-export-REPORT.md')))

    def test_archive_copies_plan_and_report(self):
        """.task/PLAN.md、REPORT.md 跟審查檔一樣帶走，檔名 <slug>-PLAN.md、<slug>-REPORT.md。"""
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        task = os.path.join(self.main + '-worktrees', 'order-export', '.task')
        write(os.path.join(task, 'PLAN.md'), '# 計畫\n- 改 api\n')
        write(os.path.join(task, 'REPORT.md'), '# 報告\n- 12 pass\n')
        write(os.path.join(task, 'REVIEW.md'), '- [LOW] x\n')
        write(os.path.join(task, 'notes.md'), 'x\n')

        r = self.run_card('archive', 'order-export')

        self.assertEqual(r.returncode, 0, r.stderr)
        archive = os.path.join(self.t, 'archive')
        self.assertEqual(read(os.path.join(archive, 'order-export-PLAN.md')), '# 計畫\n- 改 api\n')
        self.assertEqual(read(os.path.join(archive, 'order-export-REPORT.md')), '# 報告\n- 12 pass\n')
        self.assertTrue(os.path.isfile(os.path.join(archive, 'order-export-REVIEW.md')))
        self.assertFalse(os.path.exists(os.path.join(archive, 'order-export-notes.md')))

    def test_archive_reminds_filled_deploy_steps(self):
        """卡片「## 部署步驟」有 2 項已填（另有一項空白 1.）：照常歸檔，印出筆數、逐項列出與搬移提醒。"""
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        card = os.path.join(self.main + '-worktrees', 'order-export', '.desk', 'CARD.md')
        text = read(card)
        self.assertIn('## 部署步驟', text)
        head = text.index('## 部署步驟')
        rest = text.index('\n## ', head + 1)
        write(card, text[:head] + '## 部署步驟（合併後）\n\n1.\n2. php artisan migrate\n3. 重啟 queue worker\n' + text[rest:])

        r = self.run_card('archive', 'order-export')

        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.isfile(os.path.join(self.t, 'archive', 'order-export-CARD.md')))
        self.assertNotIn('| 訂單匯出 |', read(self.reg))
        self.assertIn('部署步驟 2 項', r.stdout)
        self.assertIn('  1. php artisan migrate\n  2. 重啟 queue worker\n', r.stdout)
        self.assertIn('請確認已搬到發版線卡片或登錄表「## 提醒」', r.stdout)
        self.assertIn('worktree remove', r.stdout)

    def test_archive_without_deploy_steps_prints_no_reminder(self):
        """範本的部署步驟只有空白 1.：照常歸檔，不出現提醒。"""
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')

        r = self.run_card('archive', 'order-export')

        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn('部署步驟', r.stdout)
        self.assertNotIn('發版線卡片', r.stdout)

    def open_case(self, branch, name, merged=False):
        """開卡、在 worktree commit 一次；merged=True 時在主 repo 用 --no-ff 併進 main。回傳 worktree 路徑。"""
        self.run_card('new', branch, name, 'origin/main')
        slug = branch.rsplit('/', 1)[-1]
        wt = os.path.join(self.main + '-worktrees', slug)
        write(os.path.join(wt, f'{slug}.txt'), 'x\n')
        git('add', f'{slug}.txt', cwd=wt)
        git('commit', '-q', '-m', f'{slug}', cwd=wt)
        if merged:
            git('merge', '-q', '--no-ff', '-m', f'merge {branch}', branch, cwd=self.main)
        return wt

    def worktrees(self):
        out = subprocess.run(['git', 'worktree', 'list', '--porcelain'], cwd=self.main, capture_output=True, text=True, check=True).stdout
        return [os.path.realpath(l[len('worktree '):]) for l in out.splitlines() if l.startswith('worktree ')]

    def branch_listed(self, branch):
        return subprocess.run(['git', 'branch', '--list', branch], cwd=self.main, capture_output=True, text=True, check=True).stdout.strip()

    def test_archive_cleanup_removes_worktree_and_branch_when_merged_and_clean(self):
        """AC-1：已合併、乾淨的 Beta：歸檔副本留著，worktree 與分支移除，登錄表那行寫已移除。"""
        wt = self.open_case('feature/beta', 'Beta', merged=True)
        card = self.card_path('beta')
        write(card, re.sub(r'^- 狀態：.*$', '- 狀態：已發版 v0.38.0，CI 通過', read(card), count=1, flags=re.M))
        write(os.path.join(wt, '.task', 'REVIEW.md'), '- [LOW] x\n')

        r = self.run_card('archive', 'beta', '--cleanup', cwd=self.main)

        self.assertEqual(r.returncode, 0, r.stderr)
        archive = os.path.join(self.t, 'archive')
        self.assertIn('已發版 v0.38.0，CI 通過', read(os.path.join(archive, 'beta-CARD.md')))
        self.assertTrue(os.path.isfile(os.path.join(archive, 'beta-REVIEW.md')))
        reg = read(self.reg)
        self.assertNotIn('| Beta |', reg)
        self.assertRegex(reg, r'(?m)^- beta：.*worktree 與分支已移除$')
        self.assertNotIn(os.path.realpath(wt), self.worktrees())
        self.assertFalse(os.path.exists(wt))
        self.assertEqual(self.branch_listed('feature/beta'), '')
        self.assertIn('清理 beta：worktree 已移除；分支 feature/beta 已刪除', r.stdout)

    def test_archive_cleanup_keeps_worktree_and_branch_when_dirty_or_unmerged(self):
        """AC-2：Beta 已合併但有未提交的改動、Gamma 乾淨但沒併入 main：兩張都歸檔，worktree 與分支都保留，提醒寫原因與自己刪的指令。"""
        beta = self.open_case('feature/beta', 'Beta', merged=True)
        gamma = self.open_case('feature/gamma', 'Gamma')
        write(os.path.join(beta, 'beta.txt'), 'changed\n')

        r = self.run_card('archive', 'beta', 'gamma', '--cleanup', cwd=self.main)

        self.assertEqual(r.returncode, 0, r.stderr)
        archive = os.path.join(self.t, 'archive')
        self.assertTrue(os.path.isfile(os.path.join(archive, 'beta-CARD.md')))
        self.assertTrue(os.path.isfile(os.path.join(archive, 'gamma-CARD.md')))
        reg = read(self.reg)
        self.assertNotIn('| Beta |', reg)
        self.assertNotIn('| Gamma |', reg)
        archived = reg[reg.index('## 已歸檔的卡'):]
        self.assertRegex(archived, r'(?m)^- beta：.*；worktree 保留：有未提交的改動（1 個檔）$')
        self.assertRegex(archived, r'(?m)^- gamma：.*；worktree 保留：分支還沒併入 main$')
        # worktree、那個改動與分支都還在
        self.assertEqual(read(os.path.join(beta, 'beta.txt')), 'changed\n')
        self.assertIn(os.path.realpath(beta), self.worktrees())
        self.assertIn(os.path.realpath(gamma), self.worktrees())
        self.assertNotEqual(self.branch_listed('feature/beta'), '')
        self.assertNotEqual(self.branch_listed('feature/gamma'), '')
        self.assertRegex(r.stdout, r'(?m)^清理 beta：.*有未提交的改動（1 個檔）')
        self.assertRegex(r.stdout, r'(?m)^清理 gamma：.*分支還沒併入 main')
        # 登錄表「## 提醒」兩行，各附自己刪的指令，不含 --force／-D
        reminders = reg[reg.index('## 提醒'):]
        lines = [l for l in reminders.splitlines() if l.startswith('- 清理 ')]
        self.assertEqual(len(lines), 2, reminders)
        for line, wt, branch in ((lines[0], beta, 'feature/beta'), (lines[1], gamma, 'feature/gamma')):
            self.assertIn(f'git -C {self.main} worktree remove {wt}', line)
            self.assertIn(f'git -C {self.main} branch -d {branch}', line)
            self.assertNotIn('--force', line)
            self.assertNotIn(' -D', line)
        self.assertTrue(lines[0].startswith('- 清理 beta：有未提交的改動（1 個檔）'))
        self.assertTrue(lines[1].startswith('- 清理 gamma：分支還沒併入 main'))

    def test_archive_cleanup_leaves_main_worktree_and_unlisted_cards_when_out_of_scope(self):
        """AC-3：主 repo 的卡照常歸檔但主 worktree 不動；沒列到的 Delta 不動；有拼錯的 slug 時整批不做。"""
        main_card = os.path.join(self.main, '.desk', 'CARD.md')
        os.makedirs(os.path.dirname(main_card))
        write(main_card, read(TEMPLATE).replace('<任務名>', '主線'))
        write(self.reg, read(self.reg) + f'| 主線 | `{main_card}` |\n')
        delta = self.open_case('feature/delta', 'Delta', merged=True)
        beta = self.open_case('feature/beta', 'Beta', merged=True)
        delta_row = next(l for l in read(self.reg).splitlines() if l.startswith('| Delta |'))

        r = self.run_card('archive', 'main', '--cleanup', cwd=self.main)

        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('主 worktree 不移除', r.stdout)
        self.assertTrue(os.path.isfile(os.path.join(self.t, 'archive', 'main-CARD.md')))
        self.assertNotIn('| 主線 |', read(self.reg))
        self.assertIn(os.path.realpath(self.main), self.worktrees())
        self.assertTrue(os.path.isfile(main_card))
        self.assertNotEqual(self.branch_listed('main'), '')
        # Delta 沒列：worktree、分支與登錄表列一字不變
        self.assertIn(delta_row, read(self.reg).splitlines())
        self.assertIn(os.path.realpath(delta), self.worktrees())
        self.assertNotEqual(self.branch_listed('feature/delta'), '')

        before = read(self.reg)
        r = self.run_card('archive', 'beta', 'nope', '--cleanup', cwd=self.main)

        self.assertNotEqual(r.returncode, 0)
        self.assertIn('找不到唯一的任務「nope」', r.stderr)
        self.assertIn('Beta', r.stderr)
        self.assertEqual(read(self.reg), before)
        self.assertFalse(os.path.exists(os.path.join(self.t, 'archive', 'beta-CARD.md')))
        self.assertIn(os.path.realpath(beta), self.worktrees())
        self.assertNotEqual(self.branch_listed('feature/beta'), '')

    def test_archive_cleanup_removes_worktree_and_keeps_branch_when_squash_merged(self):
        """squash 合併（審查 MEDIUM，D-04）：分支不是 main 的祖先但內容已在 main，worktree 照樣移除；branch -d 認不出，分支保留並寫明原因。"""
        beta = self.open_case('feature/beta', 'Beta')
        git('merge', '-q', '--squash', 'feature/beta', cwd=self.main)
        git('commit', '-q', '-m', 'Beta (#12)', cwd=self.main)
        write(os.path.join(self.main, 'later.txt'), 'x\n')
        git('add', 'later.txt', cwd=self.main)
        git('commit', '-q', '-m', 'later', cwd=self.main)

        r = self.run_card('archive', 'beta', '--cleanup', cwd=self.main)

        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.isfile(os.path.join(self.t, 'archive', 'beta-CARD.md')))
        self.assertNotIn(os.path.realpath(beta), self.worktrees())
        self.assertFalse(os.path.exists(beta))
        self.assertNotEqual(self.branch_listed('feature/beta'), '')
        self.assertIn('清理 beta：worktree 已移除；分支 feature/beta 保留：squash／rebase 合併，git branch -d 認不出已併入', r.stdout)
        reg = read(self.reg)
        self.assertRegex(reg, r'(?m)^- beta：.*；worktree 已移除，分支 feature/beta 保留：squash／rebase 合併')
        reminders = [l for l in reg[reg.index('## 提醒'):].splitlines() if l.startswith('- 清理 ')]
        self.assertEqual(len(reminders), 1, reg)
        self.assertIn('squash／rebase 合併', reminders[0])
        self.assertIn(f'git -C {self.main} branch -D feature/beta', reminders[0])
        self.assertNotIn('worktree remove', reminders[0])

    def commit_fragment(self, wt, slug):
        os.makedirs(os.path.join(wt, 'changelog.d'), exist_ok=True)
        write(os.path.join(wt, 'changelog.d', f'{slug}.md'), f'- 新增 {slug}\n')
        git('add', 'changelog.d', cwd=wt)
        git('commit', '-q', '-m', f'{slug} changelog', cwd=wt)

    def test_archive_cleanup_removes_worktree_when_squash_merged_and_fragment_released(self):
        """squash 合併後發版（審查 HIGH）：changelog 把片段檔合進 CHANGELOG 並刪掉，worktree 照樣移除、分支保留；
        沒合併、只寫了片段的分支照舊兩樣都保留。"""
        beta = self.open_case('feature/beta', 'Beta')
        self.commit_fragment(beta, 'beta')
        gamma = self.open_case('feature/gamma', 'Gamma')
        os.remove(os.path.join(gamma, 'gamma.txt'))
        git('commit', '-q', '-am', 'drop gamma.txt', cwd=gamma)
        self.commit_fragment(gamma, 'gamma')
        git('merge', '-q', '--squash', 'feature/beta', cwd=self.main)
        git('commit', '-q', '-m', 'Beta (#12)', cwd=self.main)
        # 發版：片段合進 CHANGELOG、刪掉片段檔、改版號，一起 commit（docs/WORKFLOW.md 發版第 2、5 步）。
        git('rm', '-q', 'changelog.d/beta.md', cwd=self.main)
        write(os.path.join(self.main, 'CHANGELOG.md'), '## 0.38.0\n\n- 新增 beta\n')
        git('add', 'CHANGELOG.md', cwd=self.main)
        git('commit', '-q', '-m', 'chore: 更新 版號為 0.38.0 並整理 CHANGELOG', cwd=self.main)

        r = self.run_card('archive', 'beta', 'gamma', '--cleanup', cwd=self.main)

        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn(os.path.realpath(beta), self.worktrees())
        self.assertNotEqual(self.branch_listed('feature/beta'), '')
        self.assertIn('清理 beta：worktree 已移除；分支 feature/beta 保留：squash／rebase 合併，git branch -d 認不出已併入', r.stdout)
        self.assertIn(os.path.realpath(gamma), self.worktrees())
        self.assertNotEqual(self.branch_listed('feature/gamma'), '')
        self.assertIn('清理 gamma：worktree 與分支保留：分支還沒併入 main', r.stdout)

    def commit_shared_file(self):
        """主 repo 加一支 20 行的 app.txt 並推到 origin，之後開的卡都從這裡分叉。"""
        write(os.path.join(self.main, 'app.txt'), ''.join(f'{i}\n' for i in range(1, 21)))
        git('add', 'app.txt', cwd=self.main)
        git('commit', '-q', '-m', 'app', cwd=self.main)
        git('push', '-q', 'origin', 'main', cwd=self.main)

    def change_line(self, wt, line, text):
        path = os.path.join(wt, 'app.txt')
        lines = read(path).splitlines(keepends=True)
        lines[line - 1] = f'{text}\n'
        write(path, ''.join(lines))
        git('commit', '-q', '-am', f'app line {line}', cwd=wt)

    def squash(self, branch, title):
        git('merge', '-q', '--squash', branch, cwd=self.main)
        git('commit', '-q', '-m', title, cwd=self.main)

    def test_archive_cleanup_removes_worktree_when_squash_merged_and_later_card_changed_adjacent_line(self):
        """同一版裡後合併的卡改到相鄰行（審查 MEDIUM，D-05）：Beta 改第 10 行先 squash，Delta 改第 11 行、
        先把 main 併進來解衝突再 squash；兩張都照樣移除 worktree、分支保留，不會被判「分支還沒併入 main」。"""
        self.commit_shared_file()
        beta = self.open_case('feature/beta', 'Beta')
        self.change_line(beta, 10, 'beta')
        delta = self.open_case('feature/delta', 'Delta')
        self.change_line(delta, 11, 'delta')
        self.squash('feature/beta', 'Beta (#12)')
        subprocess.run(['git', 'merge', '-q', '--no-ff', '--no-commit', 'main'], cwd=delta, capture_output=True)
        resolved = ''.join(f'{i}\n' for i in range(1, 21)).replace('10\n11\n', 'beta\ndelta\n')
        write(os.path.join(delta, 'app.txt'), resolved)
        git('add', 'app.txt', cwd=delta)
        git('commit', '-q', '--no-edit', cwd=delta)
        self.squash('feature/delta', 'Delta (#13)')
        self.assertEqual(read(os.path.join(self.main, 'app.txt')), resolved)

        r = self.run_card('archive', 'beta', 'delta', '--cleanup', cwd=self.main)

        self.assertEqual(r.returncode, 0, r.stderr)
        for slug, wt in (('beta', beta), ('delta', delta)):
            self.assertNotIn(os.path.realpath(wt), self.worktrees(), r.stdout)
            self.assertNotEqual(self.branch_listed(f'feature/{slug}'), '')
            self.assertIn(f'清理 {slug}：worktree 已移除；分支 feature/{slug} 保留：squash／rebase 合併，git branch -d 認不出已併入', r.stdout)
        self.assertNotIn('還沒併入', r.stdout)

    def test_archive_cleanup_keeps_worktree_and_branch_when_squash_merged_then_reverted(self):
        """squash 合併後 main 又 revert 了那張（D-05 的反例）：內容已不在 main，照舊判「分支還沒併入 main」、兩樣都保留。"""
        self.commit_shared_file()
        beta = self.open_case('feature/beta', 'Beta')
        self.change_line(beta, 10, 'beta')
        self.squash('feature/beta', 'Beta (#12)')
        git('revert', '--no-edit', 'HEAD', cwd=self.main)

        r = self.run_card('archive', 'beta', '--cleanup', cwd=self.main)

        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(os.path.realpath(beta), self.worktrees())
        self.assertNotEqual(self.branch_listed('feature/beta'), '')
        self.assertIn('清理 beta：worktree 與分支保留：分支還沒併入 main', r.stdout)

    def merge_main_resolving(self, wt, changes):
        """把 main 併進 worktree；app.txt 衝突時改成 changes（行號 → 文字）解掉，再 commit。"""
        subprocess.run(['git', 'merge', '-q', '--no-ff', '--no-commit', 'main'], cwd=wt, capture_output=True)
        write(os.path.join(wt, 'app.txt'), ''.join(f'{changes.get(i, i)}\n' for i in range(1, 21)))
        git('add', 'app.txt', cwd=wt)
        git('commit', '-q', '--no-edit', cwd=wt)

    def rebase_merge(self, branch):
        """模擬 PR 用 rebase 方式合併：分支的 commit 逐一 cherry-pick 到 main。"""
        git('cherry-pick', f'main..{branch}', cwd=self.main)

    def assert_squash_kept_branch(self, r, slug, wt):
        self.assertNotIn(os.path.realpath(wt), self.worktrees(), r.stdout)
        self.assertNotEqual(self.branch_listed(f'feature/{slug}'), '')
        self.assertIn(f'清理 {slug}：worktree 已移除；分支 feature/{slug} 保留：squash／rebase 合併，git branch -d 認不出已併入', r.stdout)

    def test_archive_cleanup_removes_worktree_when_squash_merged_after_other_card_changed_nearby_line(self):
        """審查 MEDIUM，D-06：squash 前已有別張卡改到 Beta 改動上下 3 行內。Xray 改第 8 行先 squash，Beta 改第 10 行接著 squash
        （squash commit 的 diff 上下文含 Xray 的第 8 行，跟分支的整體改動上下文不同），之後 Delta 改第 11 行、併 main 解衝突再 squash；
        三張都照樣移除 worktree、分支保留，Beta 不會被判「分支還沒併入 main」。"""
        self.commit_shared_file()
        xray = self.open_case('feature/xray', 'Xray')
        self.change_line(xray, 8, 'xray')
        beta = self.open_case('feature/beta', 'Beta')
        self.change_line(beta, 10, 'beta')
        delta = self.open_case('feature/delta', 'Delta')
        self.change_line(delta, 11, 'delta')
        self.squash('feature/xray', 'Xray (#11)')
        self.squash('feature/beta', 'Beta (#12)')
        self.merge_main_resolving(delta, {8: 'xray', 10: 'beta', 11: 'delta'})
        self.squash('feature/delta', 'Delta (#13)')

        r = self.run_card('archive', 'xray', 'beta', 'delta', '--cleanup', cwd=self.main)

        self.assertEqual(r.returncode, 0, r.stderr)
        for slug, wt in (('xray', xray), ('beta', beta), ('delta', delta)):
            self.assert_squash_kept_branch(r, slug, wt)
        self.assertNotIn('還沒併入', r.stdout)

    def test_archive_cleanup_removes_worktree_when_rebase_merged_with_several_commits(self):
        """審查 MEDIUM，D-06：分支有多個 commit、用 rebase 方式合併（HEAD 上沒有任何一個 commit 等於整體改動）。
        Beta 三個 commit（beta.txt、第 10 行、第 3 行）逐一 cherry-pick 進 main，之後 Delta 改第 11 行、併 main 解衝突再 squash；
        Beta 照樣移除 worktree、分支保留。反例：Gamma 一樣 rebase 合併，之後 main revert 了它改第 17 行的 commit，
        內容不全在 main，照舊判「分支還沒併入 main」、兩樣都保留。"""
        self.commit_shared_file()
        beta = self.open_case('feature/beta', 'Beta')
        self.change_line(beta, 10, 'beta')
        self.change_line(beta, 3, 'three')
        gamma = self.open_case('feature/gamma', 'Gamma')
        self.change_line(gamma, 17, 'gamma')
        delta = self.open_case('feature/delta', 'Delta')
        self.change_line(delta, 11, 'delta')
        # main 先多一個無關的 commit，cherry-pick 出來的才是新的 commit（分支不是 main 的祖先）。
        write(os.path.join(self.main, 'other.txt'), 'x\n')
        git('add', 'other.txt', cwd=self.main)
        git('commit', '-q', '-m', 'other', cwd=self.main)
        self.rebase_merge('feature/beta')
        self.rebase_merge('feature/gamma')
        git('revert', '--no-edit', 'HEAD', cwd=self.main)
        self.merge_main_resolving(delta, {3: 'three', 10: 'beta', 11: 'delta'})
        self.squash('feature/delta', 'Delta (#13)')

        r = self.run_card('archive', 'beta', 'gamma', 'delta', '--cleanup', cwd=self.main)

        self.assertEqual(r.returncode, 0, r.stderr)
        for slug, wt in (('beta', beta), ('delta', delta)):
            self.assert_squash_kept_branch(r, slug, wt)
        self.assertIn(os.path.realpath(gamma), self.worktrees())
        self.assertNotEqual(self.branch_listed('feature/gamma'), '')
        self.assertIn('清理 gamma：worktree 與分支保留：分支還沒併入 main', r.stdout)

    def test_archive_same_card_named_twice_is_archived_once(self):
        """同一張卡用 slug 和任務名各寫一次（審查 MEDIUM，D-04）：只歸檔、清理一次，不會 Traceback 也不多一份副本。"""
        self.open_case('feature/beta', 'Beta', merged=True)
        self.open_case('feature/gamma', 'Gamma')

        r = self.run_card('archive', 'beta', 'Beta', '--cleanup', cwd=self.main)
        r2 = self.run_card('archive', 'gamma', 'Gamma', cwd=self.main)

        for out in (r, r2):
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertNotIn('Traceback', out.stderr)
        archive = os.path.join(self.t, 'archive')
        self.assertEqual(sorted(os.listdir(archive)), ['beta-CARD.md', 'gamma-CARD.md'])
        self.assertEqual(r.stdout.count('清理 '), 1, r.stdout)
        reg = read(self.reg)
        self.assertEqual(len(re.findall(r'(?m)^- beta：', reg)), 1, reg)
        self.assertEqual(len(re.findall(r'(?m)^- gamma：', reg)), 1, reg)
        self.assertNotRegex(reg, r'(?m)^- (Beta|Gamma)：')

    def test_unknown_target_lists_cases(self):
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        r = self.run_card('card', 'nope')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('訂單匯出', r.stderr)

    def test_bundled_template_is_used_by_default(self):
        self.assertTrue(os.path.isfile(TEMPLATE))
        self.run_card('new', 'feature/order-export', '訂單匯出', 'origin/main')
        self.assertIn('## 驗收情境', read(self.card_path()).replace('### 驗收情境', '## 驗收情境'))


CHANGELOG_BEFORE = '# Changelog\n\n## 未發布\n\n## 0.26.0\n\n- 修復 舊的事\n'


class ChangelogTest(unittest.TestCase):
    """`card.py changelog <版本>`：把 changelog.d/*.md 合併成版本段落。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        git('init', '-q', '-b', 'main', cwd=self.root)
        self.frag = os.path.join(self.root, 'changelog.d')
        os.makedirs(self.frag)
        write(os.path.join(self.frag, '.gitkeep'), '')
        self.changelog = os.path.join(self.root, 'CHANGELOG.md')
        write(self.changelog, CHANGELOG_BEFORE)

    def tearDown(self):
        self.tmp.cleanup()

    def run_changelog(self, version):
        env = {**os.environ, 'DESK_SETTINGS': os.path.join(self.root, 'none.json'), 'DESK_PROJECT_DIR': ''}
        return subprocess.run([sys.executable, SCRIPT, 'changelog', version], capture_output=True, text=True, env=env, cwd=self.root)

    def fragments(self):
        return sorted(f for f in os.listdir(self.frag) if f.endswith('.md'))

    def test_changelog_merges_fragments_into_version_section_and_removes_them(self):
        """AC-1：片段依 新增→調整→修復→移除 排列、同類依檔名，插在「## 未發布」之後、上一版之前；片段檔刪掉、.gitkeep 留著。"""
        write(os.path.join(self.frag, 'a.md'), '- 修復 甲\n')
        write(os.path.join(self.frag, 'b.md'), '- 新增 乙\n\n- 調整 丙\n')
        write(os.path.join(self.frag, 'c.md'), '- 移除 丁\n- 新增 戊\n')

        r = self.run_changelog('0.27.0')

        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(read(self.changelog), '# Changelog\n\n## 未發布\n\n## 0.27.0\n\n- 新增 乙\n- 新增 戊\n- 調整 丙\n- 修復 甲\n- 移除 丁\n\n## 0.26.0\n\n- 修復 舊的事\n')
        self.assertEqual(self.fragments(), [])
        self.assertTrue(os.path.isfile(os.path.join(self.frag, '.gitkeep')))
        self.assertIn('0.27.0', r.stdout)
        self.assertIn('5', r.stdout)

    def test_changelog_refuses_without_fragments(self):
        """AC-2：只有 .gitkeep 就報錯，CHANGELOG 不動。"""
        r = self.run_changelog('0.27.0')

        self.assertNotEqual(r.returncode, 0)
        self.assertIn('沒有片段檔', r.stderr)
        self.assertEqual(read(self.changelog), CHANGELOG_BEFORE)

    def test_changelog_refuses_when_version_section_exists(self):
        """AC-3：版本段已存在就報錯，CHANGELOG 與片段檔都不動。"""
        write(os.path.join(self.frag, 'a.md'), '- 修復 甲\n')

        r = self.run_changelog('0.26.0')

        self.assertNotEqual(r.returncode, 0)
        self.assertIn('已存在', r.stderr)
        self.assertEqual(read(self.changelog), CHANGELOG_BEFORE)
        self.assertEqual(self.fragments(), ['a.md'])

    def test_changelog_refuses_fragment_line_not_starting_with_dash(self):
        """AC-4：片段有一行不是「- 」開頭就報錯並指出檔名與行號，什麼都不改。"""
        write(os.path.join(self.frag, 'a.md'), '- 修復 甲\n')
        write(os.path.join(self.frag, 'bad.md'), '- 新增 乙\n新增 丙\n')

        r = self.run_changelog('0.27.0')

        self.assertNotEqual(r.returncode, 0)
        self.assertIn('bad.md', r.stderr)
        self.assertIn('2', r.stderr)
        self.assertEqual(read(self.changelog), CHANGELOG_BEFORE)
        self.assertEqual(self.fragments(), ['a.md', 'bad.md'])


KAC_BEFORE = '# Changelog\n\n## [Unreleased]\n\n## [v26.2.6] - 2026-10-22\n\n### Fixed\n\n- 修復 舊的事\n'


class KeepAChangelogTest(unittest.TestCase):
    """dispatch.json 設 card.changelog.format = "keepachangelog" 時，`changelog <版本>` 依 Keep a Changelog 合併。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        git('init', '-q', '-b', 'main', cwd=self.root)
        self.frag = os.path.join(self.root, 'changelog.d')
        os.makedirs(self.frag)
        write(os.path.join(self.frag, '.gitkeep'), '')
        self.changelog = os.path.join(self.root, 'CHANGELOG.md')
        write(self.changelog, KAC_BEFORE)
        self.settings = os.path.join(self.root, 'settings.json')
        write(self.settings, json.dumps({'card': {'changelog': {'format': 'keepachangelog'}}}))

    def tearDown(self):
        self.tmp.cleanup()

    def run_changelog(self, version):
        env = {**os.environ, 'DESK_SETTINGS': self.settings, 'DESK_PROJECT_DIR': ''}
        before = datetime.date.today().isoformat()
        r = subprocess.run([sys.executable, SCRIPT, 'changelog', version], capture_output=True, text=True, env=env, cwd=self.root)
        after = datetime.date.today().isoformat()
        # 版本段的日期是 card.py 跑的那天：整套跨過午夜時，跟測試開始那天不同。照它寫的比對，但必須是跑的前後這兩天之一。
        m = re.search(rf'^## \[{re.escape(version)}\] - (\S+)$', read(self.changelog), re.M)
        self.day = m.group(1) if m and m.group(1) in (before, after) else before
        return r

    def fragments(self):
        return sorted(f for f in os.listdir(self.frag) if f.endswith('.md'))

    def test_keepachangelog_merges_fragments_into_typed_sections(self):
        """AC-1：[Unreleased] 留空標題，下方新增版本段，依 Added→Fixed→Security 分小節；片段刪掉、.gitkeep 留著、舊版本段不變。"""
        write(os.path.join(self.frag, 'a.md'), '- 修補 甲\n- 修復 乙\n')
        write(os.path.join(self.frag, 'b.md'), '- 新增 丙\n')

        r = self.run_changelog('v26.2.7')

        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(read(self.changelog), (
            '# Changelog\n\n## [Unreleased]\n\n'
            f'## [v26.2.7] - {self.day}\n\n'
            '### Added\n\n- 新增 丙\n\n'
            '### Fixed\n\n- 修復 乙\n\n'
            '### Security\n\n- 修補 甲\n\n'
            '## [v26.2.6] - 2026-10-22\n\n### Fixed\n\n- 修復 舊的事\n'
        ))
        self.assertEqual(self.fragments(), [])
        self.assertTrue(os.path.isfile(os.path.join(self.frag, '.gitkeep')))

    def test_keepachangelog_moves_unreleased_content_and_keeps_extra_sections(self):
        """AC-2：[Unreleased] 的手寫內容一起移進版本段：同類併在同一小節（手寫在前），其他小節原樣放最後；[Unreleased] 清空。"""
        write(self.changelog, KAC_BEFORE.replace(
            '## [Unreleased]\n\n',
            '## [Unreleased]\n\n### 工程專區\n\n1. 跑 migration\n2. 清快取\n\n### Fixed\n\n- 修復 手寫的\n\n',
        ))
        write(os.path.join(self.frag, 'a.md'), '- 修復 片段的\n- 新增 丙\n')

        r = self.run_changelog('v26.2.7')

        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(read(self.changelog), (
            '# Changelog\n\n## [Unreleased]\n\n'
            f'## [v26.2.7] - {self.day}\n\n'
            '### Added\n\n- 新增 丙\n\n'
            '### Fixed\n\n- 修復 手寫的\n- 修復 片段的\n\n'
            '### 工程專區\n\n1. 跑 migration\n2. 清快取\n\n'
            '## [v26.2.6] - 2026-10-22\n\n### Fixed\n\n- 修復 舊的事\n'
        ))
        self.assertEqual(self.fragments(), [])

    def test_keepachangelog_refuses_unknown_verb(self):
        """AC-3：片段條目的動詞不在對照表就報錯並指出檔名與條目，CHANGELOG 與片段檔都不動。"""
        write(os.path.join(self.frag, 'a.md'), '- 修復 乙\n')
        write(os.path.join(self.frag, 'odd.md'), '- 優化 載入速度\n')

        r = self.run_changelog('v26.2.7')

        self.assertNotEqual(r.returncode, 0)
        self.assertIn('odd.md', r.stderr)
        self.assertIn('優化 載入速度', r.stderr)
        self.assertEqual(read(self.changelog), KAC_BEFORE)
        self.assertEqual(self.fragments(), ['a.md', 'odd.md'])

    def test_keepachangelog_refuses_existing_version_or_nothing_to_release(self):
        """AC-4：版本段已存在，或沒有片段且 [Unreleased] 是空的，都報錯、什麼都不改。"""
        r = self.run_changelog('v26.2.7')

        self.assertNotEqual(r.returncode, 0)
        self.assertIn('沒有', r.stderr)
        self.assertEqual(read(self.changelog), KAC_BEFORE)

        write(os.path.join(self.frag, 'a.md'), '- 修復 乙\n')

        r = self.run_changelog('v26.2.6')

        self.assertNotEqual(r.returncode, 0)
        self.assertIn('已存在', r.stderr)
        self.assertEqual(read(self.changelog), KAC_BEFORE)
        self.assertEqual(self.fragments(), ['a.md'])

    def test_keepachangelog_refuses_unreleased_with_only_empty_headings(self):
        """AC-4：[Unreleased] 只有空的 ### 小節標題、又沒有片段，也算沒東西可發，報錯、什麼都不改。"""
        before = KAC_BEFORE.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Added\n\n### 工程專區\n')
        write(self.changelog, before)

        r = self.run_changelog('v26.2.7')

        self.assertNotEqual(r.returncode, 0)
        self.assertIn('沒有東西可以發版', r.stderr)
        self.assertEqual(read(self.changelog), before)


REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
# 發版段的 9 個步驟，依序要出現的關鍵字
RELEASE_STEPS = [
    'origin/main',
    '/desk:card changelog',
    '.claude-plugin/plugin.json',
    'claude plugin validate .',
    'commit',
    'git tag -a',
    'git push',
    'CI',
    'git worktree remove',
]


class ReleaseDocsTest(unittest.TestCase):
    """docs/WORKFLOW.md 的發版段與 README 的動作表。"""

    def release_section(self):
        lines = read(os.path.join(REPO, 'docs', 'WORKFLOW.md')).splitlines()
        start = next(i for i, l in enumerate(lines) if l.startswith('- 發版'))
        end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith(('- ', '#'))), len(lines))
        return '\n'.join(lines[start:end])

    def test_release_docs_list_every_step(self):
        section = self.release_section()
        at = 0
        for step in RELEASE_STEPS:
            found = section.find(step, at)
            self.assertGreaterEqual(found, 0, f'發版段在第 {at} 字之後找不到「{step}」：\n{section}')
            at = found + len(step)
        self.assertEqual(len(re.findall(r'^\s+\d+\. ', section, re.M)), len(RELEASE_STEPS))
        readme = read(os.path.join(REPO, 'README.md'))
        self.assertRegex(readme, r'(?m)^\| ⚑ 發版 \|')

    def test_release_steps_push_atomically_and_wait_ci_by_exit_status(self):
        """審查 MEDIUM：push 用 --atomic（main 被拒時 tag 不推）；CI 先取 run id 再 watch --exit-status（非互動要 id、失敗回非零）；changelog 寫在要發版的那份 main，不只寫主 repo。"""
        section = self.release_section()
        self.assertIn('git push --atomic origin HEAD:main', section)
        self.assertIn('gh run list --branch main --commit', section)
        self.assertIn('--exit-status', section)
        skill = read(os.path.join(REPO, 'skills', 'card', 'SKILL.md'))
        readme = read(os.path.join(REPO, 'README.md'))
        for text in (skill, readme):
            self.assertIn('從 origin/main 開的暫存 worktree', text)
        self.assertNotIn('在主 repo、要發的 PR 都合併之後執行', skill)

    def test_release_docs_state_one_question_and_version_rule_when_releasing_desk(self):
        """AC-4：發版段寫只問一次與題目範本、desk 的版號規則、照做的 9 步，歸檔在步驟之後；README 的「⚑ 發版」列跟著改。"""
        section = self.release_section()
        for part in ('只問一次', 'A) 照做', 'B) 改用', 'C) 先不發', '選 A／B 後一路做完不再問', '失敗就停'):
            self.assertIn(part, section)
        # 版號規則：有 feature 分支或「新增」升次版號（0.38.0），否則升修訂號（0.37.1），附過去發版的佐證
        for part in ('feature/', '「新增」', '次版號', '0.38.0', '修訂號', '0.37.1', '0.27.0 起 12 次發版都符合'):
            self.assertIn(part, section)
        self.assertLess(section.find('次版號'), section.find('修訂號'))
        # 9 步從暫存 worktree 開始、收尾移除它；歸檔寫在第 9 步之後，不在題目裡
        steps = re.findall(r'(?m)^\s+(\d+)\. (.*)$', section)
        self.assertEqual([n for n, _ in steps], [str(i) for i in range(1, 10)])
        self.assertIn('git worktree add', steps[0][1])
        self.assertIn('git worktree remove', steps[8][1])
        last_step = section.find(steps[8][1])
        self.assertGreater(section.find('歸檔', last_step + len(steps[8][1])), 0)
        self.assertNotIn('歸檔', section[:last_step + len(steps[8][1])])
        readme = read(os.path.join(REPO, 'README.md'))
        row = next(l for l in readme.splitlines() if l.startswith('| ⚑ 發版 |'))
        self.assertIn('只問一次', row)
        self.assertNotIn('打 tag 並 push', row)


if __name__ == '__main__':
    unittest.main()
