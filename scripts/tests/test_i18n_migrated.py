"""守門：已搬進字串目錄（hooks/i18n/zh-TW.ts）的檔不再直接寫中文顯示字串，目錄裡也沒有用不到的鍵（i18n 目錄與示範 AC-3、AC-4；i18n 動態與 toast AC-2、i18n 狀態說明 AC-3 沿用，已搬清單各加 10 個檔）。

沿用 test_wording 的 strip_code：去掉註解與正規式字面值之後，程式文字裡還有中文字或全形標點就列出「檔:行」。
MIGRATED 是已搬完的檔，之後的卡搬完一個檔就往上加；只搬了一段的檔（register.tsx 只搬 /desk 指令說明）另列在 MIGRATED_LINES，只看那幾行。
KEPT 是搬完的檔裡刻意留在原處的字（解析契約、卡片欄位名、給 Agent 的提示與給對話的面板操作紀錄、示範資料與教學沙盒內容），每條寫原因。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_wording import ROOT, hook_files, strip_code  # noqa: E402

CATALOG = 'hooks/i18n/zh-TW.ts'
MIGRATED = (
    'hooks/update.ts',
    'hooks/update-run.ts',
    'hooks/release-update.ts',
    'hooks/engine-version.ts',
    'hooks/formats.ts',
    'hooks/kind-label.ts',
    'hooks/stack.ts',
    'hooks/theme.ts',
    'hooks/text.ts',
    'hooks/actions.ts',
    'hooks/band.tsx',
    'hooks/pane.tsx',
    'hooks/turn.ts',
    'hooks/pane-card.tsx',
    'hooks/chain.ts',
    'hooks/quota-words.ts',
    'hooks/stop-reason.ts',
    'hooks/agent-queue.ts',
    'hooks/auto-chain.ts',
    'hooks/auto-pr.ts',
    'hooks/card-actions.ts',
    'hooks/catchup.ts',
    'hooks/desk-io.ts',
    'hooks/dispatch-runner.ts',
    'hooks/verify-runner.ts',
    'hooks/stale-agents.ts',
    'hooks/extras.ts',
    'hooks/pipeline.ts',
    'hooks/dispatch.ts',
    'hooks/model.ts',
    'hooks/settings.ts',
    'hooks/next-words.ts',
    'hooks/risk.ts',
    'hooks/tutorial-run.tsx',
    'hooks/agents.ts',
    'hooks/approve-check.ts',
    'hooks/probes.ts',
)
# (檔名, 只看符合這個正規式的行)
MIGRATED_LINES = (
    ('hooks/register.tsx', re.compile(r"\$\.command\.register\(\{ name: 'desk'")),
)
# (檔名, 那一行裡要扣掉的字, 原因)
KEPT = (
    ('hooks/release-update.ts', re.compile(r"\['狀態'\]"), '卡片欄位名，解析契約（規格非目標）'),
    ('hooks/stop-reason.ts', re.compile(r"^\s*'[^'\n]+': '\w+',$", re.M),
     '舊流程紀錄存的停下原因句（資料格式契約）：更新前停下的流程讀時還原成代碼，凍結不跟著目錄改（舊紀錄相容）'),
    ('hooks/card-actions.ts', re.compile(r"\['狀態'\]"), '卡片欄位名，解析契約（規格非目標）'),
    ('hooks/card-actions.ts', re.compile(r"isReleaseLine\(c\) \? '等下一版開發' : `\$\{ARCHIVE_WORD\}："),
     '確認上線時寫進卡片「下一步」欄的字：卡片內容，跟卡片欄位名一樣給對話與 Agent 讀，不搬（規格非目標）'),
    ('hooks/card-actions.ts', re.compile(r"tellPanel\(\$, [^,]+, (?:'[^']*'|`[^`]*`)"),
     '給對話的面板操作紀錄（附在下一則提示）：當成給 Agent 的提示，維持中文（D-03）'),
    ('hooks/verify-runner.ts', re.compile(r"tellPanel\(\$, [^,]+, `[^`]*`"),
     '給對話的面板操作紀錄（附在下一則提示）：當成給 Agent 的提示，維持中文（D-03）'),
    ('hooks/desk-io.ts', re.compile(r"^(?:\s*const lines = list\.map\(a => |\s*return `面板在對話外做了).*$", re.M),
     '給對話的面板操作紀錄（附在下一則提示）：當成給 Agent 的提示，維持中文（D-03）'),
    ('hooks/desk-io.ts', re.compile(
        r"^(?:const cardLines = |const lead = |export const cardData = |\s*return `\$\{lead\(c\)\}卡片 |export const MEDIUM_FIX_BY_DESK = "
        r"|export const mediumFollowUpName = |\s*const base = branch \? |\s*return `審查 MEDIUM 那題選了 B\) |\s*const ask = `這是使用者在工作桌).*$", re.M),
     '附給對話的選取任務與決策：給 Agent 的提示（卡片欄位名照卡片格式），不搬（規格非目標）'),
    ('hooks/card-actions.ts', re.compile(r"^const nextStepAnswer = .*$", re.M),
     '回覆選「照卡片的下一步繼續」時送給 Agent 的那句：給 Agent 的提示，不搬（規格非目標）'),
    ('hooks/card-actions.ts', re.compile(r"(?:pushRequest|openPrRequest)\(c\.git\?\.branch \?\? '分支'"),
     '推送 Agent 提示裡的分支名預設值：給 Agent 的提示，不搬（規格非目標）'),
    ('hooks/agent-queue.ts', re.compile(r"pushRequest\(c\.git\?\.branch \?\? '分支'"),
     '推送 Agent 提示裡的分支名預設值：給 Agent 的提示，不搬（規格非目標）'),
    ('hooks/pipeline.ts', re.compile(r"new RegExp\(`\$\{name\}[^`]*`"),
     '讀審查結論四個分級的解析式（關卡格式契約），不搬（規格非目標）'),
    ('hooks/dispatch.ts', re.compile(
        r"^(?:\s*: kind === 'continue' \? |\s*: kind === 'sync' \? |\s*: `\$\{named\(settings\.user\)|\s*const who = self \? "
        r"|\s*return \[head, |\s*return `第一步：這張卡疊在 ).*$", re.M),
     '派工給 Agent 的提示（繼續、同步、回覆、疊放卡第一步、任務與卡片路徑）：給 Agent 的文字維持中文留原處（D-03）'),
    ('hooks/model.ts', re.compile(r"card\?\.\['[^']+'\]"), '卡片欄位名，解析契約（規格非目標）'),
    ('hooks/model.ts', re.compile(r"^(?:\s*const card = \(status: string|\s*`<!-- DESK -->|\s*\[\{ name: '[^']+', statusPath: '/demo/).*$", re.M),
     '示範資料（示範卡的任務名與卡片內容，欄位名照卡片格式契約）：留到英文版（D-02）'),
    ('hooks/settings.ts', re.compile(r"^\s*(?:high|security|categories): '[^']*',$", re.M),
     '審查分級的預設說明：組進審查提示給 Agent 讀，維持中文留原處（D-03）'),
    ('hooks/next-words.ts', re.compile(
        r"^const (?:IDLE_WAIT|IDLE_PRESS_V|IDLE_OPEN_PR|IDLE_FOLLOW_TURN|IDLE_CLAUSE|REVIEW_WORD|REVIEW_CMD|REVIEW_CLAUSE) = .*$", re.M),
     '辨識卡片「下一步」寫法的解析式（Agent 與人寫的下一步，卡片內容契約），不搬（規格非目標）'),
    ('hooks/tutorial-run.tsx', re.compile(r"'feat: 新增會員折扣' : 'fix: 金額為負數時丟出 ValueError'|p\.marker, '[^']*'"),
     '教學沙盒內容（教學 commit 訊息、標記檔內容）：寫進沙盒的檔案與 git 歷史，跟教學卡本文一樣留到英文版（D-02）'),
)
CHINESE = re.compile(r'[　-〿一-鿿＀-￯]+')
CATALOG_KEY = re.compile(r"^\s*'([\w.]+)':", re.M)


def inline_chinese(rel, text, only=None):
    """回傳 [(行號, 那一行)]：去掉註解、正規式與 KEPT 之後還有中文的行；only 是正規式時只看符合它的原始行。"""
    lines = text.split('\n')
    found = []
    for no, code in enumerate(strip_code(text).split('\n'), 1):
        raw = lines[no - 1]
        if only is not None and not only.search(raw):
            continue
        for f, pat, _why in KEPT:
            if f == rel:
                code = pat.sub('', code)
        if CHINESE.search(code):
            found.append((no, raw.strip()))
    return found


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


class MigratedFilesTest(unittest.TestCase):
    def test_migrated_files_have_no_inline_chinese_display_text(self):
        """AC-3：已搬完的檔沒有直接寫的中文顯示字串，有就列出「檔:行」。"""
        targets = [(rel, None) for rel in MIGRATED] + list(MIGRATED_LINES)
        hits = [f'{rel}:{no} {line[:80]}' for rel, only in targets for no, line in inline_chinese(rel, read(rel), only)]
        self.assertEqual(hits, [], '已搬進字串目錄的檔又直接寫了中文，改寫進 hooks/i18n/zh-TW.ts 再用 t() 取：\n' + '\n'.join(hits))

    def test_guard_reports_file_and_line_and_skips_comments_regex_and_kept(self):
        """AC-3：守門本身認得出字串、樣板字串與 JSX 文字裡的中文；註解、正規式與 KEPT 扣掉的字不算；only 只看指定的行。"""
        text = '\n'.join([
            "// 註解裡的中文",
            "const re = /已發版/",
            "const a = t('update.busy')",
            "const b = '有新版本'",
            "const c = `desk ${x}：更新`",
            "const d = <Text>好</Text>",
            "const e = card?.['狀態']",
        ])
        self.assertEqual([no for no, _ in inline_chinese('hooks/x.ts', text)], [4, 5, 6, 7])
        self.assertEqual([no for no, _ in inline_chinese('hooks/release-update.ts', text)], [4, 5, 6])
        self.assertEqual([no for no, _ in inline_chinese('hooks/x.ts', text, re.compile('const b'))], [4])

    def test_partial_and_kept_entries_still_match(self):
        """MIGRATED_LINES 每條真的對到一行、KEPT 每條在那個檔真的扣到字，免得改了程式之後守門默默變成什麼都不看。"""
        for rel in MIGRATED:
            self.assertTrue(os.path.exists(os.path.join(ROOT, rel)), rel)
        for rel, only in MIGRATED_LINES:
            self.assertTrue(any(only.search(line) for line in read(rel).split('\n')), rel)
        for rel, pat, why in KEPT:
            self.assertTrue(pat.search(read(rel)), rel)
            self.assertRegex(why, '契約|欄位名|提示|示範|教學')

    def test_catalog_has_no_unused_keys(self):
        """AC-4：目錄裡每個鍵都有 hooks 底下別的檔在用（寫成 'update.notice' 這樣的字面值）。"""
        keys = CATALOG_KEY.findall(read(CATALOG))
        self.assertTrue(keys)
        self.assertEqual(len(keys), len(set(keys)), '目錄有重複的鍵')
        code = '\n'.join(strip_code(read(rel)) for rel, _path in hook_files() if rel != CATALOG)
        unused = [k for k in keys if f"'{k}'" not in code]
        self.assertEqual(unused, [], '字串目錄有沒有程式在用的鍵，刪掉或補上用的地方：\n' + '\n'.join(unused))


if __name__ == '__main__':
    unittest.main()
