"""README 與 docs/ 底下的 Markdown 相對連結都要指到存在的檔（readme-beginner 卡的 AC-3）。

README 的細節搬到 docs/REFERENCE.md 與 docs/DEVELOPMENT.md 後，連結的出發點從根目錄變成 docs/，
少改一個 `../` 就會斷；這支把斷掉的連結列成「檔:連結」。

執行：python3 -m unittest discover -s scripts/tests
"""
import os
import re
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LINK = re.compile(r'\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
FENCE = re.compile(r'(?ms)^```.*?^```')
INLINE_CODE = re.compile(r'`[^`\n]*`')
EXTERNAL = re.compile(r'^(?:[a-z][a-z0-9+.-]*:|#)', re.I)


def doc_files(root: str) -> list:
    """根目錄的 README.md 加上 docs/ 底下（含子資料夾）的 .md，路徑相對 root。"""
    files = ['README.md'] if os.path.isfile(os.path.join(root, 'README.md')) else []
    for base, _, names in os.walk(os.path.join(root, 'docs')):
        files += [os.path.relpath(os.path.join(base, n), root).replace(os.sep, '/') for n in sorted(names) if n.endswith('.md')]
    return files


def relative_links(text: str) -> list:
    """Markdown 連結的目標，扣掉程式碼區塊與行內程式碼裡的、網址與只有錨點的。"""
    text = INLINE_CODE.sub('', FENCE.sub('', text))
    return [t for t in LINK.findall(text) if not EXTERNAL.match(t)]


def broken_links(root: str) -> list:
    """回傳 ['檔:連結']：去掉 #錨點後，從那個檔所在資料夾算出的路徑不存在。"""
    out = []
    for rel in doc_files(root):
        with open(os.path.join(root, rel), encoding='utf-8') as f:
            text = f.read()
        for target in relative_links(text):
            path = os.path.normpath(os.path.join(root, os.path.dirname(rel), target.split('#', 1)[0]))
            if not os.path.exists(path):
                out.append(f'{rel}:{target}')
    return out


def write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


class DocLinksTest(unittest.TestCase):
    def test_relative_links_in_docs_point_to_existing_files(self):
        """AC-3：README 與 docs/ 的相對連結都找得到檔；斷掉的列成「檔:連結」。"""
        self.assertEqual(broken_links(ROOT), [], '相對連結指到不存在的檔：\n' + '\n'.join(broken_links(ROOT)))

    def test_broken_links_lists_file_and_link_from_each_file_folder(self):
        """AC-3：從 docs/ 出發的連結少一個 ../ 就列出「檔:連結」；網址、錨點、程式碼裡的、帶錨點但檔在的不列。"""
        with tempfile.TemporaryDirectory() as root:
            write(os.path.join(root, 'skills', 'card', 'SKILL.md'), 'x\n')
            write(os.path.join(root, 'README.md'), '\n'.join([
                '[卡](skills/card/SKILL.md) [參考](docs/REFERENCE.md#指令) [壞](docs/NOPE.md)',
                '[網](https://example.com) [錨](#安裝) `[碼](nope.md)`',
                '```', '[區塊](nope.md)', '```',
            ]))
            write(os.path.join(root, 'docs', 'REFERENCE.md'), '\n'.join([
                '[對](../skills/card/SKILL.md) [錯](skills/card/SKILL.md) [回](../README.md#安全須知)',
            ]))

            self.assertEqual(broken_links(root), ['README.md:docs/NOPE.md', 'docs/REFERENCE.md:skills/card/SKILL.md'])


if __name__ == '__main__':
    unittest.main()
