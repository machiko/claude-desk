"""hooks/dispatch.ts 的提示詞拆到 hooks/prompts/ 之後的檔案結構檢查（plugin test 的環境不能讀檔，所以寫在這裡）。「沒改既有測試檔」是這次重構的一次性事實，由審查用 git diff 核對、記在卡片 History，不寫成永久測試（合併後會讓之後改到 tests/ 的分支變紅）；「≤ 300 行」同理，只在審查時核對一次。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DISPATCH = os.path.join(ROOT, 'hooks', 'dispatch.ts')
PROMPTS = os.path.join(ROOT, 'hooks', 'prompts')
# 照實作計畫的分配：每個提示詞名稱定義在哪一個檔
PROMPT_HOME = {
    'rules.ts': ['SPEC_RULE', 'DONE_RULE', 'PUSH_RULE', 'NO_PUSH_RULE', 'changelogRule', 'testRule', 'cardRules'],
    'catchup.ts': ['CATCHUP_CARD_RULE', 'catchupHead'],
    'publish.ts': ['PUBLISH_CARD_RULE', 'publishHead'],
    'review.ts': ['REVIEW_FILE', 'SECURITY_FILE', 'MEDIUM_RECORD', 'MEDIUM_ASK', 'MEDIUM_COUNT', 'mediumRule', 'mergedBase', 'reviewPrompt'],
    'fix.ts': ['MEDIUM_DECIDE', 'reviewFixStep', 'manualFixHead'],
}
# 搬到 hooks/next-words.ts、hooks/worktree-mark.ts 的判斷，dispatch.ts 只 re-export
MOVED_LOGIC = ['idleNext', 'reviewNext', 'markOf', 'markRefusal']
# 比對跨檔重複時只看夠長的字串常值，短的（空字串、分隔符）本來就會重複
MIN_LITERAL = 20


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def defines(text, name):
    return re.search(rf'^(?:export\s+)?(?:const|let|function|type)\s+{re.escape(name)}\b', text, re.M) is not None


def literals(text):
    found = re.findall(r"'((?:\\.|[^'\\\n])*)'|`((?:\\.|[^`\\])*)`", text)
    return {s for pair in found for s in pair if len(s) >= MIN_LITERAL}


class PromptFilesTest(unittest.TestCase):
    def test_dispatch_keeps_only_settings_launch_and_refusals(self):
        text = read(DISPATCH)
        moved = [n for names in PROMPT_HOME.values() for n in names] + MOVED_LOGIC
        self.assertEqual([n for n in moved if defines(text, n)], [])

    def test_each_prompt_is_defined_in_exactly_one_file(self):
        files = {name: read(os.path.join(PROMPTS, name)) for name in PROMPT_HOME}
        for home, names in PROMPT_HOME.items():
            for n in names:
                self.assertEqual([f for f, t in files.items() if defines(t, n)], [home], n)
        seen = {}
        for f, t in files.items():
            for s in literals(t):
                self.assertNotIn(s, seen, f'{f} 與 {seen.get(s)} 都有這段字串')
                seen[s] = f


if __name__ == '__main__':
    unittest.main()
