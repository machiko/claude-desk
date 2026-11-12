"""templates/review.md（審查契約）與流程文件的測試：MEDIUM 不管影不影響行為一律記錄、不問（驗收 MEDIUM 記錄後繼續）；自動修正只修 CRITICAL／HIGH。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONTRACT = os.path.join(ROOT, 'templates', 'review.md')
WORKFLOW = os.path.join(ROOT, 'docs', 'WORKFLOW.md')
FLOW = os.path.join(ROOT, 'skills', 'flow', 'SKILL.md')
ASK = '審查 MEDIUM 1 條（<一句摘要>）怎麼處理：A) 不修，記錄原因 B) 另開卡修（推薦，這張先過關） C) 修掉（在這張卡修，多一輪修正） D) 改規格'


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
        self.assertIn('不寫進卡片「等你」', text)
        # plain-pm-wording AC-4：歷程那筆照白話範本「<誰>：<做了什麼> → <結果>」，不寫檔名
        self.assertIn('`- YYYY-MM-DD HH:MM：審查：MEDIUM n 條記錄不修 → 見審查檔`', text)
        self.assertNotIn('見 .task/REVIEW.md`', text)
        self.assertIn('`可開 PR：push 後開 PR`', text)
        # 舊的無條件句不再出現
        self.assertNotIn('CRITICAL＋HIGH 為 0、但有 MEDIUM：卡片「等你」寫成一題', text)
        # 關卡格式不動
        self.assertIn('`review：CRITICAL <n>、HIGH <n>、MEDIUM <n>、LOW <n>；<一句結論>`', text)
        # 複審不重提記錄、不修的
        self.assertIn('「記錄、不修」的不要再提', text)

    def test_review_contract_lists_test_anti_patterns(self):
        """review-pr-risk AC-4：審查規則列出三種測試反模式（預期值同一套算法、mock 專案自己的模組、橫向切片），歸 MEDIUM 記錄、不修；是某條 AC 唯一的對應測試、驗不到「則」時算沒測到、列 HIGH。"""
        text = read(CONTRACT)
        part = text.split('測試寫法（', 1)[1].split('\n\n', 1)[0]

        self.assertIn('預期值跟程式用同一套方法算', part)
        self.assertIn('mock 了專案自己的模組', part)
        self.assertIn('橫向切片：先寫完全部測試才寫程式', part)
        self.assertIn('這三種列成 `- [MEDIUM][測試] … （記錄、不修）`', part)
        self.assertRegex(part, r'唯一的對應測試、因此驗不到「則」那欄的結果時，那條 AC 算「沒測到」，改列 `- \[HIGH\]\[測試\]')
        # 放在分級之後、規格對照之前
        self.assertLess(text.index('- LOW：風格'), text.index('測試寫法（'))
        self.assertLess(text.index('測試寫法（'), text.index('規格對照（'))

    def test_review_contract_records_behavior_affecting_medium(self):
        """review-medium-record AC-4（驗收 MEDIUM 記錄後繼續 AC-1 改）：可能影響行為（或拿不準、AC 無法驗證）的 MEDIUM 也只記錄、不在「等你」問；舊卡已有的題目保留、不新增。"""
        text = read(CONTRACT)

        self.assertRegex(text, r'可能影響行為的（拿不準的、驗收情境無法驗證、要改規格才能修的也一樣）：審查檔那條結尾加「（記錄、不修）」，不寫進卡片「等你」')
        self.assertIn('工作桌不會自動修 MEDIUM，流程照常往開 PR 走', text)
        self.assertIn('推送 Agent 會把審查檔的 MEDIUM 逐條列進 PR 說明', text)
        self.assertIn('「等你」不新增 MEDIUM 的題目', text)
        # 舊規則的題目、下一步與新標法都不再出現
        self.assertNotIn(ASK, text)
        self.assertNotIn('`決定 MEDIUM 後 push、開 PR`', text)
        self.assertNotIn('一律在審查檔那條結尾標「（等你決定）」', text)
        # 每種 MEDIUM 都算進關卡的 MEDIUM 數
        self.assertIn('都算進關卡的 MEDIUM', text)

    def test_workflow_docs_say_behavior_neutral_medium_is_recorded(self):
        """AC-1：docs/WORKFLOW.md 自動流程段與 /desk:flow 驗收段都寫明不影響行為的 MEDIUM 直接記錄、不問。"""
        for path, heading in ((WORKFLOW, '自動流程'), (FLOW, '驗收')):
            part = section(read(path), heading)
            self.assertIn('記錄、不修', part, path)
            self.assertIn('等你', part, path)
            self.assertIn('不影響行為', part, path)

    def test_review_contract_records_medium_and_counts_fix_rounds_per_card(self):
        """修正輪收斂（驗收 MEDIUM 記錄後繼續 AC-1 改）：MEDIUM 不分第幾輪一律記錄、不問、不自動修；自動修正只修 CRITICAL／HIGH，上限算整張卡；複審只把舊卡已標等你決定的照原樣再列。"""
        text = read(CONTRACT)

        self.assertRegex(text, r'驗收情境無法驗證、要改規格才能修的也一樣[^\n]*（記錄、不修）')
        self.assertIn('CRITICAL＋HIGH 為 0 就過關（MEDIUM 只記錄，照常往開 PR 走）', text)
        self.assertIn('只修 CRITICAL／HIGH', text)
        self.assertIn('整張卡（同一條分支）最多兩輪', text)
        self.assertNotIn('這次不會自動修', text)
        self.assertNotIn('不加註記', text)
        self.assertNotIn('沒加註記的 MEDIUM', text)
        # 複審：只確認 CRITICAL／HIGH；記錄、不修的不再提，舊卡已標等你決定的照原樣再列、不新增
        self.assertIn('只判斷上次的 CRITICAL／HIGH 修好沒', text)
        self.assertIn('「記錄、不修」的不要再提', text)
        self.assertIn('上一份已有標「（等你決定）」的（這條規則之前的舊卡）照原樣再列，不新增這種標法', text)
        self.assertNotIn('過關時要在「等你」問', text)
        # /desk:flow 驗收段跟著新規則
        part = section(read(FLOW), '驗收')
        self.assertIn('只修 CRITICAL／HIGH', part)
        self.assertIn('最多自動修兩輪', part)
        self.assertRegex(part, r'可能影響行為[^\n]*一律直接記錄[^\n]*不寫進「等你」')
        self.assertNotRegex(part, r'可能影響行為的 MEDIUM 時，流程會自動派')

    def test_unverifiable_ac_line_is_marked_recorded_when_review_cannot_verify_spec(self):
        """審查 MEDIUM 第 4 條（驗收 MEDIUM 記錄後繼續 AC-1 改）：規格對照「無法判斷」的範本行帶「（記錄、不修）」，照抄也不會被當成要自動修、也不在等你問；MEDIUM 分三點後寫「都算進」。"""
        text = read(CONTRACT)

        line = next(l for l in text.splitlines() if l.strip().startswith('- 無法判斷'))

        self.assertIn('`- [MEDIUM][規格] — AC-n 無法驗證：…（記錄、不修）`', line)
        self.assertIn('不寫進卡片「等你」', line)
        self.assertIn('- 都算進關卡的 MEDIUM 數。', text)
        self.assertNotIn('兩種都算進', text)

    def test_review_contract_no_longer_asks_medium_and_keeps_old_answers(self):
        """lean-fix-loop AC-2（驗收 MEDIUM 記錄後繼續 AC-6 改）：審查契約不再出 MEDIUM 題，舊卡已回答的照 Decisions 改標；/desk:flow 與 WORKFLOW 寫舊卡選項（B 另開卡修推薦、C 修掉在這張卡修）的行為。"""
        text = read(CONTRACT)

        self.assertNotIn(ASK, text)
        self.assertNotIn('B) 修掉', text)
        self.assertIn('選了不修、另開卡修或改規格的改標「（不修，見 Decisions）」', text)
        flow = section(read(FLOW), '驗收')
        self.assertIn('B) 另開卡修（推薦，這張先過關） C) 修掉（在這張卡修，多一輪修正） D) 改規格', flow)
        self.assertIn('/desk:card new feature/<slug>-medium "<原卡名>：審查 MEDIUM" <原分支>', flow)
        self.assertIn('選 C) 修掉送出時', flow)
        self.assertNotIn('修完自動重新測試與驗收', flow)
        workflow = section(read(WORKFLOW), '自動流程')
        self.assertIn('不修／另開卡修（推薦）／修掉／改規格', workflow)
        self.assertIn('卡名「<原卡名>：審查 MEDIUM」', workflow)

    def test_workflow_docs_say_pitfalls_grow_only_through_archive_retro(self):
        """review-slim AC-4：WORKFLOW 常犯錯誤清單段不再說審查會追加，寫明新條目由歸檔回顧確認後追加；只有第一次審查讀清單。"""
        text = section(read(WORKFLOW), '讓審查越來越準')
        line = next(l for l in text.splitlines() if l.startswith('- **常犯錯誤清單**'))

        self.assertNotIn('審查對話會在檔尾追加', line)
        self.assertNotIn('過去的審查紀錄', line)
        self.assertIn('新條目由歸檔回顧提出、你確認後追加', line)
        self.assertIn('第一次審查先讀（複審、重新審查、資安審查不讀）', line)


if __name__ == '__main__':
    unittest.main()
