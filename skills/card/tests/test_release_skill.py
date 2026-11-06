"""skills/release/SKILL.md 的測試：發版規則只留在這份 skill，字句一條都不能少。

`claude plugin test` 的環境不能讀 .md 檔，所以讀檔的斷言放這裡；範本照 tests/release-sample.mjs 填好後等於樣本題目，
樣本交給 parseDecisions 只有一題、選項 A／B／C 由 tests/release-skill.test.ts 的同名測試斷言。

執行：python3 -m unittest discover -s skills/card/tests
"""
import json
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SKILL = os.path.join(ROOT, 'skills', 'release', 'SKILL.md')
SAMPLE = os.path.join(ROOT, 'tests', 'release-sample.mjs')

# AC-4 列的規則：每句都要在 SKILL.md 正文裡。
RULES = [
    '版號照這個專案過去的慣例提，寫出理由',
    '合併 CHANGELOG 片段 → 改版號 → 跑完整檢查 → commit → 打 tag → push 主分支與 tag → 等 CI 通過',
    '歸檔並移除 worktree 與分支',
    '回答任一張就算數，收到決策先把每張的「等你」清成無',
    '選 A 或 B 後照順序做完、中間不再問',
    '任何一步失敗就停、後面的不做（還沒 push 就不 push，已 push 的不回退、不 force push）',
    '選 C 就清掉「等你」、什麼都不做',
    '題目沒列的事一律不做（force push、改寫歷史、合併 PR、刪分支、改清單外的卡）',
    '有 `release：` 關卡的卡留給使用者部署後按 u',
    '照專案文件的發版步驟補上專案自己的步驟與收尾',
    # 面板按兩次 z 的確認段（AC-4、AC-6）
    '有確認段：不寫題目，版號照慣例提',
    '發版 v<版號>（<理由>），面板確認',
    '發版 v<版號>：進行中（<步驟>）',
    '判斷不了版號（沒有 v* tag、兩個候選都合理）才寫題目停下',
    '沒有確認段（手打的）',
    # 手打路徑出題後停下（AC-5）
    '寫完題就停，等使用者在面板按 a／b／c 再按 `f`',
]


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


class ReleaseSkillTest(unittest.TestCase):
    def test_release_skill_keeps_every_rule_and_parses_as_one_abc_question(self):
        text = read(SKILL)
        front = re.match(r'---\n(.*?)\n---\n', text, re.S)
        self.assertIsNotNone(front)
        self.assertIn('name: release', front.group(1).splitlines())
        body = text[front.end():]
        for rule in RULES:
            self.assertIn(rule, body)
        # AC-5：手打的請求（沒有確認段）照範本出題、寫完就停，不照做
        manual = body[body.find('- 沒有確認段'):]
        manual = manual[:manual.find('\n')]
        self.assertGreater(body.find('- 沒有確認段'), -1)
        self.assertIn('照第 1 點的範本寫題目', manual)
        self.assertIn('寫完就停', manual)
        for go in ('不寫題目', '照慣例版號直接做', '不出題'):
            self.assertNotIn(go, manual)
        # 確認題範本：反引號裡以「發版 v<版號>」開頭的那句，整句沒有「；」
        templates = re.findall(r'`(發版 v<版號>[^`]*)`', body)
        self.assertEqual(len(templates), 1)
        template = templates[0]
        self.assertNotIn('；', template)
        sample = json.loads(read(SAMPLE).split('\nexport default ', 1)[1])
        question = template
        for slot, value in sample['fill'].items():
            self.assertIn(slot, template)
            question = question.replace(slot, value)
        self.assertNotIn('<', question)
        self.assertEqual(question, sample['question'])
        self.assertIn('PR #13）', question)

    def test_release_skill_takes_panel_confirmation_without_asking(self):
        """AC-4、AC-6：帶確認段的請求不出題、先記 Decisions 與狀態再照順序做；判斷不了版號才寫題停下、不打 tag。"""
        text = read(SKILL)
        front = re.match(r'---\n(.*?)\n---\n', text, re.S)
        body = text[front.end():]
        sample = json.loads(read(SAMPLE).split('\nexport default ', 1)[1])
        self.assertIn(sample['confirmed'], body)
        self.assertIn(sample['confirmed'], front.group(1))
        self.assertIn('不出題', front.group(1))
        confirm = body[body.find('- 有確認段'):body.find('- 沒有確認段')]
        self.assertGreater(len(confirm), 0)
        # 先記 Decisions、寫狀態，再照順序做；「等你」不動
        self.assertIn('Decisions', confirm)
        self.assertIn('進行中', confirm)
        self.assertLess(confirm.find('Decisions'), confirm.find('進行中'))
        self.assertLess(confirm.find('進行中'), confirm.find('照第 3 點的順序做完'))
        self.assertIn('「等你」不動', confirm)
        # 判斷不了版號：照範本寫題、不打 tag
        stuck = confirm[confirm.find('判斷不了版號'):]
        self.assertIn('寫題目停下', stuck)
        self.assertIn('不打 tag', stuck)
        # 失敗就停在那步、狀態寫原因
        self.assertIn('任何一步失敗就停在那步、「狀態」寫原因', body)

    def test_release_skill_uses_version_written_in_request_when_confirmed(self):
        """AC-7：帶確認段的請求另寫了版號（填入提示叫人在送出前改這行）：用那個版號、不出題，理由寫使用者指定。"""
        body = read(SKILL)
        confirm = body[body.find('- 有確認段'):body.find('- 沒有確認段')]
        given = confirm[confirm.find('請求裡另寫了版號'):]
        self.assertGreater(confirm.find('請求裡另寫了版號'), -1)
        self.assertIn('就用那個版號', given)
        self.assertIn('照樣不出題', given)
        self.assertIn('使用者指定', given)
        # 指定版號的規則在「判斷不了版號」之前：寫了版號就不算判斷不了
        self.assertLess(confirm.find('請求裡另寫了版號'), confirm.find('判斷不了版號'))

    def test_release_skill_runs_integration_review_before_changelog(self):
        """本卡 AC-5：合併 CHANGELOG 前先對上一個 v* tag..origin/main 整版審查，結果寫 reviews 的 release-v<版號>.md；
        有 CRITICAL／HIGH 停在這步、不打 tag，每張卡等你寫同一題；只有 MEDIUM／LOW 照常發版並列出。派審查 Agent 做，對話不自己邊看邊修。"""
        body = read(SKILL)
        order = body[body.find('3. 照做的動作依序是'):]
        order = order[:order.find('\n')]
        self.assertIn('整版審查 → 合併 CHANGELOG 片段', order)
        front = re.match(r'---\n(.*?)\n---\n', body, re.S).group(1)
        self.assertLess(front.find('整版審查'), front.find('合併 CHANGELOG 片段'))
        start = body.find('## 整版審查')
        self.assertGreater(start, -1)
        section = body[start:body.find('\n## ', start + 1)]
        for phrase in ('合併 CHANGELOG 片段之前做', '有確認段也照做', '上一個 `v*` tag', 'origin/main',
                       '派一個審查 Agent 做', '對話不自己邊看邊修', '同一個檔被多張卡改', '一張卡改了另一張依賴的行為',
                       'reviews 資料夾', '`release-v<版號>.md`', '不打 tag', '只有 MEDIUM／LOW：照常接著做', '列出'):
            self.assertIn(phrase, section)
        blocked = section[section.find('有 CRITICAL 或 HIGH'):]
        self.assertIn('停在這步', blocked)
        self.assertIn('不打 tag', blocked)
        # 擋下時的題目範本：數字填上後跟樣本一字不差（樣本由 TS 那支交給 parseDecisions，只有一題 A／B／C）
        sample = json.loads(read(SAMPLE).split('\nexport default ', 1)[1])['integration']
        self.assertIn('每張卡的「等你」寫同一題', blocked)
        self.assertIn('`%s`' % sample['template'], blocked)
        question = sample['template']
        for n in sample['counts']:
            question = question.replace(' n', ' %d' % n, 1)
        self.assertEqual(question, sample['question'])
        # 審查契約有整版審查段：只看跨卡的交互、各卡規格不重審
        template = read(os.path.join(ROOT, 'templates', 'review.md'))
        part = template[template.find('整版審查（'):]
        self.assertGreater(template.find('整版審查（'), -1)
        self.assertIn('只看跨卡的交互', part)
        self.assertIn('不重審', part)

    def test_release_in_progress_pattern_matches_release_skill(self):
        """發版進行中狀態卡 K-2：SKILL.md 叫對話寫進「狀態」的那句範本，跟 tests/release-sample.mjs 的 inProgress 是同一串字；
        照樣本填好的狀態由 tests/release-in-progress.test.tsx 的同名測試交給面板的正規式，認得出步驟。"""
        body = read(SKILL)
        sample = json.loads(read(SAMPLE).split('\nexport default ', 1)[1])['inProgress']
        self.assertIn('「狀態」寫「%s」' % sample['template'], body)
        status = sample['template']
        for slot, value in sample['fill'].items():
            status = status.replace(slot, value)
        self.assertEqual(status, sample['status'])


if __name__ == '__main__':
    unittest.main()
