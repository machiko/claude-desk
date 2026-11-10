"""Claude Code 最低版本三處一致（min-cc-version 卡的 AC-5）：README「需要什麼」、CI 安裝的版本、hooks/engine-version.ts 的常數。

升 Claude Code 版本時三處要一起改；任一處改了另兩處沒改，這支就失敗。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VERSION = r'(\d+\.\d+\.\d+)'


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def readme_version(text):
    """README「需要什麼」那段裡 Claude Code 那一行寫的版號。"""
    section = re.search(r'^## 需要什麼$(.*?)(?=^## )', text, re.M | re.S)
    if not section:
        return None
    line = re.search(r'^- Claude Code：.*?' + VERSION, section.group(1), re.M)
    return line.group(1) if line else None


def ci_version(text):
    """CI 安裝 Claude Code 的版號（npm install -g @anthropic-ai/claude-code@x.y.z）。"""
    found = re.findall(r'@anthropic-ai/claude-code@' + VERSION, text)
    return found[0] if len(found) == 1 else None


def hooks_version(text):
    """hooks/engine-version.ts 的 MIN_CLAUDE_CODE。"""
    found = re.search(r"^export const MIN_CLAUDE_CODE = '" + VERSION + "'$", text, re.M)
    return found.group(1) if found else None


class MinClaudeCodeVersionTest(unittest.TestCase):
    def test_readme_ci_and_hooks_name_the_same_minimum_version(self):
        versions = {
            'README.md': readme_version(read('README.md')),
            '.github/workflows/ci.yml': ci_version(read('.github/workflows/ci.yml')),
            'hooks/engine-version.ts': hooks_version(read('hooks/engine-version.ts')),
        }
        for where, version in versions.items():
            self.assertIsNotNone(version, f'{where} 找不到 Claude Code 的版號')
        self.assertEqual(len(set(versions.values())), 1, f'Claude Code 最低版本三處不一致：{versions}')

    def test_each_reader_sees_a_changed_version(self):
        """三個讀法都讀得到改過的版號：任一處改了就會跟另兩處不同（讀不到時上面那支會報找不到）。"""
        self.assertEqual(readme_version('## 需要什麼\n\n- Claude Code：以 2.1.400 開發與測試。\n- macOS\n\n## 下一段\n'), '2.1.400')
        self.assertEqual(ci_version('        run: npm install -g @anthropic-ai/claude-code@2.1.400\n'), '2.1.400')
        self.assertEqual(hooks_version("export const MIN_CLAUDE_CODE = '2.1.400'\n"), '2.1.400')


if __name__ == '__main__':
    unittest.main()
