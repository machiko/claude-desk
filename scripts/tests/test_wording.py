"""守門：hooks 裡給人看的字樣不再出現六段的舊說法（檢查／審查、進行中、仍在執行）。

六段的第 3、4 段叫「測試」「驗收」，Agent 在做事只說「處理中」。掃 hooks/**/*.ts(x) 去掉註解與正規式之後的程式文字
（字串字面值與 JSX 文字），略過寫給 Agent 的提示詞 hooks/prompts/；有舊詞就列出檔名:行號。
允許清單只放資料格式與檔名，每條寫原因。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOKS = os.path.join(ROOT, 'hooks')
SKIP_DIRS = ('prompts',)  # 寫給 Agent 的提示詞，不是給人看的句子（規格非目標）
OLD_WORDS = re.compile(
    r'檢查(?:通過|未通過|中斷|未執行|仍在執行|跑完|沒跑成)|完成檢查|派(?:獨立)?審查|審查(?:通過|結論|有要修)'
    r'|重新(?:檢查|審查)|複審|免審查|資安審查|進行中|仍在執行'
)
# (檔名, 那一行要符合的正規式, 原因)
ALLOWED = (
    ('hooks/tutorial.ts', re.compile(r'^export const REVIEW_[123] = `# 程式碼審查'),
     '教學寫進審查檔（.task/REVIEW.md）的本文，跟真的審查檔同格式；審查檔不改名（D-01）'),
    ('hooks/stop-reason.ts', re.compile(r"^\s*'完成檢查的指令(?:改過、|還沒)"),
     '換詞前存進流程紀錄（$.store 的 chain.stopped）的原因句，資料格式：只拿來比對換成新句、不顯示'),
    ('hooks/card.ts', re.compile(r"^export const UNREVIEWED_(?:GATE|MARK) = '"),
     '修正 Agent 寫進卡片關卡的結論（規格 AC-1 定的字）與認它的關鍵字，資料格式；面板的說法用「未重新驗收」'),
)
# 正規式字面值前面可能接的字元或關鍵字（其餘的「/」是除號）。不含「<」：`</` 是 JSX 收尾標籤；不含「}」：`{a}/{b}` 是 JSX 文字或除號
# （hooks 裡接在「}」後面的「/」都在樣板字串或正規式裡面）。另外 `/>` 是 JSX 自閉合標籤，也不是正規式。
REGEX_PREFIX = re.compile(r'(?:^|[(,=:\[!&|?{;+\-*%>~^]|\breturn|\btypeof|\bcase|\bin|\bof)\s*$')


def strip_code(text):
    """把註解與正規式字面值換成空白（保留換行，行號不變），留下程式、字串與 JSX 文字。"""
    out = []
    i, n = 0, len(text)
    stack = []  # 樣板字串裡 ${ … } 的大括號深度

    def blank(s):
        return ''.join('\n' if ch == '\n' else ' ' for ch in s)

    while i < n:
        ch = text[i]
        if stack and stack[-1] == 'tpl':
            if ch == '\\':
                out.append(text[i:i + 2]); i += 2; continue
            if ch == '`':
                stack.pop(); out.append(ch); i += 1; continue
            if text.startswith('${', i):
                stack.append(0); out.append('${'); i += 2; continue
            out.append(ch); i += 1; continue
        if text.startswith('//', i):
            end = text.find('\n', i)
            end = n if end < 0 else end
            out.append(blank(text[i:end])); i = end; continue
        if text.startswith('/*', i):
            end = text.find('*/', i + 2)
            end = n if end < 0 else end + 2
            out.append(blank(text[i:end])); i = end; continue
        if ch in '\'"':
            j = i + 1
            while j < n and text[j] != ch and text[j] != '\n':
                j += 2 if text[j] == '\\' else 1
            out.append(text[i:j + 1]); i = j + 1; continue
        if ch == '`':
            stack.append('tpl'); out.append(ch); i += 1; continue
        if ch == '{' and stack:
            stack[-1] += 1
        if ch == '}' and stack:
            if stack[-1] == 0:
                stack.pop(); out.append(ch); i += 1; continue
            stack[-1] -= 1
        if ch == '/' and text[i + 1:i + 2] != '>' and REGEX_PREFIX.search(''.join(out[-40:])):
            j, in_class = i + 1, False
            while j < n and text[j] != '\n' and (in_class or text[j] != '/'):
                if text[j] == '\\':
                    j += 1
                elif text[j] == '[':
                    in_class = True
                elif text[j] == ']':
                    in_class = False
                j += 1
            if j < n and text[j] == '/':
                out.append(blank(text[i:j + 1])); i = j + 1; continue
        out.append(ch); i += 1
    return ''.join(out)


def old_words(rel, text):
    """回傳 [(行號, 舊詞, 那一行)]，扣掉允許清單。"""
    lines = text.split('\n')
    found = []
    for no, line in enumerate(strip_code(text).split('\n'), 1):
        for m in OLD_WORDS.finditer(line):
            raw = lines[no - 1]
            if any(rel == f and pat.search(raw) for f, pat, _ in ALLOWED):
                continue
            found.append((no, m.group(0), raw.strip()))
    return found


def hook_files():
    for base, dirs, files in os.walk(HOOKS):
        dirs[:] = [d for d in dirs if not (base == HOOKS and d in SKIP_DIRS)]
        for name in sorted(files):
            if name.endswith(('.ts', '.tsx')):
                path = os.path.join(base, name)
                yield os.path.relpath(path, ROOT).replace(os.sep, '/'), path


class WordingGuardTest(unittest.TestCase):
    def test_hooks_strings_use_new_stage_words(self):
        hits = []
        for rel, path in hook_files():
            with open(path, encoding='utf-8') as f:
                hits += [f'{rel}:{no}：「{word}」 {line[:80]}' for no, word, line in old_words(rel, f.read())]
        self.assertEqual(hits, [], '給人看的字樣還有舊詞，改用測試／驗收／處理中／已上線：\n' + '\n'.join(hits))

    def test_guard_reports_file_and_line_and_skips_comments_and_regex(self):
        text = '\n'.join([
            "// 檢查通過 是註解",
            "/* 審查通過",
            "   還是註解 */",
            "const re = /重新審查/",
            "const a = '完成檢查已開始'",
            "const b = <Text>Agent 仍在執行</Text>",
            "const c = `${x ? `複審` : ''}資安審查`",
            "const d = <Box><Text>好</Text><Text>檢查通過</Text></Box>",
            "const e = <Text>{`   ✓ 審查通過`}</Text>",
            "const f = <Box><Box flexGrow={1} /><Text>檢查通過</Text></Box>",
            "const g = <Text>{done}/{total} 免審查</Text>",
        ])
        hits = old_words('hooks/x.ts', text)
        self.assertEqual([(no, w) for no, w, _ in hits], [(5, '完成檢查'), (6, '仍在執行'), (7, '複審'), (7, '資安審查'), (8, '檢查通過'), (9, '審查通過'), (10, '檢查通過'), (11, '免審查')])

    def test_allowed_list_is_only_data_format_with_reasons(self):
        for rel, pat, why in ALLOWED:
            self.assertTrue(os.path.exists(os.path.join(ROOT, rel)), rel)
            self.assertTrue(why.strip(), rel)
            self.assertRegex(why, '審查檔|檔名|資料格式|欄位')
        self.assertEqual(SKIP_DIRS, ('prompts',))


if __name__ == '__main__':
    unittest.main()
