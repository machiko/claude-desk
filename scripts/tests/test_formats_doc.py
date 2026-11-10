"""格式版本標記 AC-6：docs/FORMATS.md 列的版號，跟 hooks/formats.ts、card.py 的常數，以及卡片模板、空登錄表的標記一致。

plugin test 的環境不能讀檔，所以寫在這裡。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOC = os.path.join(ROOT, 'docs', 'FORMATS.md')
FORMATS_TS = os.path.join(ROOT, 'hooks', 'formats.ts')
CARD_TS = os.path.join(ROOT, 'hooks', 'card.ts')
CARD_PY = os.path.join(ROOT, 'skills', 'card', 'scripts', 'card.py')
TEMPLATE = os.path.join(ROOT, 'templates', 'DESK-template.md')
NAMES = ('CARD_FORMAT', 'SETTINGS_FORMAT', 'REGISTRY_FORMAT')
MARK_VERSION = re.compile(r'格式\s*[=＝]\s*([0-9]+)')


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def doc_versions():
    """「目前的格式」表：常數名 → 版號（表格列「| 檔案 | 版號 | 標記 | `常數` |」）。"""
    out = {}
    for line in read(DOC).split('\n'):
        cols = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cols) == 4 and re.fullmatch(r'`[A-Z_]+`', cols[3]) and cols[1].isdigit():
            out[cols[3].strip('`')] = int(cols[1])
    return out


def constants(text, pattern):
    return {name: int(m.group(1)) for name in NAMES for m in [re.search(pattern.format(name=name), text, re.M)] if m}


class FormatsDocTest(unittest.TestCase):
    def test_format_versions_match_between_code_and_docs(self):
        documented = doc_versions()
        self.assertEqual(sorted(documented), sorted(NAMES), 'docs/FORMATS.md 的「目前的格式」表要列三個常數')
        ts = constants(read(FORMATS_TS), r'^export const {name} = ([0-9]+)$')
        py = constants(read(CARD_PY), r'^{name} = ([0-9]+)$')
        self.assertEqual(ts, documented, 'hooks/formats.ts 的版號跟文件不同')
        self.assertEqual(py, documented, 'card.py 的版號跟文件不同')

        # 新開的卡與新建的登錄表寫的標記也是同一個版號
        opener = re.search(r'<!--\s*DESK([^>]*)-->', read(TEMPLATE))
        self.assertIsNotNone(opener, '卡片模板找不到 DESK 開頭標記')
        self.assertEqual(int(MARK_VERSION.search(opener.group(1)).group(1)), documented['CARD_FORMAT'])
        for path, pattern in ((CARD_TS, r"^export const REGISTRY_TEMPLATE = '([^']*)'$"), (CARD_PY, r"^REGISTRY_TEMPLATE = '([^']*)'$")):
            template = re.search(pattern, read(path), re.M)
            self.assertIsNotNone(template, f'{path} 找不到 REGISTRY_TEMPLATE')
            mark = re.search(r'<!--\s*desk\s+登錄表([^>]*)-->', template.group(1))
            self.assertIsNotNone(mark, f'{path} 的空登錄表沒有格式標記')
            self.assertEqual(int(MARK_VERSION.search(mark.group(1)).group(1)), documented['REGISTRY_FORMAT'], path)


if __name__ == '__main__':
    unittest.main()
