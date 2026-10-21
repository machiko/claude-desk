"""card.py 的測試：在暫存資料夾造主 repo、登錄表與卡片，跑真的子指令。

執行：python3 -m unittest discover -s skills/card/tests
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts', 'card.py')
SPEC_CASES = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), 'tests', 'spec-cases.mjs')
TEMPLATE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), 'templates', 'DESK-template.md')


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


if __name__ == '__main__':
    unittest.main()
