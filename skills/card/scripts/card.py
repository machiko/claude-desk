#!/usr/bin/env python3
"""/desk:card 的卡片操作：開卡、找卡、補空白規格段、改關卡、確認規格、寫回進度、歸檔、發版合併 CHANGELOG 片段。

兩種卡片都支援：
- 新卡 `.desk/CARD.md`：`<!-- DESK -->` 區塊，欄位「檢查」「等你」。
- 舊卡 `.console/STATUS.md`：`<!-- CARD -->` 區塊，欄位「驗證」「等使用者」，`- 更新：… · rev N · …` 每次寫入要加 1。

用法：
  card.py new <分支> <卡名> [base]             從主 repo 建 worktree（資料夾名取分支最後一段）、DESK 卡、登錄表列；
                                               沒給 base 時用主 repo 當下的分支（origin 有同名分支就用 origin/<分支>），
                                               主 repo 是 detached HEAD 時用 card.base；用到的基準寫進 DESK 區塊的「基準」欄。
                                               base 是登錄表上另一張卡的分支（疊放的後續卡）時，基準欄改記那張卡的基準（它沒有就不記）
                                               --trivial（任何位置）：瑣事卡，規格段標「類型：瑣事」、關卡設 spec：待確認規格（瑣事）；驗收情境維持範本，由 spec 步驟預填
  card.py card <slug|任務名|main>                印出卡片資訊（path、root、format、branch、spec、gate、check、專案規則）
  card.py spec-init <slug|任務名|main>           沒有「## 規格」就插入模板的空白規格段
  card.py gate <slug|任務名|main> <關卡內容>       改 CARD／DESK 區塊的「關卡」
  card.py spec-ok <slug|任務名|main>             關卡是 spec：…、AC 與實作計畫都填了才清成「無」、狀態改「規格已確認…，可派實作」，並在 Decisions／History 記一筆；
                                               實作計畫跟其他進行中的卡同檔時，輸出結尾印 overlap 的預警行、History 也記一筆（不擋確認）
  card.py overlap <slug|任務名|main>            實作計畫跟登錄表上其他進行中的卡（已歸檔段、卡片檔不存在、沒填計畫的不算）同檔時，
                                               每個同檔印一行「同檔預警：<檔> 也在「<卡名>」的實作計畫（<slug>）」；沒有就印「同檔預警：無」
  card.py done <slug|任務名|main> <狀態一句>      主對話告一段落時寫回：狀態改成那句；下一步依關卡四選一：驗收已過關、審查檔之後有新 commit 寫
                                               「等自動重新測試；沒動靜就到面板按 v」，驗收已過關但之後沒有新 commit（或沒有審查檔）寫
                                               「到面板照「輪到你」開 PR 或合併」，關卡是依審查修完的未複審結論寫
                                               「到面板照「輪到你」接著做」，其他寫「到面板按 v 執行測試」；
                                               History 記一筆「<人>：<狀態> → <結果>（commit <HEAD>）」（有未提交的檔就註明幾個）；規格還沒確認就拒絕
  card.py archive <slug>… [--cleanup]          卡、審查檔與 .task 的計畫／報告複製到歸檔資料夾、登錄表列移到「已歸檔」段（不刪 worktree）；
                                               worktree 有 .task/stats.json 或登錄表旁 reviews/ 有這張卡的審查留檔時，輸出與已歸檔那行帶
                                               「統計：總執行 N 分・修正 n 輪・驗收 n 輪（資安 n）」，只列有資料的部分（壞掉的欄位略過）；
                                               可一次給多張，有一張找不到就報錯、哪張都不動。--cleanup（發版確認裡同意過才帶）：複製完再
                                               移除已併入主 repo 目前分支、沒有未提交改動的 worktree（git worktree remove）與分支（git branch -d），
                                               不用 --force／-D、不碰遠端；主 worktree 不移除。只有一個例外：worktree 含 submodule 時 git 不加
                                               --force 一律拒絕，乾淨已先確認過，才改加 --force 再試一次，輸出與提醒註明。沒併入、有改動、有被 git 忽略的本機設定或資料
                                               （.env*、*.local.* 等，見 IGNORED_LOCAL）或 git 拒絕的保留，每張印一行「清理 <slug>：…」，
                                               原因與自己刪的指令寫進登錄表「## 提醒」；有保留不算失敗。其他被忽略的檔隨 worktree 刪掉，
                                               可重建的（node_modules、__pycache__ 等，見 IGNORED_DISPOSABLE）以外的列在輸出與提醒
  card.py changelog <版本>                      發版：把所在 repo 的 changelog.d/*.md 合併成 CHANGELOG.md 的「## <版本>」段
                                               （插在「## 未發布」之後、上一版之前；條目依 新增→調整→修復→移除、同類依檔名），刪掉片段檔。
                                               沒有片段、版本段已存在、片段有一行不是「- 」開頭都報錯、不改檔。
                                               card.changelog.format 設 keepachangelog 時改依 Keep a Changelog：
                                               「## [Unreleased]」的手寫內容與片段一起移進「## [<版本>] - <今天>」段，
                                               條目依動詞分進 ### Added／Changed／Removed／Fixed／Security，其他手寫小節原樣排最後；
                                               片段動詞不在對照表、版本段已存在、沒有片段且 [Unreleased] 是空的都報錯、不改檔。
  card.py emit <slug|任務名|main> <working|blocked|done|idle> [訊息] [--agent <名>] [--wait <permission|question>] [--pid <PID>]
                                               推播 Agent 狀態：向 stdout 印出 Herdr 相容的 OSC 7501 轉義序列，同時原子寫入
                                               .task/agent-state.json（面板即時感知外部 Agent 狀態），有訊息時一併寫入 .task/AGENT-OUT.md
  card.py read <slug|任務名|main> [--source <out|review|security|report|spec|card|state>] [--lines <N>] [--json]
                                               讀取目標任務的 Agent 輸出（.task/AGENT-OUT.md）或產物（REVIEW.md 等），自動剝除控制字元並解析 OSC 7501
  card.py wait <slug|任務名|main> --until <done|blocked|gate|ready|idle> [--timeout <秒>] [--interval <秒>] [--json]
                                               阻塞等待目標任務達到指定狀態；等待 done 時若目標進入 blocked 或等你決策會提前返回（exit 2）
  card.py send <slug|任務名|main> --to <claude|agy|cmd> <提示詞或指令> [--bg] [--agent-cmd <執行檔>] [--json]
                                               跨 Agent 派工：在目標 worktree 啟動指定 Agent，自動維護 .task/agent-state.json 與 .task/AGENT-OUT.md

CHANGELOG 片段檔：每張卡只寫 changelog.d/<slug>.md（slug＝worktree 資料夾名），內容是一行或多行「- 」開頭、
動詞開頭的條目，沒有標題；不改 CHANGELOG.md，發版時才用 changelog 合併，各分支就不會再搶「## 未發布」。

設定讀 desk 的全域 dispatch.json（環境變數 DESK_SETTINGS 可指定別的路徑），再疊上目前專案的
~/.claude/handoffs/<repo 資料夾名>/dispatch.json（頂層同名鍵以專案的為準）。目前專案＝執行時所在
資料夾的 git repo，worktree 算主 repo；環境變數 DESK_PROJECT_DIR 可指定專案資料夾（測試用）：
  user            寫進卡片的人名（預設「使用者」）
  card.main       主 repo（new 從這裡建 worktree；目標寫 main 時指它的卡片）
  card.worktrees  worktree 放哪（預設主 repo 旁邊的 <名稱>-worktrees）
  card.base       new 沒給 base、主 repo 又是 detached HEAD 時從哪裡切（預設 origin/main）
  card.check      new 之後建議的完成檢查，{slug} 會換成資料夾名
  card.registry   任務登錄表（預設專案資料夾裡的 projects-scope.md；new 時不存在就建一份）
  card.template   DESK 卡模板（預設 plugin 內附的 templates/DESK-template.md）
  card.archive    歸檔資料夾（預設登錄表旁邊的 archive/）
  card.specRules  寫規格時要額外遵守的專案規則（字串陣列）
  card.specPreflight  規格前審指令，{root}、{card}、{paths} 會換成對應路徑
  card.specPreflightMinFiles  相關檔少於這個數就不跑規格前審（正整數，預設 3）
  card.retro      歸檔回顧指令，{slug} 會換成卡片名稱
  card.changelog.format  changelog 的格式：不設是「## 未發布」＋扁平條目；"keepachangelog" 依 Keep a Changelog
                  （動詞對照：新增→Added、調整→Changed、移除→Removed、修復→Fixed、修補→Security）
"""
import datetime
import fnmatch
import json
import os
import re
import shlex
import subprocess
import sys
import time

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
DEFAULT_SPEC_PREFLIGHT_MIN_FILES = 3
SPEC_PREFLIGHT_MIN_FILES = CFG.get('specPreflightMinFiles') if isinstance(CFG.get('specPreflightMinFiles'), int) and not isinstance(CFG.get('specPreflightMinFiles'), bool) and CFG.get('specPreflightMinFiles') > 0 else DEFAULT_SPEC_PREFLIGHT_MIN_FILES
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
    return name, path, card_root(path)


def card_root(path):
    """卡片檔路徑去掉 .desk/CARD.md（或 .console/STATUS.md）＝任務根目錄。"""
    for f in CARD_FILES:
        if path.endswith('/' + f):
            return path[: -len(f) - 1]
    return path


def stamp():
    """History 行開頭的本機時間「YYYY-MM-DD HH:MM」（面板歷程顯示成「MM-DD HH:MM」）。"""
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M')


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def write(path, text):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


# 卡片區塊與欄位行：規則與 hooks/card.ts 的 parseCard 相同（tests/card-cases.mjs 兩邊共用）。
# 標記的 `<!--` 與 DESK／CARD 之間、結尾標記裡可以有空白；區塊從開頭標記的 `-->` 之後算起，不必緊接換行。
CARD_BLOCK = re.compile(r'<!--\s*(DESK|CARD)[^>]*-->(.*?)<!--\s*/\1\s*-->', re.S)
# 欄位行：行首可有空白，`-` 之後、冒號前後的空白都不算；全形「：」或半形「:」都認。
FIELD_LINE = re.compile(r'^\s*-\s*([^：:]+?)\s*[：:]\s*(.*)$')
# 舊欄名對照（與 hooks/card.ts 的 FIELD_ALIAS 同一張表）：讀到左邊的欄名當成右邊那欄。
FIELD_ALIAS = {'等使用者': '等你', '檢查': '驗證'}


def canonical(name):
    return FIELD_ALIAS.get(name, name)


def find_block(text):
    """(format, start, end)：CARD／DESK 區塊在全文中的範圍（不含標記）；沒有區塊回 None。"""
    m = CARD_BLOCK.search(text)
    return (m.group(1), m.start(2), m.end(2)) if m else None


def block(text):
    """回傳 (format, start, end)：CARD／DESK 區塊在全文中的範圍（不含結尾標記）。"""
    found = find_block(text)
    if found is None:
        fail('卡片裡找不到 <!-- DESK --> 或 <!-- CARD --> 區塊')
    return found


def all_field_lines(body):
    """區塊內文裡每一行欄位：[(行號, 原本的欄名, 正式欄名, 值)]。讀（field）與寫（rewrite_fields）都從這裡找行。"""
    out = []
    for i, line in enumerate(body.split('\n')):
        m = FIELD_LINE.match(line)
        if m:
            out.append((i, m.group(1), canonical(m.group(1)), m.group(2).strip()))
    return out


def field_lines(body, name):
    """區塊內文裡欄名（換成正式欄名後）是 name 那欄的行：[(行號, 原本的欄名, 值)]。"""
    want = canonical(name)
    return [(i, own, value) for i, own, key, value in all_field_lines(body) if key == want]


def field(body, name):
    """區塊內文裡某欄的值；同一欄寫了兩行時跟面板一樣取最後一行，沒有就是空字串。舊欄名照 FIELD_ALIAS 認。"""
    lines = field_lines(body, name)
    return lines[-1][2] if lines else ''


def card_body(text):
    """卡片區塊的內文（換行統一成 \\n）；沒有區塊回 None。"""
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    found = find_block(text)
    return text[found[1]:found[2]] if found else None


def parse_card(text):
    """卡片區塊的所有欄位（欄名換成正式欄名）；沒有區塊回 None。結果與 hooks/card.ts 的 parseCard 相同。
    每欄的值由指令讀欄位用的 field() 取，共用範例（tests/card-cases.mjs）驗的就是指令實際走的路。"""
    body = card_body(text)
    if body is None:
        return None
    return {key: field(body, key) for _, _, key, _ in all_field_lines(body)}


def rewrite_fields(body, fields):
    """把區塊內文裡的欄位改成新值，回傳新內文；不存在的欄略過。行的認法與 field() 相同，同一欄有兩行時改面板讀的最後一行。
    改過的行一律寫成「- <欄>：<值>」：全形冒號、去掉多餘空白，欄名沿用那一行原本的（舊卡的舊欄名不換）。"""
    for name, new in fields.items():
        found = field_lines(body, name)
        if not found:
            continue
        at, own, _ = found[-1]
        lines = body.split('\n')
        body = '\n'.join(lines[:at] + [f'- {own}：{new}'] + lines[at + 1:])
    return body


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


TRIVIAL_FLAG = '--trivial'
TRIVIAL_LINE = '- 類型：瑣事（只改註解、CHANGELOG、沒被測試引用的說明文字；規格一句、免前審、不問釐清題，測試、CI 與審查風險照舊）'
TRIVIAL_GATE = 'spec：待確認規格（瑣事）'


def is_trivial(text):
    """瑣事卡：「## 規格」段裡有「- 類型：瑣事」那行才算；卡名、History 等其他段有「瑣事」不算。"""
    return re.search(r'^- 類型：瑣事', spec_section(text), re.M) is not None


def trivial_card(text):
    """把開好的卡改成瑣事卡：「## 規格」標題下插類型行，驗收情境維持範本（預填那條由 /desk:card spec 寫）。模板沒有規格段就回 None。"""
    head = re.search(r'^## 規格[ \t]*\n', text, re.M)
    if not head:
        return None
    # 類型行自成一行：模板標題下有沒有空行都一樣，不會黏到下一行。
    return text[:head.end()] + '\n' + TRIVIAL_LINE + '\n' + text[head.end():].lstrip('\n')


def filled_ac(text):
    """有內容（「則」欄不是空白也不是 <…> 佔位）的驗收情境。"""
    out = []
    for line in spec_section(text).split('\n'):
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) >= 4 and re.match(r'AC-\d+$', cells[0]) and cells[3] and not cells[3].startswith('<'):
            out.append(cells[0])
    return out


def plan_cells(text):
    """「### 實作計畫」表裡有內容的列（檔案、改什麼都不是空白或 <…> 佔位），回傳原樣的檔案欄。表格第一列一律是表頭，不看它寫什麼。"""
    m = re.search(r'^### 實作計畫\s*\n(.*?)(?=^##|\Z)', spec_section(text), re.M | re.S)
    rows = [line for line in (m.group(1) if m else '').split('\n') if line.strip().startswith('|')]
    out = []
    for line in rows[1:]:
        raw = [c.strip() for c in line.strip().strip('|').split('|')]
        cells = [c.strip('`').strip() for c in raw]
        if len(cells) < 2 or not cells[0] or re.fullmatch(r':?-+:?', cells[0]):
            continue
        if not cells[0].startswith('<') and cells[1] and not cells[1].startswith('<'):
            out.append(raw[0])
    return out


def filled_plan(text):
    """有內容的實作計畫列，回傳檔案欄（去掉頭尾反引號）。"""
    return [c.strip('`').strip() for c in plan_cells(text)]


def plan_files(text):
    """實作計畫列到的檔案路徑：去掉反引號、前導 ./、反引號外全形或半形括號之後的說明；一格有多個反引號路徑就都算。"""
    out = []
    for cell in plan_cells(text):
        kept = []
        for part in re.split(r'(`[^`]*`)', cell):
            if part.startswith('`') or not re.search(r'[（(]', part):
                kept.append(part)
                continue
            kept.append(re.split(r'[（(]', part, 1)[0])
            break
        head = ''.join(kept)
        names = re.findall(r'`([^`]+)`', head) or [head]
        for name in names:
            name = re.sub(r'^(\./)+', '', name.strip())
            if name and name not in out:
                out.append(name)
    return out


def git(*args, check=False, c_locale=False):
    """c_locale：要比對 git 的錯誤訊息字面時設 True，用 LC_ALL=C 跑，帶翻譯的 git 也輸出英文。"""
    env = {**os.environ, 'LC_ALL': 'C'} if c_locale else None
    r = subprocess.run(['git', *args], capture_output=True, text=True, timeout=120, env=env)
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
    """改區塊裡的欄位（每欄一行，改法見 rewrite_fields）；required 的欄不存在就報錯不寫，其他欄不存在就略過。舊卡 rev 只加一次。"""
    text = read(path)
    fmt, start, end = block(text)
    body = text[start:end]
    for name in required:
        if not field_lines(body, name):
            fail(f'卡片區塊沒有「{name}」欄')
    body = rewrite_fields(body, fields)
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


BASE_FIELD = '基準'


def main_repo_base():
    """new 沒給 base 時的基準：主 repo 當下的分支，origin 有同名分支就用 origin/<分支>；detached HEAD 用 card.base。"""
    branch = git_branch(MAIN)
    if not branch:
        return BASE
    remote = git('-C', MAIN, 'show-ref', '--verify', '--quiet', f'refs/remotes/origin/{branch}').returncode == 0
    return f'origin/{branch}' if remote else branch


def stacked_on(base):
    """base（可帶 origin/）是登錄表上另一張進行中的卡的 worktree 分支時，回傳那張卡的 (卡名, 卡片路徑)；不是就 None。
    主 repo 那張卡（根目錄就是主 repo，例如發版線）不算疊放；卡片檔或 worktree 不在的列略過。"""
    if not base or not os.path.isfile(REG):
        return None
    wanted = base[len('origin/'):] if base.startswith('origin/') else base
    for name, path in active_rows():
        root = card_root(path)
        if not os.path.isfile(path) or not os.path.isdir(root) or os.path.abspath(root) == os.path.abspath(MAIN):
            continue
        if git_branch(root) == wanted:
            return name, path
    return None


def recorded_base(base):
    """卡片「基準」欄要記的分支與說明。疊在別張卡的分支上（審查 MEDIUM 另開卡修的後續卡）時，那條分支合併後就沒了，
    不能當審查範圍與開 PR 目標：改記那張卡的基準欄；那張卡沒有基準欄就不記（工作桌照舊順序找）。"""
    parent = stacked_on(base)
    if not parent:
        return base, base
    name, path = parent
    text = read(path)
    desk = find_block(text)
    inherited = field(text[desk[1]:desk[2]], BASE_FIELD) if desk else ''
    if inherited:
        return inherited, f'{inherited}（疊在「{name}」的分支上，沿用它的基準）'
    return '', f'不記（疊在「{name}」的分支上，那張卡沒有基準欄，工作桌照舊順序找）'


def insert_base_field(path, base):
    """DESK 區塊「關卡」行之後插一行「- 基準：<ref>」；沒有關卡行（自訂模板）就接在區塊最後。新行自己帶換行。"""
    text = read(path)
    _, start, end = block(text)
    body = text[start:end]
    line = f'- {BASE_FIELD}：{base}'
    gate = field_lines(body, '關卡')
    if gate:
        lines = body.split('\n')
        at = gate[-1][0] + 1
        body = '\n'.join(lines[:at] + [line] + lines[at:])
    else:
        body = (body if body.endswith('\n') or not body else body + '\n') + line + '\n'
    write(path, text[:start] + body + text[end:])


def cmd_new(branch, name, base=None, trivial=False):
    need_registry()
    if not MAIN:
        fail('沒有設定主 repo：在 dispatch.json 加上 "card": { "main": "~/path/to/repo" }')
    if not os.path.isfile(TPL):
        fail(f'找不到卡片模板：{TPL}')
    content = read(TPL).replace(NAME_SLOT, name).replace(LEGACY_NAME_SLOT, name)
    if trivial:
        # 建 worktree 之前就檢查，模板不合用時什麼都不動。
        content = trivial_card(content)
        if content is None:
            fail(f'卡片模板沒有「## 規格」段，開不了瑣事卡：{TPL}')
    slug = branch.rsplit('/', 1)[-1]
    wt = os.path.join(WT_ROOT, slug)
    if os.path.exists(wt):
        fail(f'已存在：{wt}')
    os.makedirs(WT_ROOT, exist_ok=True)
    git('-C', MAIN, 'fetch', '-q', 'origin')
    base = base or main_repo_base()
    if git('-C', MAIN, 'show-ref', '--verify', '--quiet', f'refs/heads/{branch}').returncode == 0:
        git('-C', MAIN, 'worktree', 'add', wt, branch, check=True)
    else:
        git('-C', MAIN, 'worktree', 'add', '-b', branch, wt, base, check=True)
        # 從遠端分支切出來時不要追蹤它，免得 push 到錯的地方。
        git('-C', wt, 'branch', '--unset-upstream')
    os.makedirs(os.path.join(wt, '.desk'), exist_ok=True)
    os.makedirs(os.path.join(wt, '.task'), exist_ok=True)
    card = os.path.join(wt, '.desk', 'CARD.md')
    write(card, content)
    record, shown_base = recorded_base(base)
    if record:
        insert_base_field(card, record)
    if trivial:
        # 開卡就設 spec 關卡：spec 步驟預填驗收情境後，確認前也不會派工。驗收情境不在這裡預填，面板才會像一般卡提示去寫規格。
        set_gate(card, TRIVIAL_GATE)
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
    print(f'  基準：{shown_base}')
    check = cfg('check').replace('{slug}', slug)
    print(f'  建議完成檢查：{check}' if check else f'  完成檢查：{CMD} spec 會一起補上')
    print(f'  下一步：{CMD} spec {slug} 產生規格，確認後 /desk refresh')
    if trivial:
        print('  瑣事卡：規格一句、免前審')


def cmd_card(arg):
    name, path, root = resolve(arg)
    text = read(path)
    fmt, s, e = block(text)
    body = text[s:e]
    check = field(body, '驗證')  # 新卡的「檢查」照 FIELD_ALIAS 也讀成「驗證」
    print(f'name: {name}')
    print(f'path: {path}')
    print(f'root: {root}')
    print(f'format: {fmt}')
    print(f'branch: {git_branch(root)}')
    if field(body, BASE_FIELD):
        print(f'base: {field(body, BASE_FIELD)}')
    print(f'gate: {field(body, "關卡")}')
    print(f'check: {check}')
    print(f'spec: {"yes" if has_spec(text) else "no"}; filled AC: {", ".join(filled_ac(text)) or "none"}')
    trivial = is_trivial(text)
    if trivial:
        print('trivial: yes')
    print(f'user: {USER}')
    # 建議的完成檢查只對 worktree 有意義（{slug} 是 worktree 資料夾名）。
    if cfg('check') and WT_ROOT and os.path.dirname(root.rstrip('/')) == WT_ROOT.rstrip('/'):
        print(f'suggested check: {cfg("check").replace("{slug}", os.path.basename(root))}')
    if cfg('specPreflight') and not trivial:
        print(f'spec preflight: {cfg("specPreflight")}')
        print(f'spec preflight min files: {SPEC_PREFLIGHT_MIN_FILES}')
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


# History 一筆的白話範本：「<誰>：<做了什麼> → <結果>（代號）」，代號最多一個、放句尾括號（見 hooks/prompts/rules.ts 的 HISTORY_FORMAT）。
def spec_ok_history(now):
    """spec-ok 在 History 記的那一筆；面板的 spec-ok 偵測（hooks/touch.ts 的 SPEC_OK_HISTORY）認這個寫法與舊寫法。"""
    return f'- {now}：{USER}：確認規格 → 可派實作'


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
    now = stamp()
    n = len(re.findall(r'^- D-\d+', text, re.M)) + 1
    text = append_line(text, '## Decisions', f'- D-{n:02d} {today} {USER}：確認規格（{span}，共 {len(ids)} 條）與實作計畫（{len(plan)} 項）')
    text = append_line(text, '## History', spec_ok_history(now))
    # 跟其他進行中的卡同檔：只預警，不擋確認。History 照白話範本只寫跟哪幾張同檔，檔名在輸出的預警行。
    found = overlaps(path)
    warnings = overlap_lines(found)
    if found:
        names = ''.join(f'「{name}」' for name in dict.fromkeys(name for _, name, _ in found))
        text = append_line(text, '## History', f'- {now}：工作桌：比對實作計畫 → 跟{names}改到同一個檔')
    write(path, text)
    print(f'規格已確認（{span}），關卡清為「無」：{path}')
    for line in warnings:
        print(line)


ARCHIVED_HEADING = '## 已歸檔'


def active_rows():
    """登錄表裡進行中的列：「## 已歸檔…」段裡的不算。"""
    need_registry()
    rows, archived = [], False
    for line in read(REG).split('\n'):
        if line.startswith('## '):
            archived = line.startswith(ARCHIVED_HEADING)
        m = None if archived else re.match(r'^\|\s*([^|]+?)\s*\|\s*`([^`]+)`', line)
        if m:
            rows.append((m.group(1), expand(m.group(2))))
    return rows


def overlaps(path):
    """這張卡的實作計畫跟登錄表上其他進行中的卡同檔的 (檔案, 卡名, slug)，依這張卡的計畫順序；
    卡片檔不存在、讀不到或沒填計畫的卡略過，不報錯。"""
    mine = plan_files(read(path))
    others = []
    for name, other in active_rows():
        if os.path.abspath(other) == os.path.abspath(path) or not os.path.isfile(other):
            continue
        try:
            files = set(plan_files(read(other)))
        except (OSError, UnicodeDecodeError):
            continue
        if files:
            others.append((name, os.path.basename(card_root(other)), files))
    return [(f, name, slug) for f in mine for name, slug, files in others if f in files]


def overlap_lines(found):
    return [f'同檔預警：{f} 也在「{name}」的實作計畫（{slug}）' for f, name, slug in found]


def cmd_overlap(arg):
    _, path, _ = resolve(arg)
    for line in overlap_lines(overlaps(path)) or ['同檔預警：無']:
        print(line)


DONE_NEXT = '到面板按 v 執行測試'
# 驗收已過關後又有新 commit：開流程的對話開著面板時會自動重新測試（這條分支審查過就不再驗收，高風險或舊流程紀錄才接著驗收）；
# card.py 看不到是哪個對話開著面板，所以帶「沒動靜就按 v」。
DONE_NEXT_RECHECK = '等自動重新測試；沒動靜就到面板按 v'
# 關卡是依審查修完寫的「…；已依審查修正、未複審」：不是審查結論。流程可能還在重新測試、修正輪用完停下（要按 g），
# 或已經未複審過關（停在合併段）；card.py 看不到流程紀錄，照面板「輪到你」走（hooks/next-words.ts 認得這句是等待）。
DONE_NEXT_TURN = '到面板照「輪到你」接著做'
# 認「依審查修完、還沒人審過」只看這三個字（與 hooks/card.ts 的 UNREVIEWED_MARK 同一個字）：Agent 照抄結論可能少括號、換標點。
UNREVIEWED_MARK = '未複審'
# 驗收已過關、之後沒有新 commit（或沒有審查檔）：結論仍算數，面板停在合併段，不會重新測試、也沒有 v。
DONE_NEXT_MERGE = '到面板照「輪到你」開 PR 或合併'
REVIEW_FILE = os.path.join('.task', 'REVIEW.md')


def unreviewed_gate(gate):
    """關卡是依審查修完寫的 review：…（結論含「未複審」）：不算審查結論（與 hooks/card.ts 的 parseGate、unreviewedGate 同規則）。"""
    m = re.match(r'\s*review\s*[:：]\s*(.*)$', gate or '', re.I | re.S)
    return bool(m) and UNREVIEWED_MARK in m.group(1)


def review_passed(gate):
    """關卡是 review：…、四個分級都讀得到數字、CRITICAL 與 HIGH 都是 0（與 hooks/pipeline.ts 的 parseVerdict、blocking 同規則）；
    依審查修完寫的未複審關卡不算（hooks/card.ts 的 parseGate 當成沒有關卡）。"""
    m = re.match(r'\s*review\s*[:：]\s*(.*)$', gate or '', re.I | re.S)
    if not m or unreviewed_gate(gate):
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


# done 的 History 那筆「→」後面的結果：跟寫進下一步的那句對應。
DONE_RESULT = {
    DONE_NEXT: '待測試',
    DONE_NEXT_RECHECK: '待重新測試',
    DONE_NEXT_MERGE: '待開 PR 或合併',
    DONE_NEXT_TURN: '照面板接著做',
}


def done_history(now, status, result, dirty, sha):
    """done 在 History 記的那一筆：「<人>：<狀態> → <結果>（commit <HEAD>）」；有未提交的檔接在結果後面，沒有 commit 就不帶括號。"""
    note = f'，有 {dirty} 個檔未提交' if dirty else ''
    code = f'（commit {sha}）' if sha else ''
    return f'- {now}：{USER}：{status} → {result}{note}{code}'


def cmd_done(arg, status):
    """主對話告一段落時寫回卡片：狀態改成那句；下一步驗收已過關時，驗收後有新 commit 寫等自動重新測試（沒動靜就按 v），
    沒有新 commit 寫照面板開 PR 或合併；關卡是依審查修完的未複審結論寫照面板「輪到你」接著做；其他寫去面板按 v；
    History 照白話範本記一筆「<人>：<狀態> → <結果>（commit <HEAD>）」；等你、關卡、檢查不動。"""
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
    sha = git('-C', root, 'rev-parse', '--short', 'HEAD').stdout.strip()
    dirty = [l for l in git('-C', root, 'status', '--porcelain').stdout.split('\n') if l.strip()]
    if unreviewed_gate(gate):
        next_step = DONE_NEXT_TURN
    elif review_passed(gate):
        next_step = DONE_NEXT_RECHECK if committed_after_review(root) else DONE_NEXT_MERGE
    else:
        next_step = DONE_NEXT
    set_fields(path, {'狀態': status, '下一步': next_step}, required=('狀態', '下一步'))
    line = done_history(stamp(), status, DONE_RESULT[next_step], len(dirty), sha)
    write(path, append_line(read(path), '## History', line))
    print(f'已寫回卡片：{path}')
    print(f'  狀態：{status}')
    print(f'  下一步：{next_step}')
    if dirty:
        print(f'  注意：有 {len(dirty)} 個檔未提交，測試與驗收只看 commit 過的內容')


DEPLOY_STEP = re.compile(r'^\s*(?:\d+[.)、]|[-*])\s+(.*\S)\s*$')

# 終端機控制碼：規則與 hooks/model.ts 的 plain() 逐條相同（tests/card-cases.mjs 兩邊共用）。
PLAIN_RULES = (
    re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]'),           # CSI：顏色、游標移動、清除
    re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)'),  # OSC：標題、超連結
    re.compile(r'\x1b[@-Z\\-_]'),                     # 其他兩字元序列
    re.compile(r'^[0-9;]*m'),                         # 尾巴被截斷時殘留的半截顏色碼（只看整段開頭）
    re.compile(r'[\x00-\x08\x0b-\x1f\x7f-\x9f]'),
)


def plain(text):
    """去掉終端機控制碼，面板顯示的字就是這個結果。"""
    for rule in PLAIN_RULES:
        text = rule.sub('', text)
    return text


def deploy_steps(text):
    """卡片「## 部署…」段已填的步驟，去掉終端機控制碼；略過空白編號與 `<…>` 佔位（與 hooks/extras.ts 的 deploySteps 同規則）。"""
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
            steps.append(plain(m.group(1)))
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
    """squash／rebase 合併：分支不是 HEAD 的祖先，但內容已經在 HEAD 裡。merges_into_head、merged_by_patch 任一認得就算，
    兩個都認不出來（包括 merge-base 找不到）就當沒併入。"""
    base = git('-C', main, 'merge-base', 'HEAD', branch)
    if base.returncode != 0:
        return False
    base = base.stdout.strip()
    return merges_into_head(main, branch, base) or merged_by_patch(main, branch, base)


def merges_into_head(main, branch, base):
    """把分支合進 HEAD 結果跟 HEAD 一樣。唯一容許的差別是發版合併掉的片段檔（見 released_fragment）。
    有衝突、合出不同的內容，或 git 太舊沒有 merge-tree --write-tree（2.38 以前），都不算。"""
    merged = git('-C', main, 'merge-tree', '--write-tree', 'HEAD', branch)
    if merged.returncode != 0:
        return False
    diff = git('-C', main, 'diff', '-z', '--no-renames', '--name-status', 'HEAD', merged.stdout.split('\n', 1)[0].strip())
    if diff.returncode != 0:
        return False
    parts = [p for p in diff.stdout.split('\0') if p]
    return all(status == 'A' and released_fragment(main, base, path) for status, path in zip(parts[::2], parts[1::2]))


# 算 patch-id 的 diff 每處都用同一套選項，不受使用者的顏色、外部 diff、textconv、改名偵測、路徑前綴設定影響。
# -U0：不看上下文，合進來之前別張卡改到上下幾行（squash commit 的上下文跟分支不同）也認得是同一份改動；
# --no-prefix：log -R 反向時 a/、b/ 前綴會對調，patch-id 會把前綴算進去，拿掉才跟 revert commit 對得上。
PATCH_DIFF = ('--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-prefix', '-U0')
# 逐 commit 輸出 patch，每個前面一行「commit <sha>」，patch-id 才分得出是哪個 commit 的。
PATCH_LOG = ('log', '-p', '--no-merges', '--no-show-signature', *PATCH_DIFF, '--format=commit %H')


def merged_by_patch(main, branch, base):
    """分支的改動在 HEAD 這邊分叉後的非 merge commit 裡出現過（patch-id 相同）：整體改動就是其中一個 commit（squash），
    或分支每個有改動的 commit 都在（rebase 合併，見 rebased_by_patch）。看的是當初合進來的 commit，
    同一版別張卡後來改到相鄰行、merge-tree 合出衝突也認得。
    被 revert 的不算：反向的 patch 出現得一樣多就當沒併入；整體改動被 revert 過，就不再逐 commit 看。分支沒有改動、git 失敗也不算。"""
    head = [p for p, _ in patch_ids(main, *PATCH_LOG, f'{base}..HEAD')]
    whole = [p for p, _ in patch_ids(main, 'diff', *PATCH_DIFF, base, branch)]
    undo = [p for p, _ in patch_ids(main, 'diff', *PATCH_DIFF, branch, base)]
    if not head or not whole or not undo:
        return False
    if head.count(whole[0]) > head.count(undo[0]):
        return True
    return head.count(undo[0]) == 0 and rebased_by_patch(main, branch, base, head)


def rebased_by_patch(main, branch, base, head):
    """rebase 合併：分支每個有改動的 commit，在 head（HEAD 這邊各 commit 的 patch-id）裡都出現得比它的反向 patch 多。
    分支裡有 merge commit 就不算：解衝突的內容在 merge commit 裡，逐 commit 比對不到。"""
    span = f'{base}..{branch}'
    merges = git('-C', main, 'rev-list', '--merges', span)
    if merges.returncode != 0 or merges.stdout.strip():
        return False
    forward = {c: p for p, c in patch_ids(main, *PATCH_LOG, span)}
    undo = {c: p for p, c in patch_ids(main, *PATCH_LOG, '-R', span)}
    return bool(forward) and forward.keys() == undo.keys() and all(head.count(p) > head.count(undo[c]) for c, p in forward.items())


def patch_ids(main, *args):
    """git <args> 輸出的 patch 逐個算 patch-id（--stable，跟檔案順序、行號無關），回傳 [(patch-id, commit)]；
    沒有「commit <sha>」行的（git diff）commit 是一串 0。git 失敗回空清單。用 bytes 傳，非 UTF-8 的內容也照算。"""
    out = subprocess.run(['git', '-C', main, *args], capture_output=True, timeout=120)
    if out.returncode != 0:
        return []
    r = subprocess.run(['git', '-C', main, 'patch-id', '--stable'], input=out.stdout, capture_output=True, timeout=120)
    if r.returncode != 0:
        return []
    return [tuple(l.split()[:2]) for l in r.stdout.decode('ascii', 'replace').splitlines() if l.strip()]


def released_fragment(main, base, path):
    """發版時 changelog 把片段檔合進 CHANGELOG 並刪掉：合進來的分支會把它加回去，但它在分叉後的 HEAD 歷史裡出現過（加過又刪了）。"""
    return path.startswith(f'{FRAGMENT_DIR}/') and git('-C', main, 'rev-list', '-1', f'{base}..HEAD', '--', path).stdout.strip() != ''


# --cleanup 看 worktree 裡被 git 忽略的項目（git worktree remove 不加 --force 也會把它們一起刪掉）；fnmatch 比對、區分大小寫。
# 可丟棄：路徑任一層符合就不列。desk 自己的卡片與 .task（歸檔前已複製），以及裝套件、建置、測試會再產生的目錄與檔。
IGNORED_DISPOSABLE = (
    '.desk', '.task', 'node_modules', '__pycache__', '*.pyc', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache',
    '.tox', '.next', '.nuxt', '.turbo', '.parcel-cache', '.gradle', 'vendor', 'dist', 'build', 'target', 'coverage', 'htmlcov',
    '.coverage', '.DS_Store', 'Thumbs.db',
)
# 本機設定與資料：檔名符合就不移除 worktree、分支也保留，列出來讓使用者看過後自己刪。
IGNORED_LOCAL = (
    '.env', '.env.*', '*.local', '*.local.*', '*.pem', '*.key', '*.sqlite', '*.sqlite3', '*.db', '*.sql', '*.dump', '*.csv', '*.xlsx',
)
# 輸出與提醒最多列幾項，其餘寫「等 n 項」。
IGNORED_SHOWN = 10


def matches(name, patterns):
    return any(fnmatch.fnmatchcase(name, p) for p in patterns)


def disposable(path):
    return any(matches(part, IGNORED_DISPOSABLE) for part in path.strip('/').split('/'))


def shown(items):
    return '、'.join(items[:IGNORED_SHOWN]) + (f' 等 {len(items)} 項' if len(items) > IGNORED_SHOWN else '')


def ignored_items(root):
    """worktree 裡被 git 忽略、會跟著 worktree 一起刪的項目，分成 (本機設定與資料, 其他)；可丟棄的不列。git 失敗回 None。
    git 把整個被忽略的資料夾列成一項：裡面有本機設定或資料就列那些檔，只有可丟棄的就不列，其他列資料夾本身。"""
    r = git('-C', root, 'status', '--porcelain', '-z', '--ignored')
    if r.returncode != 0:
        return None
    local, other = [], []
    for path in (e[3:] for e in r.stdout.split('\0') if e.startswith('!! ')):
        if disposable(path):
            continue
        if matches(path.rstrip('/').rsplit('/', 1)[-1], IGNORED_LOCAL):
            local.append(path)
            continue
        found, rest = scan_ignored_dir(root, path) if path.endswith('/') else ([], True)
        if found:
            local.extend(found)
        elif rest:
            other.append(path)
    return local, other


def scan_ignored_dir(root, rel):
    """被忽略的資料夾裡（略過可丟棄的）：(本機設定與資料的路徑, 有沒有其他檔)。"""
    found, rest = [], False
    for top, dirs, files in os.walk(os.path.join(root, rel)):
        dirs[:] = sorted(d for d in dirs if not matches(d, IGNORED_DISPOSABLE))
        for f in sorted(f for f in files if not matches(f, IGNORED_DISPOSABLE)):
            if matches(f, IGNORED_LOCAL):
                found.append(os.path.relpath(os.path.join(top, f), root))
            else:
                rest = True
    return found, rest


SUBMODULE_REFUSAL = 'containing submodules cannot be moved or removed'
FORCED_SUBMODULE = '含 submodule，以 --force 移除（已先確認乾淨）'


def changed_files(root):
    """未提交的改動（含 submodule 內部：不管 .gitmodules 的 ignore 設定）。"""
    return [l for l in git('-C', root, 'status', '--porcelain', '--ignore-submodules=none').stdout.splitlines() if l.strip()]


def module_git_dirs(gitdir):
    """gitdir/modules 底下每個 submodule 的 git 目錄（名字可以含 /，巢狀的在 <名>/modules/<名>）。"""
    found = []
    for top, dirs, files in os.walk(os.path.join(gitdir, 'modules')):
        if 'HEAD' in files and 'objects' in dirs:
            found.append(os.path.realpath(top))
            dirs[:] = ['modules'] if 'modules' in dirs else []
    return found


def submodule_reason(root):
    """--force 會刪掉這個 worktree 的 git 目錄，連同底下 modules/ 裡每個 submodule 的 git 目錄（worktree 裡 submodule 的 commit、
    分支與 stash 只存在那裡），也跳過 git 自己的乾淨檢查。所以先逐一（遞迴）看已 checkout 的 submodule：沒有未提交的改動、
    沒有被忽略的本機設定或資料、沒有 stash、所有 ref（HEAD、本機分支、tag）與 reflog 找得到的 commit 都在它的遠端分支上
    （submodule 平常是 detached HEAD，在裡面 commit 後一跑 submodule update，那個 commit 就只剩 reflog 指著；不逐一列舉要查哪些 ref，
    免得再漏一種。代價：上游有不在任何分支上的 tag、或改寫過歷史而 fetch 過時會多保留）；modules/ 底下還有沒 checkout 的（deinit 過）
    就確認不了，一律保留。回傳 (保留原因, 一起刪掉的被忽略項目)；保留原因是空字串代表可以 --force。"""
    r = git('-C', root, 'submodule', '--quiet', 'foreach', '--recursive', 'echo "$displaypath"')
    gitdir = git('-C', root, 'rev-parse', '--absolute-git-dir')
    if r.returncode != 0 or gitdir.returncode != 0:
        return '讀不到 submodule（git submodule foreach 或 rev-parse 失敗）', []
    other, seen = [], set()
    for sub in (l for l in r.stdout.splitlines() if l.strip()):
        path = os.path.join(root, sub)
        dirty = changed_files(path)
        if dirty:
            return f'submodule {sub} 有未提交的改動（{len(dirty)} 個檔）', []
        ignored = ignored_items(path)
        if ignored is None:
            return f'讀不到 submodule {sub} 被 git 忽略的檔（git status 失敗）', []
        local, rest = ignored
        if local:
            return f'submodule {sub} 有被 git 忽略的本機設定或資料（{shown([f"{sub}/{x}" for x in local])}）', []
        if git('-C', path, 'rev-parse', '-q', '--verify', 'refs/stash').returncode == 0:
            return f'submodule {sub} 有 stash（git stash list）', []
        unpushed = git('-C', path, 'rev-list', '-n1', '--all', '--reflog', '--not', '--remotes')
        if unpushed.returncode != 0 or unpushed.stdout.strip():
            return f'submodule {sub} 有遠端分支上沒有的 commit（ref 或 reflog 指著：沒推上去，或上游改寫過歷史）', []
        seen.add(os.path.realpath(git('-C', path, 'rev-parse', '--absolute-git-dir').stdout.strip()))
        other.extend(f'{sub}/{x}' for x in rest)
    base = os.path.join(gitdir.stdout.strip(), 'modules')
    hidden = [os.path.relpath(d, os.path.realpath(base)) for d in module_git_dirs(gitdir.stdout.strip()) if d not in seen]
    if hidden:
        return f'submodule 的 git 目錄沒有 checkout（{shown(hidden)}），確認不了裡面的 commit 推上去了沒', []
    return '', other


def remove_worktree(main, root):
    """乾淨才 git worktree remove（不加 --force）。回傳 (保留原因, 一起刪掉的被忽略項目, 備註)；保留原因是空字串代表已移除。
    被 git 忽略的本機設定或資料也算不乾淨：status --porcelain 看不到它們，worktree remove 卻會一起刪掉。
    git 只因 worktree 含 submodule 而拒絕（不加 --force 一律拒絕，跟乾不乾淨無關）時，再確認每個 submodule 內部也乾淨（submodule_reason），
    才改加 --force 再試一次，備註寫 FORCED_SUBMODULE；其他拒絕原因照舊保留。"""
    dirty = changed_files(root)
    if dirty:
        return f'有未提交的改動（{len(dirty)} 個檔）', [], ''
    ignored = ignored_items(root)
    if ignored is None:
        return '讀不到被 git 忽略的檔（git status 失敗）', [], ''
    local, other = ignored
    if local:
        return f'有被 git 忽略的本機設定或資料（{shown(local)}）', [], ''
    r = git('-C', main, 'worktree', 'remove', root, c_locale=True)
    if r.returncode == 0:
        return '', other, ''
    if SUBMODULE_REFUSAL not in r.stderr + r.stdout:
        return git_reason(r), [], ''
    why, inside = submodule_reason(root)
    if why:
        return why, [], ''
    r = git('-C', main, 'worktree', 'remove', '--force', root)
    return (git_reason(r), [], '') if r.returncode != 0 else ('', other + inside, FORCED_SUBMODULE)


def cleanup(root):
    """--cleanup：移除已併入主 repo 目前分支、沒有未提交改動與被忽略的本機設定的 worktree 與分支（不加 --force／-D）。
    squash／rebase 合併的（內容已在主 repo，但分支不是祖先）只移除 worktree：branch -d 會拒絕，分支留著寫進提醒。
    其他被忽略的檔跟著 worktree 刪掉時，輸出與提醒列出刪了哪些。
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
    if not ancestor and not squashed:
        why, gone, forced = f'分支還沒併入 {git_branch(main) or "主 repo 的 HEAD"}', [], ''
    else:
        why, gone, forced = remove_worktree(main, root)
    if why:
        return f'worktree 與分支保留：{why}', f'；worktree 保留：{why}', why, [remove_wt, remove_branch]
    note = (f'；{forced}' if forced else '') + (f'；一起刪掉被 git 忽略的：{shown(gone)}' if gone else '')
    if squashed:
        why = f'worktree 已移除，分支 {branch} 保留：{SQUASHED}{note}'
        return f'worktree 已移除；分支 {branch} 保留：{SQUASHED}{note}', f'；{why}', why, [remove_branch]
    r = git('-C', main, 'branch', '-d', branch)
    if r.returncode != 0:
        why = f'worktree 已移除，分支 {branch} 保留：{git_reason(r)}{note}'
        return f'worktree 已移除；分支 {branch} 保留：{git_reason(r)}{note}', f'；{why}', why, [remove_branch]
    return f'worktree 已移除；分支 {branch} 已刪除{note}', f'；worktree 與分支已移除{note}', f'worktree 與分支已移除{note}' if note else '', []


def cmd_archive(slugs, cleanup_after=False):
    # 先把每張都找到：有一張找不到就報錯，哪張都不動。同一張卡（slug 與任務名各寫一次）只做第一次。
    found = [(slug, *resolve(slug)) for slug in slugs]
    targets = [t for i, t in enumerate(found) if all(os.path.realpath(t[2]) != os.path.realpath(u[2]) for u in found[:i])]
    for slug, _, path, root in targets:
        archive_one(slug, path, root, cleanup_after)


# 工作桌寫的卡片統計（hooks/run-stats.ts 的 STATS_FILE）與審查留檔（hooks/probes.ts 的 archiveReview：<資料夾名>-<年月日>-<時分>-code|security.md）。
STATS_FILE = os.path.join('.task', 'stats.json')
REVIEW_KINDS = ('code', 'security')


def run_minutes_text(ms):
    """總執行給人看：跟面板（hooks/text.ts 的 runMinutesText）同一套寫法，整分往下取。"""
    m = int(max(0, ms) // 60_000)
    if m < 1:
        return '不到 1 分'
    return f'{m} 分' if m < 60 else f'{m // 60} 小時 {m % 60} 分'


def stats_count(value):
    """stats.json 的數字欄位：非負的數字才算（布林、字串、負數都不算），回傳整數或 None。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value < 0 or value == float('inf'):
        return None
    return int(value)


def card_stats(root):
    """讀 worktree 的 .task/stats.json：回傳 (總執行毫秒, 修正輪數)；沒有檔、不是 JSON、欄位不是非負數字的那項是 None。"""
    try:
        data = json.loads(read(os.path.join(root, STATS_FILE)))
    except (OSError, ValueError):
        return None, None
    if not isinstance(data, dict):
        return None, None
    return stats_count(data.get('runMs')), stats_count(data.get('fixRounds'))


def review_counts(root):
    """登錄表旁 reviews/ 裡這張卡（worktree 資料夾名）的審查留檔份數：(程式碼審查, 資安審查)。"""
    folder = os.path.basename(os.path.normpath(root))
    reviews = os.path.join(os.path.dirname(REG), 'reviews') if REG else ''
    names = os.listdir(reviews) if reviews and os.path.isdir(reviews) else []
    pattern = re.compile(rf'{re.escape(folder)}-\d{{8}}-\d{{4}}-({"|".join(REVIEW_KINDS)})\.md')
    kinds = [m.group(1) for m in map(pattern.fullmatch, names) if m]
    return tuple(kinds.count(k) for k in REVIEW_KINDS)


def stats_line(root):
    """歸檔的統計句「統計：總執行 N 分・修正 n 輪・驗收 n 輪（資安 n）」；只列有資料的部分，都沒有是空字串。"""
    run_ms, fixes = card_stats(root)
    code, security = review_counts(root)
    parts = ([f'總執行 {run_minutes_text(run_ms)}'] if run_ms is not None else []) \
        + ([f'修正 {fixes} 輪'] if fixes is not None else []) \
        + ([f'驗收 {code} 輪' + (f'（資安 {security}）' if security else '')] if code or security else [])
    return f'統計：{"・".join(parts)}' if parts else ''


def archive_one(slug, path, root, cleanup_after):
    os.makedirs(ARCHIVE, exist_ok=True)
    # 統計檔在 worktree 裡，清理會一起刪掉：先讀。
    stats = stats_line(root)
    dest = os.path.join(ARCHIVE, f'{slug}-CARD.md')
    card = read(path)
    write(dest, card)
    task = os.path.join(root, '.task')
    for f in sorted(os.listdir(task)) if os.path.isdir(task) else []:
        if re.match(r'(REVIEW|SECURITY|PLAN|REPORT|review-.*)\.md$', f):
            write(os.path.join(ARCHIVE, f'{slug}-{f}'), read(os.path.join(task, f)))
    retro = cfg('retro')
    if retro:
        cmd = retro.replace('{slug}', shlex.quote(slug))
        try:
            r = subprocess.run(cmd, shell=True, text=True, capture_output=True, cwd=root, timeout=60)
            if r.stdout:
                print(r.stdout.rstrip('\n'))
            if r.returncode != 0:
                err = (r.stderr or '').strip()
                print(f'回顧指令失敗（{r.returncode}）：{err or cmd}')
        except subprocess.TimeoutExpired:
            print(f'回顧指令超時（60s）：{cmd}')
        except Exception as e:
            print(f'回顧指令失敗：{e}')
    # 移除 worktree 會連 .desk、.task 一起刪，所以清理排在複製之後。
    said, suffix, kept, commands = cleanup(root) if cleanup_after else ('', '', '', [])
    lines = read(REG).split('\n')
    removed = [l for l in lines if l.startswith('|') and f'`{path}`' in l]
    lines = [l for l in lines if not (l.startswith('|') and f'`{path}`' in l)]
    note = f'- {slug}：{datetime.date.today().isoformat()} 歸檔；卡片在 `{dest}`' + (f'；{stats}' if stats else '') + suffix
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
    if stats:
        print(stats)
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


BEACON_REL = os.path.join('.task', 'agent-state.json')
AGENT_OUT_REL = os.path.join('.task', 'AGENT-OUT.md')
VALID_AGENT_STATES = ('working', 'blocked', 'done', 'idle')
VALID_WAITS = ('permission', 'question')
OSC_7501_RE = re.compile(r'\x1b\]7501;([^\x07\x1b]*)(?:\x07|\x1b\\)')
ANSI_STRIP_RE = re.compile(
    r'\x1b\[[0-?]*[ -/]*[@-~]'
    r'|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)'
    r'|\x1b[@-Z\\-_]'
    r'|[\x00-\x08\x0b-\x1f\x7f-\x9f]'
)


def strip_ansi(text):
    """剝除終端機 CSI／OSC 控制序列與控制字元。"""
    return ANSI_STRIP_RE.sub('', text or '')


def parse_osc7501_py(text):
    """從原始文字掃描最後一筆合法的 OSC 7501 狀態訊號。"""
    if not text or '\x1b]7501;' not in text:
        return None
    found = None
    for m in OSC_7501_RE.finditer(text):
        kv = {}
        for part in m.group(1).split(';'):
            if '=' not in part:
                continue
            k, v = part.split('=', 1)
            k, v = k.strip().lower(), v.strip()
            if k and v:
                kv[k] = v
        state = kv.get('state', '').lower()
        if state not in VALID_AGENT_STATES:
            continue
        wait = kv.get('wait') or kv.get('reason') or kv.get('waitingfor') or ''
        wait = wait.lower() if wait.lower() in VALID_WAITS else ('permission' if state == 'blocked' else '')
        sig = {'state': state}
        if wait:
            sig['waitsFor'] = wait
        if kv.get('agent') or kv.get('runner'):
            sig['agent'] = strip_ansi(kv.get('agent') or kv.get('runner')).strip()
        if kv.get('msg') or kv.get('message'):
            sig['message'] = strip_ansi(kv.get('msg') or kv.get('message')).strip()
        found = sig
    return found


def format_osc7501(state, agent=None, waits_for=None, message=None):
    """組出 Herdr 相容的 OSC 7501 轉義序列字串。"""
    parts = [f'state={state}']
    if agent:
        parts.append(f'agent={agent.replace(";", ",")}')
    if waits_for:
        parts.append(f'wait={waits_for}')
    if message:
        clean_msg = strip_ansi(message).replace('\n', ' ').replace(';', ',').strip()
        if clean_msg:
            parts.append(f'msg={clean_msg}')
    return f'\x1b]7501;{";".join(parts)}\x1b\\'


def pid_alive_py(pid):
    """檢查整數 PID 是否還活著。"""
    if not isinstance(pid, int) or pid <= 0:
        return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def write_beacon(root, state, agent='agy', pid=None, waits_for=None, message=None, started_at=None):
    """原子寫入 .task/agent-state.json。"""
    task_dir = os.path.join(root, '.task')
    os.makedirs(task_dir, exist_ok=True)
    beacon_path = os.path.join(root, BEACON_REL)
    now_ms = int(time.time() * 1000)
    prev = load_json(beacon_path) if os.path.isfile(beacon_path) else {}
    if started_at is None:
        started_at = prev.get('startedAt') if prev.get('state') in ('working', 'blocked') and isinstance(prev.get('startedAt'), int) else now_ms
    payload = {
        'state': state,
        'agent': agent or prev.get('agent') or 'agy',
        'startedAt': started_at,
        'updatedAt': now_ms,
    }
    if isinstance(pid, int) and pid > 0:
        payload['pid'] = pid
    if state == 'blocked':
        payload['waitsFor'] = waits_for if waits_for in VALID_WAITS else 'permission'
    elif waits_for in VALID_WAITS:
        payload['waitsFor'] = waits_for
    if message:
        payload['message'] = strip_ansi(message).strip()
    tmp_path = f'{beacon_path}.tmp.{os.getpid()}'
    write(tmp_path, json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
    os.replace(tmp_path, beacon_path)
    return beacon_path, payload


def append_agent_out(root, text):
    """追加文字到 .task/AGENT-OUT.md。"""
    out_path = os.path.join(root, AGENT_OUT_REL)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'a', encoding='utf-8') as f:
        f.write(text if text.endswith('\n') else text + '\n')
    return out_path


def cmd_emit(args):
    """card.py emit <target> <working|blocked|done|idle> [message...] [--agent <name>] [--wait <permission|question>] [--pid <pid>]"""
    agent = os.environ.get('DESK_AGENT') or 'agy'
    waits_for = None
    pid = None
    pos = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--agent' and i + 1 < len(args):
            agent = args[i + 1].strip() or agent
            i += 2
        elif a == '--wait' and i + 1 < len(args):
            waits_for = args[i + 1].strip().lower()
            if waits_for not in VALID_WAITS:
                fail(f'--wait 只能是 permission 或 question：{waits_for}')
            i += 2
        elif a == '--pid' and i + 1 < len(args):
            try:
                pid = int(args[i + 1])
            except ValueError:
                fail(f'--pid 要是整數：{args[i + 1]}')
            i += 2
        else:
            pos.append(a)
            i += 1
    if len(pos) < 2:
        fail('用法：card.py emit <slug|任務名|main> <working|blocked|done|idle> [訊息] [--agent <名>] [--wait <permission|question>] [--pid <PID>]', 2)
    target, state = pos[0], pos[1].strip().lower()
    if state not in VALID_AGENT_STATES:
        fail(f'狀態只能是 working、blocked、done 或 idle：{state}')
    message = ' '.join(pos[2:]).strip()
    if pid is None and state in ('working', 'blocked'):
        pid = os.getppid()
    name, _, root = resolve(target)
    osc = format_osc7501(state, agent=agent, waits_for=waits_for or ('permission' if state == 'blocked' else None), message=message)
    beacon_path, payload = write_beacon(root, state, agent=agent, pid=pid, waits_for=waits_for, message=message)
    if message:
        stamp = datetime.datetime.now().strftime('%H:%M:%S')
        append_agent_out(root, f'{osc}[{stamp}] ({agent}:{state}) {message}')
    sys.stdout.write(f'{osc}狀態已推播：{name} → {state}（{beacon_path}）\n')
    sys.stdout.flush()
    return payload


READ_SOURCES = {
    'out': AGENT_OUT_REL,
    'agent-out': AGENT_OUT_REL,
    'logs': AGENT_OUT_REL,
    'review': os.path.join('.task', 'REVIEW.md'),
    'security': os.path.join('.task', 'SECURITY-REVIEW.md'),
    'report': os.path.join('.task', 'REPORT.md'),
    'spec': os.path.join('.task', 'SPEC-PREFLIGHT.md'),
    'state': BEACON_REL,
}


def inspect_task_state(path, root):
    """讀取目標任務目前的卡片關卡、等你、外部信標與輸出狀態。"""
    text = read(path) if os.path.isfile(path) else ''
    found = find_block(text) if text else None
    body = text[found[1]:found[2]] if found else ''
    gate = field(body, '關卡') if body else ''
    ask = field(body, '等你') if body else ''
    status_text = field(body, '狀態') if body else ''
    beacon_path = os.path.join(root, BEACON_REL)
    beacon = load_json(beacon_path) if os.path.isfile(beacon_path) else {}
    out_path = os.path.join(root, AGENT_OUT_REL)
    raw_out = read(out_path) if os.path.isfile(out_path) else ''
    osc = parse_osc7501_py(raw_out)
    b_state = str(beacon.get('state') or '').lower()
    b_pid = beacon.get('pid')
    alive = pid_alive_py(b_pid) if isinstance(b_pid, int) else True
    if b_state in ('working', 'blocked') and not alive:
        b_state = 'idle'
    if b_state in ('done', 'idle'):
        eff_state = b_state
    elif osc and osc.get('state') in VALID_AGENT_STATES and alive:
        eff_state = osc['state']
    elif b_state in VALID_AGENT_STATES:
        eff_state = b_state
    else:
        eff_state = 'idle'
    clean_lines = [l.strip() for l in strip_ansi(raw_out).splitlines() if l.strip()]
    last_line = clean_lines[-1] if clean_lines else (beacon.get('message') or '')
    return {
        'gate': gate,
        'ask': ask,
        'cardStatus': status_text,
        'state': eff_state,
        'agent': (osc or {}).get('agent') or beacon.get('agent') or '',
        'waitsFor': (osc or {}).get('waitsFor') or beacon.get('waitsFor') or ('permission' if eff_state == 'blocked' else ''),
        'pid': b_pid if isinstance(b_pid, int) else None,
        'pidAlive': alive,
        'lastLine': last_line,
        'hasReview': os.path.isfile(os.path.join(root, '.task', 'REVIEW.md')),
        'hasReport': os.path.isfile(os.path.join(root, '.task', 'REPORT.md')),
        'beacon': beacon or None,
        'osc7501': osc,
    }


def cmd_read(args):
    """card.py read <target> [--source <out|review|security|report|spec|card|state>] [--lines <N>] [--json]"""
    source = 'out'
    max_lines = 50
    as_json = False
    pos = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--source' and i + 1 < len(args):
            source = args[i + 1].strip().lower()
            i += 2
        elif a == '--lines' and i + 1 < len(args):
            try:
                max_lines = int(args[i + 1])
            except ValueError:
                fail(f'--lines 要是整數：{args[i + 1]}')
            i += 2
        elif a == '--json':
            as_json = True
            i += 1
        else:
            pos.append(a)
            i += 1
    if not pos:
        fail('用法：card.py read <slug|任務名|main> [--source <out|review|security|report|spec|card|state>] [--lines <N>] [--json]', 2)
    name, card_path, root = resolve(pos[0])
    if source == 'card':
        target_file = card_path
    elif source in READ_SOURCES:
        target_file = os.path.join(root, READ_SOURCES[source])
    else:
        fail(f'不支援的 --source：{source}（可用：out、review、security、report、spec、card、state）')
    raw = read(target_file) if os.path.isfile(target_file) else ''
    osc = parse_osc7501_py(raw)
    cleaned = strip_ansi(raw)
    all_lines = [l.rstrip() for l in cleaned.splitlines() if l.strip()]
    lines = all_lines[-max_lines:] if max_lines > 0 else all_lines
    if as_json:
        info = inspect_task_state(card_path, root)
        print(json.dumps({
            'name': name,
            'root': root,
            'source': source,
            'file': target_file,
            'exists': os.path.isfile(target_file),
            'state': info['state'],
            'osc7501': osc or info['osc7501'],
            'lines': lines,
            'text': '\n'.join(lines),
        }, ensure_ascii=False))
        return
    if lines:
        print('\n'.join(lines))


VALID_UNTIL = ('done', 'blocked', 'gate', 'ready', 'idle')


def check_wait_condition(until, info):
    """判斷是否達到 wait 條件；回傳 (matched: bool, status_label: str, exit_code: int)。"""
    state = info['state']
    has_gate = bool(info['gate'] and info['gate'] != '無')
    has_ask = bool(info['ask'] and info['ask'] != '無')
    if until == 'blocked':
        if state == 'blocked' or has_ask:
            return True, 'blocked', 0
        return False, state, 0
    if until == 'gate':
        if has_gate:
            return True, 'gate', 0
        return False, state, 0
    if until in ('ready', 'idle'):
        if state in ('done', 'idle', '') and not has_ask:
            return True, state or 'idle', 0
        return False, state, 0
    if until == 'done':
        # 等待 done 時若目標卡在權限或等你決策，提前返回 exit 2 避免主控 Agent 盲等逾時
        if state == 'blocked' or has_ask:
            return True, 'blocked', 2
        if state == 'done' or (state != 'working' and (has_gate or info['hasReport'] or info['hasReview'])):
            return True, 'done', 0
    return False, state, 0


def cmd_wait(args):
    """card.py wait <target> --until <done|blocked|gate|ready|idle> [--timeout <秒>] [--interval <秒>] [--json]"""
    until = 'done'
    timeout_sec = 600.0
    interval_sec = 1.0
    as_json = False
    pos = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--until' and i + 1 < len(args):
            until = args[i + 1].strip().lower()
            if until not in VALID_UNTIL:
                fail(f'--until 只能是 {", ".join(VALID_UNTIL)}：{until}')
            i += 2
        elif a == '--timeout' and i + 1 < len(args):
            try:
                timeout_sec = float(args[i + 1])
            except ValueError:
                fail(f'--timeout 要是數字：{args[i + 1]}')
            i += 2
        elif a == '--interval' and i + 1 < len(args):
            try:
                interval_sec = max(0.05, float(args[i + 1]))
            except ValueError:
                fail(f'--interval 要是數字：{args[i + 1]}')
            i += 2
        elif a == '--json':
            as_json = True
            i += 1
        else:
            pos.append(a)
            i += 1
    if not pos:
        fail('用法：card.py wait <slug|任務名|main> --until <done|blocked|gate|ready|idle> [--timeout <秒>] [--interval <秒>] [--json]', 2)
    name, card_path, root = resolve(pos[0])
    started = time.monotonic()
    while True:
        info = inspect_task_state(card_path, root)
        matched, status_label, code = check_wait_condition(until, info)
        elapsed = round(time.monotonic() - started, 2)
        if matched:
            if as_json:
                print(json.dumps({
                    'name': name,
                    'root': root,
                    'status': status_label,
                    'until': until,
                    'agent': info['agent'],
                    'waitsFor': info['waitsFor'],
                    'gate': info['gate'],
                    'ask': info['ask'],
                    'lastLine': info['lastLine'],
                    'elapsedSec': elapsed,
                }, ensure_ascii=False))
            else:
                detail = info['lastLine'] or info['gate'] or info['ask'] or info['cardStatus']
                print(f'{name}：{status_label}{f"（{detail}）" if detail else ""} [{elapsed}s]')
            if code != 0:
                sys.exit(code)
            return
        if time.monotonic() - started >= timeout_sec:
            if as_json:
                print(json.dumps({
                    'name': name,
                    'root': root,
                    'status': 'timeout',
                    'until': until,
                    'state': info['state'],
                    'lastLine': info['lastLine'],
                    'elapsedSec': elapsed,
                }, ensure_ascii=False))
            else:
                print(f'等待逾時（{timeout_sec}s）：{name} 目前為 {info["state"]}', file=sys.stderr)
            sys.exit(124)
        time.sleep(interval_sec)


def build_send_argv(to_agent, prompt, agent_cmd=None):
    """依目標執行器組出子行程 argv。"""
    if agent_cmd:
        return [*shlex.split(agent_cmd), prompt]
    if to_agent == 'cmd':
        return ['sh', '-c', prompt]
    if to_agent == 'agy':
        base = os.environ.get('DESK_AGY_CMD') or 'agy'
        return [*shlex.split(base), prompt]
    if to_agent == 'claude':
        base = os.environ.get('DESK_CLAUDE_CMD') or 'claude'
        return [*shlex.split(base), '-p', prompt]
    return [*shlex.split(to_agent), prompt]


def run_agent_wrapped(root, to_agent, argv, prompt, started_at=None):
    """在目標 worktree 執行子行程、即時把輸出寫進 .task/AGENT-OUT.md，並在啟動與結束時更新 .task/agent-state.json。"""
    out_path = os.path.join(root, AGENT_OUT_REL)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    header = f'\x1b]7501;state=working;agent={to_agent}\x1b\\[{stamp}] ▶ {to_agent}: {prompt}\n'
    with open(out_path, 'a', encoding='utf-8') as out_f:
        out_f.write(header)
        out_f.flush()
        try:
            proc = subprocess.Popen(argv, cwd=root, stdout=out_f, stderr=subprocess.STDOUT, text=True)
        except OSError as e:
            err_line = f'\x1b]7501;state=blocked;agent={to_agent};wait=permission;msg={e}\x1b\\啟動失敗：{e}\n'
            out_f.write(err_line)
            out_f.flush()
            write_beacon(root, 'blocked', agent=to_agent, waits_for='permission', message=f'啟動失敗：{e}', started_at=started_at)
            return 127
        write_beacon(root, 'working', agent=to_agent, pid=proc.pid, message=prompt[:120], started_at=started_at)
        rc = proc.wait()
    raw_out = read(out_path) if os.path.isfile(out_path) else ''
    osc = parse_osc7501_py(raw_out)
    clean_lines = [l.strip() for l in strip_ansi(raw_out).splitlines() if l.strip()]
    last_line = clean_lines[-1] if clean_lines else ''
    if osc and osc.get('state') == 'blocked':
        write_beacon(root, 'blocked', agent=to_agent, waits_for=osc.get('waitsFor', 'permission'), message=osc.get('message') or last_line, started_at=started_at)
    elif rc == 0:
        append_agent_out(root, f'\x1b]7501;state=done;agent={to_agent}\x1b\\')
        write_beacon(root, 'done', agent=to_agent, message=last_line or '已完成', started_at=started_at)
    else:
        msg = last_line or f'執行失敗（exit {rc}）'
        append_agent_out(root, f'\x1b]7501;state=blocked;agent={to_agent};wait=question;msg={msg}\x1b\\')
        write_beacon(root, 'blocked', agent=to_agent, waits_for='question', message=msg, started_at=started_at)
    return rc


def cmd_send(args):
    """card.py send <target> --to <claude|agy|cmd> <prompt...> [--bg] [--agent-cmd <cmd>] [--json]"""
    to_agent = 'agy'
    agent_cmd = None
    bg = False
    as_json = False
    pos = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--to' and i + 1 < len(args):
            to_agent = args[i + 1].strip()
            i += 2
        elif a == '--agent-cmd' and i + 1 < len(args):
            agent_cmd = args[i + 1].strip()
            i += 2
        elif a == '--bg':
            bg = True
            i += 1
        elif a == '--json':
            as_json = True
            i += 1
        else:
            pos.append(a)
            i += 1
    if len(pos) < 2:
        fail('用法：card.py send <slug|任務名|main> --to <claude|agy|cmd> <提示詞或指令> [--bg] [--agent-cmd <執行檔>] [--json]', 2)
    target = pos[0]
    prompt = ' '.join(pos[1:]).strip()
    name, _, root = resolve(target)
    argv = build_send_argv(to_agent, prompt, agent_cmd)
    started_at = int(time.time() * 1000)
    if bg:
        runner_args = [
            sys.executable, os.path.abspath(__file__), '_run-wrapped',
            root, to_agent, prompt, str(started_at), *argv,
        ]
        proc = subprocess.Popen(runner_args, cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        beacon_path, _ = write_beacon(root, 'working', agent=to_agent, pid=proc.pid, message=prompt[:120], started_at=started_at)
        out_path = os.path.join(root, AGENT_OUT_REL)
        if as_json:
            print(json.dumps({
                'name': name,
                'root': root,
                'agent': to_agent,
                'pid': proc.pid,
                'beacon': beacon_path,
                'out': out_path,
                'background': True,
            }, ensure_ascii=False))
        else:
            print(f'已派工給 {to_agent}（PID {proc.pid}）：{name}')
            print(f'  狀態信標：{beacon_path}')
            print(f'  輸出紀錄：{out_path}')
        return
    rc = run_agent_wrapped(root, to_agent, argv, prompt, started_at=started_at)
    info = inspect_task_state(os.path.join(root, CARD_FILES[0]), root)
    if as_json:
        print(json.dumps({
            'name': name,
            'root': root,
            'agent': to_agent,
            'exitCode': rc,
            'state': info['state'],
            'lastLine': info['lastLine'],
            'background': False,
        }, ensure_ascii=False))
    else:
        tail = f' — {info["lastLine"]}' if info['lastLine'] else ''
        print(f'{name}（{to_agent}）執行結束：{info["state"]}{tail}')
    if rc != 0:
        sys.exit(rc)


def main(argv):
    if not argv:
        fail(__doc__, 2)
    cmd, args = argv[0], argv[1:]
    if cmd == 'new' and len([a for a in args if a != TRIVIAL_FLAG]) >= 2:
        pos = [a for a in args if a != TRIVIAL_FLAG]
        cmd_new(pos[0], pos[1], pos[2] if len(pos) > 2 else None, TRIVIAL_FLAG in args)
    elif cmd == 'card' and args:
        cmd_card(args[0])
    elif cmd == 'spec-init' and args:
        cmd_spec_init(args[0])
    elif cmd == 'gate' and len(args) >= 2:
        cmd_gate(args[0], ' '.join(args[1:]))
    elif cmd == 'spec-ok' and args:
        cmd_spec_ok(args[0])
    elif cmd == 'overlap' and args:
        cmd_overlap(args[0])
    elif cmd == 'done' and len(args) >= 2:
        cmd_done(args[0], ' '.join(args[1:]))
    elif cmd == 'archive' and [a for a in args if a != '--cleanup']:
        cmd_archive([a for a in args if a != '--cleanup'], '--cleanup' in args)
    elif cmd == 'changelog' and args:
        cmd_changelog(args[0])
    elif cmd == 'emit' and args:
        cmd_emit(args)
    elif cmd == 'read' and args:
        cmd_read(args)
    elif cmd == 'wait' and args:
        cmd_wait(args)
    elif cmd == 'send' and args:
        cmd_send(args)
    elif cmd == '_run-wrapped' and len(args) >= 5:
        sys.exit(run_agent_wrapped(args[0], args[1], args[4:], args[2], started_at=int(args[3])))
    else:
        fail(__doc__, 2)


if __name__ == '__main__':
    main(sys.argv[1:])
