// 現在卡：一列一個元素（content 會捲動，列數要算得出來），操作按鈕另外列成清單交給常駐的 footer 排。
import type { Case, Verify } from '../types'
import { allPicked, choiceCount, decisionAnswer, parseDecisions, parseGate, splitClauses, ARCHIVE_WORD, CARD_CMD, GATE_LABEL } from './card'
import { ago, displayWidth, fit, hhmm, pad, slugOf, summary } from './model'
import { COLOR, SPINNER, STATE, WORD } from './theme'
import { KIND_LABEL, dispatchable } from './dispatch'
import { awaitsSpecOk, canArchive, stageParts } from './pipeline'
import { gitLine, isArmed } from './extras'
import { compactStatus } from './digest-status'
import { STAGE_COLOR } from './band'
import { wrapText } from './layout'
import { cardBehind, needsPr, needsPush, sentState, shipTurn, stageActions, turnOf } from './turn'
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
const INDENT = 2

export const picksKey = (c: Case) => `${c.statusPath}\n${c.ask}`

/** 畫面上才知道、turnOf 需要的事。 */
export function turnCtx(view: PaneView, c: Case): TurnCtx {
  return { verifying: c.statusPath in view.verifying, queued: view.queue.includes(c.statusPath), launching: c.statusPath in view.launching, tutorial: !!view.s.tutorial, sent: sentState(view.sent, c) }
}

const TURN_LABEL: Record<Turn['who'], string> = { you: '▶ 輪到你', ai: '◐ 處理中', none: '— 沒有待辦' }
const TURN_COLOR: Record<Turn['who'], string> = { you: COLOR.attention, ai: COLOR.running, none: COLOR.faint }

/** 現在卡最上方那一句：輪到誰＋該做什麼（寫給人看，不是卡片給 Agent 的下一步）。 */
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

/** 現在卡的內容列：任務名、六段、PR、狀態、git、審查、部署、決策、Agent、下一步、檢查。 */
export function nowCardRows(ui: any, view: PaneView, c: Case, width: number, act: PaneActions): any[] {
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
  const tailText = `  ${meta.label}${age ? ` · ${age}` : ''}`
  const title = <Text bold color={COLOR.text} wrap="truncate-end">{fit(c.name, Math.max(4, width - 2 - displayWidth(tailText)))}</Text>
  // 你在清單上選的那件：再點一次任務名取消選取，現在卡與摘要列回到工作桌自己挑的那件。
  const isPicked = view.selected === c.statusPath
  const rows: any[] = []

  rows.push(
    <Box flexDirection="row">
      <Text color={meta.color}>{spin} </Text>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">{isPicked
        ? <Button plain key={prefix + 'name'} onPress={() => act.select(c.statusPath)}>{title}</Button>
        : title}</Box>
      <Text color={meta.color} bold>{`  ${meta.label}`}</Text>
      {age ? <Text color={COLOR.faint}>{` · ${age}`}</Text> : null}
    </Box>,
  )
  rows.push(...turnRows(ui, turnOf(c, turnCtx(view, c)), width))
  // 完成的任務：六段全部轉綠，後面接「✓ 完成 <tag>」。六段的備註（例如「可繼續實作」）由上一列的話取代。
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
  // 面板外有新的變更、卡片沒跟著寫：提示同步（新對話只讀卡片與 git，把五欄寫回）。
  if (cardBehind(c, view.now)) rows.push(...kvRows(ui, '卡片', `分支最近一次變更（${ago(c.commitAt!, view.now)}前）比卡片新：按 s 同步`, width, false, COLOR.attention, 1))
  if (c.reviewTop?.length) rows.push(...kvRows(ui, '審查', c.reviewTop.join('；'), width, view.isExpanded, COLOR.bad, 3))
  // 合併之後：六段全過才叫你歸檔，否則是上線段那一句（跟「▶ 輪到你」相同；Agent 在跑、等你時也不換成別的話）。
  const archive = `${CARD_CMD} archive ${slugOf(c)}`
  const ship = shipTurn(c)
  const afterDeploy = isDone ? archive : ship.key === 'u' ? '按 u 確認上線' : ship.text
  if (c.pr?.state === 'MERGED' || gitMerged) rows.push(...(c.deploySteps?.length
    ? kvRows(ui, '部署', c.deploySteps.map((x, i) => `${i + 1}. ${x}`).join('；') + `；全部做完後：${afterDeploy}`, width, true, COLOR.attention)
    : kvRows(ui, '下一步', isDone ? `已合併，${ARCHIVE_WORD}：${archive}` : ship.text, width, false, COLOR.attention, 1)))

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
    const [first, ...rest] = wrapText(`${head}  ${gate.detail}${gate.kind === 'review' && c.chain?.selfReview ? '（自審）' : ''}`, width - INDENT)
    rows.push(<Box paddingLeft={INDENT}><Text wrap="truncate-end"><Text color={COLOR.attention} bold>{head}</Text><Text color={COLOR.text}>{(first ?? '').slice(head.length)}</Text></Text></Box>)
    rows.push(...rest.map(line => <Box paddingLeft={INDENT}><Text color={COLOR.text} wrap="truncate-end">{line}</Text></Box>))
  }
  if (c.state === 'running') rows.push(...kvRows(ui, 'Agent', c.agent?.last || c.next, width, view.isExpanded, COLOR.running))
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
  const allowed = view.showAll ? null : stageActions(c, ctx)
  const can = (id: ActionId) => !allowed || allowed.has(id)
  const prefix = `case-${c.statusPath}-`
  const out: Action[] = []
  // 決策送出了、等對話寫回：連 m 展開全部也不給 f，免得重送。
  if (choiceCount(decisions) && can('fill') && ctx.sent !== 'waiting') out.push(button({ key: prefix + 'fill', hotkey: 'f', isLead: ready, isBoxed: ready, isDim: !ready, label: ready ? `✎ ${WORD.fill}：${decisionAnswer(decisions, picks)}` : `✎ ${WORD.fill}`, onPress: () => act.fill(c) }))
  if (c.statusPath in view.launching) out.push(button({ key: prefix + 'launching', label: `${SPINNER[view.tick % SPINNER.length]} 派工中`, color: COLOR.running }))
  else for (const k of dispatchable(c).filter(isKeyed).filter(k => (decisions.length === 0 || k !== 'continue') && can(k))) {
    const armed = isArmed(view.armed, `${c.statusPath}\n${k}`, view.now)
    // 卡片比分支最近一次變更舊：同步不變淡；這一段另有該按的鍵時不搶它的位置。
    const hint = k === 'sync' && cardBehind(c, view.now)
    out.push(button({ key: prefix + k, hotkey: DISPATCH_HOTKEY[k], isBoxed: armed, isLead: armed || leadKey === DISPATCH_HOTKEY[k] || (hint && !leadKey), isDim: !armed && leadKey !== DISPATCH_HOTKEY[k] && !hint, label: armed ? `再按 ${DISPATCH_HOTKEY[k]} 確認${KIND_LABEL[k]}（${modelText(view, k)}）` : `${DISPATCH_GLYPH[k]} ${KIND_LABEL[k]}`, onPress: () => act.dispatch(c, k) }))
  }
  if (canStop(c) && can('stop')) {
    const armed = isArmed(view.armed, `${c.statusPath}\nstop`, view.now)
    out.push(button({ key: prefix + 'stop', hotkey: 'k', isBoxed: armed, isLead: armed, isDim: !armed, label: armed ? '再按 k 確認停止' : '■ 停止', onPress: () => act.stop(c) }))
  }
  if (c.agent?.id && can('logs')) out.push(button({ key: prefix + 'logs', hotkey: 'l', isDim: true, label: view.logsOpen === c.statusPath ? '▴ 收起輸出' : '≡ 輸出', onPress: () => act.logs(c) }))
  if (c.reviewTop?.length && can('review-file')) out.push(button({ key: prefix + 'review-file', hotkey: 'e', isDim: leadKey !== 'e', isLead: leadKey === 'e', label: '↗ 審查檔', onPress: () => act.openReview(c) }))
  if (c.pr?.url && can('pr')) out.push(button({ key: prefix + 'pr', hotkey: 'p', isDim: leadKey !== 'p', isLead: leadKey === 'p', label: '↗ PR', onPress: () => act.openPr(c) }))
  // 推送 Agent：「⇡ 開 PR」「⇡ push」按兩次確認才派，沒有快捷鍵（寫遠端的事不配單鍵）。
  if (needsPr(c) && can('open-pr')) {
    const armed = isArmed(view.armed, `${c.statusPath}\nopen-pr`, view.now)
    out.push(button({ key: prefix + 'open-pr', isBoxed: armed, isLead: armed || !leadKey, isDim: !armed && !!leadKey, label: armed ? `再按一次確認派 Agent 開 PR（${modelText(view, 'publish')}）` : '⇡ 開 PR', onPress: () => act.publishPr(c) }))
  }
  if (needsPush(c) && can('push')) {
    const armed = isArmed(view.armed, `${c.statusPath}\npush`, view.now)
    out.push(button({ key: prefix + 'push', isBoxed: armed, isLead: armed || !leadKey, isDim: !armed && !!leadKey, label: armed ? `再按一次確認派 Agent push（${modelText(view, 'publish')}）` : '⇡ push', onPress: () => act.publishPush(c) }))
  }
  if (c.verify && can('verify')) out.push(button({ key: prefix + 'verify', hotkey: 'v', isDim: isVerifying || leadKey !== 'v', isLead: !isVerifying && leadKey === 'v', label: isVerifying ? `${SPINNER[view.tick % SPINNER.length]} 檢查中` : queuedAt >= 0 ? '… 排隊中' : `▶ ${WORD.verify}`, onPress: () => act.verify(c) }))
  if (canShip(c) && can('ship')) {
    const armed = isArmed(view.armed, `${c.statusPath}\nship`, view.now)
    out.push(button({ key: prefix + 'ship', hotkey: 'u', isBoxed: armed, isLead: armed || leadKey === 'u', label: armed ? '再按 u 確認已上線（清除 release 關卡）' : '✓ 上線確認', onPress: () => act.ship(c) }))
  }
  if (!view.s.tutorial && awaitsSpecOk(c) && can('spec-ok')) {
    const armed = isArmed(view.armed, `${c.statusPath}\nspec-ok`, view.now)
    out.push(button({ key: prefix + 'spec-ok', hotkey: 't', isBoxed: armed || leadKey === 't', isLead: armed || leadKey === 't', isDim: !armed && leadKey !== 't', label: armed ? '再按 t 確認規格' : '✓ 確認規格', onPress: () => act.specOk(c) }))
  }
  if (!view.s.tutorial && canArchive(c) && can('archive')) {
    const armed = isArmed(view.armed, `${c.statusPath}\narchive`, view.now)
    out.push(button({ key: prefix + 'archive', isBoxed: armed, isLead: armed, isDim: !armed, label: armed ? '再按一次確認歸檔' : '⌫ 歸檔', onPress: () => act.archive(c) }))
  }
  const lesson = view.s.tutorial ? tutorialStep(c) : null
  if (lesson && can('tutorial')) out.push(button({ key: prefix + 'tutorial', hotkey: 't', isLead: leadKey === 't', isBoxed: leadKey === 't', isDim: leadKey !== 't', label: TUTORIAL_STEP_LABEL[lesson], onPress: () => act.tutorial(c) }))
  out.push(button({ key: prefix + 'open', hotkey: 'o', isDim: leadKey !== 'o', isLead: leadKey === 'o', label: `↗ ${WORD.open}`, onPress: () => act.open(c) }))
  return out
}
