import { expect, test } from 'claude-code/testing'
import { fixture, CARD_A, result } from './fixture'
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
