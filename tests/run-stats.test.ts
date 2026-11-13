import { expect, test } from 'claude-code/testing'
import { fixture, CARD_A, CARD_C, result } from './fixture'
import { busyAgent as busy } from './world'
import { alphaOnly, helpers, ROOT } from './alpha-chain'

// 卡片統計：派工或完成檢查跑完時，worktree 的 .task/stats.json 寫著這條分支的總執行、整張卡的修正輪數與分支名，歸檔時 card.py 讀它。

const MIN = 60_000
/** 走完整條流程（實作、檢查、審查、修正）：整套一起跑、負載高時會超過預設的 5 秒。 */
const SLOW_MS = 15_000
const STATS = `${ROOT}/.task/stats.json`
const FOREIGN = '不是上一個 Agent 留下的'
/** 統計檔現在的內容（還沒寫是 null）。 */
const statsOf = (data: any): any => data.files[STATS] === undefined ? null : JSON.parse(data.files[STATS])
/** 這件記著的總執行毫秒（store 的 jobs）。 */
const runMsOf = (data: any): number => Number((data.store.jobs as any)?.[ROOT]?.runMs ?? 0)

/** AC-1 */
test('test_stats_file_written_when_dispatch_or_check_ends', { timeoutMs: SLOW_MS }, async ($, on) => {
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
  expect(statsOf(data)).toBeNull()

  // 實作跑 6 分 → 自動檢查：Agent 結束與檢查跑完各寫一次，內容跟存著的總執行一樣
  await clock.advance(6 * MIN)
  await h.finish()
  expect(checks).toBe(1)
  expect(data.launches).toHaveLength(2)
  expect(data.writes.filter((w: string) => w === STATS)).toHaveLength(2)
  const afterCheck = statsOf(data)
  expect(afterCheck.branch).toBe('feature/alpha')
  expect(afterCheck.fixRounds).toBe(0)
  expect(afterCheck.runMs).toBeGreaterThanOrEqual(6 * MIN)
  expect(afterCheck.runMs).toBe(runMsOf(data))

  // 審查跑 4 分，有 HIGH → 自動派修正
  await clock.advance(4 * MIN)
  h.setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  await h.finish()
  expect(data.launches).toHaveLength(3)
  expect(h.prompt(2)).toContain('修正第 1／2 輪')

  // 修正跑 3 分；結束後流程停在等你回答（不跑檢查）：Agent 結束這次就寫，修正輪數 1，總執行含檢查的 1 分（6 + 1 + 4 + 3）
  await clock.advance(3 * MIN)
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 等你：.*$/m, '- 等你：要不要順便改名？A) 要 B) 不要')
  await h.finish()
  const ended = statsOf(data)
  expect(ended.fixRounds).toBe(1)
  expect(ended.runMs).toBeGreaterThanOrEqual(14 * MIN)
  expect(ended.runMs).toBeLessThan(15 * MIN)
  expect(ended.runMs).toBe(runMsOf(data))

  // 同一次派工不會重複加：再重新整理幾次，統計檔不變
  await clock.advance(30 * MIN)
  await h.refresh()
  await h.refresh()
  expect(statsOf(data)).toEqual(ended)
})

/** AC-7 */
test('test_stats_file_does_not_change_worktree_mark', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  // 照真實 git：算指紋的 status 沒排除 .task 時，統計檔會以未追蹤檔出現
  data.exec = async (e: any) => {
    const argv = e.argv.map(String)
    if (argv[0] !== 'git' || !argv.includes('--untracked-files=all') || argv.includes(':(exclude).task') || data.files[STATS] === undefined) return null
    return result(0, '? .task/stats.json\n')
  }

  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  await clock.advance(2 * MIN)
  await h.finish()

  // 實作結束寫了統計檔，檢查通過後照舊派審查，不被當成別人的改動擋下
  expect(data.files[STATS]).toBeDefined()
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1)).toContain('程式碼審查')
  expect(data.toasts.some((t: string) => t.includes(FOREIGN))).toBe(false)
  expect((data.store.chains as any)[ROOT]?.stopped).toBeUndefined()
})

// 每段計時：統計檔多一份逐段紀錄（runs），歸檔時 card.py 拿來算各段分鐘與段間空等。

/** 每段計時 AC-1 */
test('test_stats_file_lists_each_stage_with_kind_and_times', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  let checks = 0
  data.run = async () => { checks++; if (checks === 1) await clock.advance(1 * MIN); return result(0, 'all green\n') }

  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  // 實作 6 分 → 測試 1 分 → 驗收 4 分（HIGH）→ 修正 3 分，修正結束後停在等你
  await clock.advance(6 * MIN)
  await h.finish()
  await clock.advance(4 * MIN)
  h.setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  await h.finish()
  await clock.advance(3 * MIN)
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 等你：.*$/m, '- 等你：要不要順便改名？A) 要 B) 不要')
  await h.finish()

  const stats = statsOf(data)
  const runs: any[] = stats.runs
  expect(runs.map(r => r.kind)).toEqual(['continue', 'verify', 'review', 'fix'])
  expect(runs.map(r => Math.floor(r.runMs / MIN))).toEqual([6, 1, 4, 3])
  for (const [i, r] of runs.entries()) {
    // 沒停下來等人：執行時間就是開始到結束；依先後列出，上一段結束不晚於下一段開始
    expect(r.endedAt - r.startedAt).toBe(r.runMs)
    if (i > 0) expect(runs[i - 1].endedAt).toBeLessThanOrEqual(r.startedAt)
    expect(r.queuedMs).toBeUndefined()
  }
  expect(runs.reduce((sum, r) => sum + r.runMs, 0)).toBe(stats.runMs)
  expect((data.store.jobs as any)[ROOT].runs).toEqual(runs)

  // 重新整理幾次：同一段只記一次
  await clock.advance(30 * MIN)
  await h.refresh()
  await h.refresh()
  expect(statsOf(data).runs).toEqual(runs)
})

const GAMMA = '/home/u/wt/gamma'
const SETTINGS = '/home/u/.claude/handoffs/dispatch.json'

/** 每段計時 AC-2 */
test('test_stats_run_records_queued_time_when_dispatch_waited_for_slot', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[SETTINGS] = JSON.stringify({})
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace('- 下一步：push', '- 下一步：實作匯入')
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 驗證：無', '- 驗證：`node test.mjs`').replace('- 下一步：無', '- 下一步：實作匯出')
  data.git[ROOT] = { branch: 'feature/alpha', head: 'h1' }
  data.git[GAMMA] = { branch: 'feature/gamma', head: 'g1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_C]: 'node test.mjs' }
  // 別的專案已有三個在跑的工作桌 Agent（預設上限 3）
  data.agents = [busy('desk-m0-0', '/home/u/other/one'), busy('desk-m0-1', '/home/u/other/two'), busy('desk-m0-2', '/home/u/other/three')]
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    data.agents = [...data.agents, { ...busy(e.argv[3], e.init.cwd), id, sessionId: `${id}-0000-4000-8000-000000000000`, startedAt: clock.now() }]
    return result(0, id)
  }
  const h = helpers($, data, clock)
  const finishOther = () => {
    const i = data.agents.findIndex((a: any) => /^desk-m0-/.test(a.name) && a.status === 'busy')
    data.agents = data.agents.map((a: any, j: number) => j === i ? { ...a, status: 'idle', state: 'done' } : a)
  }

  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(0)
  // 排了 5 分才有空位：Alpha 從隊伍派出
  await clock.advance(5 * MIN)
  finishOther()
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  // 再空出一個位置：Gamma 沒排隊直接派出
  finishOther()
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(2)

  await clock.advance(2 * MIN)
  data.agents = data.agents.map((a: any) => a.cwd === ROOT || a.cwd === GAMMA ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()

  const runOf = (root: string) => JSON.parse(String(data.files[`${root}/.task/stats.json`])).runs.find((r: any) => r.kind === 'continue')
  const queued = runOf(ROOT).queuedMs
  expect(queued).toBeGreaterThanOrEqual(5 * MIN)
  expect(queued).toBeLessThan(6 * MIN)
  expect(runOf(GAMMA).queuedMs).toBeUndefined()
})

/** 每段計時 AC-5 */
test('test_stage_runs_restart_when_branch_changes', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  // 同一個資料夾記過舊分支的兩段
  const old = [
    { kind: 'continue', startedAt: 1_000, endedAt: 1_000 + 5 * MIN, runMs: 5 * MIN },
    { kind: 'verify', startedAt: 1_000 + 6 * MIN, endedAt: 1_000 + 7 * MIN, runMs: 1 * MIN },
  ]
  data.store.jobs = { [ROOT]: { runMs: 6 * MIN, runBranch: 'feature/old', runs: old } }
  const h = helpers($, data, clock)

  await h.refresh()
  const goAt = clock.now()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  await clock.advance(3 * MIN)
  await h.finish()

  const stats = statsOf(data)
  expect(stats.branch).toBe('feature/alpha')
  expect(stats.runs[0].kind).toBe('continue')
  expect(Math.floor(stats.runs[0].runMs / MIN)).toBe(3)
  expect(stats.runs.every((r: any) => r.startedAt >= goAt)).toBe(true)
  expect(stats.runs.reduce((sum: number, r: any) => sum + r.runMs, 0)).toBe(stats.runMs)
})
