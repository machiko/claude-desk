"""hooks 的 atom 與 `$` 守門（瘦身 register 那張卡的 AC-3、AC-4；plugin test 的環境不能讀檔，所以寫在這裡）。

- 同一個 atom 位址（`{ plugin: 'desk', key }`）可以在多個檔案各自宣告，但預設值要一致（忽略 ` as …` 型別註記），
  不然哪個檔先讀到就用哪個預設，畫面會跟著載入順序變。
- 外掛載入時 `$` 只能傳給 function 宣告：匯出的箭頭函式收 `$` 會讓整個 hooks 模組載入失敗，
  從 register 搬出的模組與 register 本身都不能有這種寫法。
「自動流程與執行時間紀錄只定義在新模組」「既有測試檔沒改」是這次搬移的一次性事實，由審查核對、記在卡片 History，不寫成永久測試。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOKS = os.path.join(ROOT, 'hooks')
# 從 register 搬出的模組與 register 本身：匯出收 `$` 的函式都要是 function 宣告
DOLLAR_MODULES = ['register.tsx', 'auto-chain.ts', 'run-notes.ts']
ATOM_RE = re.compile(r"\batom\(\s*\{\s*plugin:\s*'desk',\s*key:\s*'([^']+)'\s*\}\s*as\s+const\s*,")
# 至少有一個匯出的 function 宣告收 `$`：模組被改名或掃描寫錯時不會因為什麼都沒掃到而綠
FUNCTION_EXPORT_RE = re.compile(r'^export\s+(?:async\s+)?function\s+\w+\(\$', re.M)
ARROW_EXPORT_RE = re.compile(r"^export\s+const\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:\(([^)]*)\)|(\$))\s*(?::[^=\n]+)?=>", re.M)


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def hook_files():
    """hooks 底下每個 .ts／.tsx（相對 hooks 的路徑） → 內容。"""
    out = {}
    for base, _dirs, files in os.walk(HOOKS):
        for name in files:
            if name.endswith(('.ts', '.tsx')) and not name.endswith('.d.ts'):
                path = os.path.join(base, name)
                out[os.path.relpath(path, HOOKS)] = read(path)
    return out


def default_after(text, start):
    """從 atom( 的第二個參數開頭讀到配對的右括號為止，回傳去掉頭尾空白與頂層 ` as …` 型別註記的預設值。"""
    depth, i = 0, start
    while i < len(text):
        ch = text[i]
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            if depth == 0:
                break
            depth -= 1
        elif ch in '\'"`':
            end = text.index(ch, i + 1)
            i = end
        i += 1
    raw = text[start:i].strip()
    return re.sub(r'\s+as\s+[\s\S]*$', '', raw).strip()


def atom_defaults(text):
    """這段程式宣告的 atom：[(key, 預設值)]。"""
    return [(m.group(1), default_after(text, m.end())) for m in ATOM_RE.finditer(text)]


def mismatched_defaults(files):
    """同一個 key 在不同地方寫了不同預設值的：{key: {預設值: [檔名]}}。"""
    seen = {}
    for name, text in files.items():
        for key, value in atom_defaults(text):
            seen.setdefault(key, {}).setdefault(value, []).append(name)
    return {k: v for k, v in seen.items() if len(v) > 1}


def arrow_exports_taking_dollar(text):
    """匯出的箭頭函式裡參數有 `$` 的名稱。"""
    found = []
    for m in ARROW_EXPORT_RE.finditer(text):
        params = m.group(2) if m.group(2) is not None else m.group(3)
        if re.search(r'(?:^|[\s,(])\$(?:\s*[:,=)]|\s*$)', params or ''):
            found.append(m.group(1))
    return found


class AtomKeysTest(unittest.TestCase):
    def test_atom_defaults_strip_type_annotation(self):
        text = (
            "const a = atom({ plugin: 'desk', key: 'trusted' } as const, {} as Record<string, string>)\n"
            "const b = atom({ plugin: 'desk', key: 'feed' } as const, [])\n"
            "const c = atom({ plugin: 'desk', key: 'snapshot' } as const, null)\n"
            "const d = atom({ plugin: 'desk', key: 'pick' } as const, { at: 0, list: [1, 2] })\n"
        )
        self.assertEqual(atom_defaults(text), [('trusted', '{}'), ('feed', '[]'), ('snapshot', 'null'), ('pick', '{ at: 0, list: [1, 2] }')])

    def test_mismatched_defaults_names_each_file(self):
        files = {
            'a.ts': "const x = atom({ plugin: 'desk', key: 'launching' } as const, {})\n",
            'b.ts': "const y = atom({ plugin: 'desk', key: 'launching' } as const, {} as Record<string, number>)\n",
            'c.ts': "const z = atom({ plugin: 'desk', key: 'launching' } as const, null)\n",
        }
        self.assertEqual(mismatched_defaults(files), {'launching': {'{}': ['a.ts', 'b.ts'], 'null': ['c.ts']}})

    def test_redeclared_atom_keys_share_defaults(self):
        files = hook_files()
        counts = {}
        for text in files.values():
            for key, _ in atom_defaults(text):
                counts[key] = counts.get(key, 0) + 1
        # 守門要真的看到重複宣告的 key，不然掃描寫錯也會綠
        self.assertIn('snapshot', [k for k, n in counts.items() if n > 1])
        self.assertIn('launching', [k for k, n in counts.items() if n > 1])
        self.assertEqual(mismatched_defaults(files), {})

    def test_arrow_exports_taking_dollar_finds_only_dollar_params(self):
        text = (
            "export const readSent = ($: any) => $.store.get('x')\n"
            "export const later = async ($, options) => {}\n"
            "export const bare = $ => $\n"
            "export const register: Register = (on, options) => {}\n"
            "export const price = (amount: number) => `$${amount}`\n"
            "export async function noteRuns($: any) {}\n"
        )
        self.assertEqual(arrow_exports_taking_dollar(text), ['readSent', 'later', 'bare'])

    def test_exports_taking_dollar_are_function_declarations(self):
        for name in DOLLAR_MODULES:
            text = read(os.path.join(HOOKS, name))
            self.assertEqual(arrow_exports_taking_dollar(text), [], name)
            self.assertTrue(FUNCTION_EXPORT_RE.search(text), f'{name} 沒有收 $ 的匯出 function 宣告')


if __name__ == '__main__':
    unittest.main()
