"""skills/flow/SKILL.md（/desk:flow）的測試：六段都有寫到、面板要按的鍵與寫回指令都在。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SKILL = os.path.join(ROOT, 'skills', 'flow', 'SKILL.md')
STAGES = ('規格', '實作', '檢查', '審查', '合併', '上線')


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
