#!/usr/bin/env python3
"""/desk:card 的卡片操作：開卡、找卡、補空白規格段、改關卡、確認規格、寫回進度、歸檔、發版合併 CHANGELOG 片段。

兩種卡片都支援：
- 新卡 `.desk/CARD.md`：`<!-- DESK -->` 區塊，欄位「檢查」「等你」。
- 舊卡 `.console/STATUS.md`：`<!-- CARD -->` 區塊，欄位「驗證」「等使用者」，`- 更新：… · rev N · …` 每次寫入要加 1。

用法：
  card.py new <分支> <卡名> [base]             從主 repo 建 worktree（資料夾名取分支最後一段）、DESK 卡、登錄表列
  card.py card <slug|任務名|main>                印出卡片資訊（path、root、format、branch、spec、gate、check、專案規則）
  card.py spec-init <slug|任務名|main>           沒有「## 規格」就插入模板的空白規格段
  card.py gate <slug|任務名|main> <關卡內容>       改 CARD／DESK 區塊的「關卡」
  card.py spec-ok <slug|任務名|main>             關卡是 spec：…、AC 與實作計畫都填了才清成「無」、狀態改「規格已確認…，可派實作」，並在 Decisions／History 記一筆
  card.py done <slug|任務名|main> <狀態一句>      主對話告一段落時寫回：狀態改成那句；下一步依關卡三選一：審查已過關、審查檔之後有新 commit 寫
                                               「等自動重新檢查與審查；沒動靜就到面板按 v」，審查已過關但之後沒有新 commit（或沒有審查檔）寫
                                               「到面板照「輪到你」開 PR 或合併」，其他寫「到面板按 v 執行完成檢查」；
                                               History 記分支與 HEAD（有未提交的檔就註明幾個）；規格還沒確認就拒絕
  card.py archive <slug>… [--cleanup]          卡、審查檔與 .task 的計畫／報告複製到歸檔資料夾、登錄表列移到「已歸檔」段（不刪 worktree）；
                                               可一次給多張，有一張找不到就報錯、哪張都不動。--cleanup（發版確認裡同意過才帶）：複製完再
                                               移除已併入主 repo 目前分支、沒有未提交改動的 worktree（git worktree remove）與分支（git branch -d），
                                               不用 --force／-D、不碰遠端；主 worktree 不移除。沒併入、有改動或 git 拒絕的保留，每張印一行
                                               「清理 <slug>：…」，原因與自己刪的指令寫進登錄表「## 提醒」；有保留不算失敗
  card.py changelog <版本>                      發版：把所在 repo 的 changelog.d/*.md 合併成 CHANGELOG.md 的「## <版本>」段
                                               （插在「## 未發布」之後、上一版之前；條目依 新增→調整→修復→移除、同類依檔名），刪掉片段檔。
                                               沒有片段、版本段已存在、片段有一行不是「- 」開頭都報錯、不改檔。
                                               card.changelog.format 設 keepachangelog 時改依 Keep a Changelog：
                                               「## [Unreleased]」的手寫內容與片段一起移進「## [<版本>] - <今天>」段，
                                               條目依動詞分進 ### Added／Changed／Removed／Fixed／Security，其他手寫小節原樣排最後；
                                               片段動詞不在對照表、版本段已存在、沒有片段且 [Unreleased] 是空的都報錯、不改檔。

CHANGELOG 片段檔：每張卡只寫 changelog.d/<slug>.md（slug＝worktree 資料夾名），內容是一行或多行「- 」開頭、
動詞開頭的條目，沒有標題；不改 CHANGELOG.md，發版時才用 changelog 合併，各分支就不會再搶「## 未發布」。

設定讀 desk 的全域 dispatch.json（環境變數 DESK_SETTINGS 可指定別的路徑），再疊上目前專案的
~/.claude/handoffs/<repo 資料夾名>/dispatch.json（頂層同名鍵以專案的為準）。目前專案＝執行時所在
資料夾的 git repo，worktree 算主 repo；環境變數 DESK_PROJECT_DIR 可指定專案資料夾（測試用）：
  user            寫進卡片的人名（預設「使用者」）
  card.main       主 repo（new 從這裡建 worktree；目標寫 main 時指它的卡片）
  card.worktrees  worktree 放哪（預設主 repo 旁邊的 <名稱>-worktrees）
  card.base       new 沒給 base 時從哪裡切（預設 origin/main）
  card.check      new 之後建議的完成檢查，{slug} 會換成資料夾名
  card.registry   任務登錄表（預設專案資料夾裡的 projects-scope.md；new 時不存在就建一份）
  card.template   DESK 卡模板（預設 plugin 內附的 templates/DESK-template.md）
  card.archive    歸檔資料夾（預設登錄表旁邊的 archive/）
  card.specRules  寫規格時要額外遵守的專案規則（字串陣列）
  card.changelog.format  changelog 的格式：不設是「## 未發布」＋扁平條目；"keepachangelog" 依 Keep a Changelog
                  （動詞對照：新增→Added、調整→Changed、移除→Removed、修復→Fixed、修補→Security）
"""
import datetime
import json
import os
import re
import subprocess
import sys

HOME = os.path.expanduser('~')
HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
CARD_FILES = ('.desk/CARD.md', '.console/STATUS.md')
CMD = '/desk:card'


def fail(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def expand(path):
    return os.path.expanduser(path) if path else path


def project_key(common_dir):
    """git common dir → 專案鍵（與 desk 的 hooks/project.ts 同一套規則）：一般 repo 取 .git 上一層的資料夾名；
    bare repo 去掉 .git 字尾；點開頭的（.bare 這類）也取上一層。中文與空白都可以，只擋路徑分隔與控制字元。"""
    parts = [p for p in common_dir.replace('\\', '/').rstrip('/').split('/') if p]
    last = parts.pop() if parts else ''
    name = (parts.pop() if parts else '') if last.startswith('.') else re.sub(r'\.git$', '', last)
    return name if name and not name.startswith('.') and not re.search(r'[\x00-\x1f]', name) else ''


def project_dir():
    """目前專案在 ~/.claude/handoffs 底下的資料夾；不在 git repo 裡就空字串。"""
    if 'DESK_PROJECT_DIR' in os.environ:
        return expand(os.environ['DESK_PROJECT_DIR'])
    try:
        r = subprocess.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ''
    key = project_key(r.stdout.strip().split('\n')[0]) if r.returncode == 0 else ''
    return os.path.join(HOME, '.claude', 'handoffs', key) if key else ''


def load_json(path):
    try:
        with open(path, encoding='utf-8-sig') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def load_settings():
    own = load_json(expand(os.environ.get('DESK_SETTINGS') or '~/.claude/handoffs/dispatch.json'))
    return {**own, **load_json(os.path.join(PROJECT_DIR, 'dispatch.json'))} if PROJECT_DIR else own


PROJECT_DIR = project_dir()
SETTINGS = load_settings()
CFG = SETTINGS.get('card') if isinstance(SETTINGS.get('card'), dict) else {}
USER = (SETTINGS.get('user') or '使用者').strip() if isinstance(SETTINGS.get('user'), str) else '使用者'


def cfg(key, default=''):
    v = CFG.get(key)
    return v.strip() if isinstance(v, str) and v.strip() else default


# 環境變數優先（測試用），再來是設定檔，最後是預設值。
MAIN = expand(os.environ.get('DESK_CARD_MAIN') or cfg('main'))
REG = expand(os.environ.get('DESK_CARD_REGISTRY') or cfg('registry', os.path.join(PROJECT_DIR, 'projects-scope.md') if PROJECT_DIR else ''))
TPL = expand(os.environ.get('DESK_CARD_TEMPLATE') or cfg('template', os.path.join(PLUGIN_ROOT, 'templates', 'DESK-template.md')))
WT_ROOT = expand(cfg('worktrees', (MAIN.rstrip('/') + '-worktrees') if MAIN else ''))
BASE = cfg('base', 'origin/main')
ARCHIVE = expand(os.environ.get('DESK_CARD_ARCHIVE') or cfg('archive', os.path.join(os.path.dirname(REG), 'archive') if REG else ''))
SPEC_RULES = [r.strip() for r in CFG.get('specRules', []) if isinstance(r, str) and r.strip()] if isinstance(CFG.get('specRules'), list) else []


def named(user):
    """人名放進中文句子：英文名後加空格（「Alex 確認」），中文不加（「使用者確認」）。"""
    return f'{user} ' if re.fullmatch(r'[\x00-\x7F]+', user) else user


def need_registry():
    if not REG:
        fail('目前資料夾不在 git repo 裡，找不到這個專案的登錄表；請在專案的 repo 或 worktree 裡執行')


def registry_rows():
    need_registry()
    if not os.path.isfile(REG):
        fail(f'找不到任務登錄表：{REG}（用 {CMD} new 開第一張卡會自動建立，或在 dispatch.json 的 card.registry 指定）')
    rows = []
    for line in read(REG).split('\n'):
        m = re.match(r'^\|\s*([^|]+?)\s*\|\s*`([^`]+)`', line)
        if m:
            rows.append((m.group(1), expand(m.group(2))))
    return rows


def resolve(arg):
    """slug（worktree 資料夾名）、任務名（完整或唯一部分）或 main。"""
    rows = registry_rows()
    if arg == 'main':
        if not MAIN:
            fail('沒有設定主 repo（dispatch.json 的 card.main），不能用 main 指定卡片')
        hits = [r for r in rows if os.path.dirname(os.path.dirname(r[1])) == MAIN.rstrip('/')]
    else:
        hits = [r for r in rows if f'/{arg}/' in r[1]] or [r for r in rows if r[0] == arg] or [r for r in rows if arg in r[0]]
    if len(hits) != 1:
        names = '\n'.join(f'  {n}  ({p})' for n, p in rows)
        fail(f'找不到唯一的任務「{arg}」（符合 {len(hits)} 件）。登錄表裡有：\n{names}')
    name, path = hits[0]
    if not os.path.isfile(path):
        fail(f'卡片不存在：{path}')
    root = path
    for f in CARD_FILES:
        if path.endswith('/' + f):
            root = path[: -len(f) - 1]
    return name, path, root


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def write(path, text):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def block(text):
    """回傳 (format, start, end)：CARD／DESK 區塊在全文中的範圍（不含結尾標記）。"""
    for fmt in ('DESK', 'CARD'):
        m = re.search(rf'<!-- {fmt}\b[^>]*-->\n(.*?)<!-- /{fmt} -->', text, re.S)
        if m:
            return fmt, m.start(1), m.end(1)
    fail('卡片裡找不到 <!-- DESK --> 或 <!-- CARD --> 區塊')


def field(text, name):
    m = re.search(rf'^- {name}：(.*)$', text, re.M)
    return m.group(1).strip() if m else ''


def is_placeholder(value):
    """整段被 `<` `>` 包住的是範本佔位；規則與 hooks/card.ts 的 isPlaceholder 相同。"""
    v = value.strip()
    return v.startswith('<') and v.endswith('>')


# spec-ok 時取代範本佔位的下一步。
SPEC_NEXT = '依規格與實作計畫實作'


def has_spec(text):
    return re.search(r'^## 規格\s*$', text, re.M) is not None


def spec_section(text):
    m = re.search(r'^## 規格\s*\n(.*?)(?=^## (?!#)|\Z)', text, re.M | re.S)
    return m.group(1) if m else ''


def filled_ac(text):
    """有內容（「則」欄不是空白也不是 <…> 佔位）的驗收情境。"""
    out = []
    for line in spec_section(text).split('\n'):
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) >= 4 and re.match(r'AC-\d+$', cells[0]) and cells[3] and not cells[3].startswith('<'):
            out.append(cells[0])
    return out


def filled_plan(text):
    """「### 實作計畫」表裡有內容的列（檔案、改什麼都不是空白或 <…> 佔位），回傳檔案欄。表格第一列一律是表頭，不看它寫什麼。"""
    m = re.search(r'^### 實作計畫\s*\n(.*?)(?=^##|\Z)', spec_section(text), re.M | re.S)
    rows = [line for line in (m.group(1) if m else '').split('\n') if line.strip().startswith('|')]
    out = []
    for line in rows[1:]:
        cells = [c.strip().strip('`').strip() for c in line.strip().strip('|').split('|')]
        if len(cells) < 2 or not cells[0] or re.fullmatch(r':?-+:?', cells[0]):
            continue
        if not cells[0].startswith('<') and cells[1] and not cells[1].startswith('<'):
            out.append(cells[0])
    return out


def git(*args, check=False):
    r = subprocess.run(['git', *args], capture_output=True, text=True, timeout=120)
    if check and r.returncode != 0:
        fail(r.stderr.strip() or f'git {" ".join(args)} 失敗')
    return r


def git_branch(root):
    try:
        return git('-C', root, 'branch', '--show-current').stdout.strip()
    except Exception:
        return ''


def set_gate(path, value, fields=None):
    """改區塊的「關卡」；fields 可順便改其他欄（例如 {'狀態': …}），舊卡 rev 只加一次。"""
    return set_fields(path, {'關卡': value, **(fields or {})}, required=('關卡',))


def set_fields(path, fields, required=()):
    """改區塊裡的欄位（每欄一行）；required 的欄不存在就報錯不寫，其他欄不存在就略過。舊卡 rev 只加一次。"""
    text = read(path)
    fmt, start, end = block(text)
    body = text[start:end]
    for name in required:
        if not re.search(rf'^- {name}：', body, re.M):
            fail(f'卡片區塊沒有「{name}」欄')
    for name, new in fields.items():
        body = re.sub(rf'^- {name}：.*$', lambda _, n=name, v=new: f'- {n}：{v}', body, count=1, flags=re.M)
    if fmt == 'CARD':
        # 舊卡：rev + 1，更新時間與來源一起改。
        now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')

        def bump(m):
            rev = int(m.group(1)) + 1
            return f'- 更新：{now} · rev {rev} · desk-card'
        body, n = re.subn(r'^- 更新：.*?rev (\d+).*$', bump, body, count=1, flags=re.M)
        if n == 0:
            fail('舊卡「更新」欄找不到 rev，未寫入')
    write(path, text[:start] + body + text[end:])
    return fmt


def append_line(text, heading_prefix, line):
    """在某個 ## 段落的最後一個非空行之後加一行；沒有該段就加在檔尾。"""
    lines = text.split('\n')
    i = next((k for k, l in enumerate(lines) if l.startswith(heading_prefix)), None)
    if i is None:
        return text.rstrip('\n') + f'\n\n{heading_prefix}\n\n{line}\n'
    j = i + 1
    while j < len(lines) and not (lines[j].startswith('## ') and not lines[j].startswith('###')):
        j += 1
    k = j
    while k > i + 1 and lines[k - 1].strip() == '':
        k -= 1
    lines.insert(k, line)
    return '\n'.join(lines)


def insert_registry_row(row):
    """插在登錄表第一個表格的最後一列之後；這個專案還沒有登錄表就先建一份。"""
    if not os.path.isfile(REG):
        os.makedirs(os.path.dirname(REG), exist_ok=True)
        write(REG, REGISTRY_TEMPLATE)
    lines = read(REG).split('\n')
    last, in_table = -1, False
    for i, l in enumerate(lines):
        if l.startswith('|'):
            in_table, last = True, i
        elif in_table:
            break
    if last < 0:
        fail('登錄表裡找不到表格')
    lines.insert(last + 1, row)
    write(REG, '\n'.join(lines))


# 與 hooks/card.ts 的 REGISTRY_TEMPLATE 同一份（面板的「建立空的登錄表」寫那份）。
REGISTRY_TEMPLATE = '# 任務登錄表\n\n| Project | 卡片路徑 | Scope | Out of scope | Executor |\n| --- | --- | --- | --- | --- |\n'
NAME_SLOT = '<任務名>'
LEGACY_NAME_SLOT = '<案名>'  # 0.24.0 以前模板的卡名佔位：自訂模板（card.template）可能還寫著它


def cmd_new(branch, name, base=None):
    need_registry()
    if not MAIN:
        fail('沒有設定主 repo：在 dispatch.json 加上 "card": { "main": "~/path/to/repo" }')
    if not os.path.isfile(TPL):
        fail(f'找不到卡片模板：{TPL}')
    slug = branch.rsplit('/', 1)[-1]
    wt = os.path.join(WT_ROOT, slug)
    if os.path.exists(wt):
        fail(f'已存在：{wt}')
    os.makedirs(WT_ROOT, exist_ok=True)
    git('-C', MAIN, 'fetch', '-q', 'origin')
    if git('-C', MAIN, 'show-ref', '--verify', '--quiet', f'refs/heads/{branch}').returncode == 0:
        git('-C', MAIN, 'worktree', 'add', wt, branch, check=True)
    else:
        git('-C', MAIN, 'worktree', 'add', '-b', branch, wt, base or BASE, check=True)
        # 從遠端分支切出來時不要追蹤它，免得 push 到錯的地方。
        git('-C', wt, 'branch', '--unset-upstream')
    os.makedirs(os.path.join(wt, '.desk'), exist_ok=True)
    os.makedirs(os.path.join(wt, '.task'), exist_ok=True)
    card = os.path.join(wt, '.desk', 'CARD.md')
    write(card, read(TPL).replace(NAME_SLOT, name).replace(LEGACY_NAME_SLOT, name))
    exclude = git('-C', MAIN, 'rev-parse', '--git-path', 'info/exclude').stdout.strip()
    exclude = exclude if os.path.isabs(exclude) else os.path.join(MAIN, exclude)
    current = read(exclude) if os.path.isfile(exclude) else ''
    missing = [p for p in ('.desk/', '.task/') if not re.search(rf'^{re.escape(p)}$', current, re.M)]
    if missing:
        os.makedirs(os.path.dirname(exclude), exist_ok=True)
        write(exclude, current + ('' if current.endswith('\n') or not current else '\n') + ''.join(f'{p}\n' for p in missing))
    insert_registry_row(f'| {name} | `{card}` | | | |')
    print(f'開卡完成：{wt}')
    print(f'  卡片：{card}')
    check = cfg('check').replace('{slug}', slug)
    print(f'  建議完成檢查：{check}' if check else f'  完成檢查：{CMD} spec 會一起補上')
    print(f'  下一步：{CMD} spec {slug} 產生規格，確認後 /desk refresh')


def cmd_card(arg):
    name, path, root = resolve(arg)
    text = read(path)
    fmt, s, e = block(text)
    body = text[s:e]
    check = field(body, '檢查') or field(body, '驗證')
    print(f'name: {name}')
    print(f'path: {path}')
    print(f'root: {root}')
    print(f'format: {fmt}')
    print(f'branch: {git_branch(root)}')
    print(f'gate: {field(body, "關卡")}')
    print(f'check: {check}')
    print(f'spec: {"yes" if has_spec(text) else "no"}; filled AC: {", ".join(filled_ac(text)) or "none"}')
    print(f'user: {USER}')
    # 建議的完成檢查只對 worktree 有意義（{slug} 是 worktree 資料夾名）。
    if cfg('check') and WT_ROOT and os.path.dirname(root.rstrip('/')) == WT_ROOT.rstrip('/'):
        print(f'suggested check: {cfg("check").replace("{slug}", os.path.basename(root))}')
    for rule in SPEC_RULES:
        print(f'rule: {rule}')


def cmd_spec_init(arg):
    _, path, _ = resolve(arg)
    text = read(path)
    if has_spec(text):
        print(f'已有「## 規格」：{path}')
        return
    tpl = read(TPL)
    m = re.search(r'^## 規格\s*\n.*?(?=^## Scope)', tpl, re.M | re.S)
    if not m:
        fail('模板裡找不到「## 規格」段')
    section = m.group(0).rstrip('\n') + '\n\n'
    at = re.search(r'^## Scope', text, re.M)
    if at:
        text = text[: at.start()] + section + text[at.start():]
    else:
        _, _, end = block(text)
        close = text.index('-->', end) + 3
        text = text[:close] + '\n\n' + section.rstrip('\n') + '\n' + text[close:]
    write(path, text)
    print(f'已插入空白規格段：{path}')


def cmd_gate(arg, value):
    _, path, _ = resolve(arg)
    fmt = set_gate(path, value)
    print(f'關卡已改為「{value}」（{fmt}）：{path}')


def cmd_spec_ok(arg):
    _, path, _ = resolve(arg)
    text = read(path)
    fmt, s, e = block(text)
    gate = field(text[s:e], '關卡')
    if not gate.startswith('spec'):
        fail(f'關卡不是 spec：…（目前是「{gate or "空白"}」），不動卡片')
    ids = filled_ac(text)
    if not ids:
        fail('「## 規格」沒有填好的驗收情境，不能確認')
    plan = filled_plan(text)
    if not plan:
        fail(f'「### 實作計畫」還沒填（改哪些檔、各改什麼），沒有實作計畫，不能確認；用 {CMD} spec 補上')
    span = f'{ids[0]}～{ids[-1]}' if len(ids) > 1 else ids[0]
    fields = {'狀態': f'規格已確認（{span}），可派實作'}
    # 下一步還是範本佔位：派工時才不會把 `<…>` 原樣交給 Agent。已經是具體的一句就不動。
    if is_placeholder(field(text[s:e], '下一步')):
        fields['下一步'] = SPEC_NEXT
    set_gate(path, '無', fields)
    text = read(path)
    today = datetime.date.today().isoformat()
    n = len(re.findall(r'^- D-\d+', text, re.M)) + 1
    text = append_line(text, '## Decisions', f'- D-{n:02d} {today} {USER}：確認規格（{span}，共 {len(ids)} 條）與實作計畫（{len(plan)} 項）')
    text = append_line(text, '## History', f'- {today}：規格確認，關卡清為無，可派實作')
    write(path, text)
    print(f'規格已確認（{span}），關卡清為「無」：{path}')


DONE_NEXT = '到面板按 v 執行完成檢查'
# 審查已過關後又有新 commit：開流程的對話開著面板時會自動重新檢查與審查；card.py 看不到是哪個對話開著面板，所以帶「沒動靜就按 v」。
DONE_NEXT_RECHECK = '等自動重新檢查與審查；沒動靜就到面板按 v'
# 審查已過關、之後沒有新 commit（或沒有審查檔）：結論仍算數，面板停在合併段，不會重新檢查、也沒有 v。
DONE_NEXT_MERGE = '到面板照「輪到你」開 PR 或合併'
REVIEW_FILE = os.path.join('.task', 'REVIEW.md')


def review_passed(gate):
    """關卡是 review：…、四個分級都讀得到數字、CRITICAL 與 HIGH 都是 0（與 hooks/pipeline.ts 的 parseVerdict、blocking 同規則）。"""
    m = re.match(r'\s*review\s*[:：]\s*(.*)$', gate or '', re.I | re.S)
    if not m:
        return False
    def n(name):
        hit = re.search(rf'{name}\s*[:：=]?\s*(\d+)', m.group(1), re.I)
        return int(hit.group(1)) if hit else None
    counts = [n(name) for name in ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')]
    return None not in counts and counts[0] + counts[1] == 0


def committed_after_review(root):
    """審查檔 .task/REVIEW.md 寫好之後分支有新 commit：HEAD 的 commit 時間晚於審查檔的修改時間。
    工作桌派的審查一定寫審查檔、記下審查的 HEAD，HEAD 動了面板才重新檢查；沒有審查檔（關卡是對話自己寫的）面板不會重新檢查，不算。"""
    try:
        reviewed_at = os.path.getmtime(os.path.join(root, REVIEW_FILE))
    except OSError:
        return False
    head_at = git('-C', root, 'log', '-1', '--format=%ct').stdout.strip()
    return head_at.isdigit() and int(head_at) > reviewed_at


# 狀態只寫發生了什麼：commit（7～40 碼、英數混合的 hex）、AC-n、D-n 這類代號寫在 History。
STATUS_CODES = re.compile(r'(?<![0-9A-Za-z])(?:(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}|(?:AC|D)[-－]\d+)(?![0-9A-Za-z])', re.I)


def cmd_done(arg, status):
    """主對話告一段落時寫回卡片：狀態改成那句；下一步審查已過關時，審查後有新 commit 寫等自動重新檢查與審查（沒動靜就按 v），
    沒有新 commit 寫照面板開 PR 或合併，其他寫去面板按 v；
    History 記分支與 HEAD；等你、關卡、檢查不動。"""
    status = ' '.join(status.split())
    if not status:
        fail(f'用法：{CMD} done <slug> <狀態一句>')
    _, path, root = resolve(arg)
    text = read(path)
    _, s, e = block(text)
    gate = field(text[s:e], '關卡')
    if gate.startswith('spec') or not filled_ac(text):
        fail(f'先確認規格（按 t 或 {CMD} spec {arg} ok），卡片未動')
    if STATUS_CODES.search(status):
        fail(f'狀態不放 commit／AC／D 編號（寫在 History），卡片未動：{status}')
    branch = git_branch(root) or '（分離 HEAD）'
    sha = git('-C', root, 'rev-parse', '--short', 'HEAD').stdout.strip() or '（沒有 commit）'
    dirty = [l for l in git('-C', root, 'status', '--porcelain').stdout.split('\n') if l.strip()]
    next_step = (DONE_NEXT_RECHECK if committed_after_review(root) else DONE_NEXT_MERGE) if review_passed(gate) else DONE_NEXT
    set_fields(path, {'狀態': status, '下一步': next_step}, required=('狀態', '下一步'))
    note = f'；有 {len(dirty)} 個檔未提交' if dirty else ''
    line = f'- {datetime.date.today().isoformat()}：{CMD} done（{branch} {sha}）：{status}{note}'
    write(path, append_line(read(path), '## History', line))
    print(f'已寫回卡片：{path}')
    print(f'  狀態：{status}')
    print(f'  下一步：{next_step}')
    if dirty:
        print(f'  注意：有 {len(dirty)} 個檔未提交，完成檢查與審查只看 commit 過的內容')


DEPLOY_STEP = re.compile(r'^\s*(?:\d+[.)、]|[-*])\s+(.*\S)\s*$')


def deploy_steps(text):
    """卡片「## 部署…」段已填的步驟；略過空白編號與 `<…>` 佔位（與 hooks/extras.ts 的 deploySteps 同規則）。"""
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    start = next((i for i, l in enumerate(lines) if re.match(r'##\s*部署', l)), None)
    if start is None:
        return []
    steps = []
    for l in lines[start + 1:]:
        if re.match(r'##\s', l):
            break
        m = DEPLOY_STEP.match(l)
        if m and not re.fullmatch(r'<.*>', m.group(1)):
            steps.append(m.group(1))
    return steps


def main_worktree(root):
    """root 所屬 repo 的主 worktree（worktree list 第一筆）；跟設定的主 repo 是同一個資料夾時用設定的寫法，指令才跟 new 印的一致。"""
    r = git('-C', root, 'worktree', 'list', '--porcelain')
    first = next((l[len('worktree '):] for l in r.stdout.splitlines() if l.startswith('worktree ')), '') if r.returncode == 0 else ''
    return MAIN if first and MAIN and os.path.realpath(MAIN) == os.path.realpath(first) else first


def git_reason(r):
    """git 拒絕時的原因：照抄它的第一行。"""
    return next((l.strip() for l in (r.stderr + '\n' + r.stdout).splitlines() if l.strip()), 'git 失敗')


SQUASHED = 'squash／rebase 合併，git branch -d 認不出已併入'


def merged_by_content(main, branch):
    """squash／rebase 合併：分支不是 HEAD 的祖先，但把它合進 HEAD 結果跟 HEAD 一樣（內容已經在裡面）。
    有衝突、合出不同的內容，或 git 太舊沒有 merge-tree --write-tree（2.38 以前），都當沒併入。"""
    merged = git('-C', main, 'merge-tree', '--write-tree', 'HEAD', branch)
    head = git('-C', main, 'rev-parse', 'HEAD^{tree}')
    return merged.returncode == 0 and head.returncode == 0 and merged.stdout.split('\n', 1)[0].strip() == head.stdout.strip()


def cleanup(root):
    """--cleanup：移除已併入主 repo 目前分支、沒有未提交改動的 worktree 與分支（不加 --force／-D）。
    squash／rebase 合併的（內容已在主 repo，但分支不是祖先）只移除 worktree：branch -d 會拒絕，分支留著寫進提醒。
    回傳 (輸出說明, 已歸檔那行的後綴, 保留原因, 要自己刪的指令)；保留原因是空字串代表沒有要提醒的。"""
    main = main_worktree(root)
    if not main:
        why = '找不到這個 worktree 所屬的 git repo'
        return f'worktree 與分支保留：{why}', f'；worktree 保留：{why}', why, []
    if os.path.realpath(main) == os.path.realpath(root):
        return '主 worktree 不移除', '；主 worktree 不移除', '', []
    branch = git_branch(root)
    remove_wt = f'git -C {main} worktree remove {root}'
    if not branch:
        why = '不在分支上（detached HEAD）'
        return f'worktree 保留：{why}', f'；worktree 保留：{why}', why, [remove_wt]
    ancestor = git('-C', main, 'merge-base', '--is-ancestor', branch, 'HEAD').returncode == 0
    squashed = not ancestor and merged_by_content(main, branch)
    remove_branch = f'git -C {main} branch {"-D" if squashed else "-d"} {branch}'
    why = ''
    if not ancestor and not squashed:
        why = f'分支還沒併入 {git_branch(main) or "主 repo 的 HEAD"}'
    else:
        dirty = [l for l in git('-C', root, 'status', '--porcelain').stdout.splitlines() if l.strip()]
        if dirty:
            why = f'有未提交的改動（{len(dirty)} 個檔）'
        else:
            r = git('-C', main, 'worktree', 'remove', root)
            if r.returncode != 0:
                why = git_reason(r)
    if why:
        return f'worktree 與分支保留：{why}', f'；worktree 保留：{why}', why, [remove_wt, remove_branch]
    if squashed:
        why = f'worktree 已移除，分支 {branch} 保留：{SQUASHED}'
        return f'worktree 已移除；分支 {branch} 保留：{SQUASHED}', f'；{why}', why, [remove_branch]
    r = git('-C', main, 'branch', '-d', branch)
    if r.returncode != 0:
        why = f'worktree 已移除，分支 {branch} 保留：{git_reason(r)}'
        return f'worktree 已移除；分支 {branch} 保留：{git_reason(r)}', f'；{why}', why, [remove_branch]
    return f'worktree 已移除；分支 {branch} 已刪除', '；worktree 與分支已移除', '', []


def cmd_archive(slugs, cleanup_after=False):
    # 先把每張都找到：有一張找不到就報錯，哪張都不動。同一張卡（slug 與任務名各寫一次）只做第一次。
    found = [(slug, *resolve(slug)) for slug in slugs]
    targets = [t for i, t in enumerate(found) if all(os.path.realpath(t[2]) != os.path.realpath(u[2]) for u in found[:i])]
    for slug, _, path, root in targets:
        archive_one(slug, path, root, cleanup_after)


def archive_one(slug, path, root, cleanup_after):
    os.makedirs(ARCHIVE, exist_ok=True)
    dest = os.path.join(ARCHIVE, f'{slug}-CARD.md')
    card = read(path)
    write(dest, card)
    task = os.path.join(root, '.task')
    for f in sorted(os.listdir(task)) if os.path.isdir(task) else []:
        if re.match(r'(REVIEW|SECURITY|PLAN|REPORT|review-.*)\.md$', f):
            write(os.path.join(ARCHIVE, f'{slug}-{f}'), read(os.path.join(task, f)))
    # 移除 worktree 會連 .desk、.task 一起刪，所以清理排在複製之後。
    said, suffix, kept, commands = cleanup(root) if cleanup_after else ('', '', '', [])
    lines = read(REG).split('\n')
    removed = [l for l in lines if l.startswith('|') and f'`{path}`' in l]
    lines = [l for l in lines if not (l.startswith('|') and f'`{path}`' in l)]
    note = f'- {slug}：{datetime.date.today().isoformat()} 歸檔；卡片在 `{dest}`{suffix}'
    head = next((i for i, l in enumerate(lines) if l.startswith('## 已歸檔的卡')), None)
    if head is None:
        lines += ['', '## 已歸檔的卡（worktree 刪除後，卡片留存供查閱）', '', note]
    else:
        j = head + 1
        while j < len(lines) and not lines[j].startswith('## '):
            j += 1
        while j > head + 1 and lines[j - 1].strip() == '':
            j -= 1
        lines.insert(j, note)
    text = '\n'.join(lines)
    if kept:
        todo = '、'.join(f'`{c}`' for c in commands)
        text = append_line(text, '## 提醒', f'- 清理 {slug}：{kept}' + (f'；看過後自己刪：{todo}' if todo else ''))
    write(REG, text)
    print(f'歸檔完成：{dest}（登錄表移除 {len(removed)} 列）')
    # 部署步驟跟著卡片歸檔：只提醒，不自動搬（隨發版線發版的卡，步驟要在發版線部署時做）。
    steps = deploy_steps(card)
    if steps:
        print(f'部署步驟 {len(steps)} 項：')
        for i, step in enumerate(steps, 1):
            print(f'  {i}. {step}')
        print('請確認已搬到發版線卡片或登錄表「## 提醒」，歸檔後這張卡不會再提醒')
    if cleanup_after:
        print(f'清理 {slug}：{said}')
        return
    print('worktree 與分支請自己確認後再刪：')
    print(f'  git -C {MAIN or "<主 repo>"} worktree remove {root}')


FRAGMENT_DIR = 'changelog.d'
CHANGELOG = 'CHANGELOG.md'
UNRELEASED = '## 未發布'
# 版本段裡條目的順序：動詞開頭決定分類，不在表裡的排最後；同類依檔名、再依檔內順序。
VERB_ORDER = ('新增', '調整', '修復', '移除')


def repo_root():
    """執行時所在的 repo 根目錄；不在 git repo 裡就用目前資料夾。"""
    r = git('rev-parse', '--show-toplevel')
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else os.getcwd()


def read_fragments(frag_dir, allow_empty=False):
    """changelog.d 裡的 (檔名, [條目]) 依檔名排序；空檔或有一行不是「- 」開頭就報錯。allow_empty：沒有片段檔回傳空串列。"""
    if not os.path.isdir(frag_dir):
        fail(f'沒有片段檔資料夾 {frag_dir}：每張卡的條目寫在 {FRAGMENT_DIR}/<slug>.md，發版時才合併')
    names = sorted(f for f in os.listdir(frag_dir) if f.endswith('.md') and not f.startswith('.'))
    if not names and not allow_empty:
        fail(f'{frag_dir} 裡沒有片段檔（*.md），沒有東西可以發版，不改檔')
    out = []
    for name in names:
        lines = [l.rstrip() for l in read(os.path.join(frag_dir, name)).split('\n')]
        bad = next(((i, l) for i, l in enumerate(lines, 1) if l.strip() and not l.startswith('- ')), None)
        if bad:
            fail(f'{FRAGMENT_DIR}/{name} 第 {bad[0]} 行不是「- 」開頭的條目：{bad[1]}\n片段檔只放條目（例如「- 新增 …」），沒有標題與版本；未改任何檔')
        entries = [l for l in lines if l.strip()]
        if not entries:
            fail(f'{FRAGMENT_DIR}/{name} 是空的：寫一條以上的條目，或刪掉這個檔；未改任何檔')
        out.append((name, entries))
    return out


def order_entries(fragments):
    """依 VERB_ORDER 分類（「- 」後面的動詞），同類依檔名、檔內順序；穩定排序。"""
    def rank(entry):
        verb = entry[2:].lstrip()
        return next((i for i, v in enumerate(VERB_ORDER) if verb.startswith(v)), len(VERB_ORDER))
    flat = [(rank(e), e) for _, entries in fragments for e in entries]
    return [e for _, e in sorted(flat, key=lambda x: x[0])]


def insert_version(text, version, entries):
    """「## <版本>」段插在「## 未發布」之後、下一個 ## 段之前；沒有「## 未發布」就一起補在第一個 ## 段之前（或檔尾）。"""
    section = f'## {version}\n\n' + '\n'.join(entries) + '\n'
    lines = text.split('\n')
    heads = [i for i, l in enumerate(lines) if l.startswith('## ') and not l.startswith('###')]
    unreleased = next((i for i in heads if lines[i].strip() == UNRELEASED), None)
    if unreleased is None:
        at = heads[0] if heads else len(lines)
        block = [UNRELEASED, '', *section.rstrip('\n').split('\n'), '']
    else:
        at = next((i for i in heads if i > unreleased), len(lines))
        block = [*section.rstrip('\n').split('\n'), '']
    # 插入點之前多餘的空行收成一行，插入點是檔尾時補一個空行隔開。
    before = lines[:at]
    while len(before) > 1 and before[-1].strip() == '' and before[-2].strip() == '':
        before.pop()
    if before and before[-1].strip() != '':
        before.append('')
    after = lines[at:]
    merged = before + block + after
    return '\n'.join(merged).rstrip('\n') + '\n'


KAC = 'keepachangelog'
KAC_UNRELEASED = '## [Unreleased]'
# Keep a Changelog 模式：條目開頭的動詞決定放進哪個小節；小節依這個順序，其他手寫小節排最後。
KAC_TYPES = (('新增', 'Added'), ('調整', 'Changed'), ('移除', 'Removed'), ('修復', 'Fixed'), ('修補', 'Security'))
KAC_SECTIONS = tuple(t for _, t in KAC_TYPES)


def changelog_format():
    """card.changelog.format：沒設就是原本的格式（空字串），keepachangelog 走 Keep a Changelog；其他值報錯。"""
    conf = CFG.get('changelog')
    fmt = conf.get('format') if isinstance(conf, dict) else None
    fmt = fmt.strip() if isinstance(fmt, str) else ''
    if fmt not in ('', KAC):
        fail(f'dispatch.json 的 card.changelog.format 只能是 "{KAC}" 或不設：{fmt}')
    return fmt


def kac_type(entry):
    verb = entry[2:].lstrip()
    return next((t for v, t in KAC_TYPES if verb.startswith(v)), None)


def trim_blank(lines):
    """去掉頭尾的空行。"""
    lines = list(lines)
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def split_unreleased(lines):
    """[Unreleased] 段的內容 → (小節前的散落內容, [(小節名, [內容行])])；同名小節合併，保留第一次出現的順序。"""
    loose, sections, current = [], {}, None
    for line in lines:
        if line.startswith('### '):
            current = line[4:].strip()
            sections.setdefault(current, [])
        elif current is None:
            loose.append(line)
        else:
            sections[current].append(line)
    return trim_blank(loose), [(name, trim_blank(body)) for name, body in sections.items()]


def kac_section(version, loose, sections, fragments):
    """組「## [版本] - 日期」段：散落內容在最前，Added…Security（手寫在前、片段在後），其他小節原樣排最後。"""
    hand = dict(sections)
    from_frags = {t: [e for _, entries in fragments for e in entries if kac_type(e) == t] for t in KAC_SECTIONS}
    parts = [loose] if loose else []
    for t in KAC_SECTIONS:
        body = hand.get(t, []) + from_frags[t]
        if body:
            parts.append([f'### {t}', '', *body])
    parts += [[f'### {name}', '', *body] if body else [f'### {name}'] for name, body in sections if name not in KAC_SECTIONS]
    out = [f'## [{version}] - {datetime.date.today().isoformat()}', '']
    for p in parts:
        out += [*p, '']
    return out


def cmd_changelog_kac(version):
    """Keep a Changelog：[Unreleased] 的手寫內容與片段一起移進新版本段，[Unreleased] 留空標題。"""
    if not re.fullmatch(r'v?\d+(\.\d+)+(-[0-9A-Za-z.]+)?', version):
        fail(f'版本要像 v26.2.7 或 0.27.0：{version or "空白"}')
    root = repo_root()
    changelog = os.path.join(root, CHANGELOG)
    if not os.path.isfile(changelog):
        fail(f'找不到 {changelog}')
    text = read(changelog)
    bare = version.lstrip('v')
    if re.search(rf'^## \[v?{re.escape(bare)}\]', text, re.M):
        fail(f'{CHANGELOG} 已存在「## [{version}]」段，不重複合併；要補條目請直接改那一段，片段檔未動')
    fragments = read_fragments(os.path.join(root, FRAGMENT_DIR), allow_empty=True)
    unknown = [(name, e) for name, entries in fragments for e in entries if not kac_type(e)]
    if unknown:
        verbs = '、'.join(v for v, _ in KAC_TYPES)
        listed = '\n'.join(f'  {FRAGMENT_DIR}/{name}：{e}' for name, e in unknown)
        fail(f'這些條目的動詞不在對照表（{verbs}），不知道放哪個小節；未改任何檔：\n{listed}')
    lines = text.rstrip('\n').split('\n')
    at = next((i for i, l in enumerate(lines) if l.strip() == KAC_UNRELEASED), None)
    if at is None:
        # 沒有 [Unreleased] 就補在第一個 ## 段之前（或檔尾）。
        at = next((i for i, l in enumerate(lines) if l.startswith('## ')), len(lines))
        lines = lines[:at] + [KAC_UNRELEASED] + lines[at:]
    end = next((i for i in range(at + 1, len(lines)) if lines[i].startswith('## ')), len(lines))
    loose, sections = split_unreleased(lines[at + 1:end])
    # 只有空的 ### 小節標題也算空，不然會發出沒有內容的版本段
    if not fragments and not loose and not any(body for _, body in sections):
        fail(f'沒有片段檔，{KAC_UNRELEASED} 也是空的，沒有東西可以發版，不改檔')
    section = kac_section(version, loose, sections, fragments)
    merged = trim_blank(lines[:at]) + ['', KAC_UNRELEASED, '', *section, *trim_blank(lines[end:])]
    write(changelog, '\n'.join(trim_blank(merged)) + '\n')
    for name, _ in fragments:
        os.remove(os.path.join(root, FRAGMENT_DIR, name))
    count = sum(len(entries) for _, entries in fragments)
    print(f'已把 {KAC_UNRELEASED} 與 {len(fragments)} 個片段檔（{count} 條）合併進 {CHANGELOG} 的「## [{version}]」段，片段檔已刪：')
    for name, items in fragments:
        print(f'  {FRAGMENT_DIR}/{name}（{len(items)} 條）')
    print(f'接著：改版號 → git add {CHANGELOG} {FRAGMENT_DIR} → commit → tag {version}')


def cmd_changelog(version):
    if changelog_format() == KAC:
        return cmd_changelog_kac(version.strip())
    version = version.strip().lstrip('v')
    if not re.fullmatch(r'\d+(\.\d+)+(-[0-9A-Za-z.]+)?', version):
        fail(f'版本要像 0.27.0（可以帶 v 開頭）：{version or "空白"}')
    root = repo_root()
    changelog = os.path.join(root, CHANGELOG)
    if not os.path.isfile(changelog):
        fail(f'找不到 {changelog}')
    fragments = read_fragments(os.path.join(root, FRAGMENT_DIR))
    text = read(changelog)
    if re.search(rf'^## v?{re.escape(version)}\s*$', text, re.M):
        fail(f'{CHANGELOG} 已存在「## {version}」段，不重複合併；要補條目請直接改那一段，片段檔未動')
    entries = order_entries(fragments)
    write(changelog, insert_version(text, version, entries))
    for name, _ in fragments:
        os.remove(os.path.join(root, FRAGMENT_DIR, name))
    print(f'已合併 {len(fragments)} 個片段檔、{len(entries)} 條進 {CHANGELOG} 的「## {version}」段，片段檔已刪：')
    for name, items in fragments:
        print(f'  {FRAGMENT_DIR}/{name}（{len(items)} 條）')
    print(f'接著：改版號 → git add {CHANGELOG} {FRAGMENT_DIR} → commit → tag v{version}')


def main(argv):
    if not argv:
        fail(__doc__, 2)
    cmd, args = argv[0], argv[1:]
    if cmd == 'new' and len(args) >= 2:
        cmd_new(args[0], args[1], args[2] if len(args) > 2 else None)
    elif cmd == 'card' and args:
        cmd_card(args[0])
    elif cmd == 'spec-init' and args:
        cmd_spec_init(args[0])
    elif cmd == 'gate' and len(args) >= 2:
        cmd_gate(args[0], ' '.join(args[1:]))
    elif cmd == 'spec-ok' and args:
        cmd_spec_ok(args[0])
    elif cmd == 'done' and len(args) >= 2:
        cmd_done(args[0], ' '.join(args[1:]))
    elif cmd == 'archive' and [a for a in args if a != '--cleanup']:
        cmd_archive([a for a in args if a != '--cleanup'], '--cleanup' in args)
    elif cmd == 'changelog' and args:
        cmd_changelog(args[0])
    else:
        fail(__doc__, 2)


if __name__ == '__main__':
    main(sys.argv[1:])
