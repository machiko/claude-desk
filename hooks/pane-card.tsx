// 現在卡：一列一個元素（content 會捲動，列數要算得出來），操作按鈕另外列成清單交給常駐的 footer 排。
import type { Case, Verify } from '../types'
import { allPicked, choiceCount, decisionAnswer, parseDecisions, parseGate, splitClauses, ARCHIVE_WORD, CARD_CMD, GATE_LABEL } from './card'
import { ago, displayWidth, elapsedText, fit, hhmm, pad, slugOf, summary } from './model'
import { ACTIVE_PULSE, COLOR, EDGE, SPINNER, STATE, WORD } from './theme'
import { KIND_LABEL, dispatchable, normalizeRoot } from './dispatch'
import { archivesOnShip, awaitsSpecOk, canArchive, canRelease, finalState, isMerged, parseVerdict, stageParts } from './pipeline'
import { gitLine, isArmed, mergedAtHead } from './extras'
import { compactStatus } from './digest-status'
import { STAGE_COLOR } from './band'
import { wrapText } from './layout'
import { cardBehind, isBusy, needsPr, needsPrConfirm, needsPush, riskyNoPr, sentState, shipTurn, stageActions, turnOf } from './turn'
import { TUTORIAL_STEP_LABEL, tutorialStep } from './tutorial'
import type { ActionId, Turn, TurnCtx } from './turn'
import type { DispatchKind } from './dispatch'
import type { PaneActions, PaneView } from './pane'

/** 列上的動作鍵；決策選項若撞到這些字母就只能用點的。 */
export const RESERVED = new Set(['f', 'v', 'o', 'r', 'x', 'h', 'g', 's', 'w', 'y', 'k', 'l', 'n', 'e', 'p', 'i', 'u', 'm', 't'])
/** 有單鍵的派工；推送（publish）走「⇡ 開 PR」「⇡ push」兩顆按鈕，不在這裡。 */
type KeyedKind = Exclude<DispatchKind, 'publish'>
const isKeyed = (k: DispatchKind): k is KeyedKind => k !== 'publish'
const DISPATCH_HOTKEY: Record<KeyedKind, string> = { continue: 'g', sync: 's', review: 'w', reply: 'y' }
const DISPATCH_GLYPH: Record<KeyedKind, string> = { continue: '▶', sync: '↻', review: '◆', reply: '↩' }

export const KV_LABEL = 8
const KV_LINES = 2
/** 現在卡內容的縮排：左邊的「▎ 」邊條已經佔掉原本的 2 格縮排，內容不再另外縮。 */
const INDENT = 0

export const picksKey = (c: Case) => `${c.statusPath}\n${c.ask}`

/** 畫面上才知道、turnOf 需要的事。 */
export function turnCtx(view: PaneView, c: Case): TurnCtx {
  const agentQueued = (view.agentQueue ?? []).indexOf(c.statusPath) + 1
  return { verifying: c.statusPath in view.verifying, queued: view.queue.includes(c.statusPath), launching: c.statusPath in view.launching, ...(agentQueued ? { agentQueued } : {}), tutorial: !!view.s.tutorial, sent: sentState(view.sent, c), now: view.now }
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

/** footer 上的一個操作：按鈕，或一段文字（例如「派工中」）。width 是畫出來約佔的格數，用來排列。 */
export type Action = { key: string; label: string; hotkey?: string; isDim?: boolean; isLead?: boolean; isBoxed?: boolean; onPress?: () => void; color?: string; width: number }

/** 上線確認只在最後一段：已經有 tag 包含這個 commit、關卡是 release：…（部署完由你按）。 */
export const canShip = (c: Case) => c.pipeline?.current === 'ship' && !!c.tag && parseGate(c.gate)?.kind === 'release'
/** 只有 desk 派出去、正在跑的那個才能從面板停止。 */
const canStop = (c: Case) => (c.state === 'running' || c.state === 'approve') && !!c.agent?.id && /^desk-/.test(c.agent.name)
/** Agent 不在時的這件：執行中鎖住的確認規格、歸檔照原本的條件判斷要不要列（Agent 在跑時那兩個條件本來就不成立）。 */
function withoutAgent(c: Case): Case {
  const { agent: _running, ...rest } = c
  return c.state === 'running' || c.state === 'approve' ? { ...rest, state: finalState({ ...rest, state: 'ready' }) } : rest
}

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

/** 完成檢查：結果一列、指令一列；失敗或展開時附輸出尾巴。可歸檔時已經沒有要檢查的事，只留結果一列（x 展開照舊）。 */
function verifyRows(ui: any, c: Case, v: Verify | undefined, running: boolean, view: PaneView, queuedAt: number, width: number): any[] {
  const { Box, Text } = ui
  if (!c.verify) return []
  const stale = v && v.command !== c.verify
  const show = v && !stale ? v : undefined
  const brief = canArchive(c) && !view.isExpanded
  const tail = show && (!show.ok || view.isExpanded) ? show.tail : []
  const room = Math.max(10, width - INDENT - KV_LABEL)
  const result = running ? <Text color={COLOR.running}>執行中</Text>
    : queuedAt >= 0 ? <Text color={COLOR.running}>{`排隊中（第 ${queuedAt + 1} 位）`}</Text>
    : show ? <Text color={show.ok ? COLOR.good : COLOR.bad}>{show.ok ? (brief ? '✓ 通過' : `✓ 通過 ${hhmm(show.at)}`) : `✕ 未通過（結束碼 ${show.exitCode}）· ${hhmm(show.at)}`}</Text>
    : <Text color={COLOR.faint}>{v && v.command === c.verify ? '有新 commit，需重新執行' : '尚未執行'}</Text>
  const head = <Box flexDirection="row" paddingLeft={INDENT}><Text color={COLOR.faint}>{pad(WORD.verify, KV_LABEL)}</Text>{result}</Box>
  if (brief) return [head]
  return [
    head,
    <Box flexDirection="row" paddingLeft={INDENT + KV_LABEL}><Text color={COLOR.faint} wrap="truncate-end">{fit(shortCommand(c.verify), room)}</Text></Box>,
    ...tail.map(line => <Box flexDirection="row" paddingLeft={INDENT + KV_LABEL}><Text color={show!.ok ? COLOR.dim : COLOR.bad} wrap="truncate-end">{fit(line, room)}</Text></Box>),
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
  const gate = parseGate(c.gate)
  const prefix = `case-${c.statusPath}-`
  // 狀態字是反白徽章：前後各多一格。
  const tailText = `   ${meta.label} ${age ? ` · ${age}` : ''}`
  const title = <Text bold color={COLOR.text} wrap="truncate-end">{fit(c.name, Math.max(4, width - 2 - displayWidth(tailText)))}</Text>
  // 任務名只是文字：點了不動作。取消選取在「更多動作」裡。
  const rows: any[] = []

  rows.push(
    <Box flexDirection="row">
      <Text color={meta.color}>{spin} </Text>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">{title}</Box>
      <Text>{'  '}</Text>
      <Text color={meta.color} bold inverse>{` ${meta.label} `}</Text>
      {age ? <Text color={COLOR.faint}>{` · ${age}`}</Text> : null}
    </Box>,
  )
  const turn = turnOf(c, turnCtx(view, c))
  // Agent 在跑：「處理中」同列寫已執行多久，下一列是它最後一句輸出（取代下方的 Agent 列，列數不變）。
  const isWorking = c.state === 'running' && turn.who === 'ai'
  const elapsed = isWorking && c.agent?.startedAt ? elapsedText(view.now - c.agent.startedAt) : ''
  const latest = isWorking ? c.agent?.last ?? '' : ''
  rows.push(...turnRows(ui, turn, width, view.tick, elapsed))
  if (latest) rows.push(...(view.isExpanded ? wrapText(`└ 最新：${latest}`, width - INDENT) : [fit(`└ 最新：${latest}`, width - INDENT)]).map(line => <Box paddingLeft={INDENT}><Text color={COLOR.dim} wrap="truncate-end">{line}</Text></Box>))
  // 完成的任務：六段全部轉綠，後面接「✓ 完成 <tag>」。六段的備註（例如「可繼續實作」）由上一列的話取代。
  const isDone = c.state === 'done'
  // 執行中：進行中那段在 ◉／◎ 間交替，跟著 tick 動。
  const pulse = (p: { text: string; status: string }) => c.state === 'running' && p.status === 'active' ? p.text.replace(ACTIVE_PULSE[0]!, ACTIVE_PULSE[view.tick % ACTIVE_PULSE.length]!) : p.text
  if (c.pipeline) rows.push(<Box paddingLeft={INDENT}><Text wrap="truncate-end">{stageParts(c.pipeline, width < 30).map((p, i) => <Text key={`st${i}`} color={isDone ? COLOR.good : STAGE_COLOR[p.status]}>{(i && width >= 30 ? ' ' : '') + pulse(p)}</Text>)}{isDone ? <Text color={COLOR.good} bold>{`   ✓ 完成${c.tag ? ` ${c.tag}` : ''}`}</Text> : null}</Text></Box>)
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
  if (cardBehind(c, view.now)) rows.push(...kvRows(ui, '卡片', `分支最近一次變更（${ago(c.commitAt!, view.now)}）比卡片新：按 s 同步`, width, false, COLOR.attention, 1))
  if (c.reviewTop?.length) rows.push(...kvRows(ui, GATE_LABEL.review, c.reviewTop.join('；'), width, view.isExpanded, COLOR.bad, 3))
  // 合併之後：六段全過才叫你歸檔，否則是上線段那一句（跟「▶ 輪到你」相同；等你時也不換成別的話）。
  // Agent 在跑時 u 與歸檔都鎖著：已打 tag（要你按 u 或歸檔）或六段全過時不叫你做，只說它完成後再做；
  // 還沒打 tag 的發版那句照舊（發版只填輸入框，不鎖）。部署步驟照常列出，可以先看。
  const archive = `${CARD_CMD} archive ${slugOf(c)}`
  const ship = shipTurn(c, view.s.tutorial)
  const toShip = !!c.tag && parseGate(c.gate)?.kind === 'release' && !isDone
  const waitAgent = isBusy(c) && (isDone || !!c.tag) ? `Agent 執行中，完成後再${toShip ? '確認上線' : '歸檔'}` : ''
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
  if (!c.manual && !c.verify && c.hasCard) rows.push(...wrappedRows(ui, '卡片尚缺完成檢查：請先寫一條「修正前失敗、修正後通過」的指令，才能派實作', width, COLOR.attention))
  return rows
}

/** 現在這件的操作（footer 第一排）：填入決策、派工、停止、輸出、審查檔、PR、檢查、開卡片。現在該按的那顆不變淡。 */
export function caseActions(view: PaneView, c: Case, act: PaneActions): Action[] {
  // 示範任務只能看：連 m 展開全部也沒有動作。
  if (c.demo) return []
  const decisions = c.state === 'ask' ? parseDecisions(c.ask) : []
  const picks = view.picks[picksKey(c)] ?? {}
  const ready = allPicked(decisions, picks)
  const isVerifying = c.statusPath in view.verifying
  const queuedAt = view.queue.indexOf(c.statusPath)
  const ctx = turnCtx(view, c)
  const leadKey = turnOf(c, ctx).key
  const inStage = stageActions(c, ctx)
  const allowed = view.showAll ? null : inStage
  const can = (id: ActionId) => !allowed || allowed.has(id)
  const prefix = `case-${c.statusPath}-`
  const out: Action[] = []
  // Agent 執行中或等批准：會搶 worktree／卡片的動作只列成淡色文字、寫原因，連 m 展開也按不了。
  const busy = isBusy(c)
  const idle = busy ? withoutAgent(c) : c
  const locked = (id: ActionId, label: string) => out.push(button({ key: prefix + id, label: `${label}${WORD.busyLocked}`, color: COLOR.faint }))
  // 決策送出了、等對話寫回：連 m 展開全部也不給 f，免得重送。
  if (choiceCount(decisions) && can('fill') && ctx.sent !== 'waiting') out.push(button({ key: prefix + 'fill', hotkey: 'f', isLead: ready, isBoxed: ready, isDim: !ready, label: ready ? `✎ ${WORD.fill}：${decisionAnswer(decisions, picks)}` : `✎ ${WORD.fill}`, onPress: () => act.fill(c) }))
  if (c.statusPath in view.launching) out.push(button({ key: prefix + 'launching', label: `${SPINNER[view.tick % SPINNER.length]} 派工中`, color: COLOR.running }))
  // 派工排隊中：跟派工中一樣不列派工鍵；還沒派出去，取消按一次就好。
  else if (ctx.agentQueued) {
    out.push(button({ key: prefix + 'agent-queued', label: `… 派工排隊中（第 ${ctx.agentQueued} 位）`, color: COLOR.faint }))
    if (can('unqueue')) out.push(button({ key: prefix + 'unqueue', hotkey: 'k', label: '■ 取消排隊', onPress: () => act.unqueue(c) }))
  }
  else for (const k of dispatchable(c).filter(isKeyed).filter(k => (decisions.length === 0 || k !== 'continue') && can(k))) {
    const armed = isArmed(view.armed, `${c.statusPath}\n${k}`, view.now)
    // 卡片比分支最近一次變更舊：同步不變淡；這一段另有該按的鍵時不搶它的位置。
    const hint = k === 'sync' && cardBehind(c, view.now)
    out.push(button({ key: prefix + k, hotkey: DISPATCH_HOTKEY[k], isBoxed: armed, isLead: armed || leadKey === DISPATCH_HOTKEY[k] || (hint && !leadKey), isDim: !armed && leadKey !== DISPATCH_HOTKEY[k] && !hint, label: armed ? `再按 ${DISPATCH_HOTKEY[k]} 確認${KIND_LABEL[k]}（${modelText(view, k, c)}）` : `${DISPATCH_GLYPH[k]} ${KIND_LABEL[k]}`, onPress: () => act.dispatch(c, k) }))
  }
  if (!ctx.agentQueued && canStop(c) && can('stop')) {
    const armed = isArmed(view.armed, `${c.statusPath}\nstop`, view.now)
    out.push(button({ key: prefix + 'stop', hotkey: 'k', isBoxed: armed, isLead: armed, isDim: !armed, label: armed ? '再按 k 確認停止' : '■ 停止', onPress: () => act.stop(c) }))
  }
  if (c.agent?.id && can('logs')) out.push(button({ key: prefix + 'logs', hotkey: 'l', isDim: true, label: view.logsOpen === c.statusPath ? '▴ 收起輸出' : '≡ 輸出', onPress: () => act.logs(c) }))
  if ((c.reviewTop?.length || riskyNoPr(c)) && can('review-file')) out.push(button({ key: prefix + 'review-file', hotkey: 'e', isDim: leadKey !== 'e', isLead: leadKey === 'e', label: '↗ 審查檔', onPress: () => act.openReview(c) }))
  if (c.pr?.url && can('pr')) out.push(button({ key: prefix + 'pr', hotkey: 'p', isDim: leadKey !== 'p', isLead: leadKey === 'p', label: '↗ PR', onPress: () => act.openPr(c) }))
  // 發版：只填輸入框、不寫遠端，按一次就好；沒有快捷鍵（「▶ 輪到你」不帶鍵，它就帶頭）。
  if (!view.s.tutorial && canRelease(c) && can('release')) out.push(button({ key: prefix + 'release', isLead: !leadKey, isDim: !!leadKey, label: '⚑ 發版', onPress: () => act.release(c) }))
  // 推送 Agent：「⇡ 開 PR」「⇡ push」按兩次確認才派，沒有快捷鍵（寫遠端的事不配單鍵）。高風險改動的第一次按改提醒先看過審查檔。
  const publish = (id: 'open-pr' | 'push', doing: string, onPress: () => void) => {
    const armed = isArmed(view.armed, `${c.statusPath}\n${id}`, view.now)
    const ask = id === 'open-pr' && needsPrConfirm(c) ? '看過審查檔了？再按一次' : '再按一次'
    out.push(button({ key: prefix + id, isBoxed: armed, isLead: armed || !leadKey, isDim: !armed && !!leadKey, label: armed ? `${ask}確認派 Agent ${doing}（${modelText(view, 'publish', c)}）` : `⇡ ${doing}`, onPress }))
  }
  if (needsPr(c) && can('open-pr')) publish('open-pr', '開 PR', () => act.publishPr(c))
  if (needsPush(c) && can('push')) publish('push', 'push', () => act.publishPush(c))
  if (c.verify && can('verify') && busy) locked('verify', `▶ ${WORD.verify}`)
  else if (c.verify && can('verify')) out.push(button({ key: prefix + 'verify', hotkey: 'v', isDim: isVerifying || leadKey !== 'v', isLead: !isVerifying && leadKey === 'v', label: isVerifying ? `${SPINNER[view.tick % SPINNER.length]} ${WORD.verify}中` : queuedAt >= 0 ? '… 排隊中' : `▶ ${WORD.verify}`, onPress: () => act.verify(c) }))
  if (canShip(c) && can('ship') && busy) locked('ship', '✓ 上線確認')
  else if (canShip(c) && can('ship')) {
    const armed = isArmed(view.armed, `${c.statusPath}\nship`, view.now)
    out.push(button({ key: prefix + 'ship', hotkey: 'u', isBoxed: armed, isLead: armed || leadKey === 'u', label: armed ? (archivesOnShip(c, !!view.s.tutorial) ? '再按 u 確認上線並歸檔（清除 release 關卡）' : '再按 u 確認已上線（清除 release 關卡）') : '✓ 上線確認', onPress: () => act.ship(c) }))
  }
  if (!view.s.tutorial && busy && awaitsSpecOk(idle) && can('spec-ok')) locked('spec-ok', '✓ 確認規格')
  else if (!view.s.tutorial && awaitsSpecOk(c) && can('spec-ok')) {
    const armed = isArmed(view.armed, `${c.statusPath}\nspec-ok`, view.now)
    out.push(button({ key: prefix + 'spec-ok', hotkey: 't', isBoxed: armed || leadKey === 't', isLead: armed || leadKey === 't', isDim: !armed && leadKey !== 't', label: armed ? '再按 t 確認規格' : '✓ 確認規格', onPress: () => act.specOk(c) }))
  }
  if (!view.s.tutorial && busy && canArchive(idle) && can('archive')) locked('archive', '⌫ 歸檔')
  else if (!view.s.tutorial && canArchive(c) && can('archive')) {
    const armed = isArmed(view.armed, `${c.statusPath}\narchive`, view.now)
    out.push(button({ key: prefix + 'archive', isBoxed: armed, isLead: armed, isDim: !armed, label: armed ? '再按一次確認歸檔' : '⌫ 歸檔', onPress: () => act.archive(c) }))
  }
  const lesson = view.s.tutorial ? tutorialStep(c) : null
  if (lesson && can('tutorial')) out.push(button({ key: prefix + 'tutorial', hotkey: 't', isLead: leadKey === 't', isBoxed: leadKey === 't', isDim: leadKey !== 't', label: TUTORIAL_STEP_LABEL[lesson], onPress: () => act.tutorial(c) }))
  if (can('open')) out.push(button({ key: prefix + 'open', hotkey: 'o', isDim: leadKey !== 'o', isLead: leadKey === 'o', label: `↗ ${WORD.open}`, onPress: () => act.open(c) }))
  return view.showAll ? withRetreat(out, c, inStage, prefix) : out
}

/** 合併段退回前面段落的鍵：繼續、審查、檢查。 */
const RETREAT = new Set<string>(['continue', 'review', 'verify'])

/**
 * 展開全部動作（m）時，合併段平常不列的退回鍵（繼續、審查、檢查）排在本段的動作後面、變淡、不帶頭，
 * 前面插一段不可按的「退回：」。本段列了的（例如 CI 失敗時的繼續、自審的審查）不算退回；
 * 只看這三個鍵，不拿 stageActions 的補集（Agent 在跑時它不列開 PR）。已待確認（加框）的照舊，第一次按了才看得到確認字樣。其他段落不分組。
 */
function withRetreat(out: Action[], c: Case, inStage: Set<ActionId>, prefix: string): Action[] {
  if (c.pipeline?.current !== 'merge' || isMerged(c)) return out
  const isBack = (a: Action) => {
    const id = a.key.slice(prefix.length)
    return RETREAT.has(id) && !inStage.has(id as ActionId)
  }
  const back = out.filter(isBack)
  if (!back.length) return out
  return [
    ...out.filter(a => !isBack(a)),
    button({ key: prefix + 'retreat', label: '退回：', color: COLOR.faint }),
    ...back.map(a => (a.isBoxed ? a : { ...a, isLead: false, isDim: true })),
  ]
}
