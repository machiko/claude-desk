// 面板分三區：header（desk 版本、額度、更新時間；到期提醒與容器異常）與 footer（現在這件的操作、全域鍵、容器與模型）常駐，
// 只有 content（現在卡、其他任務進度表、最近、說明）捲動。content 一列一個元素，desk 自己決定顯示哪幾列（ui.scroll）。
// 階層靠字重與明暗；顏色只給需要你、執行中、通過、未通過，以及偏低的額度。
import type { Case, FeedEvent, Picks, Snapshot, Verify, SentRecord } from '../types'
import { displayWidth, elapsedText, feedOf, fit, focusCase, hhmm, modelLabel, pad, sorted, summary, ago } from './model'
import { COLOR, SPINNER, STATE, WORD } from './theme'
import { STAGES, STAGE_GLYPH } from './pipeline'
import { dueReminders, reminderWhen } from './extras'
import { STAGE_COLOR } from './band'
import { contentWindow, flowRows, scrollHint, wrapText } from './layout'
import type { ContentWindow } from './layout'
import { button, caseActions, nowCardRows, picksKey, shortCommand } from './pane-card'
import { noticeText } from './update'
import type { Action } from './pane-card'
import { KIND_LABEL } from './dispatch'
import type { DispatchKind } from './dispatch'

export { picksKey, shortCommand }

export type PaneView = {
  s: Snapshot
  now: number
  columns: number
  /** 面板 body 可用的列數（引擎給的）；沒有就不切視窗。 */
  bodyRows?: number
  placement?: 'dock' | 'inline'
  /** content 捲到第幾列。 */
  offset: number
  isFocused: boolean
  selected: string | null
  feed: FeedEvent[]
  picks: Picks
  verifies: Record<string, Verify>
  verifying: Record<string, number>
  tick: number
  isExpanded: boolean
  launching: Record<string, number>
  queue: string[]
  armed: { key: string; at: number } | null
  logsOpen: string | null
  logView: Record<string, string[]>
  isHelp: boolean
  /** 展開全部動作（m）；平常只列現在這一段能做的。 */
  showAll: boolean
  /** 從面板送出的決策（卡片路徑 → 送出時的「等你」）；等對話寫回卡片前那題鎖住。 */
  sent: Record<string, SentRecord>
}
export type PaneActions = {
  select: (statusPath: string) => void
  /** 回到工作桌自己挑的那件（「更多動作」裡，有選取時才出現）。 */
  deselect: () => void
  pick: (c: Case, index: number, key: string) => void
  fill: (c: Case) => void
  verify: (c: Case) => void
  open: (c: Case) => void
  dispatch: (c: Case, kind: DispatchKind) => void
  stop: (c: Case) => void
  logs: (c: Case) => void
  openReview: (c: Case) => void
  openPr: (c: Case) => void
  /** 合併段還沒有 PR：派推送 Agent push 分支並對基準分支開 PR（按兩次；高風險改動照樣列出，第一次按提醒先看審查檔）；desk 自己不跑 git push、gh。 */
  publishPr: (c: Case) => void
  /** 合併段、PR 已開又有沒 push 的 commit：派推送 Agent 只 push（按兩次）。 */
  publishPush: (c: Case) => void
  /** 上線確認：清掉 release 關卡（按兩次）。 */
  ship: (c: Case) => void
  /** 真實模式的 t：確認規格（按兩次），效果同 /desk:card spec <slug> ok。 */
  specOk: (c: Case) => void
  /** 真實模式的歸檔（按兩次、沒有快捷鍵），效果同 /desk:card archive <slug>；不刪 worktree 與分支。 */
  archive: (c: Case) => void
  /** 上線段還沒打 tag：把發版請求（列出所有待發版的卡）填進輸入框，Enter 送出；沒有快捷鍵、按一次，面板不打 tag。 */
  release: (c: Case) => void
  /** 教學模式的 t：確認規格、合併、打 tag。 */
  tutorial: (c: Case) => void
  help: () => void
  refresh: () => void
  toggleBand: () => void
  /** 把 desk 更新到 GitHub 上的最新版本（跟 /desk update 一樣）；只用點的，不綁快捷鍵。 */
  update: () => void
  /** 新專案還沒有登錄表：在專案資料夾建一份空的（只有表頭）；已經有了就不覆寫。 */
  createRegistry: () => void
  expand: () => void
  more: () => void
  /** 這次畫出來 content 最多能捲到哪；捲動 hook 用它夾住位置。 */
  window?: (w: ContentWindow) => void
}

const WIDE = 100
/** 進度表放得下完整段名（數字鍵＋圖示＋至少 10 格任務名＋六段）的最小寬度；更窄改成緊湊圖示、不放標題列。 */
const NARROW = 3 + 2 + 10 + 2 + 6 * 5
const FEED_ROWS = 3
const GUTTER = 3
/** 進度表每段一欄：段名兩個字（4 格）＋1 格間隔；圖示放在段名下方中間（第 2 格）。 */
const STAGE_COL = 5
const NAME_MIN = 12

/** 現在卡上的那一件：選取的優先，否則工作桌自己挑。 */
export function focusOf(view: PaneView): Case | null {
  const picked = view.selected ? view.s.cases.find(c => c.statusPath === view.selected) ?? null : null
  // 教學只有一件：做完了也留在現在卡，讓「教學完成」那句看得到。
  return picked ?? focusCase(view.s.cases) ?? (view.s.tutorial ? view.s.cases[0] ?? null : null)
}

/** 清單上的六段：每段一個圖示，不適用的段落用「·」佔位，讓各列對齊。 */
export function stageStrip(c: Case): { text: string; status: string }[] {
  if (!c.pipeline) return []
  return c.pipeline.stages.map(s => ({ text: STAGE_GLYPH[s.status], status: s.status }))
}

/** 進度表的欄寬：數字鍵「1: 」＋狀態圖示＋任務名（各列同寬）＋六段（每段 3 格）＋時間靠右。 */
export function gridLayout(names: string[], ages: string[], width: number): { nameWidth: number; ageWidth: number; lead: number } {
  const ageWidth = Math.max(0, ...ages.map(displayWidth))
  const fixed = 3 + 2 + 2 + STAGES.length * STAGE_COL
  const longest = Math.max(4, ...names.map(displayWidth))
  // 任務名至少留 NAME_MIN 格（或全名）才放時間；不夠就先拿掉時間。
  const keepAge = ageWidth > 0 && width - fixed - ageWidth - 1 >= Math.min(NAME_MIN, longest)
  const room = width - fixed - (keepAge ? ageWidth + 1 : 0)
  const nameWidth = Math.max(4, Math.min(longest, room))
  return { nameWidth, ageWidth: keepAge ? ageWidth : 0, lead: 3 + 2 + nameWidth + 2 }
}

/** 重置時間：今天只寫時分，明天寫「明天」，7 天內寫星期，更遠寫日期；short 只留哪一天（今天、明天、週三、1/12）。 */
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']
const DAY_MS = 86_400_000
const WEEK_DAYS = 7
export function resetText(iso: string | undefined, now: number, short = false): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const n = new Date(now)
  // 比日曆日：兩邊都取當地午夜再相減（四捨五入吸收日光節約的一小時）。
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / DAY_MS)
  const day = days <= 0 ? '' : days === 1 ? '明天' : days < WEEK_DAYS ? `週${WEEKDAY[d.getDay()]}` : `${d.getMonth() + 1}/${d.getDate()}`
  if (short) return day || '今天'
  return `${day ? `${day} ` : ''}${hhmm(t)} 重置`
}

/** 剩餘量的顏色：40% 以下提醒、20% 以下警示。 */
export const remainColor = (left: number) => left <= 20 ? COLOR.bad : left <= 40 ? COLOR.attention : COLOR.good

const LIMIT_NAME: Record<string, string> = { five_hour: '5 小時', seven_day: '本週' }
type Part = { text: string; color: string; bold?: boolean }
const partsWidth = (parts: Part[]) => parts.reduce((n, p) => n + displayWidth(p.text), 0)

/** 放不下時依序退一級：本週只留星期 → 本週不寫重置 → 5 小時也不寫重置 → 拿掉名稱。 */
type QuotaLevel = { week: 'full' | 'day' | 'none'; five: boolean; named: boolean }
const QUOTA_LEVELS: QuotaLevel[] = [
  { week: 'full', five: true, named: true },
  { week: 'day', five: true, named: true },
  { week: 'none', five: true, named: true },
  { week: 'none', five: false, named: true },
  { week: 'none', five: false, named: false },
]

/** header 右側的額度：「5 小時（22:30 重置）剩 78%  本週（週三 09:00 重置）剩 31%」，放不下就照 QUOTA_LEVELS 縮。 */
export function limitParts(s: Snapshot, now: number, room: number): Part[] {
  const limits = (s.limits ?? []).filter(l => LIMIT_NAME[l.kind])
  if (!limits.length) return [{ text: '額度尚無資料', color: COLOR.faint }]
  const one = (l: { kind: string; remaining: number; resetsAt?: string }, lv: QuotaLevel): Part[] => {
    const left = Math.max(0, Math.min(100, Math.round(l.remaining)))
    const reset = l.kind === 'seven_day'
      ? (lv.week === 'none' ? '' : resetText(l.resetsAt, now, lv.week === 'day'))
      : (lv.five ? resetText(l.resetsAt, now) : '')
    return [
      ...(lv.named ? [{ text: LIMIT_NAME[l.kind]!, color: COLOR.dim }] : []),
      ...(lv.named && reset ? [{ text: `（${reset}）`, color: COLOR.faint }] : []),
      { text: `${lv.named && !reset ? ' ' : ''}剩 ${left}%`, color: remainColor(left), bold: left <= 40 },
    ]
  }
  const join = (lv: QuotaLevel) => limits.flatMap((l, i) => [...(i ? [{ text: '  ', color: COLOR.faint }] : []), ...one(l, lv)])
  for (const lv of QUOTA_LEVELS) {
    const parts = join(lv)
    if (partsWidth(parts) <= room) return parts
  }
  return join(QUOTA_LEVELS[QUOTA_LEVELS.length - 1]!)
}

function line(ui: any, parts: Part[], key?: string) {
  const { Text } = ui
  return <Text key={key} wrap="truncate-end">{parts.map((p, i) => <Text key={`p${i}`} color={p.color} bold={p.bold}>{p.text}</Text>)}</Text>
}

/** 區名＋細線到行尾。 */
function section(ui: any, label: string, width: number, right = '') {
  const { Box, Text } = ui
  const used = displayWidth(label) + 1 + (right ? displayWidth(right) + 1 : 0)
  return (
    <Box flexDirection="row">
      <Text color={COLOR.dim} bold>{label}</Text>
      <Text color={COLOR.faint}>{' ' + '─'.repeat(Math.max(2, width - used))}</Text>
      {right ? <Text color={COLOR.faint}>{' ' + right}</Text> : null}
    </Box>
  )
}

/** 只有區名：緊接在細線下的那一區不再畫第二條線。 */
function label(ui: any, text: string) {
  const { Text } = ui
  return <Text color={COLOR.dim} bold>{text}</Text>
}

/** header：desk 版本＋額度＋更新時間；有到期提醒、容器異常時各加一列；最後一條細線。 */
function headerRows(ui: any, view: PaneView, width: number): any[] {
  const { Box, Text } = ui
  const s = view.s
  const brand = `${WORD.brand}${s.versions?.desk ? ` ${s.versions.desk}` : ''}${s.project ? ` · ${s.project}` : ''}`
  const time = `${s.demo ? '示範資料 · ' : s.tutorial ? '教學模式 · ' : ''}${hhmm(s.at)} ${WORD.readAt}`
  const notice = s.update ? `  ${noticeText(s.update.latest)}` : ''
  // 時間前固定空 3 格，品牌與額度之間至少留 2 格。
  const limits = limitParts(s, view.now, width - displayWidth(brand) - displayWidth(notice) - displayWidth(time) - 3 - 2)
  const rows: any[] = [
    <Box flexDirection="row">
      <Text bold color={COLOR.text}>{WORD.brand}</Text>
      {s.versions?.desk ? <Text color={COLOR.faint}>{` ${s.versions.desk}`}</Text> : null}
      {s.update ? <Text color={COLOR.attention} bold>{`  ${noticeText(s.update.latest)}`}</Text> : null}
      {s.project ? <Text color={COLOR.dim} wrap="truncate-end">{` · ${s.project}`}</Text> : null}
      <Box flexGrow={1} />
      {line(ui, limits)}
      <Text color={COLOR.faint}>{`   ${time}`}</Text>
    </Box>,
  ]
  for (const r of dueReminders(s.reminders)) {
    const when = `  ${reminderWhen(r)}`
    const text = r.text.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
    rows.push(
      <Box flexDirection="row">
        <Text color={r.days < 0 ? COLOR.bad : COLOR.attention} bold>{`◷ ${r.date.slice(5)} `}</Text>
        <Box flexGrow={1} flexShrink={1} overflow="hidden"><Text color={COLOR.text} wrap="truncate-end">{fit(text, Math.max(4, width - 9 - displayWidth(when)))}</Text></Box>
        <Text color={COLOR.faint}>{when}</Text>
      </Box>,
    )
  }
  const k = s.containers
  if (k && (k.error || k.down.length || k.unhealthy.length)) {
    rows.push(k.error ? <Text color={COLOR.attention} wrap="truncate-end">{`容器  ${k.error}`}</Text>
      : k.down.length ? <Text wrap="truncate-end"><Text color={COLOR.bad} bold>{`✕ ${k.down.join('、')} 未啟動`}</Text><Text color={COLOR.faint}>{`   ${k.running}/${k.total} 執行中`}</Text></Text>
      : <Text wrap="truncate-end"><Text color={COLOR.attention}>{`◆ ${k.unhealthy.join('、')} 狀態異常`}</Text><Text color={COLOR.faint}>{`   ${k.total} 個執行中`}</Text></Text>)
  }
  // 新專案還沒有登錄表是正常的起點，不是錯誤：用一般字色，下方動作列有建立按鈕。
  if (s.error) rows.push(...wrapText(s.error, width).map(l => <Text color={s.missingRegistry ? COLOR.text : COLOR.bad} wrap="truncate-end">{l}</Text>))
  rows.push(<Text color={COLOR.faint}>{'─'.repeat(Math.max(2, width))}</Text>)
  return rows
}

/** 選取標記「▸ 」佔的格數：從那一列的任務名扣，六段照樣對齊。 */
const MARK_WIDTH = 2

/** 清單的時間欄：Agent 在跑的寫「▶ 已跑多久」，其他寫多久前更新。 */
function ageText(c: Case, now: number): string {
  return c.state === 'running' && c.agent?.startedAt ? `▶ ${elapsedText(now - c.agent.startedAt)}` : ago(c.updatedAt, now)
}

/**
 * 進度表（其他任務）：標題列放六段的字，每列「數字 圖示 任務名 六段 時間」對齊。
 * 清單列出全部任務（含現在卡那件），數字鍵依完整清單編號，選取前後不變；你選的那件以「▸」開頭並反白。
 */
function gridRows(ui: any, view: PaneView, cases: Case[], width: number, act: PaneActions, focus: Case | null): any[] {
  const { Box, Text, Button } = ui
  if (!cases.length) return [section(ui, WORD.others, width)]
  const narrow = width < NARROW
  const ages = cases.map(c => ageText(c, view.now))
  const isPickedRow = (c: Case) => !c.demo && view.selected === c.statusPath
  // 名稱欄寬把「▸ 」算進去，選中那件的名字不會被標記擠掉。
  const g = gridLayout(cases.map(c => (isPickedRow(c) ? `▸ ${c.name}` : c.name)), ages, width)
  const heads = (cases.find(c => c.pipeline)?.pipeline?.stages ?? STAGES).map(st => st.label)
  const rows: any[] = []
  // 教學模式的背景是示範任務：標題寫明只能看。
  const title = cases.some(c => c.demo) ? `${WORD.others}（示範，只能看）` : WORD.others
  if (narrow) rows.push(section(ui, title, width))
  else {
    const letters = heads.map(h => pad(h, STAGE_COL)).join('').trimEnd()
    if (g.lead >= displayWidth(title) + 1) rows.push(<Box flexDirection="row"><Text color={COLOR.dim} bold>{pad(title, g.lead)}</Text><Text color={COLOR.faint}>{letters}</Text></Box>)
    else { rows.push(section(ui, title, width)); rows.push(<Text color={COLOR.faint}>{' '.repeat(g.lead) + letters}</Text>) }
  }
  // 數字鍵只給真的任務；示範任務（教學背景）只是畫面，不能選。
  const real = cases.filter(c => !c.demo)
  cases.forEach((c, i) => {
    const meta = STATE[c.state]
    const n = real.indexOf(c)
    const hot = n >= 0 && n < 9 ? String(n + 1) : undefined
    const glyph = c.state === 'running' ? SPINNER[view.tick % SPINNER.length] : meta.glyph
    const strip = stageStrip(c)
    const isPicked = isPickedRow(c)
    const mark = isPicked ? MARK_WIDTH : 0
    const nameRoom = (narrow ? Math.max(4, width - 3 - 2 - 2 - 6) : g.nameWidth) - mark
    const name = narrow ? fit(c.name, Math.max(2, nameRoom)) : pad(fit(c.name, Math.max(2, nameRoom)), Math.max(2, nameRoom))
    const cells = strip.length
      ? strip.map((p, j) => <Text key={`s${j}`} color={c.state === 'done' ? COLOR.good : STAGE_COLOR[p.status as keyof typeof STAGE_COLOR]}>{narrow ? p.text : (j === strip.length - 1 ? ` ${p.text}` : pad(` ${p.text}`, STAGE_COL))}</Text>)
      : [<Text key="label" color={meta.color}>{narrow ? meta.label : pad(meta.label, STAGES.length * STAGE_COL - 2)}</Text>]
    const age = !narrow && g.ageWidth ? ages[i]! : ''
    const used = 3 + 2 + mark + (narrow ? displayWidth(name) : Math.max(2, nameRoom)) + 2 + (strip.length ? (narrow ? strip.length : (STAGES.length - 1) * STAGE_COL + 2) : displayWidth(narrow ? meta.label : pad(meta.label, STAGES.length * STAGE_COL - 2)))
    const isRunningAge = c.state === 'running' && !!c.agent?.startedAt
    const parts = [
      ...(isPicked ? [<Text key="mark" color={COLOR.text} bold>{'▸ '}</Text>] : []),
      <Text key="g" color={meta.color}>{glyph}</Text>, ' ', <Text key="n" color={COLOR.text} bold={isPicked || c.state === 'ask' || c.state === 'reply' || c.state === 'approve'}>{name}</Text>,
      <Text key="gap">{'  '}</Text>,
      ...cells,
      age ? <Text key="age" color={isRunningAge ? COLOR.running : COLOR.faint}>{' '.repeat(Math.max(1, width - used - displayWidth(age))) + age}</Text> : null,
    ]
    // 你選的那件整列反白：還是一顆按鈕（再按不會換人）。
    const line = isPicked ? [<Text key="picked" inverse>{parts}</Text>] : parts
    rows.push(c.demo
      // 示範任務：同樣的排版，前面空出數字鍵的位置，沒有按鈕。
      ? <Box key={`demo-${c.statusPath}`} flexDirection="row"><Text>{'   '}</Text>{line}</Box>
      : <Button plain key={`row-${c.statusPath}`} hotkey={hot} dimColor={c.state === 'idle' || c.state === 'nocard'} onPress={() => act.select(c.statusPath)}>{line}</Button>,
    )
    // 現在卡那件的那句話已經在現在卡上，清單只留一列。
    const note = c === focus ? '' : summary(c)
    if (!narrow && note && (c.state === 'ask' || c.state === 'reply' || c.state === 'approve' || c.state === 'gate' || c.state === 'failed')) rows.push(<Box paddingLeft={5}><Text color={COLOR.dim} wrap="truncate-end">{fit(note, width - 5)}</Text></Box>)
  })
  return rows
}

function feedRows(ui: any, view: PaneView, focus: Case | null, width: number): any[] {
  const { Text } = ui
  const list = feedOf(view.feed, focus).slice(0, FEED_ROWS)
  if (!list.length) return []
  return [
    <Text> </Text>,
    section(ui, WORD.feed, width),
    ...list.map(e => <Text wrap="truncate-end"><Text color={COLOR.faint}>{hhmm(e.at)}  </Text><Text color={e.tone === 'subtle' ? COLOR.dim : e.tone}>{fit(e.text, width - 7)}</Text></Text>),
  ]
}

const HELP: [string, string][] = [
  ['1–9', '選任務（數字依清單固定，選了不會換號；取消選取在「更多動作」裡）'], ['a b c d', '回答決策'], ['f', '填入決策'],
  ['g / w / s', '繼續／審查／同步（按兩次確認；同步平常收在 m，卡片落後分支時才出現）'], ['y', '回覆 Agent'], ['k', '停止 Agent（按兩次確認）'], ['l', 'Agent 輸出'],
  ['v', '完成檢查'], ['u', '上線確認（清 release 關卡，按兩次）'], ['m', '更多動作：平常只列現在這一段能做的，按 m 展開全部'], ['o / e / p', '開卡片／審查檔／PR'], ['r', '重新整理（在「更多動作」裡；平常每 30 秒、每回合結束、對話改了卡片時自動重讀）'], ['⇡ 更新', '「⇡ 更新到 <版本>」「⇡ 檢查並更新」把 desk 更新到 GitHub 上的最新版本（用點的，不綁快捷鍵）；已是最新只顯示文字，要重查用 /desk update'], ['x', '展開全文'], ['h', '隱藏摘要列（說明開著時）'],
  ['t', '確認規格（按兩次）；教學模式的下一步（確認規格／合併／打 tag）'], ['↑ ↓ 滾輪', '捲動中間的內容；上下兩區固定'], ['Esc', '收起面板'], ['ctrl+x tab', '回輸入框'],
  ['● ◉ ◆ ✕ ○ ·', '已過／進行中／等你／卡住／未到／不適用'], ['✓（綠）', '六段全過、已上線，可歸檔'],
]

function helpRows(ui: any, view: PaneView, act: PaneActions, width: number): any[] {
  const { Box, Text, Button } = ui
  if (!view.isHelp) return []
  return [
    <Text> </Text>,
    section(ui, '說明', width),
    ...HELP.map(([k, d]) => <Box flexDirection="row"><Text color={COLOR.attention}>{pad(k, 12)}</Text><Text color={COLOR.dim} wrap="truncate-end">{fit(d, width - 12)}</Text></Box>),
    <Box flexDirection="row"><Button key="band" plain dimColor hotkey="h" label="— 隱藏摘要列" onPress={act.toggleBand} /></Box>,
  ]
}

/** content：現在卡、其他任務進度表、最近、說明。寬時現在卡與進度表左右並排，逐列併起來。 */
function contentRows(ui: any, view: PaneView, width: number, act: PaneActions): any[] {
  const { Box, Text } = ui
  const s = view.s
  if (!s.cases.length) return wrapText(s.error ? '' : WORD.empty, width).map(l => <Text color={COLOR.dim} wrap="truncate-end">{l}</Text>)
  const focus = focusOf(view)
  const list = sorted(s.cases)
  const wide = view.columns >= WIDE
  // 區段標題說出現在卡是誰挑的。
  const nowLabel = view.selected && focus?.statusPath === view.selected ? WORD.nowPicked : WORD.nowAuto
  const tail = [...feedRows(ui, view, focus, width), ...helpRows(ui, view, act, width)]
  if (!wide) {
    return [
      label(ui, nowLabel),
      ...(focus ? nowCardRows(ui, view, focus, width, act) : []),
      <Text> </Text>,
      ...gridRows(ui, view, list, width, act, focus),
      ...tail,
    ]
  }
  const listWidth = Math.min(64, Math.floor(width * 0.5))
  const nowWidth = width - listWidth - GUTTER
  const left = [label(ui, nowLabel), ...(focus ? nowCardRows(ui, view, focus, nowWidth, act) : [])]
  const right = gridRows(ui, view, list, listWidth, act, focus)
  const zipped = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => (
    <Box flexDirection="row">
      <Box width={nowWidth} flexShrink={0} overflow="hidden">{left[i] ?? <Text> </Text>}</Box>
      <Box width={GUTTER} flexShrink={0} />
      <Box width={listWidth} flexShrink={0} overflow="hidden">{right[i] ?? <Text> </Text>}</Box>
    </Box>
  ))
  return [...zipped, ...tail]
}

/** footer 的狀態列：容器、模型、派工、版本，一列淡色字；上下文用量高時放最前面。各組用「 · 」隔開。 */
function statusParts(view: PaneView): Part[] {
  const s = view.s
  const groups: Part[][] = []
  const ctx = s.contextPercent
  if (typeof ctx === 'number' && ctx >= 50) groups.push([{ text: `上下文已用 ${ctx}%`, color: ctx >= 70 ? COLOR.bad : COLOR.attention }])
  const k = s.containers
  if (k && !k.error && k.total > 0 && !k.down.length && !k.unhealthy.length) groups.push([{ text: '●', color: COLOR.good }, { text: ` 容器 ${k.running}/${k.total} 執行中`, color: COLOR.dim }])
  const m = s.models
  if (m?.session) groups.push([{ text: '本對話 ', color: COLOR.faint }, { text: modelLabel(m.session), color: COLOR.dim, bold: true }, ...(m.effort ? [{ text: ` ${m.effort}`, color: COLOR.faint }] : [])])
  if (m?.dispatch?.model) groups.push([{ text: `派工 ${m.dispatch.model}${m.dispatch.effort ? ` ${m.dispatch.effort}` : ''}`, color: COLOR.faint }])
  for (const k of m?.kinds ?? []) groups.push([{ text: `${KIND_LABEL[k.kind]} ${[k.model, k.effort].filter(Boolean).join(' ')}`, color: COLOR.faint }])
  if (m?.sync?.model) groups.push([{ text: `同步 ${m.sync.model}${m.sync.effort ? ` ${m.sync.effort}` : ''}${m.sync.fresh ? '・新對話' : ''}`, color: COLOR.faint }])
  const v = s.versions
  if (v?.live) groups.push([{ text: `線上 ${v.live}`, color: COLOR.dim }])
  if (v?.dev) groups.push([{ text: `開發中 ${v.dev}`, color: COLOR.running }])
  return groups.flatMap((g, i) => (i ? [{ text: ' · ', color: COLOR.faint }, ...g] : g))
}

/**
 * footer 的版本格，跟著狀態列走、不多佔一列：有新版「⇡ 更新到 x」、沒查過「⇡ 檢查並更新」（都只用點的，不綁快捷鍵，免得誤按就更新）；
 * 已是最新只是淡字（要重查用 /desk update），更新中也只是字。
 */
function updateSlot(s: Snapshot, act: PaneActions): Action {
  const state = s.versionState ?? (s.update ? 'newer' : 'unknown')
  if (state === 'updating') return button({ key: 'update-status', label: `◐ ${WORD.updating}`, color: COLOR.running })
  if (state === 'latest') return button({ key: 'update-status', label: `✓ ${WORD.upToDate}`, color: COLOR.faint })
  if (state === 'newer' && s.update) return button({ key: 'update', label: `⇡ ${WORD.updateTo} ${s.update.latest}`, onPress: act.update })
  return button({ key: 'update', label: `⇡ ${WORD.checkUpdate}`, isDim: true, onPress: act.update })
}

function actionNode(ui: any, a: Action) {
  const { Button, Text } = ui
  if (!a.onPress) return <Text key={a.key} color={a.color ?? COLOR.dim}>{a.label}</Text>
  if (a.isBoxed) return <Button key={a.key} hotkey={a.hotkey} variant="primary" label={a.label} onPress={a.onPress} />
  if (a.isLead) return <Button key={a.key} plain hotkey={a.hotkey} onPress={a.onPress}><Text bold color={COLOR.text}>{a.label}</Text></Button>
  return <Button key={a.key} plain dimColor={a.isDim} hotkey={a.hotkey} label={a.label} onPress={a.onPress} />
}

/** footer：細線（右端寫捲動位置）→ 現在這件的操作 → 狀態列（左）＋全域鍵（右）；放不下時全域鍵自己一列。 */
function footerRows(ui: any, view: PaneView, act: PaneActions, width: number, focus: Case | null, hint: string): any[] {
  const { Box, Text } = ui
  // 重新整理平常自動做（定時、回合結束、對話改了卡片），按鈕收進「更多動作」，把位置留給這一段的鍵。
  const globals: Action[] = [
    ...(view.showAll ? [{ key: 'refresh', hotkey: 'r', label: `↻ ${WORD.refresh}`, isDim: true, onPress: act.refresh, width: 0 }] : []),
    // 取消選取不綁快捷鍵：只在「更多動作」展開、而且你選了任務時出現。
    ...(view.showAll && view.selected ? [{ key: 'deselect', label: '✕ 取消選取', isDim: true, onPress: act.deselect, width: 0 }] : []),
    { key: 'expand', hotkey: 'x', label: view.isExpanded ? '▴ 收合' : '▾ 展開', isDim: true, onPress: act.expand, width: 0 },
    { key: 'more', hotkey: 'm', label: view.showAll ? '▴ 精簡動作' : '⋯ 更多動作', isDim: true, onPress: act.more, width: 0 },
    { key: 'help', hotkey: 'i', label: view.isHelp ? '▴ 收起說明' : '? 說明', isDim: true, onPress: act.help, width: 0 },
  ].map(a => ({ ...a, width: displayWidth(a.label) + 3 }))
  const upd = updateSlot(view.s, act)
  // 還沒有任務、也還沒有登錄表：動作列只有建立空登錄表這一個主要動作。
  const create = view.s.missingRegistry ? [button({ key: 'create-registry', hotkey: 'n', isBoxed: true, label: `＋ ${WORD.createRegistry}`, onPress: act.createRegistry })] : []
  const mine = focus && view.s.cases.length ? caseActions(view, focus, act) : create
  const rule = hint ? `${'─'.repeat(Math.max(2, width - displayWidth(hint) - 1))} ${hint}` : '─'.repeat(Math.max(2, width))
  const status = statusParts(view)
  const globalsWidth = globals.reduce((n, a) => n + a.width, 0) + 2 * (globals.length - 1)
  const statusWidth = partsWidth(status) + (status.length ? 2 : 0) + upd.width
  const together = statusWidth + 3 + globalsWidth <= width
  const actionsRow = (list: Action[]) => <Box flexDirection="row" gap={2}>{list.map(a => actionNode(ui, a))}</Box>
  const statusRow = <Box flexDirection="row" gap={2}>{status.length ? line(ui, status) : null}{actionNode(ui, upd)}</Box>
  return [
    <Text color={COLOR.faint}>{rule}</Text>,
    ...flowRows(mine.map(a => a.width), width, 2).map(idx => actionsRow(idx.map(i => mine[i]!))),
    ...(together
      ? [<Box flexDirection="row">{statusRow}<Box flexGrow={1} />{actionsRow(globals)}</Box>]
      : [...flowRows(globals.map(a => a.width), width, 2).map(idx => actionsRow(idx.map(i => globals[i]!))), ...(statusWidth <= width ? [statusRow] : [line(ui, status), actionsRow([upd])])]),
  ]
}

export function renderPane(ui: any, view: PaneView, act: PaneActions) {
  const { Box } = ui
  const width = view.columns - 2
  const focus = view.s.cases.length ? focusOf(view) : null
  const header = headerRows(ui, view, width)
  const content = contentRows(ui, view, width, act)
  // footer 的列數不受捲動位置影響，先用空的提示算一次，再帶入真正的捲動位置。
  const chrome = header.length + footerRows(ui, view, act, width, focus, '').length
  const w = contentWindow(content.length, view.bodyRows, chrome, view.offset)
  act.window?.(w)
  const footer = footerRows(ui, view, act, width, focus, scrollHint(w, content.length))
  const shown = content.slice(w.start, w.start + w.size)
  const row = (node: any, key: string) => <Box key={key} height={1} flexDirection="row" overflow="hidden">{node}</Box>
  const isDock = view.placement === 'dock' && !!view.bodyRows
  return (
    <Box flexDirection="column" paddingX={1} height={isDock ? view.bodyRows : undefined}>
      {header.map((n, i) => row(n, `h${i}`))}
      <Box flexDirection="column" flexGrow={isDock ? 1 : 0}>{shown.map((n, i) => row(n, `c${w.start + i}`))}</Box>
      {footer.map((n, i) => row(n, `f${i}`))}
    </Box>
  )
}
