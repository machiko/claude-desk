"""根目錄 GLOSSARY.md 與 docs/ROADMAP.md 的格式（grill-spec 卡 AC-5）。

詞彙表開頭寫明只放詞彙，每條是「**用語**：一兩句定義」加 `_Avoid_` 棄用說法；
路線圖有終點、已決定、還說不清楚的、不做四段，「還說不清楚的」列有面板路線圖卡。
連結有效由 test_doc_links.py 驗（ROADMAP 在 docs/ 底下）。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GLOSSARY = os.path.join(ROOT, 'GLOSSARY.md')
ROADMAP = os.path.join(ROOT, 'docs', 'ROADMAP.md')
ENTRY = re.compile(r'^\*\*([^*]+)\*\*：\S')
AVOID = re.compile(r'^_Avoid_：\S')
ROADMAP_SECTIONS = ('終點', '已決定', '還說不清楚的', '不做')
MIN_ENTRIES = 10  # 規格列的面板用語：等你、關卡、輪到你、瑣事卡、疊放、完成檢查、驗收、歸檔、發版、六段


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def glossary_entries(text):
    """回傳 [(用語, 區塊各行)]：「## 用語」之後以空行分隔的區塊。"""
    body = text[text.index('\n## 用語\n') + len('\n## 用語\n'):]
    blocks = [b.strip('\n') for b in re.split(r'\n\s*\n', body) if b.strip()]
    out = []
    for block in blocks:
        lines = block.split('\n')
        m = ENTRY.match(lines[0])
        out.append((m.group(1) if m else None, lines))
    return out


def sections(text):
    """回傳 {二級標題: 內容}。"""
    parts = re.split(r'^## (.+)$', text, flags=re.M)
    return {parts[i].strip(): parts[i + 1] for i in range(1, len(parts), 2)}


class GlossaryRoadmapTest(unittest.TestCase):
    def test_glossary_entries_use_term_definition_format(self):
        """AC-5：開頭寫明只放詞彙；「## 用語」底下每個區塊是「**用語**：定義」加一行 `_Avoid_：…`；涵蓋規格列的面板用語。"""
        text = read(GLOSSARY)
        intro = text.split('\n## ', 1)[0]
        self.assertIn('只放詞彙', intro)
        self.assertIn('不放實作', intro)
        entries = glossary_entries(text)
        self.assertGreaterEqual(len(entries), MIN_ENTRIES)
        for term, lines in entries:
            self.assertIsNotNone(term, f'條目第一行不是「**用語**：定義」：{lines[0]}')
            self.assertEqual(len(lines), 2, f'「{term}」要剛好兩行：定義一行、_Avoid_ 一行')
            self.assertRegex(lines[1], AVOID, f'「{term}」第二行要是「_Avoid_：…」')
        terms = [t for t, _ in entries]
        self.assertEqual(len(terms), len(set(terms)), '用語重複')
        for term in ('等你', '關卡', '輪到你', '瑣事卡', '疊放', '完成檢查', '驗收', '歸檔', '發版', '六段'):
            self.assertIn(term, terms)

    def test_glossary_entry_parser_flags_bad_blocks(self):
        """AC-5：解析器認得出缺 `_Avoid_`、第一行不是粗體用語的區塊（守門測試本身會紅）。"""
        sample = '# t\n\n## 用語\n\n**好**：定義。\n_Avoid_：壞\n\n好：沒有粗體。\n_Avoid_：x\n\n**缺**：沒有棄用說法。\n'
        entries = glossary_entries(sample)
        self.assertEqual([t for t, _ in entries], ['好', None, '缺'])
        self.assertEqual(len(entries[2][1]), 1)

    def test_roadmap_has_four_sections(self):
        """AC-5：ROADMAP.md 依序有終點、已決定、還說不清楚的、不做四段，各段有內容；「還說不清楚的」列有面板路線圖卡。"""
        text = read(ROADMAP)
        found = sections(text)
        self.assertEqual([k for k in found if k in ROADMAP_SECTIONS], list(ROADMAP_SECTIONS))
        for name in ROADMAP_SECTIONS:
            self.assertRegex(found[name], r'(?m)^- \S', f'「{name}」段沒有條目')
        self.assertIn('面板路線圖卡', found['還說不清楚的'])


if __name__ == '__main__':
    unittest.main()
