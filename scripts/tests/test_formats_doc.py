"""格式版本標記 AC-6：docs/FORMATS.md 列的版號，跟 hooks/formats.ts、card.py 的常數，以及卡片模板、空登錄表的標記一致。
0.63 收尾卡 AC-4：舊格式清單「在哪裡處理」欄反引號寫的函式或常數，都真的在同一段列出的檔裡。

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


def legacy_rows():
    """「舊格式清單」表：每列（舊寫法, 在哪裡處理）。"""
    section = read(DOC).split('## 舊格式清單', 1)[1]
    rows = []
    for line in section.split('\n'):
        cols = [c.strip() for c in line.strip().strip('|').split('|')]
        if line.startswith('|') and len(cols) == 3 and cols[0] not in ('舊寫法', '---'):
            rows.append((cols[0], cols[1]))
    return rows


IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
SOURCE = re.compile(r'[\w./-]+\.(?:ts|tsx|py)')


def doc_path(token):
    """表裡的檔名換成 repo 裡的路徑：只寫 `card.py` 的指 skills/card/scripts/card.py。"""
    return CARD_PY if token == 'card.py' else os.path.join(ROOT, token)


def missing_names(where):
    """「在哪裡處理」那格：以「；」分段，每段反引號裡的程式檔與名稱（設定鍵 `card.base` 這類兩種都不是，不看）；
    檔案不存在、名稱不在同一段任何一個檔裡就列出來。"""
    out = []
    for part in where.split('；'):
        tokens = re.findall(r'`([^`]+)`', part)
        files = [t for t in tokens if SOURCE.fullmatch(t)]
        names = [t for t in tokens if IDENT.fullmatch(t)]
        for f in files:
            if not os.path.isfile(doc_path(f)):
                out.append(f'{f}（檔案不存在）')
        texts = [read(doc_path(f)) for f in files if os.path.isfile(doc_path(f))]
        for name in names:
            if not any(re.search(r'\b' + re.escape(name) + r'\b', t) for t in texts):
                out.append(f'{name}（不在 {"、".join(files) or "沒列檔案"}）')
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


class LegacyTableTest(unittest.TestCase):
    def test_legacy_table_names_exist_in_listed_files(self):
        rows = legacy_rows()
        self.assertGreater(len(rows), 10, 'docs/FORMATS.md 讀不到舊格式清單')
        for old, where in rows:
            self.assertEqual(missing_names(where), [], f'舊格式清單「{old}」那列')
        # 舊 MEDIUM 題寫的是現在真的處理它的地方：選了修掉之後派修正的是 fixPickedMedium，reviewSettled 不看這種題目。
        medium = [where for old, where in rows if old.startswith('審查 MEDIUM 在「等你」問')]
        self.assertEqual(len(medium), 1)
        self.assertIn('`fixPickedMedium`', medium[0])
        self.assertNotIn('reviewSettled', medium[0])

    def test_missing_name_is_reported(self):
        """讀法本身會抓到寫錯的名稱與不存在的檔（不然上面那支永遠綠）。"""
        self.assertEqual(missing_names('`hooks/formats.ts` 的 `CARD_FORMAT`；`card.py` 的 `CARD_FORMAT`'), [])
        self.assertEqual(missing_names('`hooks/formats.ts` 的 `NO_SUCH_NAME`'), ['NO_SUCH_NAME（不在 hooks/formats.ts）'])
        self.assertEqual(missing_names('`hooks/no-such.ts` 的 `CARD_FORMAT`'), ['hooks/no-such.ts（檔案不存在）', 'CARD_FORMAT（不在 hooks/no-such.ts）'])


if __name__ == '__main__':
    unittest.main()
