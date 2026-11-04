import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, NOW, PANE, CARD_B, REGISTRY, result } from './fixture'
import { resetText } from '../hooks/model'
import { AGENT_STOPPED, CHAIN_CHANGED, CHAIN_OVERWRITTEN } from '../hooks/chain'

// 流程紀錄帶版本號：每次寫回加 1；拿早先看到的版本做決定的寫入在版本變了時被拒絕；整張表被別的對話用舊表寫回時偵測並重套。
const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const ME = 'fixture-session'
const RESETS_AT = new Date(NOW + 2.5 * 3_600_000).toISOString()
const REASON = `5 小時額度剩 25%，低於門檻 30%，${resetText(RESETS_AT, NOW)}後按 g 重開`

const busy = (name: string, cwd: string) => ({ id: name.slice(-8), kind: 'background', cwd, name, sessionId: `${name.slice(-8)}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: 0 })
const registry = (rows: [string, string][]) => `## 任務\n| Project | path |\n| --- | --- |\n${rows.map(([n, p]) => `| ${n} | \`${p}\` |`).join('\n')}`
const lastJob = (kind: string, extra: object = {}) => ({ sessionId: 'r0000001-0000-4000-8000-000000000000', mark: '', last: { launchName: 'desk-old-0', nativeId: 'r0000001', sessionId: 'r0000001-0000-4000-8000-000000000000', kind, startedAt: 0, fresh: kind === 'review', owner: ME, ended: { how: 'finished' }, ...extra } })
const ok = (head: string) => ({ command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head })
const chains = (data: any) => data.store.chains as Record<string, any>

/** 5 小時額度已用 used%（剩 100 - used）。 */
function quota(data: any, used: number) {
  data.usage = { ...data.usage, rateLimits: [{ kind: 'five_hour', percentUsed: used, resetsAt: RESETS_AT }] }
}

function startsAgents(data: any, clock: any) {
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    const cwd = String(e.init?.cwd ?? '')
    data.agents = [...data.agents.filter((a: any) => a.cwd !== cwd), { ...busy(e.argv[3], cwd), id, sessionId: `${id}-0000-4000-8000-000000000000`, startedAt: clock.now() }]
    return result(0, id)
  }
}

function helpers($: any, clock: any) {
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  return { step, refresh }
}

/** 寫進 store 的流程紀錄（整張表）次數。 */
function countChainWrites(data: any) {
  const count = { n: 0 }
  const prev = data.storeAfterSet
  data.storeAfterSet = (key: string, value: unknown) => { if (key === 'chains') count.n++; prev?.(key, value) }
  return count
}

/** 只留 Beta：這個對話的流程剛結束實作、完成檢查在 c2 跑過且綠了；改的是程式（要派審查）。 */
function betaImplemented(data: any, clock: any, chain: object = {}) {
  data.agents = []
  data.gh = []
  data.files[REGISTRY] = registry([['Beta', CARD_B]])
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 下一步：依審核修正', '- 下一步：等驗收')
  data.git[BETA] = { branch: 'feature/b', head: 'c2', files: ['src/app.ts'] }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  data.store.verifies = { [CARD_B]: ok('c2') }
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, ...chain } }
  data.store.jobs = { [BETA]: lastJob('continue', { fresh: false }) }
  startsAgents(data, clock)
}

/** 擋在派驗收前、面板已重新整理（看到的是額度暫停與它當時的版本）。 */
async function heldBeforeReview(data: any, clock: any, h: ReturnType<typeof helpers>) {
  betaImplemented(data, clock)
  quota(data, 75)
  await h.refresh()
  await h.step()
  expect(chains(data)[BETA].resume).toEqual({ dispatch: 'review', round: 0 })
  await h.refresh()
}

const pressG = async (ui: any, clock: any) => {
  await ui.press({ key: `case-${CARD_B}-continue` }); await clock.settle()
  await ui.press({ key: `case-${CARD_B}-continue` }); await clock.settle()
}

/** AC-1：舊格式（沒有版本號）的流程紀錄停下時寫回版本 1；別的任務的紀錄不動。 */
test('test_chain_rev_increments_on_every_write_and_backfills_legacy_records', async ($, on) => {
  const { data, clock } = fixture(on)
  betaImplemented(data, clock)
  data.store.chains = { ...chains(data), [ALPHA]: { owner: 'other-session', startedAt: 0, round: 1, rev: 3 } }
  quota(data, 75)
  const h = helpers($, clock)

  await h.refresh()
  await h.step()

  expect(chains(data)[BETA].stopped).toBe(REASON)
  expect(chains(data)[BETA].rev).toBe(1)
  expect(chains(data)[ALPHA]).toEqual({ owner: 'other-session', startedAt: 0, round: 1, rev: 3 })
})

/** AC-1：版本 n 的紀錄過關（只動文件、檢查通過免審查）寫回 n＋1。 */
test('test_chain_rev_increments_on_every_write_and_backfills_legacy_records — passing writes n+1', async ($, on) => {
  const { data, clock } = fixture(on)
  betaImplemented(data, clock, { rev: 5 })
  data.git[BETA]!.files = ['README.md']
  data.store.verifies = {}
  const h = helpers($, clock)

  await h.refresh()
  for (let i = 0; i < 4; i++) await h.step()

  expect(chains(data)[BETA].passed).toBe(true)
  expect(chains(data)[BETA].rev).toBe(6)
})

/** AC-1：手動派實作（/desk go）開新的一輪：新紀錄的版本接著舊的加 1（舊格式從 1 開始）。 */
test('test_chain_rev_increments_on_every_write_and_backfills_legacy_records — a new round continues the rev', async ($, on) => {
  const { data, clock } = fixture(on)
  betaImplemented(data, clock, { passed: true, rev: 7 })
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 下一步：等驗收', '- 下一步：實作匯入')
  data.store.jobs = {}
  const h = helpers($, clock)
  await h.refresh()

  await $.command.run({ command: 'desk', args: 'go Beta' } as any)
  await clock.settle()

  expect(data.launches).toHaveLength(1)
  expect(chains(data)[BETA].passed).toBeUndefined()
  expect(chains(data)[BETA].round).toBe(0)
  expect(chains(data)[BETA].rev).toBe(8)
})

/** AC-1：停止 Agent 時這件沒有流程紀錄：閉包沒改內容，不寫回整張表，別件的版本不變；有紀錄的停下寫回 n＋1。 */
test('test_chain_rev_increments_on_every_write_and_backfills_legacy_records — unchanged closure does not write', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = [{ id: 'dddddddd', kind: 'background', cwd: BETA, name: 'desk-abc-0', sessionId: 'dddddddd-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: NOW }]
  data.store.jobs = { [BETA]: { sessionId: 'dddddddd-0000-4000-8000-000000000000', last: { launchName: 'desk-abc-0', nativeId: 'dddddddd', sessionId: 'dddddddd-0000-4000-8000-000000000000', kind: 'continue', startedAt: NOW, fresh: false, owner: ME } } }
  data.store.chains = { [ALPHA]: { owner: 'other-session', startedAt: 0, round: 0, rev: 3 } }
  const writes = countChainWrites(data)
  const h = helpers($, clock)
  await h.refresh()
  const stop = async () => {
    const ui = await $.ui.mount(PANE(72))
    await ui.press({ key: `row-${CARD_B}` })
    await ui.press({ key: `case-${CARD_B}-stop` })
    await ui.press({ key: `case-${CARD_B}-stop` })
    await clock.settle()
    await ui.unmount()
  }

  await stop()
  expect(data.stops).toEqual(['dddddddd'])
  expect(writes.n).toBe(0)
  expect(chains(data)).toEqual({ [ALPHA]: { owner: 'other-session', startedAt: 0, round: 0, rev: 3 } })

  // 有紀錄（版本 2）的停下：寫回 3
  data.store.chains = { ...chains(data), [BETA]: { owner: ME, startedAt: NOW, round: 0, rev: 2 } }
  data.agents = [{ ...data.agents[0] }]
  await h.refresh()
  await stop()
  expect(chains(data)[BETA].stopped).toBe(AGENT_STOPPED)
  expect(chains(data)[BETA].rev).toBe(3)
  expect(chains(data)[ALPHA].rev).toBe(3)
})

/** AC-2：額度煞車停下後、面板重新整理前，別的對話接手開了新一輪：按兩次 g 不派，紀錄維持別的對話寫的，toast 寫原因。 */
test('test_quota_resume_refuses_when_chain_changed_since_last_refresh', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, clock)
  await heldBeforeReview(data, clock, h)
  const seen = chains(data)[BETA].rev as number
  const theirs = { owner: 'other-session', startedAt: NOW, round: 0, rev: seen + 1 }
  data.store.chains = { ...chains(data), [BETA]: theirs }

  const ui = await $.ui.mount(PANE(160))
  await pressG(ui, clock)
  await ui.unmount()

  expect(data.launches).toHaveLength(0)
  expect(chains(data)[BETA]).toEqual(theirs)
  expect(data.toasts).toContain(`Beta：${CHAIN_CHANGED}`)
})

/** AC-2：同上，改用 /desk go 接續：回覆同一句，不派。 */
test('test_quota_resume_refuses_when_chain_changed_since_last_refresh — /desk go', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, clock)
  await heldBeforeReview(data, clock, h)
  const seen = chains(data)[BETA].rev as number
  // 別的對話還停在額度原因，只是改過紀錄（例如自己也記了一次暫停）：版本變了一樣拒絕。
  const theirs = { ...chains(data)[BETA], owner: 'other-session', rev: seen + 1 }
  data.store.chains = { ...chains(data), [BETA]: theirs }

  const go = await $.command.run({ command: 'desk', args: 'go Beta' } as any)
  await clock.settle()

  expect(String((go as any)?.text)).toBe(`Beta：${CHAIN_CHANGED}`)
  expect(data.toasts).toContain(`Beta：${CHAIN_CHANGED}`)
  expect(data.launches).toHaveLength(0)
  expect(chains(data)[BETA]).toEqual(theirs)
})

/** AC-3：帶著看到的版本 n 寫入，寫的當下紀錄已是 n＋1：不寫、紀錄一字不改，呼叫端拿到沒存（不派）；之後不帶版本的寫入照常每次加 1。 */
test('test_save_chain_rejects_a_write_based_on_a_stale_rev', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, clock)
  await heldBeforeReview(data, clock, h)
  const seen = chains(data)[BETA].rev as number
  // 接續要寫之前會看一次 worktree（git status）：別的對話剛好在這之間改了這件的流程紀錄。
  let theirs: any
  data.exec = (e: any) => {
    if (!theirs && e.argv[0] === 'git' && e.argv[2] === BETA && e.argv[3] === 'status') {
      theirs = { ...chains(data)[BETA], owner: 'other-session', rev: seen + 1 }
      data.store.chains = { ...chains(data), [BETA]: theirs }
    }
    return null
  }

  const go = await $.command.run({ command: 'desk', args: 'go Beta' } as any)
  await clock.settle()

  expect(theirs).toBeDefined()
  expect(String((go as any)?.text)).toBe(`Beta：${CHAIN_CHANGED}`)
  expect(data.launches).toHaveLength(0)
  expect(chains(data)[BETA]).toEqual(theirs)
  expect(chains(data)[BETA].rev).toBe(seen + 1)

  // 不帶版本的閉包式寫入（手動派驗收開新的一輪）照常寫回
  data.exec = null
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'review Beta' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  expect(chains(data)[BETA].owner).toBe(ME)
  // 開新的一輪、記下派審查時的 HEAD：兩次寫入各加 1
  expect(chains(data)[BETA].reviewHead).toBe('c2')
  expect(chains(data)[BETA].rev).toBe(seen + 3)
})

/** 別的對話在這個對話寫完流程紀錄之後，用它早先讀到的舊表整張寫回（改的是 Alpha），把 Beta 退回版本 2；times 次之後不再發生。 */
function staleOverwrites(data: any, times: number) {
  let n = 0
  const stale = () => ({
    [ALPHA]: { owner: 'other-session', startedAt: 0, round: 1, rev: 5 },
    [BETA]: { owner: ME, startedAt: 0, round: 0, rev: 2 },
  })
  data.storeAfterSet = (key: string, value: any) => {
    if (key !== 'chains' || !value?.[BETA]?.stopped || n >= times) return
    n++
    data.store.chains = stale()
  }
  return { count: () => n }
}

/** AC-4：寫後重讀發現 Beta 被退回舊版本：在最新的表上重套一次；兩件的改動都在，Beta 的版本是重套後的。 */
test('test_a_whole_map_overwrite_by_another_session_is_detected_and_reapplied', async ($, on) => {
  const { data, clock } = fixture(on)
  betaImplemented(data, clock, { rev: 2 })
  data.store.chains = { ...chains(data), [ALPHA]: { owner: 'other-session', startedAt: 0, round: 0, rev: 4 } }
  quota(data, 75)
  const overwrites = staleOverwrites(data, 1)
  const h = helpers($, clock)

  await h.refresh()
  await h.step()

  expect(overwrites.count()).toBe(1)
  expect(chains(data)[ALPHA]).toEqual({ owner: 'other-session', startedAt: 0, round: 1, rev: 5 })
  expect(chains(data)[BETA].stopped).toBe(REASON)
  expect(chains(data)[BETA].rev).toBe(3)
})

/** AC-5：連續 3 次重套都被蓋掉：放棄，紀錄維持別的對話寫的；動態寫一筆警告，之後再重新整理也不重複寫。 */
test('test_three_overwrites_in_a_row_give_up_and_post_a_warning', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  betaImplemented(data, clock, { rev: 2 })
  data.store.chains = { ...chains(data), [ALPHA]: { owner: 'other-session', startedAt: 0, round: 0, rev: 4 } }
  quota(data, 75)
  const overwrites = staleOverwrites(data, Infinity)
  const h = helpers($, clock)

  await h.refresh()
  for (let i = 0; i < 3; i++) { await h.step(); await h.refresh() }

  expect(overwrites.count()).toBe(3)
  expect(chains(data)).toEqual({
    [ALPHA]: { owner: 'other-session', startedAt: 0, round: 1, rev: 5 },
    [BETA]: { owner: ME, startedAt: 0, round: 0, rev: 2 },
  })
  const warning = `Beta：${CHAIN_OVERWRITTEN}`
  expect(CHAIN_OVERWRITTEN).toBe('流程紀錄寫入 3 次都被別的對話蓋掉，重新整理後再試')
  expect(log.list.filter(e => e.text === warning)).toHaveLength(1)
  expect(log.list.find(e => e.text === warning)?.tone).toBe('warning')
  expect(data.launches).toHaveLength(0)
})
