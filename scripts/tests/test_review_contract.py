"""templates/review.md（審查契約）與流程文件的測試：不影響行為的 MEDIUM 直接記錄、不問；可能影響行為的自動修，輪數用完或要你決定的才在「等你」問一題。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONTRACT = os.path.join(ROOT, 'templates', 'review.md')
WORKFLOW = os.path.join(ROOT, 'docs', 'WORKFLOW.md')
FLOW = os.path.join(ROOT, 'skills', 'flow', 'SKILL.md')
ASK = '審查 MEDIUM 1 條（<一句摘要>）怎麼處理：A) 不修，記錄原因 B) 修掉 C) 改規格'


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def section(text, heading):
    """從標題含 heading 的 `## ` 段取到下一個 `## ` 之前。"""
    m = re.search(rf'^## [^\n]*{heading}[^\n]*\n(.*?)(?=^## |\Z)', text, re.M | re.S)
    if not m:
        raise AssertionError(f'找不到「{heading}」段')
    return m.group(1)


class ReviewContractTest(unittest.TestCase):
    def test_review_contract_records_behavior_neutral_medium(self):
        """AC-1：不影響行為的 MEDIUM 在審查檔標「（記錄、不修）」、記進 History、不寫進「等你」，下一步直接開 PR。"""
        text = read(CONTRACT)

        self.assertIn('（記錄、不修）', text)
        for word in ('規格紀錄', '文件', '命名', '重複', '註解', '可維護性'):
            self.assertIn(word, text, word)
        self.assertIn('改不改程式行為都一樣', text)
        self.assertIn('不寫進卡片「等你」', text)
        self.assertIn('審查 MEDIUM n 條記錄、不修（<一句摘要>），見 .task/REVIEW.md', text)
        self.assertRegex(text, r'拿不準[^\n]*可能影響行為')
        self.assertIn('`可開 PR：push 後開 PR`', text)
        self.assertRegex(text, r'「等你」寫 無')
        # 舊的無條件句不再出現
        self.assertNotIn('CRITICAL＋HIGH 為 0、但有 MEDIUM：卡片「等你」寫成一題', text)
        # 關卡格式不動
        self.assertIn('`review：CRITICAL <n>、HIGH <n>、MEDIUM <n>、LOW <n>；<一句結論>`', text)
        # 複審不重提記錄、不修的
        self.assertIn('「記錄、不修」的不要再提', text)

    def test_review_contract_still_asks_behavior_affecting_medium(self):
        """AC-4：可能影響行為（或拿不準）的 MEDIUM 照舊在「等你」問一題，多條合成一題、選項不用「；」。"""
        text = read(CONTRACT)

        self.assertIn(ASK, text)
        self.assertIn('`決定 MEDIUM 後 push、開 PR`', text)
        self.assertIn('多條', text)
        self.assertIn('選項裡不要用「；」', text)
        # 每種 MEDIUM 都算進關卡的 MEDIUM 數
        self.assertIn('都算進關卡的 MEDIUM', text)

    def test_workflow_docs_say_behavior_neutral_medium_is_recorded(self):
        """AC-1：docs/WORKFLOW.md 自動流程段與 /desk:flow 審查段都寫明不影響行為的 MEDIUM 直接記錄、不問。"""
        for path, heading in ((WORKFLOW, '自動流程'), (FLOW, '審查')):
            part = section(read(path), heading)
            self.assertIn('記錄、不修', part, path)
            self.assertIn('等你', part, path)
            self.assertIn('不影響行為', part, path)

    def test_review_contract_auto_fixes_behavior_medium_until_rounds_run_out(self):
        """auto-fix-medium AC-4：可能影響行為的 MEDIUM 還有修正輪數時自動修；要你決定的標「（等你決定）」並問；流程文件寫明會自動修。"""
        text = read(CONTRACT)

        self.assertIn('（等你決定）', text)
        self.assertIn('自動派修正', text)
        self.assertIn('修正輪數', text)
        self.assertIn(ASK, text)
        self.assertRegex(text, r'驗收情境無法驗證、要改規格才能修[^\n]*（等你決定）')
        self.assertRegex(text, r'這次不會自動修[^\n]*（等你決定）')
        self.assertRegex(text, r'審查檔也沒有不帶註記的 MEDIUM 就過關')
        # 複審會確認上一輪沒加註記的 MEDIUM，記錄、不修的照舊不再提
        self.assertIn('沒加註記的 MEDIUM 修好沒', text)
        self.assertIn('「記錄、不修」的不要再提', text)
        for path, heading in ((WORKFLOW, '自動流程'), (FLOW, '審查')):
            part = section(read(path), heading)
            self.assertRegex(part, r'可能影響行為的 MEDIUM[^\n]*自動派', path)
            self.assertIn('最多兩輪', part, path)

    def test_unverifiable_ac_line_is_marked_your_decision_when_review_cannot_verify_spec(self):
        """審查 MEDIUM 第 4 條：規格對照「無法判斷」的範本行帶「（等你決定）」，照抄也不會被當成要自動修；MEDIUM 分三點後寫「都算進」。"""
        text = read(CONTRACT)

        line = next(l for l in text.splitlines() if l.strip().startswith('- 無法判斷'))

        self.assertIn('`- [MEDIUM][規格] — AC-n 無法驗證：…（等你決定）`', line)
        self.assertIn('- 都算進關卡的 MEDIUM 數。', text)
        self.assertNotIn('兩種都算進', text)


if __name__ == '__main__':
    unittest.main()
