// 現在卡：一列一個元素（content 會捲動，列數要算得出來），操作按鈕另外列成清單交給常駐的 footer 排。
import type { Case, Verify } from '../types'
import { allPicked, choiceCount, decisionAnswer, parseDecisions, parseGate, splitClauses, unreviewedGate, ARCHIVE_WORD, CARD_CMD, GATE_LABEL } from './card'
import { ago, displayWidth, elapsedText, fit, hhmm, isRunLong, pad, runTimeText, slugOf, summary, quotaHeld } from './model'
import { ACTIVE_PULSE, COLOR, EDGE, SPINNER, STATE, WORD } from './theme'
import { KIND_LABEL, normalizeRoot } from './dispatch'
import { archivesOnShip, canArchive, parseVerdict, stageParts } from './pipeline'
import { checkApprovalLine, gitLine, isArmed, mergedAtHead } from './extras'
import type { ApprovalKey, HeldReason } from './extras'
import { isApproved } from './approve-check'
import { CHECK_CHANGED, CHECK_UNAPPROVED } from './chain'
import { compactStatus } from './digest-status'
import { STAGE_COLOR } from './band'
import { wrapText } from './layout'
import { isSeparator } from './verify-summary'
import { cardBehind, expandedActions, isBusy, needsPrConfirm, sentState, shipTurn, stageActions, turnOf } from './turn'
import { ACTIONS, ACTION_ORDER, HOTKEY, RESERVED, actionText } from './actions'
import type { ActionId } from './actions'
import { TUTORIAL_STEP_LABEL, tutorialStep } from './tutorial'
import type { ExpandedAction, Turn, TurnCtx } from './turn'
import type { DispatchKind } from './dispatch'
import type { PaneActions, PaneView } from './pane'

// 動作的單鍵、圖示、標籤與保留鍵都在 actions.ts；這裡照舊匯出保留鍵（決策選項撞到就只能用點的）。
export { RESERVED }

export const KV_LABEL = 8
const KV_LINES = 2
/** 現在卡內容的縮排：左邊的「▎ 」邊條已經佔掉原本的 2 格縮排，內容不再另外縮。 */
const INDENT = 0

export const picksKey = (c: Case) => `${c.statusPath}\n${c.ask}`

/** 畫面上才知道、turnOf 需要的事。 */
export function turnCtx(view: PaneView, c: Case): TurnCtx {
  const agentQueued = (view.agentQueue ?? []).indexOf(c.statusPath) + 1
  return { verifying: c.statusPath in view.verifying, queued: view.queue.includes(c.statusPath), launching: c.statusPath in view.launching, ...(agentQueued ? { agentQueued } : {}), tutorial: !!view.s.tutorial, sent: sentState(view.sent, c), now: view.now, ...(view.untrusted?.[c.statusPath] ? { hold: view.untrusted[c.statusPath] } : {}) }
}

/** 檢查列上待確認的鍵（確認規格、執行檢查、派實作），沒有就是 null。 */
function approvalKey(view: PaneView, c: Case): ApprovalKey | null {
  const on = (id: string) => isArmed(view.armed, `${c.statusPath}\n${id}`, view.now)
  return on('spec-ok') ? 't' : on('verify') ? 'v' : on('continue') ? 'g' : null
}
/** 這張卡現在的檢查指令核准過了；畫面沒給核准紀錄就當核准過。 */
const checkApproved = (view: PaneView, c: Case) => !view.trusted || isApproved(view.trusted, c)
/**
 * 這個對話的流程停在檢查段，原因是指令改過或從沒核准過：別的對話開的按 v 接不下去，不算；
 * 這一刻 footer 上沒有 v（已合併、可歸檔、Agent 在跑）時也不算，不叫你按一顆不在列上的鍵。
 */
function heldReason(c: Case, listed: ReadonlySet<ActionId>): HeldReason | null {
  if (!c.chain?.heldAtCheck || c.chain.foreign || !listed.has('verify')) return null
  return c.chain.stopped === CHECK_CHANGED ? 'changed' : c.chain.stopped === CHECK_UNAPPROVED ? 'unapproved' : null
}

const TURN_LABEL: Record<Turn['who'], string> = { you: '▶ 輪到你', ai: '處理中', none: '— 沒有待辦' }
const TURN_COLOR: Record<Turn['who'], string> = { you: COLOR.attention, ai: COLOR.running, none: COLOR.faint }

/** 現在卡邊條佔的格數：「▎」加一格空白。 */
const EDGE_WIDTH = 2

/** 現在卡最上方那一句：輪到誰＋該做什麼（寫給人看，不是卡片給 Agent 的下一步）。 */
/** 輪到誰那一句：最重要的指示，寫不下就換行（接在文字底下對齊），不截斷。處理中的圖示跟著 tick 轉，Agent 在跑時同列寫已執行多久。 */
function turnRows(ui: any, t: Turn, width: number, tick: number, elapsed = ''): any[] {
  const { Box, Text } = ui
  const label = t.who === 'ai' ? `${SPINNER[tick % SPINNER.length]} ${TURN_LABEL.ai}` : TURN_LABEL[t.who]
  const lead = displayWidth(label) + 2
  // 已執行多久接在同列文字的開頭，不算進標籤，免得懸掛縮排變寬、把那句擠成好幾列。
  const lines = wrapText(elapsed ? `已執行 ${elapsed} · ${t.text}` : t.text, Math.max(4, width - INDENT - lead))
  const color = t.who === 'you' ? COLOR.text : COLOR.dim
  return lines.map((line, i) => (
    <Box flexDirection="row" paddingLeft={i ? INDENT + lead : INDENT}>
      {i ? null : <Text color={TURN_COLOR[t.who]} bold>{`${label}  `}</Text>}
      <Text color={color} wrap="truncate-end">{line}</Text>
    </Box>
  ))
}

/** footer 上的一個操作：按鈕，或一段文字（例如「派工中」「退回：」，沒有 id）。width 是畫出來約佔的格數，用來排列。 */
export type Action = { key: string; id?: ActionId; label: string; hotkey?: string; isDim?: boolean; isLead?: boolean; isBoxed?: boolean; onPress?: () => void; color?: string; width: number }


/** 確認文字裡的模型：同步用同步模型；這件有 projects 覆寫就用它實際會用的；其他看 kinds，再來是派工模型。 */
function modelText(view: PaneView, k: DispatchKind, c: Case): string {
  const m = view.s.models
  const own = k === 'sync' ? undefined : m?.byRoot?.[normalizeRoot(c.root)]?.[k]
  const pick = k === 'sync' && m?.sync?.model ? m.sync : own ?? m?.kinds?.find(e => e.kind === k) ?? m?.dispatch
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

export function button(a: Omit<Action, 'width'>): Action {
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

/** 沒收合時最多列幾支失敗。 */
const FAILURE_LINES = 3

/**
 * 沒過時結果列下面列的字：認得出框架就是「測試名：原因」（收合只列前 3 支，其餘寫「還有 n 支」），認不出、抓不到名稱或舊紀錄是去掉分隔線的尾巴（全列）；
 * 展開時列全部，再接摘要裡沒有的原始尾巴（分隔線不列）。
 */
function failureLines(v: Verify, expanded: boolean): { items: string[]; more?: string; raw: string[]; isNamed?: boolean } {
  const items = v.summary?.items ?? v.tail.filter(l => !isSeparator(l))
  const raw = expanded ? v.tail.filter(l => !items.includes(l) && !isSeparator(l)) : []
  const failed = v.summary?.failed
  if (failed === undefined || v.summary?.isTail) return { items, raw }
  const shown = expanded ? items : items.slice(0, FAILURE_LINES)
  const hidden = Math.max(failed, items.length) - shown.length
  return { items: shown, ...(hidden > 0 ? { more: expanded ? `還有 ${hidden} 支沒列出` : `還有 ${hidden} 支（x 展開）` } : {}), raw, isNamed: true }
}

/** 「測試名：原因」放不下時先縮短名稱（至少留 NAME_MIN 欄），讓原因留在畫面上。 */
const NAME_MIN = 16

function fitFailure(text: string, columns: number): string {
  const at = text.indexOf('：')
  if (at < 0 || displayWidth(text) <= columns) return fit(text, columns)
  const reason = text.slice(at)
  return fit(fit(text.slice(0, at), Math.max(NAME_MIN, columns - displayWidth(reason))) + reason, columns)
}

/** 完成檢查：結果一列；沒過時下面列失敗摘要；再一列指令；展開時附原始輸出尾巴。可歸檔時已經沒有要檢查的事，只留結果一列（x 展開照舊）。 */
function verifyRows(ui: any, c: Case, v: Verify | undefined, running: boolean, view: PaneView, queuedAt: number, width: number): any[] {
  const { Box, Text } = ui
  if (!c.verify) return []
  const stale = v && v.command !== c.verify
  const show = v && !stale ? v : undefined
  const brief = canArchive(c) && !view.isExpanded
  const failure = show && !show.ok ? failureLines(show, view.isExpanded) : undefined
  const passTail = show?.ok && view.isExpanded ? show.tail : []
  const count = show?.summary?.failed !== undefined ? ` · ${show.summary.failed} 支失敗` : ''
  const room = Math.max(10, width - INDENT - KV_LABEL)
  // 第二次按 t、v、g 就會核准這條指令，或流程正停在它沒核准：列出全文，不用去掉前綴的短版。
  const approval = checkApprovalLine(approvalKey(view, c), heldReason(c, stageActions(c, turnCtx(view, c))), checkApproved(view, c), c.verify)
  const result = running ? <Text color={COLOR.running}>測試中</Text>
    : queuedAt >= 0 ? <Text color={COLOR.running}>{`排隊中（第 ${queuedAt + 1} 位）`}</Text>
    : show ? <Text color={show.ok ? COLOR.good : COLOR.bad}>{show.ok ? (brief ? '✓ 通過' : `✓ 通過 ${hhmm(show.at)}`) : `✕ 未通過（結束碼 ${show.exitCode}）· ${hhmm(show.at)}${count}`}</Text>
    : <Text color={COLOR.faint}>{v && v.command === c.verify ? '有新 commit，需重新執行' : '尚未執行'}</Text>
  const head = <Box flexDirection="row" paddingLeft={INDENT}><Text color={COLOR.faint}>{pad(WORD.verify, KV_LABEL)}</Text>{result}</Box>
  const line = (text: string, color: string) => <Box flexDirection="row" paddingLeft={INDENT + KV_LABEL}><Text color={color} wrap="truncate-end">{text}</Text></Box>
  const plainLine = (text: string, color: string) => line(fit(text, room), color)
  const approvalRows = approval ? wrapText(approval, room).map(l => line(l, COLOR.attention)) : []
  // 可歸檔的卡沒展開只列結果；要核准的指令全文照樣列，第二次按才不會核准一條沒看到的指令。
  if (brief) return [head, ...approvalRows]
  return [
    head,
    ...(failure?.items ?? []).map(l => line(failure!.isNamed ? fitFailure(l, room) : fit(l, room), COLOR.bad)),
    ...(failure?.more ? [plainLine(failure.more, COLOR.faint)] : []),
    ...(approval ? approvalRows : [plainLine(shortCommand(c.verify), COLOR.faint)]),
    ...[...(failure?.raw ?? []), ...passTail].map(l => plainLine(l, COLOR.dim)),
  ]
}

/** 現在卡：每一列最左邊是狀態色的「▎」，一眼分得出現在卡與清單；邊條佔掉原本的縮排，內容寬度與列數不變。 */
export function nowCardRows(ui: any, view: PaneView, c: Case, width: number, act: PaneActions): any[] {
  const { Box, Text } = ui
  const color = STATE[c.state].color
  return nowCardBody(ui, view, c, width - EDGE_WIDTH, act).map(row => (
    <Box flexDirection="row">
      <Text color={color}>{EDGE}</Text>
      <Text> </Text>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">{row}</Box>
    </Box>
  ))
}

/** 現在卡頭一列至少留給任務名的寬度。 */
const HEADER_NAME_MIN = 12

/**
 * 現在卡頭一列狀態標籤後面的字：「 · 總執行 N 分（超過 15 分） · 多久前」。任務名放不下 HEADER_NAME_MIN 格時由寬到窄退讓：
 * 先省掉多久前，再省掉「（超過 15 分）」（警示色照舊）；都省了還是放不下就照最窄的，任務名被截。
 */
function headerTail(label: string, runFull: string, runShort: string, age: string, width: number): { runTime: string; age: string; text: string } {
  const tries = [{ runTime: runFull, age }, { runTime: runFull, age: '' }, { runTime: runShort, age: '' }]
  const withText = tries.map(t => ({ ...t, text: `   ${label} ${t.runTime ? ` · ${t.runTime}` : ''}${t.age ? ` · ${t.age}` : ''}` }))
  return withText.find(t => !t.runTime || width - 2 - displayWidth(t.text) >= HEADER_NAME_MIN) ?? withText[withText.length - 1]!
}

/** 現在卡的內容列：任務名、六段、PR、狀態、git、審查、部署、決策、Agent、下一步、檢查。 */
function nowCardBody(ui: any, view: PaneView, c: Case, width: number, act: PaneActions): any[] {
  const { Box, Text, Button } = ui
  const meta = STATE[c.state]
  const spin = c.state === 'running' ? SPINNER[view.tick % SPINNER.length] : meta.glyph
  const age = ago(c.updatedAt, view.now)
  const parsed = c.state === 'ask' ? parseDecisions(c.ask) : []
  // 等你沒有任何選項時，「▶ 輪到你」那列已經是原句，不再列一次；有選項時，沒選項那條只顯示文字。
  const choices = choiceCount(parsed)
  const decisions = choices ? parsed : []
  const picks = view.picks[picksKey(c)] ?? {}
  // 依審查修完寫的未複審關卡不算關卡（不影響狀態與六段），但照樣顯示原文。
  const gate = parseGate(c.gate) ?? unreviewedGate(c.gate)
  const prefix = `case-${c.statusPath}-`
  // 狀態字是反白徽章：前後各多一格。
  // 總執行時間接在狀態標籤後面（已結束的加正在跑的，跟著每秒的重畫動），超過 15 分用警示色。
  const isLong = isRunLong(c, view.now)
  const { runTime, age: shownAge, text: tailText } = headerTail(meta.label, runTimeText(c, view.now), runTimeText(c, view.now, false), age, width)
  const title = <Text bold color={COLOR.text} wrap="truncate-end">{fit(c.name, Math.max(4, width - 2 - displayWidth(tailText)))}</Text>
  // 任務名只是文字：點了不動作。取消選取在「更多動作」裡。
  const rows: any[] = []

  rows.push(
    <Box flexDirection="row">
      <Text color={meta.color}>{spin} </Text>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">{title}</Box>
      <Text>{'  '}</Text>
      <Text color={meta.color} bold inverse>{` ${meta.label} `}</Text>
      {runTime ? <Text color={isLong ? COLOR.attention : COLOR.faint} bold={isLong}>{` · ${runTime}`}</Text> : null}
      {shownAge ? <Text color={COLOR.faint}>{` · ${shownAge}`}</Text> : null}
    </Box>,
  )
  const turn = turnOf(c, turnCtx(view, c))
  // Agent 在跑：「處理中」同列寫已執行多久，下一列是它最後一句輸出（取代下方的 Agent 列，列數不變）。
  const isWorking = c.state === 'running' && turn.who === 'ai'
  const elapsed = isWorking && c.agent?.startedAt ? elapsedText(view.now - c.agent.startedAt) : ''
  const latest = isWorking ? c.agent?.last ?? '' : ''
  rows.push(...turnRows(ui, turn, width, view.tick, elapsed))
  if (latest) rows.push(...(view.isExpanded ? wrapText(`└ 最新：${latest}`, width - INDENT) : [fit(`└ 最新：${latest}`, width - INDENT)]).map(line => <Box paddingLeft={INDENT}><Text color={COLOR.dim} wrap="truncate-end">{line}</Text></Box>))
  // 完成的任務：六段全部轉綠，後面接「✓ 已上線 <tag>」。六段的備註（例如「可繼續實作」）由上一列的話取代。
  const isDone = c.state === 'done'
  // 執行中：進行中那段在 ◉／◎ 間交替，跟著 tick 動。
  const pulse = (p: { text: string; status: string }) => c.state === 'running' && p.status === 'active' ? p.text.replace(ACTIVE_PULSE[0]!, ACTIVE_PULSE[view.tick % ACTIVE_PULSE.length]!) : p.text
  if (c.pipeline) rows.push(<Box paddingLeft={INDENT}><Text wrap="truncate-end">{stageParts(c.pipeline, width < 30).map((p, i) => <Text key={`st${i}`} color={isDone ? COLOR.good : STAGE_COLOR[p.status]}>{(i && width >= 30 ? ' ' : '') + pulse(p)}</Text>)}{isDone ? <Text color={COLOR.good} bold>{`   ✓ 已上線${c.tag ? ` ${c.tag}` : ''}`}</Text> : null}</Text></Box>)
  // 沒有 PR 可看、git 判斷已合併（只在審查過後才算）
  const gitMerged = !c.pr && !!c.mergedInto && c.pipeline?.stages.find(s => s.id === 'merge')?.status === 'done'
  if (c.pr) {
    const pr = c.pr
    const color = pr.state === 'MERGED' ? COLOR.good : pr.state === 'DECLINED' ? COLOR.bad : pr.ci === 'fail' ? COLOR.bad : pr.ci === 'pending' ? COLOR.running : pr.ci === 'pass' ? COLOR.good : COLOR.dim
    // CI 通過只有在六段走到合併段才叫「可合併」；審查過期或還沒審查時，說明交給六段那列。
    const word = pr.state === 'MERGED' ? '已合併' : pr.state === 'DECLINED' ? '已拒絕' : pr.ci === 'fail' ? 'CI 失敗' : pr.ci === 'pending' ? 'CI 執行中' : pr.ci === 'pass' ? (c.pipeline?.current === 'merge' ? 'CI 通過，可合併' : 'CI 通過') : '已開啟'
    rows.push(<Box paddingLeft={INDENT}><Text wrap="truncate-end"><Text color={COLOR.faint}>{`PR #${pr.id}${pr.dest ? ` → ${pr.dest}` : ''}  `}</Text><Text color={color}>{word}</Text></Text></Box>)
  } else if (gitMerged) {
    rows.push(<Box paddingLeft={INDENT}><Text wrap="truncate-end" color={COLOR.good}>{`已合併到 ${c.mergedInto!.replace(/^origin\//, '')}（git）`}</Text></Box>)
  }
  if (c.status) rows.push(...(view.isExpanded ? kvRows(ui, '狀態', c.status, width, true, COLOR.dim) : kvRows(ui, '狀態', c.statusShort ?? compactStatus(c.status), width, false, COLOR.text, 1)))
  if (c.git && c.gitState) rows.push(...kvRows(ui, 'git', `${c.git.branch} · ${gitLine(c.gitState, mergedAtHead(c))}`, width, false, COLOR.dim, 1))
  // 面板外有新的變更、卡片沒跟著寫：提示同步（新對話只讀卡片與 git，把五欄寫回）。
  // 處理中（測試在跑、CI 跑中、派工中…）同步收進 m：footer 上沒有 s 時不叫你按 s。
  if (cardBehind(c, view.now) && stageActions(c, turnCtx(view, c)).has('sync')) rows.push(...kvRows(ui, '卡片', `分支最近一次變更（${ago(c.commitAt!, view.now)}）比卡片新：按 s 同步`, width, false, COLOR.attention, 1))
  if (c.preflight) rows.push(...kvRows(ui, '前置', c.preflight, width, false, c.preflight.startsWith('失敗') ? COLOR.attention : COLOR.dim, 1))
  if (c.reviewTop?.length) rows.push(...kvRows(ui, GATE_LABEL.review, c.reviewTop.join('；'), width, view.isExpanded, COLOR.bad, 3))
  // 合併之後：六段全過才叫你歸檔，否則是上線段那一句（跟「▶ 輪到你」相同；等你時也不換成別的話）。
  // Agent 在跑時 u 與歸檔都鎖著：已打 tag（要你按 u 或歸檔）或六段全過時不叫你做，只說它完成後再做；
  // 還沒打 tag 的發版那句照舊（發版按兩次 z 只填輸入框，不鎖）。部署步驟照常列出，可以先看。
  const archive = `${CARD_CMD} archive ${slugOf(c)}`
  const ship = shipTurn(c, view.s.tutorial)
  const toShip = !!c.tag && parseGate(c.gate)?.kind === 'release' && !isDone
  const waitAgent = isBusy(c) && (isDone || !!c.tag) ? `Agent 處理中，完成後再${toShip ? '確認上線' : '歸檔'}` : ''
  const afterDeploy = waitAgent || (isDone ? archive : ship.text)
  // 上線段那句是「要做的事；做完之後」兩段：下一步列兩段都列出來，不收成「還有 1 項」。
  if (c.pr?.state === 'MERGED' || gitMerged) rows.push(...(c.deploySteps?.length
    ? kvRows(ui, '部署', c.deploySteps.map((x, i) => `${i + 1}. ${x}`).join('；') + `；全部做完後：${afterDeploy}`, width, true, COLOR.attention)
    : kvRows(ui, '下一步', waitAgent || (isDone ? `已合併，${ARCHIVE_WORD}：${archive}` : ship.text), width, false, COLOR.attention, 2)))

  // 決策送出了、對話還在處理：選項只顯示（標出選了哪個），不能再點，免得以為還沒送。
  const isSent = turnCtx(view, c).sent === 'waiting'
  decisions.forEach((d, i) => {
    rows.push(<Text> </Text>)
    rows.push(...wrappedRows(ui, `${decisions.length > 1 ? `${i + 1}. ` : ''}${d.title || '請選擇'}`, width, isSent ? COLOR.dim : COLOR.attention, INDENT, true))
    for (const o of d.options) {
      const chosen = picks[String(i)] === o.key
      if (isSent) {
        const lead = ` ${o.key}  `
        rows.push(<Box paddingLeft={INDENT + 1}><Text wrap="truncate-end"><Text color={COLOR.faint}>{chosen ? '◉' : '○'}</Text>{lead}<Text color={chosen ? COLOR.text : COLOR.faint}>{fit(o.text, Math.max(4, width - INDENT - 2 - displayWidth(lead)))}</Text></Text></Box>)
        continue
      }
      const hot = choices === 1 && /^[a-z]$/i.test(o.key) && !RESERVED.has(o.key.toLowerCase()) ? o.key.toLowerCase() : undefined
      const lead = hot ? ' ' : ` ${o.key}  `
      const room = Math.max(4, width - INDENT - 1 - (hot ? 3 : 0) - 1 - displayWidth(lead))
      rows.push(
        <Box paddingLeft={INDENT + 1}>
          <Button plain key={prefix + 'opt' + i + o.key} hotkey={hot} dimColor={!chosen} onPress={() => act.pick(c, i, o.key)}>
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
    // 審查列只陳述分級：結論句（例如「可合併」）是指示，交給「▶ 輪到你」；讀不出四個分級時照舊顯示原文。
    const verdict = gate.kind === 'review' ? parseVerdict(c.gate) : null
    const detail = verdict ? `CRITICAL ${verdict.critical}、HIGH ${verdict.high}、MEDIUM ${verdict.medium}、LOW ${verdict.low}` : gate.detail
    const [first, ...rest] = wrapText(`${head}  ${detail}${gate.kind === 'review' && c.chain?.selfReview ? '（自審）' : ''}${gate.kind === 'review' && c.chain?.stale ? '（驗收後有新 commit，這是舊結論）' : ''}`, width - INDENT)
    rows.push(<Box paddingLeft={INDENT}><Text wrap="truncate-end"><Text color={COLOR.attention} bold>{head}</Text><Text color={COLOR.text}>{(first ?? '').slice(head.length)}</Text></Text></Box>)
    rows.push(...rest.map(line => <Box paddingLeft={INDENT}><Text color={COLOR.text} wrap="truncate-end">{line}</Text></Box>))
  }
  if (c.state === 'running' && !latest) rows.push(...kvRows(ui, 'Agent', c.agent?.last || c.next, width, view.isExpanded, COLOR.running))
  if (view.logsOpen === c.statusPath) {
    const lines = view.logView[c.statusPath] ?? []
    if (!lines.length) rows.push(<Box paddingLeft={INDENT + KV_LABEL}><Text color={COLOR.faint}>讀取中…</Text></Box>)
    else rows.push(...lines.map(l => <Box paddingLeft={INDENT + KV_LABEL}><Text color={COLOR.dim} wrap="truncate-end">{fit(l, Math.max(10, width - INDENT - KV_LABEL))}</Text></Box>))
  }

  rows.push(...verifyRows(ui, c, view.verifies[c.statusPath], c.statusPath in view.verifying, view, view.queue.indexOf(c.statusPath), width))
  if (c.manual) rows.push(<Box paddingLeft={INDENT}><Text color={COLOR.faint}>手動任務：工作桌只追蹤，不派工</Text></Box>)
  if (!c.manual && !c.verify && c.hasCard) rows.push(...wrappedRows(ui, '卡片還沒有測試指令：請先寫一條「修正前失敗、修正後通過」的指令，才能派實作', width, COLOR.attention))
  return rows
}

/** 現在這件的操作（footer 第一排）：照 stageActions 的集合畫（按 m 再照 expandedActions），帶頭的只看「▶ 輪到你」的動作。 */
export function caseActions(view: PaneView, c: Case, act: PaneActions): Action[] {
  // 示範任務只能看：連 m 展開全部也沒有動作。
  if (c.demo) return []
  const ctx = turnCtx(view, c)
  const lead = turnOf(c, ctx).action
  const prefix = `case-${c.statusPath}-`
  const shown: ExpandedAction[] = view.showAll ? expandedActions(c, ctx) : (() => { const listed = stageActions(c, ctx); return ACTION_ORDER.filter(id => listed.has(id)).map(id => ({ id })) })()
  const draw = (a: ExpandedAction): Action => {
    // Agent 執行中或等批准：會搶 worktree／卡片的動作只列成淡色文字、寫原因，連 m 展開也按不了。
    if (a.isLocked) return button({ key: prefix + a.id, id: a.id, label: `${actionText(a.id)}${WORD.busyLocked}`, color: COLOR.faint })
    const b = actionButton(view, c, act, a.id, lead)
    // 退回的鍵變淡、不帶頭；已待確認（加框）的照舊，第一次按了才看得到確認字樣。
    return a.isRetreat && !b.isBoxed ? { ...b, isLead: false, isDim: true } : b
  }
  const front = shown.filter(a => !a.isRetreat).map(draw)
  const back = shown.filter(a => a.isRetreat).map(draw)
  // 派工中、派工排隊中：不可按的字樣排在填入決策之後。
  const status = c.statusPath in view.launching ? [button({ key: prefix + 'launching', label: `${SPINNER[view.tick % SPINNER.length]} 派工中`, color: COLOR.running })]
    : ctx.agentQueued ? [button({ key: prefix + 'agent-queued', label: `… 派工排隊中（第 ${ctx.agentQueued} 位）`, color: COLOR.faint })] : []
  const at = front[0]?.id === 'fill' ? 1 : 0
  return [
    ...front.slice(0, at), ...status, ...front.slice(at),
    // 合併段平常不列的退回鍵排在本段的動作後面，前面插一段不可按的「退回：」。
    ...(back.length ? [button({ key: prefix + 'retreat', label: '退回：', color: COLOR.faint }), ...back] : []),
  ]
}

/** 一顆動作按鈕：要按兩次的第一次按了就加框、換成確認字樣；帶頭的是「▶ 輪到你」的那個動作。 */
function actionButton(view: PaneView, c: Case, act: PaneActions, id: ActionId, lead: ActionId | undefined): Action {
  const prefix = `case-${c.statusPath}-`
  const hotkey = HOTKEY(id)
  const armed = isArmed(view.armed, `${c.statusPath}\n${id}`, view.now)
  const isTurn = lead === id
  const base = { key: prefix + id, id, hotkey }
  switch (id) {
    case 'fill': {
      const decisions = parseDecisions(c.ask)
      const picks = view.picks[picksKey(c)] ?? {}
      // 決策選項還沒選完：填入不帶頭。
      const ready = allPicked(decisions, picks)
      return button({ ...base, isLead: ready, isBoxed: ready, isDim: !ready, label: ready ? `✎ ${WORD.fill}：${decisionAnswer(decisions, picks)}` : actionText('fill'), onPress: () => act.fill(c) })
    }
    case 'unqueue':
      // 還沒派出去，取消按一次就好。
      return button({ ...base, label: actionText('unqueue'), onPress: () => act.unqueue(c) })
    case 'continue': case 'review': case 'reply': case 'sync': {
      // 檢查還沒核准：第二次按 g 同時核准它（第一次已在檢查列列出全文）。
      const approving = id === 'continue' && !checkApproved(view, c) ? '核准測試並' : ''
      const word = id === 'continue' && quotaHeld(c.chain) ? '接續' : KIND_LABEL[id]
      // 卡片比分支最近一次變更舊：同步不變淡；這一段另有該按的鍵時不搶它的帶頭。
      const hint = id === 'sync' && cardBehind(c, view.now)
      return button({ ...base, isBoxed: armed, isLead: armed || isTurn, isDim: !armed && !isTurn && !hint, label: armed ? `再按 ${hotkey} 確認${approving}${word}（${modelText(view, id, c)}）` : `${ACTIONS[id].glyph} ${word}`, onPress: () => act.dispatch(c, id) })
    }
    case 'stop':
      return button({ ...base, isBoxed: armed, isLead: armed, isDim: !armed, label: armed ? `再按 ${hotkey} 確認停止` : actionText('stop'), onPress: () => act.stop(c) })
    case 'logs':
      return button({ ...base, isLead: isTurn, isDim: !isTurn, label: view.logsOpen === c.statusPath ? '▴ 收起輸出' : actionText('logs'), onPress: () => act.logs(c) })
    case 'review-file':
      return button({ ...base, isLead: isTurn, isDim: !isTurn, label: actionText('review-file'), onPress: () => act.openReview(c) })
    case 'pr':
      return button({ ...base, isLead: isTurn, isDim: !isTurn, label: actionText('pr'), onPress: () => act.openPr(c) })
    case 'release':
      // 發版：按兩次，第二次填入已確認照慣例版號的請求（只填輸入框、不寫遠端）。
      return button({ ...base, isBoxed: armed, isLead: armed || isTurn, isDim: !armed && !isTurn, label: armed ? `再按 ${hotkey} 確認：照慣例版號直接發版（不再問）` : actionText('release'), onPress: () => act.release(c) })
    case 'open-pr': case 'push': {
      // 推送 Agent：按兩次確認才派（寫遠端）。高風險改動的第一次按改提醒先看過審查檔。
      const ask = id === 'open-pr' && needsPrConfirm(c) ? `看過審查檔了？再按 ${hotkey}` : `再按 ${hotkey}`
      const doing = ACTIONS[id].label
      return button({ ...base, isBoxed: armed, isLead: armed || isTurn, isDim: !armed && !isTurn, label: armed ? `${ask} 確認派 Agent ${doing}（${modelText(view, 'publish', c)}）` : actionText(id), onPress: id === 'open-pr' ? () => act.publishPr(c) : () => act.publishPush(c) })
    }
    case 'verify': {
      const isVerifying = c.statusPath in view.verifying
      // 檢查還沒核准：按兩次，第一次在檢查列列出全文，第二次核准並執行。
      const confirm = !checkApproved(view, c) && armed
      const label = isVerifying ? `${SPINNER[view.tick % SPINNER.length]} ${WORD.verify}中` : view.queue.includes(c.statusPath) ? '… 排隊中' : confirm ? `再按 ${hotkey} 核准並執行${WORD.verify}` : actionText('verify')
      return button({ ...base, isBoxed: confirm, isDim: !confirm && (isVerifying || !isTurn), isLead: confirm || (!isVerifying && isTurn), label, onPress: () => act.verify(c) })
    }
    case 'ship':
      return button({ ...base, isBoxed: armed, isLead: armed || isTurn, label: armed ? (archivesOnShip(c, !!view.s.tutorial) ? `再按 ${hotkey} 確認上線並歸檔（清除 release 關卡）` : `再按 ${hotkey} 確認已上線（清除 release 關卡）`) : actionText('ship'), onPress: () => act.ship(c) })
    case 'spec-ok':
      return button({ ...base, isBoxed: armed || isTurn, isLead: armed || isTurn, isDim: !armed && !isTurn, label: armed ? `再按 ${hotkey} 確認規格並核准測試` : actionText('spec-ok'), onPress: () => act.specOk(c) })
    case 'archive':
      return button({ ...base, isBoxed: armed, isLead: armed || isTurn, isDim: !armed && !isTurn, label: armed ? `再按 ${hotkey} 確認歸檔` : actionText('archive'), onPress: () => act.archive(c) })
    case 'tutorial': {
      const lesson = tutorialStep(c)
      return button({ ...base, isLead: isTurn, isBoxed: isTurn, isDim: !isTurn, label: lesson ? TUTORIAL_STEP_LABEL[lesson] : '', onPress: () => act.tutorial(c) })
    }
    case 'open':
      return button({ ...base, isDim: !isTurn, isLead: isTurn, label: actionText('open'), onPress: () => act.open(c) })
  }
}
