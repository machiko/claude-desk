"""skills/card/SKILL.md「產生規格」的測試：釐清題有推薦就寫成預設決定、沒推薦的才按依賴分輪問；必問程式矛盾與用詞衝突；
驗收情境反證檢查；回報的預設決定用 ❓／➡️ 兩行；規格前審背景跑、小卡跳過。

`claude plugin test` 的環境不能讀 .md 檔，所以讀檔的斷言放這裡（做法同 test_release_skill.py）。

執行：python3 -m unittest discover -s skills/card/tests
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
CARD_SKILL = os.path.join(ROOT, 'skills', 'card', 'SKILL.md')
FLOW_SKILL = os.path.join(ROOT, 'skills', 'flow', 'SKILL.md')
OLD_PHRASE = '問 3–5 個釐清問題'


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def frontmatter(text):
    m = re.match(r'---\n(.*?)\n---\n', text, re.S)
    if m is None:
        raise AssertionError('SKILL.md 沒有 frontmatter')
    return m.group(1), text[m.end():]


def step(body, label):
    """取「產生規格」裡以 `<label> **` 開頭的那一步（到下一個編號步驟為止）。"""
    spec = body[body.index('## 產生規格（spec）'):]
    start = spec.index(f'\n{label} **')
    rest = spec[start + 1:]
    nxt = re.search(r'\n\d+[a-z]?\. \*\*', rest)
    return rest[:nxt.start()] if nxt else rest


class SpecSkillTest(unittest.TestCase):
    def setUp(self):
        self.front, self.body = frontmatter(read(CARD_SKILL))
        self.flow = read(FLOW_SKILL)

    def test_spec_skill_writes_recommended_answers_as_default_decisions(self):
        """AC-1：有推薦的題不停下來問、照推薦寫進規格；Decisions 每題一筆預設；skill 說明與 /desk:flow 不再寫「問 3–5 個釐清問題」。"""
        ask = step(self.body, '4.')
        self.assertIn('有推薦答案的題不停下來問：照推薦寫進規格', ask)
        write = step(self.body, '5.')
        self.assertIn('預設（確認規格時可改）：<題目> → <採用的答案>（其他選項：<…>）', write)
        self.assertIn('每題加一筆', write)
        self.assertIn('有推薦答案的釐清題照推薦寫成預設決定、沒推薦的才問', self.front)
        for text in (self.front, self.body, self.flow):
            self.assertNotIn(OLD_PHRASE, text)
        flow_spec = next(l for l in self.flow.splitlines() if l.startswith('- 對話要做什麼：`/desk:card spec'))
        self.assertIn('有推薦答案的釐清題照推薦寫成預設決定、沒推薦的才問', flow_spec)
        self.assertNotIn('問釐清問題', flow_spec)

    def test_spec_skill_asks_only_questions_without_recommendation(self):
        """AC-2：只有沒推薦、或選錯要重寫大半規格的題才用 AskUserQuestion 問，其他照 AC-1 寫成預設。
        題數上限由 grill-spec 卡 AC-1 改成每輪最多 3 題（原本一次最多 4 題）。"""
        ask = step(self.body, '4.')
        rule = next(l for l in ask.splitlines() if 'AskUserQuestion' in l)
        for part in ('兩個選項都合理、沒有推薦', '選錯要重寫大半規格', '才用 AskUserQuestion 問', '每輪最多 3 題'):
            self.assertIn(part, rule)
        self.assertIn('其他題照推薦寫成預設', rule)
        self.assertNotIn('一次最多 4 題', ask)
        self.assertNotIn('總共 3–5 題', ask)

    def test_spec_skill_asks_in_dependency_rounds_with_caps(self):
        """grill-spec AC-1：沒推薦的題按依賴分輪，第一輪只問被依賴的題、第二輪才問依賴它們的題；每輪最多 3 題、最多 2 輪；
        還有題目沒問完時回報建議拆卡；有推薦的題照舊寫成預設、不問。"""
        ask = step(self.body, '4.')
        rounds = next((l for l in ask.splitlines() if '按依賴分輪' in l), None)
        self.assertIsNotNone(rounds, '步驟 4 沒有「按依賴分輪」的規則')
        for part in ('第一輪只問別題要看它答案才能決定的題', '第二輪才問依賴它們的題', '最多 2 輪', '還有題目沒問', '建議拆卡'):
            self.assertIn(part, rounds)
        self.assertLess(rounds.index('第一輪'), rounds.index('第二輪'))
        self.assertIn('每輪最多 3 題', ask)
        self.assertIn('有推薦答案的題不停下來問：照推薦寫進規格', ask)
        report = step(self.body, '6.')
        self.assertIn('2 輪問完還有題目沒問時', report)
        self.assertIn('建議拆卡', report)
        self.assertIn('按依賴分輪、每輪最多 3 題', self.front)

    def test_spec_skill_challenges_code_conflicts_and_glossary_terms(self):
        """grill-spec AC-2：需求跟程式行為對不上、或用詞跟既有 GLOSSARY.md 不一致，一定列為釐清題（不寫成預設），
        題目寫出程式現況或詞彙表定義；用語定案後補進既有的 GLOSSARY.md，沒有就不建立。
        補進去的方式是寫進實作計畫、由實作 commit：寫規格這步只改卡片，worktree 留下未提交改動會擋住確認後派實作。"""
        ask = step(self.body, '4.')
        rule = next((l for l in ask.splitlines() if 'GLOSSARY.md' in l), None)
        self.assertIsNotNone(rule, '步驟 4 沒有比對 GLOSSARY.md 的規則')
        for part in ('必問（不寫成預設）', '需求描述跟程式行為對不上', '用詞跟專案根目錄既有的 `GLOSSARY.md` 不一致',
                     '程式現況', '詞彙表的定義', '算進每輪 3 題', '用語定案後補進既有的 `GLOSSARY.md`',
                     '這一步不改那個檔', '在「### 實作計畫」加一列 `GLOSSARY.md`', '由實作補進來並 commit',
                     '沒有 `GLOSSARY.md` 時不建立'):
            self.assertIn(part, rule)
        plan = next(l for l in step(self.body, '5.').splitlines() if '「### 實作計畫」表' in l)
        self.assertIn('步驟 4 有定案的用語時列 `GLOSSARY.md`', plan)
        read_only = next(l for l in step(self.body, '2.').splitlines() if '不改程式、不 commit' in l)
        for part in ('整個 spec 只寫這張卡片', '不改 worktree 裡其他檔', '`GLOSSARY.md`、文件也不改', '寫進「### 實作計畫」'):
            self.assertIn(part, read_only)

    def test_spec_skill_requires_falsifiable_acceptance_rows(self):
        """grill-spec AC-3：寫進卡片前每條驗收情境都要說得出「看到什麼就算沒做到」、開工時還看不到；說不出的改寫；
        History 記「反證檢查：n 條、改寫 m 條」；瑣事卡跳過；不加驗收情境欄位。"""
        write = step(self.body, '5.')
        rule = next((l for l in write.splitlines() if '反證檢查' in l), None)
        self.assertIsNotNone(rule, '步驟 5 沒有反證檢查的規則')
        for part in ('寫進卡片前', '瑣事卡跳過', '看到什麼就算沒做到', '開工時', '還看不到', '改寫',
                     '不另加欄位', '`- YYYY-MM-DD HH:MM：反證檢查：n 條、改寫 m 條`'):
            self.assertIn(part, rule)
        self.assertLess(write.index('反證檢查'), write.index('card.py gate'))

    def test_spec_skill_report_marks_questions_and_recommendations(self):
        """grill-spec AC-4：回報的每條預設決定用兩行列出：`❓ D-nn <題目>`、下一行 `➡️ <採用的答案>（其他選項：…）`；
        「先一句結論」仍排在最前。"""
        report = step(self.body, '6.')
        self.assertIn('每條兩行：`❓ D-nn <題目>`，下一行 `➡️ <採用的答案>（其他選項：<…>）`', report)
        self.assertLess(report.index('先一句結論'), report.index('❓'))
        self.assertLess(report.index('❓'), report.index('➡️'))

    def test_spec_skill_report_lists_default_decisions(self):
        """AC-3：回報在結論後逐條列出預設決定（題目、採用的答案、其他選項），確認那行寫明確認規格同時確認這幾條預設、要改哪條直接說。"""
        report = step(self.body, '6.')
        self.assertIn('有預設決定時接著逐條列出（題目、採用的答案、其他選項）', report)
        self.assertLess(report.index('先一句結論'), report.index('逐條列出'))
        confirm = next(l for l in report.splitlines() if l.strip().startswith('`確認：'))
        self.assertIn('確認規格同時確認上面列的預設決定', confirm)
        self.assertIn('要改哪一條（含預設）直接說', confirm)
        # 沒有預設決定時，那句與「（含預設）」都要省略，確認行字面才成立
        omit = next(l for l in report.splitlines() if '沒有預設決定時省略' in l)
        self.assertIn('「確認規格同時確認上面列的預設決定；」那句與「（含預設）」', omit)

    def test_spec_skill_runs_preflight_in_background(self):
        """AC-4：相關檔 3 個以上時前審在背景跑，同時繼續讀程式與擬草稿，寫進卡片前收結果；History 照舊記候選與採用數。"""
        pre = step(self.body, '2b.')
        for part in ('相關檔 3 個以上', '在背景執行前審指令', '同時繼續讀程式', '擬規格草稿', '寫進卡片前收結果'):
            self.assertIn(part, pre)
        self.assertIn('規格前審：候選 m、採用 n', pre)

    def test_spec_skill_skips_preflight_for_small_cards(self):
        """AC-5：相關檔只有 1～2 個時不跑前審，History 記「規格前審：略過（小卡：相關檔 n 個）」；瑣事卡照舊跳過。"""
        pre = step(self.body, '2b.')
        self.assertIn('相關檔只有 1～2 個', pre)
        self.assertIn('不跑前審', pre)
        self.assertIn('`- YYYY-MM-DD HH:MM：規格前審：略過（小卡：相關檔 n 個）`', pre)
        trivial = step(self.body, '2c.')
        self.assertIn('跳過 2b 規格前審', trivial)

    def test_spec_preflight_threshold_from_config(self):
        """card-base-and-fast-path AC-4／AC-7：2b 的小卡門檻讀步驟 1 印的 `spec preflight min files:`（card.specPreflightMinFiles，沒設是 3）。
        card.py 印出門檻的那半由 test_card.py 的 test_card_command_prints_spec_preflight_min_files 驗。"""
        pre = step(self.body, '2b.')
        skip = next(l for l in pre.splitlines() if '不跑前審' in l)
        for part in ('少於步驟 1 印的 `spec preflight min files:`', '`card.specPreflightMinFiles`', '沒設是 3'):
            self.assertIn(part, skip)
        self.assertIn('相關檔達到門檻', pre)

    def test_spec_skill_requires_unchanged_behavior_rows(self):
        """build-like-review AC-5：改到自動流程、狀態旗標或解析器的卡，寫驗收情境時要列「維持現狀」的相鄰路徑或真實輸出樣本，各一列。"""
        write = step(self.body, '5.')
        rule = next((l for l in write.splitlines() if '維持現狀' in l), None)
        self.assertIsNotNone(rule, '步驟 5 沒有「維持現狀」情境的規則')
        for part in ('改到自動流程、狀態旗標或解析器時', '受影響的相鄰路徑', '暫停後重開', '別的對話', '重新驗收', '真實輸出樣本', '各一列'):
            self.assertIn(part, rule)


if __name__ == '__main__':
    unittest.main()
