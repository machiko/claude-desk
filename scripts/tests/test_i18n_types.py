"""守門：字串目錄的鍵與參數真的有檢查守著（i18n 目錄與示範 AC-2 的型別那半）。

`claude plugin test` 不做型別檢查，專案的 tsc 又要讀不進版控的 `.claude-plugin/types/`（README「型別檢查」），所以分兩層：
1. 用 tsc 編 t() 的型別探針（scripts/tests/i18n_types_probe.ts）與不需要 claude-code 型別、能單獨編的已搬檔（TYPECHECKED）：
   簽名被改鬆（未知鍵、少給參數、參數名打錯、多給參數照樣過）或這些檔的呼叫處寫錯，都會有型別錯誤。
2. 其餘要 claude-code 型別才編得動的檔（update-run、release-update、register、kind-label 等），逐一比對 hooks 裡每個 t() 呼叫：
   鍵要在目錄裡、參數要寫成物件字面值並給齊句中每個 {name}、沒有參數的句子不帶參數。

執行：python3 -m unittest discover -s scripts/tests（要有 Node 的 npx；CI 有裝）
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_wording import ROOT, hook_files, strip_code  # noqa: E402

PROBE = os.path.join(ROOT, 'scripts', 'tests', 'i18n_types_probe.ts')
CATALOG = 'hooks/i18n/zh-TW.ts'
# 已搬、而且只靠 hooks 自己的型別就編得動的檔（不 import claude-code）
TYPECHECKED = ('hooks/update.ts', 'hooks/engine-version.ts', 'hooks/formats.ts', 'hooks/stack.ts')
# 跟專案 tsconfig 同樣嚴格；types 清空，不讀 .claude-plugin/types/
COMPILER_OPTIONS = {
    'target': 'es2023', 'lib': ['es2023'], 'module': 'esnext', 'moduleResolution': 'bundler',
    'strict': True, 'noUncheckedIndexedAccess': True, 'noEmit': True, 'skipLibCheck': True, 'types': [],
}
TSC_TIMEOUT_S = 180

CATALOG_ENTRY = re.compile(r"^\s*'([\w.]+)':\s*'((?:[^'\\]|\\.)*)'", re.M)
PARAM = re.compile(r'\{(\w+)\}')
T_CALL = re.compile(r"(?<![\w.$])t\(\s*")
OBJECT_KEY = re.compile(r'^\s*(\w+)\s*(?::|$)')
IMPORTS_T = re.compile(r"^import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'\.\.?/i18n'", re.M)
# 用 tsc 編不動、只靠第 2 層比對的已搬檔：這些檔一定要被比對到
CALL_CHECKED = ('hooks/update-run.ts', 'hooks/release-update.ts', 'hooks/register.tsx', 'hooks/kind-label.ts')


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def catalog_params():
    """目錄的每個鍵 → 句中 {name} 參數名的集合。"""
    return {key: set(PARAM.findall(text)) for key, text in CATALOG_ENTRY.findall(read(CATALOG))}


def matching(text, i, open_ch, close_ch):
    """text[i] 是 open_ch：回傳對應 close_ch 的位置（略過字串字面值裡的括號）；找不到回 -1。"""
    depth = 0
    j = i
    while j < len(text):
        ch = text[j]
        if ch in '\'"`':
            k = j + 1
            while k < len(text) and text[k] != ch:
                k += 2 if text[k] == '\\' else 1
            j = k + 1
            continue
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return -1


def top_level_items(body):
    """物件字面值大括號裡、以最外層逗號分開的每一項。"""
    items, depth, start, j = [], 0, 0, 0
    while j < len(body):
        ch = body[j]
        if ch in '\'"`':
            k = j + 1
            while k < len(body) and body[k] != ch:
                k += 2 if body[k] == '\\' else 1
            j = k + 1
            continue
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
        elif ch == ',' and depth == 0:
            items.append(body[start:j])
            start = j + 1
        j += 1
    items.append(body[start:])
    return [x for x in items if x.strip()]


def call_problems(rel, text, params):
    """回傳 [(行號, 問題)]：t() 呼叫的鍵不是目錄裡的字面值、參數不是物件字面值、少給或多給參數。"""
    code = strip_code(text)
    found = []
    for m in T_CALL.finditer(code):
        no = code.count('\n', 0, m.start()) + 1
        at = m.end()
        key_m = re.match(r"'([\w.]+)'\s*", code[at:])
        if not key_m:
            found.append((no, '鍵不是字面值'))
            continue
        key = key_m.group(1)
        if key not in params:
            found.append((no, f'目錄沒有 {key}'))
            continue
        rest = code[at + key_m.end():]
        if rest.startswith(')'):
            given = set()
        elif rest.startswith(','):
            arg_at = at + key_m.end() + 1 + (len(rest[1:]) - len(rest[1:].lstrip()))
            if code[arg_at:arg_at + 1] != '{':
                found.append((no, f'{key} 的參數不是物件字面值'))
                continue
            close = matching(code, arg_at, '{', '}')
            items = top_level_items(code[arg_at + 1:close])
            names = [OBJECT_KEY.match(x) for x in items]
            if not all(names):
                found.append((no, f'{key} 的參數有展開或計算出來的名字'))
                continue
            given = {n.group(1) for n in names}
        else:
            found.append((no, f'{key} 後面接的不是參數'))
            continue
        need = params[key]
        if need - given:
            found.append((no, f'{key} 少給 {", ".join(sorted(need - given))}'))
        if given - need:
            found.append((no, f'{key} 多給 {", ".join(sorted(given - need))}'))
    return found


def run_tsc(files):
    """用 tsc 編這幾個檔（絕對路徑），回傳 (結束碼, 輸出)。"""
    npx = shutil.which('npx')
    if not npx:
        raise AssertionError('找不到 npx：這支測試要 Node 的 npx 跑 tsc（CI 有裝 Node 22）')
    with tempfile.TemporaryDirectory() as tmp:
        config = os.path.join(tmp, 'tsconfig.json')
        with open(config, 'w', encoding='utf-8') as f:
            json.dump({'compilerOptions': COMPILER_OPTIONS, 'files': files}, f)
        r = subprocess.run([npx, '-y', '-p', 'typescript@5', 'tsc', '-p', config, '--pretty', 'false'],
                           capture_output=True, text=True, timeout=TSC_TIMEOUT_S, cwd=ROOT)
    return r.returncode, (r.stdout + r.stderr).strip()


class CatalogTypesTest(unittest.TestCase):
    def test_t_rejects_unknown_keys_and_missing_params_at_type_check(self):
        """AC-2：探針裡的正確寫法過、錯誤寫法每一行都是型別錯誤；能單獨編的已搬檔沒有型別錯誤（含它們的 t() 呼叫）。"""
        code, out = run_tsc([PROBE] + [os.path.join(ROOT, rel) for rel in TYPECHECKED])
        self.assertEqual(code, 0, 'tsc 有錯（t() 的簽名被改鬆時是 Unused \'@ts-expect-error\'）：\n' + out)

    def test_every_t_call_uses_catalog_keys_with_all_params(self):
        """AC-2：hooks 裡每個 import 了目錄 t() 的檔（含編不動的檔），呼叫的鍵都在目錄、參數給齊也沒多給，有錯列出「檔:行」。"""
        params = catalog_params()
        self.assertTrue(params)
        users = [rel for rel, _path in hook_files() if not rel.startswith('hooks/i18n/') and IMPORTS_T.search(read(rel))]
        for rel in CALL_CHECKED:
            self.assertIn(rel, users)
        hits = [f'{rel}:{no} {why}' for rel in users for no, why in call_problems(rel, read(rel), params)]
        self.assertEqual(hits, [], 't() 的呼叫跟字串目錄對不上：\n' + '\n'.join(hits))

    def test_call_check_reports_each_kind_of_mistake(self):
        """守門本身：未知鍵、少給、多給、沒給、不該給卻給、非字面值的鍵或參數都報；正確寫法、註解裡的 t( 與巢狀呼叫不誤報。"""
        params = {'a.none': set(), 'a.one': {'name'}, 'a.two': {'dir', 'why'}}
        text = '\n'.join([
            "const ok1 = t('a.none')",
            "const ok2 = t('a.one', { name })",
            "const ok3 = t('a.two', { dir: x.dir, why: t('a.one', { name: f(a, b) }) })",
            "// t('a.nope') 註解不算",
            "const e1 = t('a.nope')",
            "const e2 = t('a.two', { dir })",
            "const e3 = t('a.one', { name, extra: 1 })",
            "const e4 = t('a.one')",
            "const e5 = t('a.none', { name })",
            "const e6 = t(key)",
            "const e7 = t('a.one', params)",
            "const e8 = t('a.one', { ...rest })",
            "const notT = format('a.nope'); const alsoNot = x.t('a.nope')",
        ])
        self.assertEqual(call_problems('hooks/x.ts', text, params), [
            (5, '目錄沒有 a.nope'),
            (6, 'a.two 少給 why'),
            (7, 'a.one 多給 extra'),
            (8, 'a.one 少給 name'),
            (9, 'a.none 多給 name'),
            (10, '鍵不是字面值'),
            (11, 'a.one 的參數不是物件字面值'),
            (12, 'a.one 的參數有展開或計算出來的名字'),
        ])
        # 只比對 import 了目錄 t() 的檔：band.tsx 這類自己有區域變數 t 的檔不算
        self.assertTrue(IMPORTS_T.search("import { t } from './i18n'"))
        self.assertTrue(IMPORTS_T.search("import { other, t } from '../i18n'"))
        self.assertFalse(IMPORTS_T.search("import { tx } from './i18n'"))


if __name__ == '__main__':
    unittest.main()
