// 摘要列：輸入框上方一行。左邊是面板上選的那件（沒選就是進行中的那件，再沒有就是現在該看的那件）與它的六段，右邊是在等你的那件。
// 版面先算好（純函式，可測），再畫；放不下時依序：段名縮成字形 → 拿掉備註 → 任務名截斷 → 拿掉右邊。
import type { Case, Snapshot, StageStatus } from '../types'
import { displayWidth, fit, focusCase, liveCases, summary } from './model'
import { stageParts } from './pipeline'
import { COLOR, STATE, WORD } from './theme'
import { dueReminders, reminderWhen } from './extras'
import { turnOf } from './turn'
import type { TurnCtx } from './turn'
import { noticeText } from './update'

export const STAGE_COLOR: Record<StageStatus, string> = { done: COLOR.dim, active: COLOR.running, wait: COLOR.attention, fail: COLOR.bad, todo: COLOR.faint, na: COLOR.faint }

export type BandPart = { text: string; color: string; bold?: boolean }
/** notice：desk 有新版本（自動檢查查到的），放在面板按鈕左邊；太窄才拿掉。 */
export type BandLayout = { lead: BandPart[]; wait: BandPart | null; notice: BandPart | null; button: string; buttonWidth: number }

const NARROW = 48
const width = (parts: BandPart[]) => parts.reduce((n, p) => n + displayWidth(p.text), 0)

function leadCase(s: Snapshot, selected: string | null): Case | null {
  const picked = selected ? s.cases.find(c => c.statusPath === selected) : undefined
  if (picked) return picked
  const running = liveCases(s.cases).filter(c => c.state === 'running').sort((a, b) => (b.agent?.startedAt ?? 0) - (a.agent?.startedAt ?? 0))
  return running[0] ?? focusCase(s.cases) ?? (s.tutorial ? s.cases[0] ?? null : null)
}

const NEEDS_YOU = new Set(['ask', 'reply', 'gate', 'failed'])

export function layoutBand(s: Snapshot, columns: number, paneOpen: boolean, ctxOf: (c: Case) => TurnCtx = () => ({}), selected: string | null = null): BandLayout {
  const narrow = columns < NARROW
  const button = narrow ? '⌗' : paneOpen ? `⌗ ${WORD.brand} ▾` : `⌗ ${WORD.brand} ▸`
  const buttonWidth = displayWidth(button) + 1
  const update: BandPart | null = s.update ? { text: noticeText(s.update.latest), color: COLOR.attention } : null
  const updateWidth = update ? displayWidth(update.text) + 3 : 0
  // 有新版本的提示放在面板按鈕左邊；放了之後左邊還留得下 24 格才放，其餘照原本由寬到窄擠。
  const notice = update && columns - buttonWidth - 1 - updateWidth >= 24 ? update : null
  const room = columns - buttonWidth - 1 - (notice ? updateWidth : 0)
  const lead = leadCase(s, selected)
  const runningMore = s.cases.filter(c => c.state === 'running' && c !== lead).length
  const waiting = liveCases(s.cases).filter(c => NEEDS_YOU.has(c.state) && c !== lead)
  // 你在面板選的那件是對話的主角：前面標「已選」，提醒提示都會附上它的卡。
  const isPicked = !!selected && lead?.statusPath === selected
  const demo: BandPart[] = [
    ...(s.demo ? [{ text: '示範  ', color: COLOR.faint }] : s.tutorial ? [{ text: '教學  ', color: COLOR.faint }] : []),
    ...(isPicked ? [{ text: '已選  ', color: COLOR.dim }] : []),
  ]

  if (!lead) {
    const quiet = s.cases.length ? `○ ${s.cases.length} 件都閒置` : '尚無任務'
    return { lead: [...demo, { text: quiet, color: COLOR.faint }], wait: null, notice, button, buttonWidth }
  }
  const meta = STATE[lead.state]
  const head: BandPart[] = [...demo, { text: `${meta.glyph} `, color: meta.color }]
  const name = (max: number): BandPart => ({ text: fit(lead.name, max), color: COLOR.text, bold: true })
  const strip = (compact: boolean): BandPart[] => lead.pipeline ? stageParts(lead.pipeline, compact).map(p => ({ text: compact ? p.text : ` ${p.text}`, color: STAGE_COLOR[p.status] })) : []
  const current = lead.pipeline?.stages.find(st => st.id === lead.pipeline!.current)
  const label: BandPart[] = current ? [{ text: ` ${current.label}`, color: STAGE_COLOR[current.status] }] : []
  // 摘要列的那句話跟現在卡最上方一樣：輪到你／處理中＋該做什麼。
  const turn = turnOf(lead, ctxOf(lead))
  // 處理中時摘要列只留主句（括號提示留在面板），把位置讓給六段與提醒。
  const noteText = turn.who === 'you' ? `輪到你：${turn.text}` : turn.who === 'ai' ? `處理中：${turn.text.split(/[，（]/)[0]}` : turn.text
  const note: BandPart[] = noteText ? [{ text: `  ${noteText}`, color: turn.who === 'you' ? COLOR.attention : COLOR.dim }] : []
  const more: BandPart[] = runningMore > 0 ? [{ text: `  +${runningMore}`, color: COLOR.running }] : []
  const waitPart = (max: number): BandPart | null => {
    const w = waiting[0]
    const due = dueReminders(s.reminders)[0]
    if (!w && due && max >= 14) {
      const tail = `（${reminderWhen(due)}）`
      return { text: `◷ ${fit(due.text, max - 2 - displayWidth(tail))}${tail}`, color: due.days < 0 ? COLOR.bad : COLOR.attention, bold: true }
    }
    if (!w || max < 10) return null
    const tail = ` 等你${waiting.length > 1 ? ` +${waiting.length - 1}` : ''}`
    return { text: `● ${fit(w.name, max - 2 - displayWidth(tail))}${tail}`, color: COLOR.attention, bold: true }
  }

  // 由寬到窄試，第一個放得下的就用。
  const tries: (() => { lead: BandPart[]; wait: BandPart | null })[] = [
    () => ({ lead: [...head, name(24), { text: ' ', color: COLOR.dim }, ...strip(false), ...note, ...more], wait: waitPart(40) }),
    () => ({ lead: [...head, name(20), { text: '  ', color: COLOR.dim }, ...strip(true), ...label, ...note, ...more], wait: waitPart(22) }),
    () => ({ lead: [...head, name(18), { text: '  ', color: COLOR.dim }, ...strip(true), ...label, ...more], wait: waitPart(18) }),
    () => ({ lead: [...head, name(16), { text: '  ', color: COLOR.dim }, ...strip(true), ...label], wait: null }),
    () => ({ lead: [...head, name(14), { text: '  ', color: COLOR.dim }, ...strip(true)], wait: null }),
  ]
  for (const t of tries) {
    const r = t()
    const total = width(r.lead) + (r.wait ? displayWidth(r.wait.text) + 3 : 0)
    if (total <= room) return { ...r, notice, button, buttonWidth }
  }
  const last: BandPart[] = [...head, name(Math.max(4, room - width(head)))]
  return { lead: last, wait: null, notice, button, buttonWidth }
}

export function renderBand(ui: any, layout: BandLayout, columns: number, onToggle: () => void) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="row" flexWrap="nowrap" width={columns} height={1} overflow="hidden">
      <Box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
        <Text wrap="truncate-end">{layout.lead.map((p, i) => <Text key={`l${i}`} color={p.color} bold={p.bold}>{p.text}</Text>)}</Text>
      </Box>
      {layout.wait && <Box flexShrink={0} height={1} paddingLeft={3}><Text color={layout.wait.color} bold={layout.wait.bold} wrap="truncate-end">{layout.wait.text}</Text></Box>}
      {layout.notice && <Box flexShrink={0} height={1} paddingLeft={3}><Text color={layout.notice.color} wrap="truncate-end">{layout.notice.text}</Text></Box>}
      <Box width={layout.buttonWidth} flexShrink={0} height={1} overflow="hidden" justifyContent="flex-end">
        <Button key="pane" plain dimColor label={layout.button} onPress={onToggle} />
      </Box>
    </Box>
  )
}
