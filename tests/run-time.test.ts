import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, NOW, REGISTRY, result, text, flat } from './fixture'
import { alphaOnly, helpers, ROOT } from './alpha-chain'

// 任務總執行時間：每張卡累加 Agent 每次派工與自動檢查跑了多久，卡片頭一列一律寫、超過 15 分在清單也標警示。

const MIN = 60_000
/** 走完整條流程（實作、檢查、審查、修正）的那支：整套一起跑、負載高時會超過預設的 5 秒。 */
const SLOW_MS = 15_000
const BETA = '/home/u/wt/beta'
const BETA_SID = 'bbbbbbbb-0000-4000-8000-000000000000'
const screen = async (ui: any) => flat(text(await ui.drawn()))
/** 這件記著的總執行毫秒（store 的 jobs）。 */
const runMsOf = (data: any, root: string): number => Number((data.store.jobs as any)?.[root]?.runMs ?? 0)
/** 畫面上第一個整段等於 `pattern` 的 Text。 */
const textNode = async (ui: any, pattern: RegExp) => (await ui.findAll({ type: 'Text' })).find((n: any) => pattern.test(String(n.text ?? '')))

/** 只留 Beta 一件：卡片沒有待決策，Agent 清單與派工紀錄由測試自己擺。 */
function betaOnly(data: any) {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.git[BETA] = { branch: 'feature/b', head: 'g1' }
  data.agents = []
}

/** Beta 的最後一次派工是 `name`，從 `startedAt` 開始；`agent` 是它在 Agent 清單裡的樣子（null＝不在清單）。 */
function betaDispatched(data: any, name: string, startedAt: number, agent: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  const own = (data.store.jobs as any)?.[BETA] ?? {}
  data.store.jobs = { ...(data.store.jobs as any ?? {}), [BETA]: { ...own, sessionId: BETA_SID, last: { launchName: name, nativeId: 'bbbbbbbb', sessionId: BETA_SID, kind: 'continue', startedAt, fresh: false } }, ...extra }
  data.agents = agent ? [{ id: 'bbbbbbbb', kind: 'background', cwd: BETA, name, sessionId: BETA_SID, startedAt, ...agent }] : []
}

/** AC-1 */
test('test_run_time_sums_agent_and_check_durations', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  // 第一次自動檢查跑 1 分；之後的檢查立刻跑完。
  let checks = 0
  data.run = async () => { checks++; if (checks === 1) clock.advance(1 * MIN); return result(0, 'all green\n') }

  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)

  // 實作跑 6 分 → 自動檢查 1 分 → 自動派審查
  await clock.advance(6 * MIN)
  await h.finish()
  expect(checks).toBe(1)
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1)).toContain('程式碼審查')

  // 審查跑 4 分，有 HIGH → 自動派修正
  await clock.advance(4 * MIN)
  h.setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  await h.finish()
  expect(data.launches).toHaveLength(3)
  expect(h.prompt(2)).toContain('修正第 1／2 輪')

  // 修正跑 3 分；結束後流程停在等你回答（卡片有題目），這段不算
  await clock.advance(3 * MIN)
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 等你：.*$/m, '- 等你：要不要順便改名？A) 要 B) 不要')
  await h.finish()

  // 6 + 4 + 3 + 1 = 14 分（每次結束時工作桌多等的幾秒輪詢不到 1 分）
  const ran = runMsOf(data, ROOT)
  expect(ran).toBeGreaterThanOrEqual(14 * MIN)
  expect(ran).toBeLessThan(15 * MIN)

  // 等你回答、沒有 Agent 在跑：過了半小時也不加
  await clock.advance(30 * MIN)
  await h.refresh()
  expect(runMsOf(data, ROOT)).toBe(ran)
  const ui = await $.ui.mount(PANE(120))
  expect(await screen(ui)).toContain(flat('總執行 14 分'))
  await ui.unmount()
})

/** AC-2 */
test('test_card_header_shows_total_run_time_including_running_agent', async ($, on) => {
  const { data, clock } = fixture(on)
  betaOnly(data)
  // 之前結束的派工共 9 分；現在這個 Agent 已跑 4 分
  data.store.jobs = { [BETA]: { runMs: 9 * MIN, runBranch: 'feature/b' } }
  betaDispatched(data, 'desk-run', NOW - 4 * MIN, { state: 'working', status: 'busy' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(120))

  // 卡片頭一列：狀態標籤後面寫已結束的加正在跑的
  const header = await textNode(ui, /總執行/)
  expect(String(header?.text)).toBe(' · 總執行 13 分')
  // 15 分以內不是警示色
  expect(header?.props?.color).not.toBe('warning')

  // 跟著時間動：再過 1 分（不重新整理，只有每秒的重畫）變 14 分
  await clock.advance(1 * MIN)
  await clock.settle()
  expect(String((await textNode(ui, /總執行/))?.text)).toBe(' · 總執行 14 分')
  await ui.unmount()
})

/** AC-3 */
test('test_over_15_minutes_is_marked_in_card_and_list', async ($, on) => {
  const { data, clock } = fixture(on)
  // Beta 總執行 16 分（含正在跑的 1 分）；Alpha 總執行 5 分、沒在跑
  data.store.jobs = {
    [BETA]: { runMs: 15 * MIN, runBranch: 'feature/b' },
    '/home/u/wt/alpha': { runMs: 5 * MIN, runBranch: 'feature/alpha' },
  }
  data.git[BETA] = { branch: 'feature/b', head: 'g1' }
  data.git['/home/u/wt/alpha'] = { branch: 'feature/alpha', head: 'h1' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  // 選 Beta 當現在卡
  const ui = await $.ui.mount(PANE(120))
  await ui.press({ key: `row-${CARD_B}` })
  await clock.settle()

  // 卡片頭一列：寫「（超過 15 分）」用警示色
  const header = await textNode(ui, /總執行/)
  expect(String(header?.text)).toBe(' · 總執行 16 分（超過 15 分）')
  expect(header?.props?.color).toBe('warning')

  // 清單那一列的時間欄：「⏱ 16 分」用警示色，不是「▶ 已跑多久」
  const beta = await ui.find({ key: `row-${CARD_B}` })
  expect(beta?.text).toContain('⏱ 16 分')
  expect(beta?.text).not.toContain('▶')
  const betaAge = leavesWith(beta, /⏱ 16 分/)
  expect(betaAge?.props?.color).toBe('warning')

  // 15 分以內：照舊寫多久前更新（Alpha 卡片 20 分鐘前改的）
  const alpha = await ui.find({ key: `row-${CARD_A}` })
  expect(alpha?.text).not.toContain('⏱')
  expect(alpha?.text).toContain('20 分鐘前')
  await ui.unmount()

  // 窄畫面：任務名放不下時先省掉多久前，再省掉「（超過 15 分）」，警示色照舊
  const narrow = await $.ui.mount(PANE(40))
  const tight = await textNode(narrow, /總執行/)
  expect(String(tight?.text)).toBe(' · 總執行 16 分')
  expect(tight?.props?.color).toBe('warning')
  expect(await screen(narrow)).toContain('Beta')
  await narrow.unmount()

  // 正在跑、15 分以內：照舊「▶ 已跑多久」
  data.store.jobs = { [BETA]: { runMs: 2 * MIN, runBranch: 'feature/b' } }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const wide = await $.ui.mount(PANE(120))
  const calm = await wide.find({ key: `row-${CARD_B}` })
  expect(calm?.text).toContain('▶ 1 分 0 秒')
  expect(calm?.text).not.toContain('⏱')
  await wide.unmount()
})

/** 節點底下第一個文字符合 `pattern` 的 Text。 */
function leavesWith(node: any, pattern: RegExp): any {
  if (!node || typeof node === 'string') return undefined
  if (node.type === 'Text' && pattern.test(text(node))) {
    const inner = (node.children ?? []).map((c: any) => leavesWith(c, pattern)).find(Boolean)
    return inner ?? node
  }
  return (node.children ?? []).map((c: any) => leavesWith(c, pattern)).find(Boolean)
}

/** AC-4 */
test('test_run_time_is_per_branch_and_hidden_when_zero', async ($, on) => {
  const { data, clock } = fixture(on)
  betaOnly(data)
  // 沒派過工：不寫總執行（不是「0 秒」）
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  let ui = await $.ui.mount(PANE(120))
  let shown = await screen(ui)
  expect(shown).not.toContain(flat('總執行'))
  expect(shown).not.toContain(flat('0 秒'))
  await ui.unmount()

  // 舊分支跑了 20 分；同一個資料夾換成新分支（舊卡歸檔、新卡用同一個路徑）：從 0 起算，不顯示
  data.store.jobs = { [BETA]: { runMs: 20 * MIN, runBranch: 'feature/old' } }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  ui = await $.ui.mount(PANE(120))
  shown = await screen(ui)
  expect(shown).not.toContain(flat('總執行'))
  expect(shown).not.toContain('⏱')
  await ui.unmount()

  // 新分支第一次派工跑 3 分結束：只算這 3 分，記到新分支
  betaDispatched(data, 'desk-new', clock.now(), { state: 'working', status: 'busy' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await clock.advance(3 * MIN)
  data.agents = data.agents.map((a: any) => ({ ...a, state: 'done', status: 'idle' }))
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ran = runMsOf(data, BETA)
  expect(ran).toBeGreaterThanOrEqual(3 * MIN)
  expect(ran).toBeLessThan(4 * MIN)
  expect((data.store.jobs as any)[BETA].runBranch).toBe('feature/b')
  ui = await $.ui.mount(PANE(120))
  expect(await screen(ui)).toContain(flat('總執行 3 分'))
  await ui.unmount()
})

/** AC-5 */
test('test_run_time_counts_each_dispatch_once', async ($, on) => {
  const { data, clock } = fixture(on)
  betaOnly(data)

  // 被 claude stop 停掉：照樣算進總數
  betaDispatched(data, 'desk-stopped', clock.now(), { state: 'working', status: 'busy' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await clock.advance(5 * MIN)
  data.agents = data.agents.map((a: any) => ({ ...a, state: 'stopped', status: 'idle' }))
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect((data.store.jobs as any)[BETA].last.ended).toEqual({ how: 'stopped' })
  const once = runMsOf(data, BETA)
  expect(once).toBeGreaterThanOrEqual(5 * MIN)
  expect(once).toBeLessThan(6 * MIN)

  // 同一次派工之後每次重新整理都看到它結束：不重複加
  for (let i = 0; i < 3; i++) {
    await clock.advance(MIN)
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    await clock.settle()
  }
  expect(runMsOf(data, BETA)).toBe(once)

  // 工作桌重開後才看到上一次結束（派工紀錄還沒記 ended）：照樣算進去，只算一次
  // （重開前的那段時間工作桌沒在看：Agent 清單裡還看不到它）
  const start = clock.now()
  betaDispatched(data, 'desk-before-restart', start, null)
  await clock.advance(2 * MIN)
  await clock.settle()
  betaDispatched(data, 'desk-before-restart', start, { state: 'done', status: 'idle' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const twice = runMsOf(data, BETA)
  expect(twice - once).toBeGreaterThanOrEqual(2 * MIN)
  expect(twice - once).toBeLessThan(3 * MIN)
  expect((data.store.jobs as any)[BETA].last.ended).toEqual({ how: 'finished' })

  // 既有的「已執行 … · 」那句與清單的「▶ 已跑多久」不變
  betaDispatched(data, 'desk-running', clock.now() - 2 * MIN, { state: 'working', status: 'busy' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(120))
  const shown = await screen(ui)
  expect(shown).toContain(flat('已執行 2 分 0 秒 · '))
  expect((await ui.find({ key: `row-${CARD_B}` }))?.text).toContain('▶ 2 分 0 秒')
  await ui.unmount()
})
