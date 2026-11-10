"""hooks 的執行期 import 結構檢查（拆分 model 與 dispatch 那張卡的 AC-2～AC-4；plugin test 的環境不能讀檔，所以寫在這裡）。

只看執行期的 import：`import type`、`export type … from` 不算，型別在執行時不存在，不會造成載入循環。
「既有測試檔沒改」是這次重構的一次性事實，由完成檢查的 git diff 核對，不寫成永久測試。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOKS = os.path.join(ROOT, 'hooks')
# 拆分 model 與 dispatch 的 AC-2：這幾條執行期的邊不能出現（從哪個模組 → 不能 import 哪個模組）
FORBIDDEN = [
    ('model', 'dispatch'),
    ('dispatch', 'model'),
    ('probes', 'dispatch'),
    ('dispatch-runner', 'card-actions'),
    ('verify-runner', 'card-actions'),
    ('pane', 'band'),
    ('pane-card', 'band'),
]
# 拆分 model 與 dispatch 的 AC-4：搬走的名稱 → 新家、原本在哪個檔（原檔只 re-export）
MOVED = {
    'text': ('model', ['plain', 'isNoise', 'isStatusLine', 'screenLines', 'lastMeaningful', 'displayWidth', 'fit', 'pad', 'ago', 'hhmm', 'elapsedText', 'runMinutesText', 'resetText', 'errorText', 'reasonLine', 'errorLine', 'slugOf', 'STALE_MS']),
    'agents': ('model', ['rawAgents', 'parseAgents', 'agentsByRoot', 'LastLaunch', 'Superseded', 'supersede', 'EndedAlive', 'endedAlive', 'agentInfo', 'approvalWait', 'approveText', 'asksFor', 'asksQuestion', 'askClearedOnCard', 'codeJobEnded', 'askedOnCardAtEnd', 'endedHow', 'runSeen', 'agentWaits']),
    'run-time': ('dispatch', ['RUN_WARN_MS', 'addRunTime', 'RUN_SEEN_STEP_MS', 'spanMs', 'dispatchRunMs', 'observeRun', 'RunShown', 'runOf', 'runMsOn']),
    'settings': ('dispatch', ['MODEL_KINDS', 'ModelKind', 'ReviewWords', 'DispatchSettings', 'DEFAULT_MAX_AGENTS', 'DEFAULT_CHAIN_QUOTA_STOP', 'DEFAULT_USER', 'DEFAULT_REVIEW', 'parseSettings', 'normalizeRoot', 'pitfallsFor', 'modelFor']),
}
# dispatch.ts 搬到 agents.ts 的那幾個（agents.ts 同時收 model.ts 與 dispatch.ts 的）；DEMO_ONLY、STAGE_COLOR 搬到 theme.ts
MOVED_ELSEWHERE = [
    ('agents', 'dispatch', ['launchName', 'isDeskLaunch', 'runningDeskAgents', 'confirmLaunch', 'RawAgent', 'UUID']),
    ('theme', 'card-actions', ['DEMO_ONLY']),
    ('theme', 'band', ['STAGE_COLOR']),
]
# text 這類葉節點執行期可以 import 的模組：字串目錄（'./i18n' 解析成 i18n）與它的語言檔；它們自己也只 import 彼此（見 test_text_module_is_a_leaf）
LEAF_DEPS = {'i18n', 'i18n/index', 'i18n/zh-TW'}
IMPORT_RE = re.compile(r"^\s*(import|export)\s+(type\s+)?([^'\"]*?)\s*from\s*['\"](\.[^'\"]*)['\"]", re.M)
REEXPORT_RE = re.compile(r"^\s*export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['\"]\./([^'\"]+)['\"]", re.M)


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def modules():
    """hooks 底下每個 .ts／.tsx 的模組名（相對 hooks、去掉副檔名，例如 prompts/rules） → 內容。"""
    out = {}
    for base, _dirs, files in os.walk(HOOKS):
        for name in files:
            if name.endswith(('.ts', '.tsx')) and not name.endswith('.d.ts'):
                path = os.path.join(base, name)
                out[os.path.splitext(os.path.relpath(path, HOOKS))[0].replace(os.sep, '/')] = read(path)
    return out


def runtime_imports(module, text):
    """這個模組在執行期 import（含 export … from）的 hooks 模組名；import type、export type 不算。"""
    found = set()
    for m in IMPORT_RE.finditer(text):
        if m.group(2):
            continue
        target = os.path.normpath(os.path.join(os.path.dirname(module), m.group(4))).replace(os.sep, '/')
        if not target.startswith('..'):
            found.add(re.sub(r'\.tsx?$', '', target))
    return found


def definers(mods, name):
    """定義這個名稱的模組（const／let／function／class／type／interface，含 export 與 async）。"""
    pat = re.compile(rf'^(?:export\s+)?(?:async\s+)?(?:const|let|function|class|type|interface)\s+{re.escape(name)}\b', re.M)
    return sorted(m for m, t in mods.items() if pat.search(t))


def reexports(text, source):
    """原檔從 ./<source> re-export 的名稱。"""
    return {n.strip().split(' as ')[-1].strip() for m in REEXPORT_RE.finditer(text) if m.group(2) == source for n in m.group(1).split(',') if n.strip()}


class HookImportsTest(unittest.TestCase):
    def test_runtime_imports_skip_import_type(self):
        text = "import type { A } from './dispatch'\nimport { b } from './model'\nexport type { C } from './band'\nexport { d } from './prompts/rules'\n"
        self.assertEqual(runtime_imports('probes', text), {'model', 'prompts/rules'})
        self.assertEqual(runtime_imports('prompts/fix', "import { x } from '../card'\n"), {'card'})

    def test_forbidden_runtime_imports_are_absent(self):
        mods = modules()
        found = [(a, b) for a, b in FORBIDDEN if b in runtime_imports(a, mods[a])]
        self.assertEqual(found, [])

    def test_text_module_is_a_leaf(self):
        """text 執行期只 import 字串目錄（i18n 外框那張卡：時間與單位改用 t()），而字串目錄只 import 自己的語言檔，不會繞回別的 hooks 模組。"""
        mods = modules()
        self.assertIn('text', set(mods))
        self.assertEqual(runtime_imports('text', mods['text']) - LEAF_DEPS, set())
        for dep in ('i18n/index', 'i18n/zh-TW'):
            self.assertEqual(runtime_imports(dep, mods[dep]) - LEAF_DEPS, set(), dep)

    def test_moved_names_are_defined_once(self):
        mods = modules()
        moves = [(home, origin, names) for home, (origin, names) in MOVED.items()] + MOVED_ELSEWHERE
        for home, origin, names in moves:
            kept = reexports(mods[origin], home)
            for n in names:
                self.assertEqual(definers(mods, n), [home], n)
                self.assertIn(n, kept, f'{origin} 沒有 re-export {n}')


if __name__ == '__main__':
    unittest.main()
