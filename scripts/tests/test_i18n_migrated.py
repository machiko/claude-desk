"""守門：已搬進字串目錄（hooks/i18n/zh-TW.ts）的檔不再直接寫中文顯示字串，目錄裡也沒有用不到的鍵（i18n 目錄與示範 AC-3、AC-4）。

沿用 test_wording 的 strip_code：去掉註解與正規式字面值之後，程式文字裡還有中文字或全形標點就列出「檔:行」。
MIGRATED 是已搬完的檔，之後的卡搬完一個檔就往上加；只搬了一段的檔（register.tsx 只搬 /desk 指令說明）另列在 MIGRATED_LINES，只看那幾行。
KEPT 是搬完的檔裡刻意留在原處的字（解析契約、卡片欄位名），每條寫原因。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_wording import ROOT, hook_files, strip_code  # noqa: E402

CATALOG = 'hooks/i18n/zh-TW.ts'
MIGRATED = (
    'hooks/update.ts',
    'hooks/update-run.ts',
    'hooks/release-update.ts',
    'hooks/engine-version.ts',
    'hooks/formats.ts',
    'hooks/kind-label.ts',
    'hooks/stack.ts',
)
# (檔名, 只看符合這個正規式的行)
MIGRATED_LINES = (
    ('hooks/register.tsx', re.compile(r"\$\.command\.register\(\{ name: 'desk'")),
)
# (檔名, 那一行裡要扣掉的字, 原因)
KEPT = (
    ('hooks/release-update.ts', re.compile(r"\['狀態'\]"), '卡片欄位名，解析契約（規格非目標）'),
)
CHINESE = re.compile(r'[　-〿一-鿿＀-￯]+')
CATALOG_KEY = re.compile(r"^\s*'([\w.]+)':", re.M)


def inline_chinese(rel, text, only=None):
    """回傳 [(行號, 那一行)]：去掉註解、正規式與 KEPT 之後還有中文的行；only 是正規式時只看符合它的原始行。"""
    lines = text.split('\n')
    found = []
    for no, code in enumerate(strip_code(text).split('\n'), 1):
        raw = lines[no - 1]
        if only is not None and not only.search(raw):
            continue
        for f, pat, _why in KEPT:
            if f == rel:
                code = pat.sub('', code)
        if CHINESE.search(code):
            found.append((no, raw.strip()))
    return found


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


class MigratedFilesTest(unittest.TestCase):
    def test_migrated_files_have_no_inline_chinese_display_text(self):
        """AC-3：已搬完的檔沒有直接寫的中文顯示字串，有就列出「檔:行」。"""
        targets = [(rel, None) for rel in MIGRATED] + list(MIGRATED_LINES)
        hits = [f'{rel}:{no} {line[:80]}' for rel, only in targets for no, line in inline_chinese(rel, read(rel), only)]
        self.assertEqual(hits, [], '已搬進字串目錄的檔又直接寫了中文，改寫進 hooks/i18n/zh-TW.ts 再用 t() 取：\n' + '\n'.join(hits))

    def test_guard_reports_file_and_line_and_skips_comments_regex_and_kept(self):
        """AC-3：守門本身認得出字串、樣板字串與 JSX 文字裡的中文；註解、正規式與 KEPT 扣掉的字不算；only 只看指定的行。"""
        text = '\n'.join([
            "// 註解裡的中文",
            "const re = /已發版/",
            "const a = t('update.busy')",
            "const b = '有新版本'",
            "const c = `desk ${x}：更新`",
            "const d = <Text>好</Text>",
            "const e = card?.['狀態']",
        ])
        self.assertEqual([no for no, _ in inline_chinese('hooks/x.ts', text)], [4, 5, 6, 7])
        self.assertEqual([no for no, _ in inline_chinese('hooks/release-update.ts', text)], [4, 5, 6])
        self.assertEqual([no for no, _ in inline_chinese('hooks/x.ts', text, re.compile('const b'))], [4])

    def test_partial_and_kept_entries_still_match(self):
        """MIGRATED_LINES 每條真的對到一行、KEPT 每條在那個檔真的扣到字，免得改了程式之後守門默默變成什麼都不看。"""
        for rel in MIGRATED:
            self.assertTrue(os.path.exists(os.path.join(ROOT, rel)), rel)
        for rel, only in MIGRATED_LINES:
            self.assertTrue(any(only.search(line) for line in read(rel).split('\n')), rel)
        for rel, pat, why in KEPT:
            self.assertTrue(pat.search(read(rel)), rel)
            self.assertRegex(why, '契約|欄位名')

    def test_catalog_has_no_unused_keys(self):
        """AC-4：目錄裡每個鍵都有 hooks 底下別的檔在用（寫成 'update.notice' 這樣的字面值）。"""
        keys = CATALOG_KEY.findall(read(CATALOG))
        self.assertTrue(keys)
        self.assertEqual(len(keys), len(set(keys)), '目錄有重複的鍵')
        code = '\n'.join(strip_code(read(rel)) for rel, _path in hook_files() if rel != CATALOG)
        unused = [k for k in keys if f"'{k}'" not in code]
        self.assertEqual(unused, [], '字串目錄有沒有程式在用的鍵，刪掉或補上用的地方：\n' + '\n'.join(unused))


if __name__ == '__main__':
    unittest.main()
