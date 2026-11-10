"""hooks/dispatch.ts 的提示詞拆到 hooks/prompts/ 之後的檔案結構檢查（plugin test 的環境不能讀檔，所以寫在這裡）。「沒改既有測試檔」是這次重構的一次性事實，由審查用 git diff 核對、記在卡片 History，不寫成永久測試（合併後會讓之後改到 tests/ 的分支變紅）；「≤ 300 行」同理，只在審查時核對一次。

執行：python3 -m unittest discover -s scripts/tests
"""
import json
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
    'publish.ts': ['PUBLISH_CARD_RULE', 'MEDIUM_IN_PR', 'publishHead'],
    'review.ts': ['REVIEW_FILE', 'SECURITY_FILE', 'MEDIUM_RULE', 'OLD_ASKED_KEEP', 'MEDIUM_ASK_FORM', 'mergedBase', 'reviewPrompt'],
    'fix.ts': ['MEDIUM_SPEC_RECORD', 'reviewFixStep', 'autoReviewFixStep', 'manualFixHead'],
}
# 搬到 hooks/next-words.ts、hooks/worktree-mark.ts 的判斷，dispatch.ts 只 re-export
MOVED_LOGIC = ['idleNext', 'reviewNext', 'markOf', 'markRefusal']
# 比對跨檔重複時只看夠長的字串常值，短的（空字串、分隔符）本來就會重複
MIN_LITERAL = 20
# MEDIUM 一律記錄之後，自動流程、卡片答題、審查檔計數、審查提示這幾處的說明不能再講審查會在「等你」問 MEDIUM
MEDIUM_NOTE_FILES = [os.path.join(ROOT, 'hooks', f) for f in ('auto-chain.ts', 'card.ts', 'extras.ts', os.path.join('prompts', 'review.ts'))]
OLD_MEDIUM_NOTES = [
    r'MEDIUM 由審查寫進「等你」',
    r'審查寫進「等你」的 MEDIUM 題',
    r'既不修也不問',
    r'審查過關時(?:才)?(?:在「等你」)?問',
    r'照舊複審一次',
]
PLUGIN_JSON = os.path.join(ROOT, '.claude-plugin', 'plugin.json')
WORKFLOW = os.path.join(ROOT, 'docs', 'WORKFLOW.md')


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

    def test_comments_do_not_describe_review_asking_medium(self):
        for path in MEDIUM_NOTE_FILES:
            text = read(path)
            for pattern in OLD_MEDIUM_NOTES:
                self.assertIsNone(re.search(pattern, text), f'{os.path.relpath(path, ROOT)} 還有舊說法：{pattern}')
        # 新說法：自動流程寫 MEDIUM 只記錄、不寫進「等你」；卡片答題的 MEDIUM 題標明只在舊卡
        self.assertIn('MEDIUM 只記錄、不寫進「等你」', read(MEDIUM_NOTE_FILES[0]))
        self.assertRegex(read(MEDIUM_NOTE_FILES[1]), r'舊卡「等你」裡的 MEDIUM 題（新審查不再出題）.*\nconst REVIEW_MEDIUM_ASK')

    def test_plugin_pitfalls_description_matches_workflow(self):
        desc = json.loads(read(PLUGIN_JSON))['userConfig']['pitfallsPath']['description']
        self.assertTrue(desc.startswith('第一次審查才讀；新條目由歸檔回顧提出、你確認後追加到檔尾。'), desc)
        self.assertNotIn('每次', desc)
        # WORKFLOW 也是這兩件事：第一次審查才讀、新條目由歸檔回顧提出並經你確認
        workflow = read(WORKFLOW)
        self.assertIn('第一次審查先讀（複審、重新審查、資安審查不讀）', workflow)
        self.assertIn('新條目由歸檔回顧提出、你確認後追加', workflow)


if __name__ == '__main__':
    unittest.main()
