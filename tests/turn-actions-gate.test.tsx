import { expect, test } from 'claude-code/testing'
import { buildCase, stateOf } from '../hooks/model'
import { finalState, pipeline } from '../hooks/pipeline'
import { AGENT_STOPPED, CHECK_CHANGED, CHECK_UNAPPROVED } from '../hooks/chain'
import { ACTIONS, HOTKEY } from '../hooks/actions'
import type { ActionId } from '../hooks/actions'
import { isHandling, stageActions, turnOf } from '../hooks/turn'
import { caseActions, turnCtx } from '../hooks/pane-card'
import type { Action } from '../hooks/pane-card'
import type { AgentInfo, Case, ChainInfo, Verify } from '../types'
import { fixture, CARD_B, PANE, REGISTRY, flat, text } from './fixture'

// 守門矩陣（卡片「提示與動作單一來源」規格）：「▶ 輪到你」那句指定的動作、句子裡的「按 X」與 footer 畫出的動作一致。
// 維度與值照規格列舉，不另加；取法照規格的 1～4。

const PATH = '/w/age-group/.desk/CARD.md'
const ROOT = '/w/age-group'
const PASSED_REVIEW = 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
const CHOICE = '要 push 嗎？A) 要 B) 等'
const QUOTA = '5 小時額度剩 20%，低於門檻 30%，13:00 重置後按 g 重開'
const PR_URL = 'https://github.com/acme/shop/pull/12'
const pr = (over: Partial<NonNullable<Case['pr']>> = {}): NonNullable<Case['pr']> => ({ id: 12, state: 'OPEN', ci: 'pass', url: PR_URL, ...over })
const synced = { ahead: 0, behind: 0, changed: 0, untracked: 0, upstream: true }
const passed: Verify = { command: 'npm test', at: 1, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h1' }
const failed: Verify = { ...passed, ok: false, exitCode: 1 }

/** 一種段落情境：卡片欄位、疊上的 Case 欄位、檢查結果；current 是直接指定的段落（照 tests/turn.test.ts 的 atCheck）。 */
type Segment = { name: string; card?: { check?: string; ask?: string; next?: string; gate?: string }; extra?: Partial<Case>; verify?: Verify; current?: 'check' }

const SEGMENTS: Segment[] = [
  // 規格
  { name: '規格：spec 關卡待確認', card: { gate: 'spec：待確認規格' } },
  { name: '規格：缺驗收情境', card: { gate: 'spec：待確認規格' }, extra: { specGap: true } },
  { name: '規格：缺測試指令', card: { check: '無' } },
  // 實作
  { name: '實作：一般下一步' },
  { name: '實作：下一步只剩等待', card: { next: '到面板按 v 執行完成檢查' } },
  { name: '實作：下一步是驗收', card: { next: '派審查' } },
  { name: '實作：測試沒過', verify: failed },
  { name: '實作：流程停下', extra: { chain: { round: 1, stopped: '修了 2 輪仍有 CRITICAL 0、HIGH 1' } } },
  { name: '實作：Agent 被停', extra: { chain: { round: 0, stopped: AGENT_STOPPED } } },
  { name: '實作：額度煞車', extra: { chain: { round: 0, stopped: QUOTA } } },
  { name: '實作：等你有選項', card: { ask: CHOICE } },
  { name: '實作：等你沒有選項', card: { ask: '請先在終端機登入 gh' } },
  // 測試
  { name: '測試：新一輪', extra: { chain: { round: 0, lastKind: 'continue', autoReview: true } }, current: 'check' },
  { name: '測試：驗收後有新 commit', extra: { chain: { round: 0, stale: true, passed: true } } },
  { name: '測試：指令改過', extra: { chain: { round: 0, stopped: CHECK_CHANGED, heldAtCheck: true } }, current: 'check' },
  { name: '測試：指令未核准', extra: { chain: { round: 0, stopped: CHECK_UNAPPROVED, heldAtCheck: true } }, current: 'check' },
  { name: '測試：別的對話的流程停在測試', extra: { chain: { round: 0, stopped: CHECK_UNAPPROVED, heldAtCheck: true, foreign: true } }, current: 'check' },
  // 驗收
  { name: '驗收：沒結論', verify: passed },
  { name: '驗收：有結論', card: { gate: 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核' }, extra: { chain: { round: 0 } }, verify: passed },
  { name: '驗收：會自動驗收', extra: { chain: { round: 0, lastKind: 'continue', autoReview: true } }, verify: passed },
  { name: '驗收：自審', card: { gate: PASSED_REVIEW }, extra: { chain: { round: 0, selfReview: true } } },
  // 合併
  { name: '合併：沒 PR', card: { gate: PASSED_REVIEW } },
  { name: '合併：高風險沒 PR', card: { gate: PASSED_REVIEW }, extra: { chain: { round: 0, passed: true, needsHuman: '高風險改動（認證）' } } },
  { name: '合併：PR 開著且分支領先', card: { gate: PASSED_REVIEW }, extra: { pr: pr(), gitState: { ...synced, ahead: 1 } } },
  { name: '合併：CI 跑中', card: { gate: PASSED_REVIEW }, extra: { pr: pr({ ci: 'pending' }), gitState: synced } },
  { name: '合併：CI 失敗', card: { gate: PASSED_REVIEW }, extra: { pr: pr({ ci: 'fail' }), gitState: synced } },
  { name: '合併：CI 通過', card: { gate: PASSED_REVIEW }, extra: { pr: pr(), gitState: synced } },
  { name: '合併：衝突且自動解', card: { gate: PASSED_REVIEW }, extra: { pr: pr(), gitState: synced, chain: { round: 0, passed: true }, conflict: { into: 'main', ref: 'origin/main', files: ['a.ts'], dirty: 0 } } },
  { name: '合併：衝突且要手動解', card: { gate: PASSED_REVIEW }, extra: { pr: pr(), gitState: synced, conflict: { into: 'main', ref: 'origin/main', files: ['a.ts'], dirty: 0 } } },
  // 上線
  { name: '上線：沒 tag', card: { gate: PASSED_REVIEW }, extra: { pr: pr({ state: 'MERGED' }) } },
  { name: '上線：有 tag＋release 關卡', card: { gate: 'release：v0.2.0 待上線確認' }, extra: { pr: pr({ state: 'MERGED' }), tag: 'v0.2.0' } },
  { name: '上線：有 tag 沒關卡（可歸檔）', card: { gate: PASSED_REVIEW }, extra: { pr: pr({ state: 'MERGED' }), tag: 'v0.2.0' } },
  { name: '上線：隨發版線', card: { gate: PASSED_REVIEW }, extra: { pr: pr({ state: 'MERGED', dest: 'release/v1.4' }) } },
  { name: '上線：已上線', card: { next: '可歸檔' }, extra: { tag: 'v0.2.0' } },
]

const busy = (name: string, over: Partial<AgentInfo> = {}): AgentInfo => ({ id: 'a1b2c3d4', name, state: 'working', status: 'busy', ...over })
const DESK = 'desk-mw2ar92l-3'
/** Agent 狀態（6 種）。 */
const AGENTS: { name: string; agent?: AgentInfo }[] = [
  { name: '無' },
  { name: 'desk 派的在跑', agent: busy(DESK) },
  { name: '不是 desk 派的在跑', agent: busy('main-chat') },
  { name: '停在提問', agent: busy(DESK, { status: 'waiting', waitsFor: 'question', waitingFor: '要用哪個資料庫？' }) },
  { name: '等權限批准', agent: busy(DESK, { status: 'waiting', waitsFor: 'permission', waitingFor: 'permission to run Bash' }) },
  { name: '跑完閒置', agent: busy(DESK, { state: 'done', status: 'idle' }) },
]

/** 畫面狀態（7 種）：決策已送出／沒寫回兩值把卡片「等你」換成有選項的題目。 */
type Screen = { name: string; verifying?: boolean; queued?: boolean; launching?: boolean; agentQueued?: boolean; sent?: 'waiting' | 'unwritten' }
const SCREENS: Screen[] = [
  { name: '無' }, { name: '測試在跑', verifying: true }, { name: '測試排隊', queued: true }, { name: '派工中', launching: true },
  { name: '派工排隊', agentQueued: true }, { name: '決策已送出等寫回', sent: 'waiting' }, { name: '決策沒寫回', sent: 'unwritten' },
]

/** 流程擁有者（4 種）：疊在段落情境自己的流程紀錄上。 */
type Owner = { name: string; chain: (seg?: ChainInfo) => ChainInfo | undefined }
const OWNERS: Owner[] = [
  { name: '無', chain: seg => seg },
  { name: '自己', chain: seg => ({ round: 0, ...seg }) },
  { name: '別的對話', chain: seg => ({ round: 0, ...seg, foreign: true }) },
  { name: '已停', chain: seg => ({ round: 0, ...seg, stopped: seg?.stopped ?? '容器沒有啟動' }) },
]
const SELF = OWNERS[1]!

const card = (f: Segment['card'] = {}) =>
  `<!-- DESK -->\n- 狀態：ok\n- 檢查：${f.check ?? '`npm test`'}\n- 等你：${f.ask ?? '無'}\n- 下一步：${f.next ?? '依規格實作'}\n- 關卡：${f.gate ?? '無'}\n<!-- /DESK -->`

/** 跟工作桌一樣：讀卡（帶 Agent）→ 疊上 git／PR／流程 → 重算狀態 → 算六段 → 決定是否完成。 */
function mk(seg: Segment, agent: AgentInfo | undefined, owner: Owner, ask?: string): Case {
  const f = ask ? { ...seg.card, ask } : seg.card
  const built = buildCase({ name: 'A', statusPath: PATH }, card(f), 1, agent ? { [ROOT]: agent } : {}, seg.verify)
  const chain = owner.chain(seg.extra?.chain)
  const { state: _built, ...rest } = { ...built, git: { branch: 'feature/a', head: 'h1' }, ...seg.extra, ...(chain ? { chain } : {}) }
  const base = { ...rest, state: stateOf(rest, seg.verify) } as Case
  const piped = { ...base, pipeline: pipeline(base, seg.verify) }
  const c = { ...piped, state: finalState(piped) } as Case
  return seg.current ? { ...c, pipeline: { ...c.pipeline!, current: seg.current } } : c
}

/** 面板的 view：畫面狀態照 Screen 填；sent 用卡片現在的「等你」，跟 sentState 的判斷一致。 */
function viewOf(c: Case, screen: Screen = { name: '無' }, tutorial = false): any {
  return {
    s: { tutorial, cases: [c] }, picks: {}, armed: null, now: 0, logsOpen: null, showAll: false,
    verifying: screen.verifying ? { [PATH]: 1 } : {}, queue: screen.queued ? [PATH] : [], launching: screen.launching ? { [PATH]: 1 } : {},
    agentQueue: screen.agentQueued ? [PATH] : [], sent: screen.sent ? { [PATH]: { ask: c.ask, done: screen.sent === 'unwritten' } } : {},
  }
}
const ACT = new Proxy({}, { get: () => () => {} }) as any

type Combo = { label: string; c: Case; view: any }

/** 取法 1～4：段落×Agent（204）、段落×畫面（238）、擁有者×Agent（72）、教學（3）。 */
function matrix(): Combo[] {
  const out: Combo[] = []
  for (const seg of SEGMENTS) for (const a of AGENTS) {
    const c = mk(seg, a.agent, SELF)
    out.push({ label: `${seg.name} × Agent ${a.name}`, c, view: viewOf(c) })
  }
  for (const seg of SEGMENTS) for (const sc of SCREENS) {
    const c = mk(seg, undefined, SELF, sc.sent ? CHOICE : undefined)
    out.push({ label: `${seg.name} × 畫面 ${sc.name}`, c, view: viewOf(c, sc) })
  }
  const owned = SEGMENTS.filter(s => ['實作：下一步只剩等待', '實作：下一步是驗收', '實作：流程停下', '實作：額度煞車'].includes(s.name) || s.name.startsWith('測試：'))
  for (const seg of owned) for (const o of OWNERS) for (const a of AGENTS.slice(0, 2)) {
    const c = mk(seg, a.agent, o)
    out.push({ label: `${seg.name} × 擁有者 ${o.name} × Agent ${a.name}`, c, view: viewOf(c) })
  }
  const lessons: [string, Segment][] = [
    ['教學：確認規格', SEGMENTS[0]!], ['教學：合併', SEGMENTS.find(s => s.name === '合併：沒 PR')!], ['教學：打 tag', SEGMENTS.find(s => s.name === '上線：沒 tag')!],
  ]
  for (const [label, seg] of lessons) {
    const c = mk(seg, undefined, SELF)
    out.push({ label, c, view: viewOf(c, { name: '無' }, true) })
  }
  return out
}

const ids = (actions: Action[]) => actions.flatMap(a => (a.id ? [a.id] : []))
const leads = (actions: Action[]) => actions.filter(a => a.isLead || a.isBoxed).flatMap(a => (a.id ? [a.id] : []))
const sorted = (xs: Iterable<string>) => [...xs].sort()

function look(m: Combo) {
  const ctx = turnCtx(m.view, m.c)
  const turn = turnOf(m.c, ctx)
  const listed = stageActions(m.c, ctx)
  const footer = caseActions(m.view, m.c, ACT)
  return { ctx, turn, listed, footer }
}

test('守門矩陣照規格的取法：517 組', () => {
  expect(SEGMENTS).toHaveLength(34)
  expect(AGENTS).toHaveLength(6)
  expect(SCREENS).toHaveLength(7)
  expect(OWNERS).toHaveLength(4)
  expect(matrix()).toHaveLength(204 + 238 + 72 + 3)
})

/** AC-1 */
test('test_turn_action_is_listed_and_leads_for_every_matrix_case', () => {
  const bad: string[] = []
  for (const m of matrix()) {
    const { turn, listed, footer } = look(m)
    const drawn = ids(footer)
    const lead = leads(footer)
    if (turn.action && !listed.has(turn.action)) bad.push(`${m.label}：動作 ${turn.action} 不在該出現的動作裡`)
    if (turn.action && !drawn.includes(turn.action)) bad.push(`${m.label}：動作 ${turn.action} 沒畫在 footer`)
    if (turn.key !== (turn.action ? HOTKEY(turn.action) : undefined)) bad.push(`${m.label}：鍵 ${turn.key} 對不上動作 ${turn.action}`)
    if (lead.length > 1) bad.push(`${m.label}：帶頭的不只一顆 ${lead.join('、')}`)
    // 決策選項還沒選完（矩陣裡都沒選）：填入照舊不帶頭。
    const expected = turn.action && turn.action !== 'fill' ? [turn.action] : []
    if (lead.join() !== expected.join()) bad.push(`${m.label}：帶頭的是 ${lead.join('、') || '（無）'}，應為 ${expected.join() || '（無）'}`)
    if (!turn.action && listed.has('sync') && turn.who !== 'ai') bad.push(`${m.label}：卡片落後卻沒帶同步`)
  }
  expect(bad).toEqual([])
})

/**
 * 允許表：句子裡的「按 X」不在 footer 上也可以的句型，每條寫原因。新增要寫原因，不能為了變綠塞進來。
 * o、m、x、i 這類全域鍵寫成「（o 開卡片）」「x 展開」時不是「按 X」，本來就不掃。
 */
const ALLOW: { why: string; whole?: (text: string, c: Case) => boolean; strip?: RegExp }[] = [
  { why: '直接引用卡片「等你」原句：字母是卡片寫的，不是面板的鍵', whole: (t, c) => t === c.ask },
  { why: '要你輸入 /desk:card … 指令：要你打字，不是按鍵', strip: /輸入 \/desk:card [^）；]*/g },
  { why: '額度煞車原句：原因句由流程寫入，照原句顯示', whole: (t, c) => t === c.chain?.stopped && t.startsWith('5 小時額度剩 ') },
  { why: '「通過後按 X」：說的是測試通過之後的步驟，這一刻不在 footer', strip: /通過後按 [a-z]/g },
  { why: '「之後部署並按 u」：打了 tag 之後的步驟', strip: /之後部署並按 u/g },
  { why: '「打 tag 後部署並按 u」：發版線打 tag 之後的步驟', strip: /打 tag 後部署並按 u/g },
  { why: '「到那個對話按 v」：別的對話的步驟', strip: /到那個對話按 v/g },
]

/** 句子裡的「按 X」「按兩次 X」的字母（允許表的句型拿掉後）。 */
function pressedKeys(text: string, c: Case): string[] {
  if (ALLOW.some(a => a.whole?.(text, c))) return []
  const rest = ALLOW.reduce((t, a) => (a.strip ? t.replace(a.strip, '') : t), text)
  return [...rest.matchAll(/按(?:兩次)? ([a-z])(?![a-z])/g)].map(m => m[1]!)
}

/** AC-2 */
test('test_turn_text_keys_map_to_listed_actions_except_allowlist', () => {
  const bad: string[] = []
  for (const m of matrix()) {
    const { turn, footer } = look(m)
    const drawn = ids(footer)
    for (const k of pressedKeys(turn.text, m.c)) {
      const owners = (Object.keys(ACTIONS) as ActionId[]).filter(id => HOTKEY(id) === k)
      if (!owners.some(id => drawn.includes(id))) bad.push(`${m.label}：「${turn.text}」叫你按 ${k}，footer 上沒有（${drawn.join('、')}）`)
    }
  }
  expect(bad).toEqual([])
  // 允許表每條都有原因
  for (const a of ALLOW) expect(a.why.length).toBeGreaterThan(4)
})

const PASSIVE: ActionId[] = ['stop', 'logs', 'open', 'unqueue', 'fill', 'review-file', 'pr']

/** AC-3 */
test('test_footer_draws_exactly_stage_actions', () => {
  const bad: string[] = []
  for (const m of matrix()) {
    const { listed, footer } = look(m)
    const drawn = ids(footer)
    if (sorted(drawn).join() !== sorted(listed).join()) bad.push(`${m.label}：footer ${sorted(drawn).join('、')}，該出現 ${sorted(listed).join('、')}`)
    if (new Set(drawn).size !== drawn.length) bad.push(`${m.label}：footer 有重複的動作`)
  }
  expect(bad).toEqual([])
})

/** AC-3 */
test('test_ai_turn_lists_only_passive_actions', () => {
  const bad: string[] = []
  let handled = 0
  for (const m of matrix()) {
    const { ctx, turn, listed } = look(m)
    if (isHandling(m.c, ctx) !== (turn.who === 'ai')) bad.push(`${m.label}：isHandling 跟「輪到你」不一致（${turn.who}）`)
    if (turn.who !== 'ai') continue
    handled++
    const testing = ctx.verifying || ctx.queued
    for (const id of listed) if (!PASSIVE.includes(id) && !(id === 'verify' && testing)) bad.push(`${m.label}：處理中卻列了 ${id}`)
  }
  expect(bad).toEqual([])
  expect(handled).toBeGreaterThan(50)
})

/** AC-1～AC-3 的最後一條：desk 派的 Agent 在跑（含停在關卡、等你有選項）一定有停止。 */
test('every matrix case with a running desk agent can be stopped', () => {
  const bad: string[] = []
  for (const m of matrix()) {
    const a = m.c.agent
    const running = !!a && a.name.startsWith('desk-') && (a.status === 'busy' || a.waitsFor === 'permission') && !m.view.agentQueue.length
    const { footer } = look(m)
    if (running && !ids(footer).includes('stop')) bad.push(`${m.label}：desk 派的 Agent 在跑卻沒有停止`)
  }
  expect(bad).toEqual([])
})

// ── AC-4：停止鍵在關卡／等你時也出現 ──

const BETA = '/home/u/wt/beta'
const deskAgent = (name: string) => ({ id: 'bbbbbbbb', kind: 'background', cwd: BETA, name, sessionId: 'bbbbbbbb-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: 0 })

/** 只留 Beta 一件：卡片關卡／等你換成 field，Agent 換成 agent。 */
function onlyBeta(data: any, field: string, agent: any) {
  data.gh = []
  // 這件最後一次派工的啟動名對得上 Agent 名稱，面板才停得了它（stopAgent 的判斷）。
  data.store.jobs = { [BETA]: { sessionId: agent.sessionId, last: { launchName: agent.name, nativeId: 'x', sessionId: agent.sessionId, kind: 'continue', startedAt: 0, fresh: false } } }
  data.agents = [agent]
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', field.startsWith('- 關卡') ? field : '- 關卡：無').replace(/- 等你：.*/, field.startsWith('- 等你') ? field : '- 等你：無')
}

const STOP = `case-${CARD_B}-stop`
const labelOf = async (ui: any, key: string) => { const b = await ui.find({ key }); return String(b?.text || b?.props?.label || '') }
const buttonKeys = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key ?? '')).filter((k: string) => k.startsWith(`case-${CARD_B}-`)).map((k: string) => k.slice(`case-${CARD_B}-`.length))
const BETA_CARD = (data: any) => data.files[CARD_B]!

/** AC-4 */
test('test_desk_agent_running_at_gate_or_ask_can_be_stopped', async ($, on) => {
  const { data, clock } = fixture(on)
  const original = BETA_CARD(data)
  const seen: unknown[] = []
  for (const field of ['- 關卡：spec：待確認規格', '- 關卡：review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核', '- 關卡：release：v0.2.0 待上線確認', `- 等你：${CHOICE}`]) {
    data.files[CARD_B] = original
    onlyBeta(data, field, deskAgent(DESK))
    data.stops.length = 0
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    const ui = await $.ui.mount(PANE(120))
    const before = await buttonKeys(ui)
    await ui.press({ key: STOP })
    const armed = await labelOf(ui, STOP)
    const afterFirst = [...data.stops]
    await ui.press({ key: STOP })
    await clock.settle()
    seen.push({ field, stop: before.includes('stop'), armed, afterFirst, stops: [...data.stops] })
    await ui.unmount()
  }
  expect(seen).toEqual(['spec', 'review', 'release', 'ask'].map((_, i) => ({
    field: ['- 關卡：spec：待確認規格', '- 關卡：review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核', '- 關卡：release：v0.2.0 待上線確認', `- 等你：${CHOICE}`][i],
    stop: true, armed: '再按 k 確認停止', afterFirst: [], stops: ['bbbbbbbb'],
  })))
})

/** AC-4：在跑的 Agent 不是 desk 派的（主對話或別人開的）：沒有停止鍵，連 m 展開也沒有。 */
test('test_foreign_agent_running_has_no_stop', async ($, on) => {
  const { data } = fixture(on)
  const original = BETA_CARD(data)
  const seen: unknown[] = []
  for (const field of ['- 關卡：spec：待確認規格', `- 等你：${CHOICE}`, '- 關卡：無']) {
    data.files[CARD_B] = original
    onlyBeta(data, field, deskAgent('main-chat'))
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    const ui = await $.ui.mount(PANE(120))
    const normal = (await buttonKeys(ui)).includes('stop')
    await ui.press({ key: 'more' })
    const all = await buttonKeys(ui)
    seen.push({ field, normal, expanded: all.includes('stop'), logs: all.includes('logs') })
    await ui.unmount()
  }
  expect(seen).toEqual(['- 關卡：spec：待確認規格', `- 等你：${CHOICE}`, '- 關卡：無'].map(field => ({ field, normal: false, expanded: false, logs: true })))
})

// ── AC-5：核准提示跟 v 鍵一致 ──

/** AC-5：已合併可歸檔、流程停在檢查沒核准：不叫你按兩次 v；同樣停在測試段（v 在 footer 上）時照舊出現。 */
test('test_approval_hint_only_when_its_key_is_on_footer', async ($, on) => {
  const { data } = fixture(on)
  const original = BETA_CARD(data)
  data.store.chains = { [BETA]: { owner: 'fixture-session', startedAt: 0, round: 0, stopped: CHECK_UNAPPROVED, heldAtCheck: true } }
  // 已合併、打了 tag、六段全過可歸檔
  onlyBeta(data, `- 關卡：${PASSED_REVIEW}`, deskAgent(DESK))
  data.agents = []
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git', tag: 'v0.19.0' }
  data.gh = [{ number: 12, state: 'MERGED', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: PR_URL, statusCheckRollup: [] }]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  let ui = await $.ui.mount(PANE(120))
  // 做完的卡不會自動挑成現在卡：先選它。
  await ui.press({ key: `row-${CARD_B}` })
  const archivable = { keys: await buttonKeys(ui), hint: flat(text(await ui.drawn())).includes(flat('按兩次 v')) }
  await ui.unmount()
  expect(archivable).toEqual({ keys: ['archive'], hint: false })

  // 還沒合併、流程停在測試段：v 在 footer 上，照舊叫你按兩次 v
  data.files[CARD_B] = original
  data.gh = []
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  ui = await $.ui.mount(PANE(120))
  const held = { verify: (await buttonKeys(ui)).includes('verify'), hint: flat(text(await ui.drawn())).includes(flat('還沒核准的指令（按兩次 v 核准並執行）')) }
  await ui.unmount()
  expect(held).toEqual({ verify: true, hint: true })
})
