"""skills/flow/SKILL.md（/desk:flow）的測試：六段都有寫到、面板要按的鍵與寫回指令都在。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SKILL = os.path.join(ROOT, 'skills', 'flow', 'SKILL.md')
STAGES = ('規格', '實作', '測試', '驗收', '合併', '上線')


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


class FlowSkillTest(unittest.TestCase):
    def test_flow_skill_lists_six_stages(self):
        text = read(SKILL)
        self.assertRegex(text, r'^---\nname: flow\ndescription: .+\n---\n', 'frontmatter 要有 name: flow 與 description')
        headings = re.findall(r'^## (.+)$', text, re.M)
        # 六段各一節，依序出現，後面接歸檔
        at = [next((i for i, h in enumerate(headings) if stage in h), -1) for stage in (*STAGES, '歸檔')]
        self.assertNotIn(-1, at, headings)
        self.assertEqual(at, sorted(at), headings)
        for stage in STAGES:
            section = re.search(rf'^## [^\n]*{stage}[^\n]*\n(.*?)(?=^## |\Z)', text, re.M | re.S).group(1)
            self.assertIn('對話要做什麼', section, stage)
            self.assertIn('面板怎麼看得到', section, stage)
        self.assertIn('/desk:card done', text)
        for key in ('t', 'v', 'u'):
            self.assertRegex(text, rf'按 `?{key}`?', key)

    def test_flow_skill_names_stages_three_and_four_test_and_acceptance(self):
        """AC-5：第 3、4 段寫「測試」「驗收」，done 的下一步用新詞；舊說法（完成檢查、派審查、重新檢查與審查）不再出現。"""
        text = read(SKILL)

        self.assertRegex(text, re.compile(r'^## 3 測試\n', re.M))
        self.assertRegex(text, re.compile(r'^## 4 驗收\n', re.M))
        self.assertIn('按 `w` 兩次派驗收', text)
        self.assertIn('測試未通過（exit n）', text)
        self.assertIn('到面板按 v 執行測試', text)
        self.assertIn('等自動重新測試；沒動靜就到面板按 v', text)
        self.assertIn('到面板照「輪到你」接著做', text)
        for old in ('完成檢查', '派審查', '重新檢查與審查', '檢查未通過', '審查通過'):
            self.assertNotIn(old, text, old)

    def test_flow_skill_says_how_to_pick_the_card_without_a_slug(self):
        """/desk:flow 沒帶 slug：用目前 worktree 的資料夾名；在主 repo 用 main（審查 MEDIUM-1）。"""
        text = read(SKILL)

        self.assertIn('沒帶 slug', text)
        self.assertIn('git rev-parse --show-toplevel', text)
        self.assertRegex(text, r'主 repo[^\n]*`main`')

    def test_flow_skill_ends_with_one_line_claude_md_rule(self):
        text = read(SKILL)
        last = re.findall(r'^## [^\n]*\n', text, re.M)[-1]
        self.assertIn('CLAUDE.md', last)
        tail = text[text.rindex(last):]
        rule = re.findall(r'^```[^\n]*\n(.*?)```', tail, re.M | re.S)
        self.assertEqual(len(rule), 1, '末尾放一個規則範本')
        lines = [l for l in rule[0].split('\n') if l.strip()]
        self.assertEqual(len(lines), 1, '規則只有一行')
        self.assertIn('/desk:card done', lines[0])


if __name__ == '__main__':
    unittest.main()
