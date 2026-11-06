// 面板分三區：header（desk 版本、額度、更新時間；到期提醒與容器異常）與 footer（現在這件的操作、全域鍵、容器與模型）常駐，
// 只有 content（現在卡、全部任務進度表、歷程、說明）捲動。content 一列一個元素，desk 自己決定顯示哪幾列（ui.scroll）。
// 階層靠字重與明暗；顏色只給需要你、執行中、通過、未通過，以及偏低的額度。
import type { Case, FeedEvent, Picks, Snapshot, Verify, SentRecord, HistoryEntry } from '../types'
import { LIMIT_NAME, displayWidth, elapsedText, fit, focusCase, hhmm, isRunLong, issueOf, modelLabel, pad, resetText, runMinutesText, sorted, stateCounts, summary, totalRunMs, waitingBesides, ago } from './model'
export { resetText } from './model'
import { COLOR, SPINNER, STATE, WORD } from './theme'
import { STAGES, STAGE_GLYPH } from './pipeline'
import { paneReminders, reminderWhen } from './extras'
import type { Reminder } from './extras'
import { STAGE_COLOR } from './band'
import { contentWindow, flowRows, scrollHint, wrapText } from './layout'
import type { ContentWindow } from './layout'
import { button, caseActions, nowCardRows, picksKey, shortCommand } from './pane-card'
import { noticeText } from './update'
import type { Action } from './pane-card'
import { KIND_LABEL } from './dispatch'
import type { DispatchKind, UntrustedHold } from './dispatch'

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
  /** 上次派工因為 repo 還沒信任而開不了的那幾件（卡片路徑 → 擋下原因）；舊的呼叫端沒給就當沒有。 */
  untrusted?: Record<string, UntrustedHold>
  queue: string[]
  /** 派工隊伍（同時執行的 Agent 達上限時排的），卡片路徑依序；舊的呼叫端沒給就當空的。 */
  agentQueue?: string[]
  armed: { key: string; at: number } | null
  /** 這個對話核准過的完成檢查（卡片路徑 → 指令全文）；沒給就當都核准過，檢查列不多列全文。 */
  trusted?: Record<string, string>
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
  /** 回到工作桌自己挑的那件（現在卡上方的區段標題列與「更多動作」裡，有選取時才出現）。 */
  deselect: () => void
  pick: (c: Case, index: number, key: string) => void
  fill: (c: Case) => void
  verify: (c: Case) => void
  open: (c: Case) => void
  dispatch: (c: Case, kind: DispatchKind) => void
  stop: (c: Case) => void
  /** 取消派工排隊（按一次，還沒派出去不用確認）。 */
  unqueue: (c: Case) => void
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
  /** 上線段還沒打 tag：按兩次 z，第二次把帶確認段的發版請求（列出所有待發版的卡、已確認照慣例版號）填進輸入框，Enter 送出；面板不打 tag。 */
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
const GUTTER = 3
/** 進度表每段一欄：段名兩個字（4 格）＋1 格間隔；圖示放在段名下方中間（第 2 格）。 */
const STAGE_COL = 5
const NAME_MIN = 12
/** 一串版（六段縮成連續圖示）每列除了任務名以外佔的格數：數字鍵、狀態圖示、間隔、六個圖示。 */
const STRIP_FIXED = 3 + 2 + 2 + STAGES.length

/** 現在卡上的那一件：選取的優先，否則工作桌自己挑。 */
export function focusOf(view: Pick<PaneView, 's' | 'selected'>): Case | null {
  const picked = view.selected ? view.s.cases.find(c => c.statusPath === view.selected) ?? null : null
  // 教學只有一件：做完了也留在現在卡，讓「教學完成」那句看得到。
  return picked ?? focusCase(view.s.cases) ?? (view.s.tutorial ? view.s.cases[0] ?? null : null)
}

/** 「更多動作」展開時記下的那件：現在卡的路徑，沒有現在卡是空字串。畫面與換件收回共用這條規則。 */
export function moreKeyOf(s: PaneView['s'] | null, selected: PaneView['selected']): string {
  return (s ? focusOf({ s, selected })?.statusPath : undefined) ?? ''
}

/** 清單上的六段：每段一個圖示，不適用的段落用「·」佔位，讓各列對齊。 */
export function stageStrip(c: Case): { text: string; status: string }[] {
  if (!c.pipeline) return []
  return c.pipeline.stages.map(s => ({ text: STAGE_GLYPH[s.status], status: s.status }))
}

/**
 * 進度表的欄寬：數字鍵「1: 」＋狀態圖示＋任務名（各列同寬）＋六段（每段 3 格）＋時間靠右。
 * compact：任務名在欄位版會被截、六段縮成一串就放得下，改走一串版（不列段名），名字完整。
 */
export function gridLayout(names: string[], ages: string[], width: number): { nameWidth: number; ageWidth: number; lead: number; compact: boolean } {
  const ageWidth = Math.max(0, ...ages.map(displayWidth))
  const fixed = 3 + 2 + 2 + STAGES.length * STAGE_COL
  const longest = Math.max(4, ...names.map(displayWidth))
  // 任務名至少留 NAME_MIN 格（或全名）才放時間；不夠就先拿掉時間。
  const keepAge = ageWidth > 0 && width - fixed - ageWidth - 1 >= Math.min(NAME_MIN, longest)
  const room = width - fixed - (keepAge ? ageWidth + 1 : 0)
  const nameWidth = Math.max(4, Math.min(longest, room))
  const compact = longest > nameWidth && longest <= width - STRIP_FIXED
  return { nameWidth, ageWidth: keepAge ? ageWidth : 0, lead: 3 + 2 + nameWidth + 2, compact }
}

/** 剩餘量的顏色：40% 以下提醒、20% 以下警示。 */
export const remainColor = (left: number) => left <= 20 ? COLOR.bad : left <= 40 ? COLOR.attention : COLOR.good

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

/** 區名＋細線到行尾。右邊的字是 Part[] 時，細線剩不到 2 格就整段拿掉，不截字。 */
function section(ui: any, label: string, width: number, right: string | Part[] = '') {
  const { Box, Text } = ui
  const parts: Part[] = typeof right === 'string' ? (right ? [{ text: right, color: COLOR.faint }] : []) : right
  const rightWidth = partsWidth(parts)
  const fits = typeof right === 'string' || width - displayWidth(label) - 2 - rightWidth >= 2
  const shown = parts.length && fits ? parts : []
  const used = displayWidth(label) + 1 + (shown.length ? rightWidth + 1 : 0)
  return (
    <Box flexDirection="row">
      <Text color={COLOR.dim} bold>{label}</Text>
      <Text color={COLOR.faint}>{' ' + '─'.repeat(Math.max(2, width - used))}</Text>
      {shown.length ? <Text color={COLOR.faint}>{' '}</Text> : null}
      {shown.map((p, i) => <Text key={`r${i}`} color={p.color} bold={p.bold}>{p.text}</Text>)}
    </Box>
  )
}

/** 全部任務標題列的狀態計數：「● 2 ◆ 1 ▶ 1 ○ 3」，各段用該狀態的顏色。 */
function tallyParts(cases: readonly Case[]): Part[] {
  return stateCounts(cases).flatMap((t, i) => [
    ...(i ? [{ text: ' ', color: COLOR.faint }] : []),
    { text: `${STATE[t.state].glyph} ${t.count}`, color: STATE[t.state].color },
  ])
}

/** 只有區名：緊接在細線下的那一區不再畫第二條線。 */
function label(ui: any, text: string) {
  const { Text } = ui
  return <Text color={COLOR.dim} bold>{text}</Text>
}

/**
 * header 的提醒：平常收成一列（1 件寫事項，多件寫「提醒 n 件 · 第一條」，後面接第一條的距今天數）；
 * 展開更多動作（m）時改列全部提醒的全文，太長就換行。過期用提醒色，不用失敗的紅色。
 */
function reminderRows(ui: any, view: PaneView, width: number): any[] {
  const { Box, Text } = ui
  const list = paneReminders(view.s.reminders)
  if (!list.length) return []
  if (view.showAll) return reminderList(ui, list, width)
  const first = list[0]!
  const count = list.length > 1 ? `提醒 ${list.length} 件 · ` : ''
  const when = reminderWhen(first) ? `  ${reminderWhen(first)}` : ''
  const text = first.text.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
  return [
    <Box flexDirection="row">
      <Text color={COLOR.attention} bold>{`◷ ${count}`}</Text>
      <Box flexGrow={1} flexShrink={1} overflow="hidden"><Text color={COLOR.text} wrap="truncate-end">{fit(text, Math.max(4, width - 2 - displayWidth(count) - displayWidth(when)))}</Text></Box>
      {when ? <Text color={isOverdue(first) ? COLOR.attention : COLOR.faint}>{when}</Text> : null}
    </Box>,
  ]
}

const isOverdue = (r: Reminder) => r.days !== null && r.days < 0

/** 展開時提醒本身最多佔幾列（另加一列「還有 k 件」）：沒日期的提醒不會到期消失，不設上限會把內容區與動作列擠掉。 */
export const MAX_REMINDER_ROWS = 4

/** 展開時的提醒：依序放到 MAX_REMINDER_ROWS 列為止（放不下整條就停），其餘收成「還有 k 件」一列。 */
function reminderList(ui: any, list: Reminder[], width: number): any[] {
  const { Box, Text } = ui
  const rows: any[] = []
  let shown = 0
  for (const r of list) {
    const lines = reminderFull(ui, r, width)
    const room = MAX_REMINDER_ROWS - rows.length
    if (lines.length > room) {
      // 第一條就超過上限：截到放得下，避免整段空白。
      if (!rows.length) { rows.push(...lines.slice(0, Math.max(1, room))); shown = 1 }
      break
    }
    rows.push(...lines)
    shown++
  }
  const rest = list.length - shown
  if (rest > 0) rows.push(
    <Box flexDirection="row">
      <Text color={COLOR.attention} bold>{'◷ '}</Text>
      <Text color={COLOR.dim}>{`還有 ${rest} 件：看登錄表「## 提醒」`}</Text>
    </Box>,
  )
  return rows
}

/** 展開時的一條提醒：「◷ MM-DD 事項  還有 n 天」，沒日期的不寫日期與天數；換行的接續列縮排對齊。 */
function reminderFull(ui: any, r: Reminder, width: number): any[] {
  const { Box, Text } = ui
  const when = reminderWhen(r)
  const body = `${r.date ? `${r.date.slice(5)} ` : ''}${r.text}${when ? `  ${when}` : ''}`
  return wrapText(body, width - 2).map((l, i) => (
    <Box flexDirection="row">
      <Text color={COLOR.attention} bold>{i ? '  ' : '◷ '}</Text>
      <Text color={COLOR.text}>{l}</Text>
    </Box>
  ))
}

/** header：desk 版本＋額度＋更新時間；有提醒時加一列（m 展開時列全部）、容器異常時加一列；最後一條細線。 */
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
  rows.push(...reminderRows(ui, view, width))
  const k = s.containers
  if (k && (k.error || k.down.length || k.unhealthy.length)) {
    rows.push(k.error ? <Text color={COLOR.attention} wrap="truncate-end">{`容器  ${k.error}`}</Text>
      : k.down.length ? <Text wrap="truncate-end"><Text color={COLOR.bad} bold>{`✕ ${k.down.join('、')} 未啟動`}</Text><Text color={COLOR.faint}>{`   ${k.running}/${k.total} 執行中`}</Text></Text>
      : <Text wrap="truncate-end"><Text color={COLOR.attention}>{`◆ ${k.unhealthy.join('、')} 狀態異常`}</Text><Text color={COLOR.faint}>{`   ${k.total} 個執行中`}</Text></Text>)
  }
  // 新專案還沒有登錄表是正常的起點，不是錯誤：用一般字色，下方動作列有建立按鈕。
  if (s.error) rows.push(...wrapText(s.error, width).map(l => <Text color={s.missingRegistry ? COLOR.text : COLOR.bad} wrap="truncate-end">{l}</Text>))
  // 讀不到登錄表是要你排除的錯誤：紅字下說排除後怎麼重讀（還沒有登錄表的起點不算）。
  if (s.error && !s.missingRegistry) rows.push(<Text color={COLOR.faint} wrap="truncate-end">{WORD.retryRegistry}</Text>)
  rows.push(<Text color={COLOR.faint}>{'─'.repeat(Math.max(2, width))}</Text>)
  return rows
}

/** 選取標記「▸ 」佔的格數：從那一列的任務名扣，六段照樣對齊。 */
const MARK_WIDTH = 2

/** 清單的時間欄：總執行超過 15 分寫「⏱ 總執行多久」（警示色），否則 Agent 在跑的寫「▶ 已跑多久」，其他寫多久前更新。 */
function ageText(c: Case, now: number): string {
  if (isRunLong(c, now)) return `⏱ ${runMinutesText(totalRunMs(c, now))}`
  return c.state === 'running' && c.agent?.startedAt ? `▶ ${elapsedText(now - c.agent.startedAt)}` : ago(c.updatedAt, now)
}

/**
 * 進度表（全部任務）：標題列放六段的字，每列「數字 圖示 任務名 六段 時間」對齊。
 * 清單列出全部任務（含現在卡那件），數字鍵依完整清單編號，選取前後不變；你選的那件以「▸」開頭並反白。
 */
function gridRows(ui: any, view: PaneView, cases: Case[], width: number, act: PaneActions, focus: Case | null): any[] {
  const { Box, Text, Button } = ui
  if (!cases.length) return [section(ui, WORD.list, width)]
  const tight = width < NARROW
  const ages = cases.map(c => ageText(c, view.now))
  const isPickedRow = (c: Case) => !c.demo && view.selected === c.statusPath
  // 名稱欄寬把「▸ 」算進去，選中那件的名字不會被標記擠掉。
  const g = gridLayout(cases.map(c => (isPickedRow(c) ? `▸ ${c.name}` : c.name)), ages, width)
  // 太窄，或有任務名在欄位版會被截：六段縮成一串、不列段名。
  const narrow = tight || g.compact
  const tally = tallyParts(cases)
  const heads = (cases.find(c => c.pipeline)?.pipeline?.stages ?? STAGES).map(st => st.label)
  const rows: any[] = []
  // 教學模式的背景是示範任務：標題寫明只能看。
  const title = cases.some(c => c.demo) ? `${WORD.list}（示範任務只能看）` : WORD.list
  if (narrow) rows.push(section(ui, title, width, tally))
  else {
    const letters = heads.map(h => pad(h, STAGE_COL)).join('').trimEnd()
    // 計數靠右，放在段名後面剩下的寬度（任務名越長越少），至少隔 2 格。
    const free = width - g.lead - displayWidth(letters) - partsWidth(tally)
    if (g.lead >= displayWidth(title) + 1 && (!tally.length || free >= 2)) {
      const right = tally.length ? [<Text key="gap">{' '.repeat(free)}</Text>, ...tally.map((p, i) => <Text key={`t${i}`} color={p.color}>{p.text}</Text>)] : []
      rows.push(<Box flexDirection="row"><Text color={COLOR.dim} bold>{pad(title, g.lead)}</Text><Text color={COLOR.faint}>{letters}</Text>{right}</Box>)
    } else {
      // 區名放不進任務名欄，或同一列放不下計數（寬版並排時清單那欄只有 49–64 格）：區名＋計數一列，段名另起一列。
      rows.push(section(ui, title, width, tally))
      rows.push(<Text color={COLOR.faint}>{' '.repeat(g.lead) + letters}</Text>)
    }
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
    const nameRoom = (narrow ? Math.max(4, width - STRIP_FIXED) : g.nameWidth) - mark
    const name = narrow ? fit(c.name, Math.max(2, nameRoom)) : pad(fit(c.name, Math.max(2, nameRoom)), Math.max(2, nameRoom))
    const cells = strip.length
      ? strip.map((p, j) => <Text key={`s${j}`} color={c.state === 'done' ? COLOR.good : STAGE_COLOR[p.status as keyof typeof STAGE_COLOR]}>{narrow ? p.text : (j === strip.length - 1 ? ` ${p.text}` : pad(` ${p.text}`, STAGE_COL))}</Text>)
      : [<Text key="label" color={meta.color}>{narrow ? meta.label : pad(meta.label, STAGES.length * STAGE_COL - 2)}</Text>]
    const used = 3 + 2 + mark + (narrow ? displayWidth(name) : Math.max(2, nameRoom)) + 2 + (strip.length ? (narrow ? strip.length : (STAGES.length - 1) * STAGE_COL + 2) : displayWidth(narrow ? meta.label : pad(meta.label, STAGES.length * STAGE_COL - 2)))
    // 一串版（不是太窄）：這一列還放得下時間才放。
    const age = !narrow && g.ageWidth ? ages[i]! : g.compact && !tight && width - used - 1 >= displayWidth(ages[i]!) ? ages[i]! : ''
    const isRunningAge = c.state === 'running' && !!c.agent?.startedAt
    const isLongAge = isRunLong(c, view.now)
    const parts = [
      ...(isPicked ? [<Text key="mark" color={COLOR.text} bold>{'▸ '}</Text>] : []),
      <Text key="g" color={meta.color}>{glyph}</Text>, ' ', <Text key="n" color={COLOR.text} bold={isPicked || c.state === 'ask' || c.state === 'reply' || c.state === 'approve'}>{name}</Text>,
      <Text key="gap">{'  '}</Text>,
      ...cells,
      age ? <Text key="age" color={isLongAge ? COLOR.attention : isRunningAge ? COLOR.running : COLOR.faint}>{' '.repeat(Math.max(1, width - used - displayWidth(age))) + age}</Text> : null,
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
    if (!tight && note && (c.state === 'ask' || c.state === 'reply' || c.state === 'approve' || c.state === 'gate' || c.state === 'failed')) rows.push(<Box paddingLeft={5}><Text color={COLOR.dim} wrap="truncate-end">{fit(note, width - 5)}</Text></Box>)
  })
  return rows
}

/** 歷程一筆的時間欄「MM-DD HH:MM」（沒時間的留白、沒日期的整欄留白，都對齊）＋兩格。 */
const HISTORY_STAMP = 11
const HISTORY_LEAD = HISTORY_STAMP + 2

/** 歷程時間欄的字：「MM-DD HH:MM」；舊卡只有日期就「MM-DD」；沒日期空白。 */
const historyStamp = (e: HistoryEntry) => e.date ? `${e.date.slice(5)}${e.time ? ` ${e.time}` : ''}` : ''

/**
 * 歷程：問題列（desk 動態最新一筆是錯誤或警告時，「時:分  動態」）＋現在這件卡片 History。
 * 全部列出、新的在前（比畫面高時靠 content 的捲動看）；收合時每筆一行截斷，展開（x）時長的換行顯示全文。
 */
function historyRows(ui: any, view: PaneView, focus: Case | null, width: number): any[] {
  const { Box, Text } = ui
  const issue = issueOf(view.feed, focus)
  const all = focus?.history ?? []
  if (!issue && !all.length) return []
  const room = width - HISTORY_LEAD
  const entry = (e: HistoryEntry) => {
    const lines = view.isExpanded ? wrapText(e.text, room) : [fit(e.text, room)]
    return lines.map((l, i) => (
      <Box flexDirection="row">
        <Text color={COLOR.faint}>{pad(i === 0 ? historyStamp(e) : '', HISTORY_LEAD)}</Text>
        <Text color={COLOR.text} wrap="truncate-end">{l}</Text>
      </Box>
    ))
  }
  return [
    <Text> </Text>,
    section(ui, WORD.history, width),
    ...(issue ? [<Text wrap="truncate-end"><Text color={COLOR.faint}>{hhmm(issue.at)}  </Text><Text color={issue.tone}>{fit(issue.text, width - 7)}</Text></Text>] : []),
    ...all.flatMap(entry),
  ]
}

/**
 * 說明頁（i）的每一條：`<鍵>  <做什麼>（<什麼時候用>）`，一條一句、不用「；」接第二件事，補充只放句尾一個括號。
 * tests/plain-wording.test.ts 逐條檢查寫法與每個鍵都還在。
 */
export const HELP: [string, string][] = [
  ['1–9', '選任務（要操作某一件時，號碼依清單固定不會換，取消選取在「現在 · 你選的」那列或 m 裡）'], ['a b c d', '回答決策（「等你」有選項時）'], ['f', '填入決策（選好選項後，填進輸入框再按 Enter 送出）'],
  ['g / w / s', '繼續／驗收／同步（按兩次確認，同步平常收在 m、卡片落後分支時才出現）'], ['y', '回覆 Agent（Agent 停下來問你時）'], ['k', '停止 Agent（按兩次確認，派工排隊中按一次是取消排隊）'], ['l', '看 Agent 輸出（想知道 Agent 做到哪時）'],
  ['v', '執行測試（測試指令還沒核准或改過時按兩次，第一次列出全文）'], ['u', '確認上線（部署完、關卡是 release 時按兩次，清掉關卡）'], ['n', '⇡ 開 PR／⇡ push 派 Agent 推送（要開 PR 或 PR 有新 commit 時，按兩次確認）'], ['z', '⚑ 發版（合併後按兩次，把已確認照慣例版號的發版請求填進輸入框）'], ['q', '⌫ 歸檔（做完要收掉時，按兩次確認）'], ['m', '更多動作（要找這一段沒列出的動作時，按 m 展開全部）'], ['o / e / p', '開卡片／審查檔／PR（要看細節時）'], ['r', '重新整理（要馬上重讀時從 m 裡按，平常每 30 秒、每回合結束、對話改了卡片時自動重讀）'], ['⇡ 更新', '把 desk 更新到 GitHub 上的最新版本（看到「⇡ 更新到 <版本>」「⇡ 檢查並更新」時用點的，已是最新要重查輸入 /desk update）'], ['x', '展開全文（歷程要看每筆全文時）'], ['i', '說明（就是這份，再按 i 收起）'], ['h', '隱藏摘要列（說明開著時才能按，也可輸入 /desk bar）'],
  ['t', '確認規格（規格看過、要派實作時按兩次，教學模式裡是確認規格／合併／打 tag 的下一步）'], ['↑ ↓ 滾輪', '捲動中間的內容（上下兩區固定不動）'], ['Esc', '回輸入框（面板留著）'], ['/desk close', '收起面板（不用時，也可點摘要列的 ⌗ desk）'],
  ['● ◉ ◆ ✕ ○ ·', '已過／處理中／等你／卡住／未到／不適用（看六段走到哪時）'], ['✓（綠）', '六段全過、已上線（可以歸檔了）'],
]

/** 說明頁鍵名欄的寬度：描述放不下時換到下一列，續列對齊描述欄。 */
const HELP_KEY_WIDTH = 12
/** 還沒有登錄表時才列的那條：n 建立空的登錄表（有登錄表時 n 是推送）。 */
export const HELP_CREATE: [string, string] = ['n', `＋ ${WORD.createRegistry}（還沒有登錄表時）`]

/** 說明的每一條：還沒有登錄表時，推送那條 n 之後多列建立登錄表的 n。 */
function helpEntries(view: PaneView): [string, string][] {
  if (!view.s.missingRegistry) return HELP
  const at = HELP.findIndex(([k]) => k === 'n') + 1
  return [...HELP.slice(0, at), HELP_CREATE, ...HELP.slice(at)]
}

/** 一條說明：描述懸掛換行、不截字，一列一個元素（content 要算得出列數）。 */
function helpEntryRows(ui: any, [k, d]: [string, string], width: number): any[] {
  const { Box, Text } = ui
  return wrapText(d, width - HELP_KEY_WIDTH).map((l, i) => i === 0
    ? <Box flexDirection="row"><Text color={COLOR.attention}>{pad(k, HELP_KEY_WIDTH)}</Text><Text color={COLOR.dim}>{l}</Text></Box>
    : <Box flexDirection="row" paddingLeft={HELP_KEY_WIDTH}><Text color={COLOR.dim}>{l}</Text></Box>)
}

function helpRows(ui: any, view: PaneView, act: PaneActions, width: number): any[] {
  const { Box, Text, Button } = ui
  if (!view.isHelp) return []
  return [
    <Text> </Text>,
    section(ui, '說明', width),
    ...helpEntries(view).flatMap(entry => helpEntryRows(ui, entry, width)),
    <Box flexDirection="row"><Button key="band" plain dimColor hotkey="h" label="— 隱藏摘要列" onPress={act.toggleBand} /></Box>,
  ]
}

/** 「✕ 取消選取」按鈕佔的寬度（含左邊間隔）。 */
const DESELECT_WIDTH = displayWidth(WORD.deselect) + 2

/**
 * 現在卡上方的區段標題：說出現在卡是誰挑的。自動挑選時後接「另有 n 件等你」（現在卡以外需要人的件數）；
 * 你選的時後接「<任務名> · 之後每則對話都附上它的卡」與「✕ 取消選取」（只用點的）。
 * 放不下時由寬到窄退讓、不截字：省掉提示字只留任務名與按鈕 → 只留按鈕（寬版並排時現在卡那欄只有 46–61 格）→ 連按鈕都放不下才只剩區名。
 */
function nowTitle(ui: any, view: PaneView, focus: Case | null, width: number, act: PaneActions) {
  const { Box, Text, Button } = ui
  const isPicked = !!view.selected && focus?.statusPath === view.selected
  const head = isPicked ? WORD.nowPicked : WORD.nowAuto
  const room = width - displayWidth(head) - 2
  if (isPicked && focus) {
    const full = `${focus.name} · ${WORD.pickedNote}`
    // 區名之後：「  <字>」＋「  ✕ 取消選取」要放得進剩下的寬度（room 已扣掉區名後的 2 格）。
    const fits = (n: string) => (n ? 2 + displayWidth(n) : 0) + DESELECT_WIDTH <= room + 2
    const note = fits(full) ? full : fits(focus.name) ? focus.name : ''
    if (!fits(note)) return label(ui, head)
    return (
      <Box flexDirection="row">
        <Text color={COLOR.dim} bold>{head}</Text>
        {note ? <Text color={COLOR.text}>{`  ${note}`}</Text> : null}
        <Text>{'  '}</Text>
        <Button key="deselect-title" plain dimColor label={WORD.deselect} onPress={act.deselect} />
      </Box>
    )
  }
  const n = waitingBesides(view.s.cases, focus)
  const more = n ? WORD.othersWaiting(n) : ''
  if (!more || displayWidth(more) > room) return label(ui, head)
  return (
    <Box flexDirection="row">
      <Text color={COLOR.dim} bold>{head}</Text>
      <Text>{'  '}</Text>
      <Text color={COLOR.attention}>{more}</Text>
    </Box>
  )
}

/** content：現在卡、全部任務進度表、歷程、說明。寬時現在卡與進度表左右並排，逐列併起來。 */
function contentRows(ui: any, view: PaneView, width: number, act: PaneActions): any[] {
  const { Box, Text } = ui
  const s = view.s
  // 沒有任務（含還沒有登錄表）時說明頁也要看得到。
  if (!s.cases.length) return [...(s.error ? [] : wrapText(WORD.empty, width).map(l => <Text color={COLOR.dim} wrap="truncate-end">{l}</Text>)), ...helpRows(ui, view, act, width)]
  const focus = focusOf(view)
  const list = sorted(s.cases)
  const wide = view.columns >= WIDE
  const tail = [...historyRows(ui, view, focus, width), ...helpRows(ui, view, act, width)]
  if (!wide) {
    return [
      nowTitle(ui, view, focus, width, act),
      ...(focus ? nowCardRows(ui, view, focus, width, act) : []),
      <Text> </Text>,
      ...gridRows(ui, view, list, width, act, focus),
      ...tail,
    ]
  }
  const listWidth = Math.min(64, Math.floor(width * 0.5))
  const nowWidth = width - listWidth - GUTTER
  const left = [nowTitle(ui, view, focus, nowWidth, act), ...(focus ? nowCardRows(ui, view, focus, nowWidth, act) : [])]
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
    // 取消選取不綁快捷鍵：這裡只在「更多動作」展開、而且你選了任務時出現（區段標題列上另有一顆）。
    ...(view.showAll && view.selected ? [{ key: 'deselect', label: WORD.deselect, isDim: true, onPress: act.deselect, width: 0 }] : []),
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
