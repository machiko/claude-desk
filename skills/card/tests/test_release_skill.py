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
        self.assertLess(confirm.find('Decisions'), confirm.find('進行中'))
        self.assertLess(confirm.find('進行中'), confirm.find('照第 3 點的順序做完'))
        self.assertIn('「等你」不動', confirm)
        # 判斷不了版號：照範本寫題、不打 tag
        stuck = confirm[confirm.find('判斷不了版號'):]
        self.assertIn('寫題目停下', stuck)
        self.assertIn('不打 tag', stuck)
        # 失敗就停在那步、狀態寫原因
        self.assertIn('任何一步失敗就停在那步、「狀態」寫原因', body)


if __name__ == '__main__':
    unittest.main()
