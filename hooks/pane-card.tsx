// 現在卡：一列一個元素（content 會捲動，列數要算得出來），操作按鈕另外列成清單交給常駐的 footer 排。
import type { Case, Verify } from '../types'
import { allPicked, decisionAnswer, parseDecisions, parseGate, splitClauses, CARD_CMD, GATE_LABEL } from './card'
import { ago, displayWidth, fit, hhmm, pad, summary } from './model'
import { COLOR, SPINNER, STATE, WORD } from './theme'
import { KIND_LABEL, dispatchable } from './dispatch'
import { stageParts } from './pipeline'
import { gitLine, isArmed } from './extras'
import { compactStatus } from './digest-status'
import { STAGE_COLOR } from './band'
import { wrapText } from './layout'
import { stageActions, turnOf } from './turn'
import { TUTORIAL_STEP_LABEL, tutorialStep } from './tutorial'
import type { ActionId, Turn, TurnCtx } from './turn'
import type { DispatchKind } from './dispatch'
import type { PaneActions, PaneView } from './pane'

/** 列上的動作鍵；決策選項若撞到這些字母就只能用點的。 */
export const RESERVED = new Set(['f', 'v', 'o', 'r', 'x', 'h', 'g', 's', 'w', 'y', 'k', 'l', 'n', 'e', 'p', 'i', 'u', 'm', 't'])
const DISPATCH_HOTKEY: Record<DispatchKind, string> = { continue: 'g', sync: 's', review: 'w', reply: 'y' }
const DISPATCH_GLYPH: Record<DispatchKind, string> = { continue: '▶', sync: '↻', review: '◆', reply: '↩' }

export const KV_LABEL = 8
const KV_LINES = 2
const INDENT = 2

export const picksKey = (c: Case) => `${c.statusPath}\n${c.ask}`

/** 畫面上才知道、turnOf 需要的事。 */
export function turnCtx(view: PaneView, c: Case): TurnCtx {
  return { verifying: c.statusPath in view.verifying, queued: view.queue.includes(c.statusPath), launching: c.statusPath in view.launching, tutorial: !!view.s.tutorial }
}

const TURN_LABEL: Record<Turn['who'], string> = { you: '▶ 輪到你', ai: '◐ AI 處理中', none: '— 沒有待辦' }
const TURN_COLOR: Record<Turn['who'], string> = { you: COLOR.attention, ai: COLOR.running, none: COLOR.faint }

/** 現在卡最上方那一句：輪到誰＋該做什麼（寫給人看，不是卡片給執行者的下一步）。 */
/** 輪到誰那一句：最重要的指示，寫不下就換行（接在文字底下對齊），不截斷。 */
function turnRows(ui: any, t: Turn, width: number): any[] {
  const { Box, Text } = ui
  const label = TURN_LABEL[t.who]
  const lead = displayWidth(label) + 2
  const lines = wrapText(t.text, Math.max(4, width - INDENT - lead))
  const color = t.who === 'you' ? COLOR.text : COLOR.dim
  return lines.map((line, i) => (
    <Box flexDirection="row" paddingLeft={i ? INDENT + lead : INDENT}>
      {i ? null : <Text color={TURN_COLOR[t.who]} bold>{`${label}  `}</Text>}
      <Text color={color} wrap="truncate-end">{line}</Text>
    </Box>
  ))
}

/** footer 上的一個操作：按鈕，或一段文字（例如「派工中」）。width 是畫出來約佔的格數，用來排列。 */
export type Action = { key: string; label: string; hotkey?: string; isDim?: boolean; isLead?: boolean; isBoxed?: boolean; onPress?: () => void; color?: string; width: number }

const slugOf = (c: Case) => c.root.split('/').filter(Boolean).pop() ?? ''
/** 上線確認只在最後一段：已經有 tag 包含這個 commit、關卡是 release：…（部署完由你按）。 */
export const canShip = (c: Case) => c.pipeline?.current === 'ship' && !!c.tag && parseGate(c.gate)?.kind === 'release'
/** 只有 desk 派出去、正在跑的那個才能從面板停止。 */
const canStop = (c: Case) => c.state === 'running' && !!c.agent?.id && /^desk-/.test(c.agent.name)

/** 確認文字裡的模型：同步用同步模型，其他用派工模型。 */
function modelText(view: PaneView, k: DispatchKind): string {
  const m = view.s.models
  const pick = k === 'sync' && m?.sync?.model ? m.sync : m?.dispatch
  return pick?.model ? `${pick.model}${pick.effort ? ` · ${pick.effort}` : ''}` : '預設模型'
}

/** 指令顯示用：拿掉 `docker compose exec -T app` 與 `…/.bin/` 這類前綴，串接的多段只留段名。 */
export function shortCommand(cmd: string): string {
  return cmd.split(/\s*&&\s*/).map(part => part.replace(/^docker compose exec (?:-T )?\S+\s+/, '').replace(/^\S*\/\.bin\//, '')).join('  →  ')
}

/** 按鈕畫出來的寬度：plain 是「鍵: 標籤」，有框的再加「[  ]」。 */
function buttonWidth(label: string, hotkey?: string, isBoxed = false): number {
  return displayWidth(label) + (hotkey ? 3 : 0) + (isBoxed ? 4 : 0)
}

function button(a: Omit<Action, 'width'>): Action {
  return { ...a, width: a.onPress ? buttonWidth(a.label, a.hotkey, a.isBoxed) : displayWidth(a.label) }
}

/** 標籤＋內容兩欄：內容依「；」拆行，預設前兩行（截斷），多的寫「還有 n 項」；展開時每行自己換行。 */
function kvRows(ui: any, label: string, text: string, width: number, expanded: boolean, color: string, maxLines = KV_LINES): any[] {
  const { Box, Text } = ui
  const room = Math.max(10, width - INDENT - KV_LABEL)
  const clauses = splitClauses(text)
  const shown = expanded ? clauses : clauses.slice(0, maxLines)
  const lines = expanded ? shown.flatMap(cl => wrapText(cl, room)) : shown.map(cl => fit(cl, room))
  const more = clauses.length - shown.length
  const rows = lines.map((line, i) => (
    <Box flexDirection="row" paddingLeft={INDENT}>
      <Text color={COLOR.faint}>{pad(i === 0 ? label : '', KV_LABEL)}</Text>
      <Text color={color} wrap="truncate-end">{line}</Text>
    </Box>
  ))
  if (more > 0) rows.push(<Box flexDirection="row" paddingLeft={INDENT + KV_LABEL}><Text color={COLOR.faint}>{`還有 ${more} 項（x 展開）`}</Text></Box>)
  return rows
}

/** 一段會換行的字：每列一個元素。 */
function wrappedRows(ui: any, text: string, width: number, color: string, indent = INDENT, bold = false): any[] {
  const { Box, Text } = ui
  return wrapText(text, width - indent).map(line => <Box paddingLeft={indent}><Text color={color} bold={bold} wrap="truncate-end">{line}</Text></Box>)
}

/** 完成檢查：結果一列、指令一列；失敗或展開時附輸出尾巴。 */
function verifyRows(ui: any, c: Case, v: Verify | undefined, running: boolean, view: PaneView, queuedAt: number, width: number): any[] {
  const { Box, Text } = ui
  if (!c.verify) return []
  const stale = v && v.command !== c.verify
  const show = v && !stale ? v : undefined
  const tail = show && (!show.ok || view.isExpanded) ? show.tail : []
  const room = Math.max(10, width - INDENT - KV_LABEL)
  const result = running ? <Text color={COLOR.running}>執行中</Text>
    : queuedAt >= 0 ? <Text color={COLOR.running}>{`排隊中（第 ${queuedAt + 1} 位）`}</Text>
    : show ? <Text color={show.ok ? COLOR.good : COLOR.bad}>{show.ok ? `✓ 通過 ${hhmm(show.at)}` : `✕ 未通過 exit ${show.exitCode}  ${hhmm(show.at)}`}</Text>
    : <Text color={COLOR.faint}>{v && v.command === c.verify ? '有新 commit，需重新執行' : '尚未執行'}</Text>
  return [
    <Box flexDirection="row" paddingLeft={INDENT}><Text color={COLOR.faint}>{pad('檢查', KV_LABEL)}</Text>{result}</Box>,
    <Box flexDirection="row" paddingLeft={INDENT + KV_LABEL}><Text color={COLOR.faint} wrap="truncate-end">{fit(shortCommand(c.verify), room)}</Text></Box>,
    ...tail.map(line => <Box flexDirection="row" paddingLeft={INDENT + KV_LABEL}><Text color={show!.ok ? COLOR.dim : COLOR.bad} wrap="truncate-end">{fit(line, room)}</Text></Box>),
  ]
}

/** 現在卡的內容列：案名、六段、PR、狀態、git、審查、部署、決策、執行者、下一步、檢查。 */
export function nowCardRows(ui: any, view: PaneView, c: Case, width: number, act: PaneActions): any[] {
  const { Box, Text, Button } = ui
  const meta = STATE[c.state]
  const spin = c.state === 'running' ? SPINNER[view.tick % SPINNER.length] : meta.glyph
  const age = ago(c.updatedAt, view.now)
  const decisions = c.state === 'ask' ? parseDecisions(c.ask) : []
  const picks = view.picks[picksKey(c)] ?? {}
  const gate = parseGate(c.gate)
  const prefix = `case-${c.statusPath}-`
  const tailText = `  ${meta.label}${age ? ` · ${age}` : ''}`
  const rows: any[] = []

  rows.push(
    <Box flexDirection="row">
      <Text color={meta.color}>{spin} </Text>
      <Box flexGrow={1} flexShrink={1} overflow="hidden"><Text bold color={COLOR.text} wrap="truncate-end">{fit(c.name, Math.max(4, width - 2 - displayWidth(tailText)))}</Text></Box>
      <Text color={meta.color} bold>{`  ${meta.label}`}</Text>
      {age ? <Text color={COLOR.faint}>{` · ${age}`}</Text> : null}
    </Box>,
  )
  rows.push(...turnRows(ui, turnOf(c, turnCtx(view, c)), width))
  // 完成的案子：六段全部轉綠，後面接「✓ 完成 <tag>」。六段的備註（例如「可繼續實作」）由上一列的話取代。
  const isDone = c.state === 'done'
  if (c.pipeline) rows.push(<Box paddingLeft={INDENT}><Text wrap="truncate-end">{stageParts(c.pipeline, width < 30).map((p, i) => <Text key={`st${i}`} color={isDone ? COLOR.good : STAGE_COLOR[p.status]}>{(i && width >= 30 ? ' ' : '') + p.text}</Text>)}{isDone ? <Text color={COLOR.good} bold>{`   ✓ 完成${c.tag ? ` ${c.tag}` : ''}`}</Text> : null}</Text></Box>)
  // 沒有 PR 可看、git 判斷已合併（只在審查過後才算）
  const gitMerged = !c.pr && !!c.mergedInto && c.pipeline?.stages.find(s => s.id === 'merge')?.status === 'done'
  if (c.pr) {
    const pr = c.pr
    const color = pr.state === 'MERGED' ? COLOR.good : pr.state === 'DECLINED' ? COLOR.bad : pr.ci === 'fail' ? COLOR.bad : pr.ci === 'pending' ? COLOR.running : pr.ci === 'pass' ? COLOR.good : COLOR.dim
    const word = pr.state === 'MERGED' ? '已合併' : pr.state === 'DECLINED' ? '已拒絕' : pr.ci === 'fail' ? 'CI 失敗' : pr.ci === 'pending' ? 'CI 執行中' : pr.ci === 'pass' ? 'CI 通過，可合併' : '已開啟'
    rows.push(<Box paddingLeft={INDENT}><Text wrap="truncate-end"><Text color={COLOR.faint}>{`PR #${pr.id}${pr.dest ? ` → ${pr.dest}` : ''}  `}</Text><Text color={color}>{word}</Text></Text></Box>)
  } else if (gitMerged) {
    rows.push(<Box paddingLeft={INDENT}><Text wrap="truncate-end" color={COLOR.good}>{`已合併到 ${c.mergedInto!.replace(/^origin\//, '')}（git）`}</Text></Box>)
  }
  if (c.status) rows.push(...(view.isExpanded ? kvRows(ui, '狀態', c.status, width, true, COLOR.dim) : kvRows(ui, '狀態', c.statusShort ?? compactStatus(c.status), width, false, COLOR.text, 1)))
  if (c.git && c.gitState) rows.push(...kvRows(ui, 'git', `${c.git.branch} · ${gitLine(c.gitState)}`, width, false, COLOR.dim, 1))
  if (c.reviewTop?.length) rows.push(...kvRows(ui, '審查', c.reviewTop.join('；'), width, view.isExpanded, COLOR.bad, 3))
  if (c.pr?.state === 'MERGED' || gitMerged) rows.push(...(c.deploySteps?.length
    ? kvRows(ui, '部署', c.deploySteps.map((x, i) => `${i + 1}. ${x}`).join('；') + `；全部做完後：${CARD_CMD} archive ${slugOf(c)}`, width, true, COLOR.attention)
    : kvRows(ui, '下一步', `已合併，可歸檔：${CARD_CMD} archive ${slugOf(c)}`, width, false, COLOR.attention, 1)))

  decisions.forEach((d, i) => {
    rows.push(<Text> </Text>)
    rows.push(...wrappedRows(ui, `${decisions.length > 1 ? `${i + 1}. ` : ''}${d.title || '請選擇'}`, width, COLOR.attention, INDENT, true))
    for (const o of d.options) {
      const chosen = picks[String(i)] === o.key
      const hot = /^[a-z]$/i.test(o.key) && !RESERVED.has(o.key.toLowerCase()) ? o.key.toLowerCase() : undefined
      const lead = decisions.length === 1 && hot ? ' ' : ` ${o.key}  `
      const room = Math.max(4, width - INDENT - 1 - (decisions.length === 1 && hot ? 3 : 0) - 1 - displayWidth(lead))
      rows.push(
        <Box paddingLeft={INDENT + 1}>
          <Button plain key={prefix + 'opt' + i + o.key} hotkey={decisions.length === 1 ? hot : undefined} dimColor={!chosen} onPress={() => act.pick(c, i, o.key)}>
            <Text color={chosen ? COLOR.attention : COLOR.dim}>{chosen ? '◉' : '○'}</Text>{lead}<Text color={chosen ? COLOR.text : COLOR.dim}>{fit(o.text, room)}</Text>
          </Button>
        </Box>,
      )
    }
  })

  if (c.state === 'reply') { rows.push(<Text> </Text>); rows.push(...wrappedRows(ui, summary(c), width, COLOR.attention)) }
  if (gate) {
    rows.push(<Text> </Text>)
    const head = `◆ ${GATE_LABEL[gate.kind]}`
    const [first, ...rest] = wrapText(`${head}  ${gate.detail}`, width - INDENT)
    rows.push(<Box paddingLeft={INDENT}><Text wrap="truncate-end"><Text color={COLOR.attention} bold>{head}</Text><Text color={COLOR.text}>{(first ?? '').slice(head.length)}</Text></Text></Box>)
    rows.push(...rest.map(line => <Box paddingLeft={INDENT}><Text color={COLOR.text} wrap="truncate-end">{line}</Text></Box>))
  }
  if (c.state === 'running') rows.push(...kvRows(ui, '執行者', c.agent?.last || c.next, width, view.isExpanded, COLOR.running))
  if (view.logsOpen === c.statusPath) {
    const lines = view.logView[c.statusPath] ?? []
    if (!lines.length) rows.push(<Box paddingLeft={INDENT + KV_LABEL}><Text color={COLOR.faint}>讀取中…</Text></Box>)
    else rows.push(...lines.map(l => <Box paddingLeft={INDENT + KV_LABEL}><Text color={COLOR.dim} wrap="truncate-end">{fit(l, Math.max(10, width - INDENT - KV_LABEL))}</Text></Box>))
  }

  rows.push(...verifyRows(ui, c, view.verifies[c.statusPath], c.statusPath in view.verifying, view, view.queue.indexOf(c.statusPath), width))
  if (c.manual) rows.push(<Box paddingLeft={INDENT}><Text color={COLOR.faint}>手動案子：工作桌只追蹤，不派工</Text></Box>)
  if (!c.manual && !c.verify && c.hasCard) rows.push(...wrappedRows(ui, '卡片尚缺完成檢查：請先寫一條「修正前失敗、修正後通過」的指令，才能派實作', width, COLOR.attention))
  return rows
}

/** 現在這件的操作（footer 第一排）：填入決策、派工、停止、輸出、審查檔、PR、檢查、開卡片。現在該按的那顆不變淡。 */
export function caseActions(view: PaneView, c: Case, act: PaneActions): Action[] {
  // 示範案子只能看：連 m 展開全部也沒有動作。
  if (c.demo) return []
  const decisions = c.state === 'ask' ? parseDecisions(c.ask) : []
  const picks = view.picks[picksKey(c)] ?? {}
  const ready = allPicked(decisions, picks)
  const isVerifying = c.statusPath in view.verifying
  const queuedAt = view.queue.indexOf(c.statusPath)
  const ctx = turnCtx(view, c)
  const leadKey = turnOf(c, ctx).key
  const allowed = view.showAll ? null : stageActions(c, ctx)
  const can = (id: ActionId) => !allowed || allowed.has(id)
  const prefix = `case-${c.statusPath}-`
  const out: Action[] = []
  if (decisions.length && can('fill')) out.push(button({ key: prefix + 'fill', hotkey: 'f', isLead: ready, isBoxed: ready, isDim: !ready, label: ready ? `✎ ${WORD.fill}：${decisionAnswer(decisions, picks)}` : `✎ ${WORD.fill}`, onPress: () => act.fill(c) }))
  if (c.statusPath in view.launching) out.push(button({ key: prefix + 'launching', label: `${SPINNER[view.tick % SPINNER.length]} 派工中`, color: COLOR.running }))
  else for (const k of dispatchable(c).filter(k => (decisions.length === 0 || k !== 'continue') && can(k))) {
    const armed = isArmed(view.armed, `${c.statusPath}\n${k}`, view.now)
    out.push(button({ key: prefix + k, hotkey: DISPATCH_HOTKEY[k], isBoxed: armed, isLead: armed || leadKey === DISPATCH_HOTKEY[k], isDim: !armed && leadKey !== DISPATCH_HOTKEY[k], label: armed ? `再按 ${DISPATCH_HOTKEY[k]} 確認${KIND_LABEL[k]}（${modelText(view, k)}）` : `${DISPATCH_GLYPH[k]} ${KIND_LABEL[k]}`, onPress: () => act.dispatch(c, k) }))
  }
  if (canStop(c) && can('stop')) {
    const armed = isArmed(view.armed, `${c.statusPath}\nstop`, view.now)
    out.push(button({ key: prefix + 'stop', hotkey: 'k', isBoxed: armed, isLead: armed, isDim: !armed, label: armed ? '再按 k 確認停止' : '■ 停止', onPress: () => act.stop(c) }))
  }
  if (c.agent?.id && can('logs')) out.push(button({ key: prefix + 'logs', hotkey: 'l', isDim: true, label: view.logsOpen === c.statusPath ? '▴ 收起輸出' : '≡ 輸出', onPress: () => act.logs(c) }))
  if (c.reviewTop?.length && can('review-file')) out.push(button({ key: prefix + 'review-file', hotkey: 'e', isDim: leadKey !== 'e', isLead: leadKey === 'e', label: '↗ 審查檔', onPress: () => act.openReview(c) }))
  if (c.pr?.url && can('pr')) out.push(button({ key: prefix + 'pr', hotkey: 'p', isDim: leadKey !== 'p', isLead: leadKey === 'p', label: '↗ PR', onPress: () => act.openPr(c) }))
  if (c.verify && can('verify')) out.push(button({ key: prefix + 'verify', hotkey: 'v', isDim: isVerifying || leadKey !== 'v', isLead: !isVerifying && leadKey === 'v', label: isVerifying ? `${SPINNER[view.tick % SPINNER.length]} 檢查中` : queuedAt >= 0 ? '… 排隊中' : `▶ ${WORD.verify}`, onPress: () => act.verify(c) }))
  if (canShip(c) && can('ship')) {
    const armed = isArmed(view.armed, `${c.statusPath}\nship`, view.now)
    out.push(button({ key: prefix + 'ship', hotkey: 'u', isBoxed: armed, isLead: armed || leadKey === 'u', label: armed ? '再按 u 確認已上線（清除 release 關卡）' : '✓ 上線確認', onPress: () => act.ship(c) }))
  }
  const lesson = view.s.tutorial ? tutorialStep(c) : null
  if (lesson && can('tutorial')) out.push(button({ key: prefix + 'tutorial', hotkey: 't', isLead: leadKey === 't', isBoxed: leadKey === 't', isDim: leadKey !== 't', label: TUTORIAL_STEP_LABEL[lesson], onPress: () => act.tutorial(c) }))
  out.push(button({ key: prefix + 'open', hotkey: 'o', isDim: leadKey !== 'o', isLead: leadKey === 'o', label: `↗ ${WORD.open}`, onPress: () => act.open(c) }))
  return out
}
