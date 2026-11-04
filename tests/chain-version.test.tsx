import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, NOW, PANE, PROJECT_DIR, CARD_B, REGISTRY, result } from './fixture'
import { resetText } from '../hooks/model'
import { AGENT_STOPPED, CHAIN_CHANGED, CHAIN_OVERWRITTEN, CHECK_UNAPPROVED } from '../hooks/chain'

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

/**
 * 別的對話在這個對話寫完 Beta 的流程紀錄之後，用它早先讀到的舊表整張寫回（改的是 Alpha），把 Beta 退回版本 2；times 次之後不再發生。
 * `when` 挑哪幾次寫入會被蓋掉（預設：Beta 版本超過 2 的每一次）。
 */
function staleOverwrites(data: any, times: number, when: (beta: any) => boolean = beta => beta?.rev > 2) {
  let n = 0
  const stale = () => ({
    [ALPHA]: { owner: 'other-session', startedAt: 0, round: 1, rev: 5 },
    [BETA]: { owner: ME, startedAt: 0, round: 0, rev: 2 },
  })
  data.storeAfterSet = (key: string, value: any) => {
    if (key !== 'chains' || !when(value?.[BETA]) || n >= times) return
    n++
    data.store.chains = stale()
  }
  return { count: () => n, stop: () => { times = n } }
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

function capture(on: any) {
  const notified: string[] = []
  on('ui.notify', (_: any, e: any) => { notified.push(e.text); return { value: { isSent: true as const, channel: 'terminal_bell' as const } } })
  return notified
}

/** AC-5：連續 3 次重套都被蓋掉：放棄，紀錄維持別的對話寫的；動態寫一筆警告，不發暫停的動態、toast 與通知。
 * 那次派工改回未處理，之後每次重新整理都再試；一直被蓋掉，警告仍只有一筆。寫成功後清掉，之後再放棄會再寫一筆。 */
test('test_three_overwrites_in_a_row_give_up_and_post_a_warning', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const notified = capture(on)
  betaImplemented(data, clock, { rev: 2 })
  data.store.chains = { ...chains(data), [ALPHA]: { owner: 'other-session', startedAt: 0, round: 0, rev: 4 } }
  quota(data, 75)
  const overwrites = staleOverwrites(data, Infinity)
  const h = helpers($, clock)
  const warning = `Beta：${CHAIN_OVERWRITTEN}`
  const warnings = () => log.list.filter(e => e.text === warning)
  const paused = () => log.list.filter(e => e.text === `Beta 流程已暫停：${REASON}`)

  await h.refresh()
  await h.step()

  expect(overwrites.count()).toBe(3)
  expect(chains(data)).toEqual({
    [ALPHA]: { owner: 'other-session', startedAt: 0, round: 1, rev: 5 },
    [BETA]: { owner: ME, startedAt: 0, round: 0, rev: 2 },
  })
  expect(CHAIN_OVERWRITTEN).toBe('流程紀錄寫入 3 次都被別的對話蓋掉，重新整理後再試')
  expect(warnings()).toHaveLength(1)
  expect(warnings()[0]?.tone).toBe('warning')
  expect(paused()).toHaveLength(0)
  expect(data.toasts.some((t: string) => t.includes('流程已暫停'))).toBe(false)
  expect(notified.some(t => t.includes('流程已暫停'))).toBe(false)
  expect((data.store.jobs as any)[BETA].last.handled).toBeFalsy()

  // 重新整理後再試：一直被蓋掉，每次都重套 3 次，警告仍只有一筆
  for (let i = 0; i < 2; i++) { await h.refresh(); await h.step() }
  expect(overwrites.count()).toBe(9)
  expect(warnings()).toHaveLength(1)
  expect(data.launches).toHaveLength(0)

  // 別的對話不再蓋：下次重新整理寫進去，照常暫停並通知一次
  overwrites.stop()
  await h.refresh(); await h.step()
  expect(chains(data)[BETA].stopped).toBe(REASON)
  expect(chains(data)[BETA].rev).toBe(3)
  expect(paused()).toHaveLength(1)

  // 寫成功後清掉去重：之後同一件再放棄，會再寫一筆
  data.store.chains = { ...chains(data), [BETA]: { owner: ME, startedAt: 0, round: 0, rev: 3 } }
  data.store.jobs = { [BETA]: lastJob('continue', { fresh: false }) }
  const again = staleOverwrites(data, Infinity)
  await h.refresh(); await h.step()
  expect(again.count()).toBe(3)
  expect(warnings()).toHaveLength(2)
  expect(paused()).toHaveLength(1)
})

/** AC-5：要派審查時寫輪數被蓋掉、放棄：不派 Agent，紀錄維持別的對話寫的。 */
test('test_three_overwrites_in_a_row_give_up_and_post_a_warning — no agent is dispatched', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  betaImplemented(data, clock, { rev: 2 })
  const overwrites = staleOverwrites(data, Infinity)
  const h = helpers($, clock)

  await h.refresh()
  await h.step()

  expect(overwrites.count()).toBe(3)
  expect(data.launches).toHaveLength(0)
  expect(chains(data)[BETA]).toEqual({ owner: ME, startedAt: 0, round: 0, rev: 2 })
  expect(log.list.filter(e => e.text === `Beta：${CHAIN_OVERWRITTEN}`)).toHaveLength(1)
  expect((data.store.jobs as any)[BETA].last.handled).toBeFalsy()

  // 那次派工改回未處理：下次重新整理再重套 3 次，仍不派、警告仍一筆
  await h.refresh()
  await h.step()
  expect(overwrites.count()).toBe(6)
  expect(data.launches).toHaveLength(0)
  expect(log.list.filter(e => e.text === `Beta：${CHAIN_OVERWRITTEN}`)).toHaveLength(1)
})

/** AC-5：只動文件、檢查通過的過關寫入放棄：不發過關的動態、toast、通知，不自動派推送；那次派工改回未處理。 */
test('test_three_overwrites_in_a_row_give_up_and_post_a_warning — a pass is not announced or pushed', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const notified = capture(on)
  betaImplemented(data, clock, { rev: 2 })
  data.git[BETA] = { branch: 'feature/b', head: 'c2', files: ['README.md'], remote: 'git@github.com:acme/shop.git', upstream: false }
  data.files[`${PROJECT_DIR}/dispatch.json`] = JSON.stringify({ autoPr: true })
  const overwrites = staleOverwrites(data, Infinity)
  const h = helpers($, clock)

  await h.refresh()
  for (let i = 0; i < 3; i++) await h.step()

  expect(overwrites.count()).toBeGreaterThanOrEqual(3)
  expect(chains(data)[BETA].passed).toBeUndefined()
  expect(log.list.some(e => e.text.includes('免審查'))).toBe(false)
  expect(data.toasts.some((t: string) => t.includes('免審查'))).toBe(false)
  expect(notified).toEqual([])
  expect(data.launches).toHaveLength(0)
  expect((data.store.jobs as any)[BETA].last.handled).toBeFalsy()
  expect(log.list.filter(e => e.text === `Beta：${CHAIN_OVERWRITTEN}`)).toHaveLength(1)
})

/** AC-5：審查結論（審查時的 HEAD）寫入放棄：不歸檔審查檔、不往下走（不過關、不派），那次審查派工維持未處理。 */
test('test_three_overwrites_in_a_row_give_up_and_post_a_warning — a review verdict is not archived', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  betaImplemented(data, clock, { rev: 2, reviewHead: 'c2', reviewBranch: 'feature/b' })
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；可合併')
  data.files[`${BETA}/.task/REVIEW.md`] = '（無）'
  data.store.jobs = { [BETA]: lastJob('review') }
  const overwrites = staleOverwrites(data, Infinity)
  const h = helpers($, clock)

  await h.refresh()
  await h.step()

  expect(overwrites.count()).toBe(3)
  expect(data.writes.some((w: string) => w.includes('/reviews/'))).toBe(false)
  expect(chains(data)[BETA]).toEqual({ owner: ME, startedAt: 0, round: 0, rev: 2 })
  expect(log.list.some(e => e.text.includes('可開 PR') || e.text.includes('審查通過'))).toBe(false)
  expect(data.launches).toHaveLength(0)
  expect((data.store.jobs as any)[BETA].last.handled).toBeFalsy()
})

const TEMPLATE_SPEC = '\n## 規格\n\n- 目標：<一句話>\n\n### 驗收情境\n\n| # | 給定 | 當 | 則 | 對應測試 |\n| --- | --- | --- | --- | --- |\n| AC-1 | <前提> | <操作> | <看得到的結果> | `<測試名稱>` |\n'

/** AC-5：規格還是範本、流程要停在規格段，寫入放棄：不寫「流程停下」；之後每次重新整理再試，警告仍只有一筆。 */
test('test_three_overwrites_in_a_row_give_up_and_post_a_warning — a spec stop is not announced', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  betaImplemented(data, clock, { rev: 2 })
  data.files[CARD_B] = data.files[CARD_B]! + TEMPLATE_SPEC
  const overwrites = staleOverwrites(data, Infinity)
  const h = helpers($, clock)

  await h.refresh()
  await h.step()
  expect(overwrites.count()).toBe(3)
  expect(log.list.some(e => e.text.startsWith('Beta 流程停下'))).toBe(false)

  await h.refresh()
  await h.step()
  expect(overwrites.count()).toBe(6)
  expect(log.list.some(e => e.text.startsWith('Beta 流程停下'))).toBe(false)
  expect(log.list.filter(e => e.text === `Beta：${CHAIN_OVERWRITTEN}`)).toHaveLength(1)
  expect(chains(data)[BETA].stopped).toBeUndefined()
})

/** AC-5：排隊的自動驗收被額度擋下、停下流程的寫入放棄：不跳「流程已暫停」的 toast 與通知，紀錄維持別的對話寫的。 */
test('test_three_overwrites_in_a_row_give_up_and_post_a_warning — a dropped queued dispatch does not announce a pause', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const notified = capture(on)
  betaImplemented(data, clock)
  data.agents = [busy('desk-m0-0', '/home/u/other/one'), busy('desk-m0-1', '/home/u/other/two'), busy('desk-m0-2', '/home/u/other/three')]
  const h = helpers($, clock)
  await h.refresh()
  await h.step()
  expect(log.has('Beta 自動派驗收排隊中（第 1 位）')).toBe(true)

  const overwrites = staleOverwrites(data, Infinity, beta => !!beta?.stopped)
  quota(data, 75)
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()

  expect(overwrites.count()).toBe(3)
  expect(data.launches).toHaveLength(0)
  expect(chains(data)[BETA].stopped).toBeUndefined()
  expect(data.toasts.some((t: string) => t.startsWith('Beta：流程已暫停'))).toBe(false)
  expect(notified.some(t => t.startsWith('Beta：流程已暫停'))).toBe(false)
})

/** AC-5：自動跑的完成檢查中斷、停下流程的寫入放棄：不發「流程已暫停」的通知。 */
test('test_three_overwrites_in_a_row_give_up_and_post_a_warning — an interrupted check does not announce a pause', async ($, on) => {
  const { data, clock } = fixture(on)
  const notified = capture(on)
  // 檢查跑完要記 Beta 的結果時被拒：檢查中斷（重新整理自己讀進來的那次不擋）。
  on('state.set', (_: any, e: any, next: any) => e?.plugin === 'desk' && e?.key === 'verifies' && e.value?.[CARD_B] ? { deny: '狀態寫不進去' } : next(e))
  betaImplemented(data, clock, { rev: 2 })
  data.store.verifies = {}
  const overwrites = staleOverwrites(data, Infinity)
  const h = helpers($, clock)

  await h.refresh()
  for (let i = 0; i < 3; i++) await h.step()

  expect(data.toasts.some((t: string) => t.startsWith('Beta：檢查中斷'))).toBe(true)
  expect(overwrites.count()).toBeGreaterThanOrEqual(3)
  expect(chains(data)[BETA].stopped).toBeUndefined()
  expect(notified.some(t => t.includes('流程已暫停'))).toBe(false)
})

/** AC-5：自動跑的完成檢查要用的容器沒啟動、停下流程的寫入放棄：不發「流程已暫停」的通知。 */
test('test_three_overwrites_in_a_row_give_up_and_post_a_warning — a check held for a stopped container does not announce a pause', { options: { composeDir: '/home/u/app' } }, async ($, on) => {
  const { data, clock } = fixture(on)
  const notified = capture(on)
  const check = 'docker compose exec -T app php artisan test'
  betaImplemented(data, clock, { rev: 2 })
  data.files[CARD_B] = data.files[CARD_B]!.replace('`npm test`', `\`${check}\``)
  data.compose = JSON.stringify({ Service: 'app', State: 'exited', Health: '' })
  data.store.trustedVerify = { [CARD_B]: check }
  data.store.verifies = {}
  const overwrites = staleOverwrites(data, Infinity)
  const h = helpers($, clock)

  await h.refresh()
  for (let i = 0; i < 3; i++) await h.step()

  expect(data.toasts.some((t: string) => t.includes('容器 app 未啟動'))).toBe(true)
  expect(overwrites.count()).toBeGreaterThanOrEqual(3)
  expect(chains(data)[BETA].stopped).toBeUndefined()
  expect(notified.some(t => t.includes('流程已暫停'))).toBe(false)
})

/** AC-5：停在檢查段、你按 v 跑完，解除暫停的寫入放棄：不寫「流程繼續」，那次實作維持處理過。 */
test('test_three_overwrites_in_a_row_give_up_and_post_a_warning — a check run by hand does not claim the chain resumed', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  betaImplemented(data, clock, { rev: 2, stopped: CHECK_UNAPPROVED, heldAtCheck: true })
  data.store.verifies = {}
  data.store.jobs = { [BETA]: lastJob('continue', { fresh: false, handled: true }) }
  const h = helpers($, clock)
  await h.refresh()
  const overwrites = staleOverwrites(data, Infinity)

  await $.command.run({ command: 'desk', args: 'verify Beta' } as any)
  await clock.settle()
  await h.step()

  expect(log.has('Beta 檢查通過')).toBe(true)
  expect(overwrites.count()).toBe(3)
  expect(log.list.some(e => e.text.includes('流程繼續'))).toBe(false)
  expect((data.store.jobs as any)[BETA].last.handled).toBe(true)
})

/** AC-5：審查過關後跟基準分支有衝突、解衝突派不出去，停下流程的寫入放棄：不寫「流程已暫停」、不發通知。 */
test('test_three_overwrites_in_a_row_give_up_and_post_a_warning — an unsent conflict agent does not announce a pause', { timeoutMs: 15_000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const notified = capture(on)
  data.agents = []
  data.gh = [{ number: 12, state: 'OPEN', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }]
  data.files[REGISTRY] = registry([['Beta', CARD_B]])
  data.files[CARD_B] = '<!-- DESK -->\n- 狀態：Beta 過關\n- 驗證：`npm test`\n- 等你：無\n- 下一步：合併\n- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 1；可合併\n<!-- /DESK -->'
  data.git[BETA] = { branch: 'feature/b', head: 'h1', remote: 'git@github.com:acme/shop.git', releases: '', conflicts: ['src/a.ts', 'src/b.ts'] }
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, passed: true, reviewHead: 'h1', reviewBranch: 'feature/b', judgedHead: 'h1', judgedBranch: 'feature/b', rev: 2 } }
  data.store.verifies = { [CARD_B]: ok('h1') }
  data.store.jobs = { [BETA]: lastJob('review', { handled: true }) }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  data.launch = async () => result(1, '', 'claude: 無法啟動背景 Agent')
  const overwrites = staleOverwrites(data, Infinity, beta => !!beta?.stopped)
  const h = helpers($, clock)

  for (let i = 0; i < 2; i++) { await h.refresh(); await h.step() }

  expect(data.launches.length).toBeGreaterThanOrEqual(1)
  expect(overwrites.count()).toBe(3)
  expect(chains(data)[BETA].stopped).toBeUndefined()
  expect(log.list.some(e => e.text.includes('流程已暫停'))).toBe(false)
  expect(notified.some(t => t.includes('解衝突沒派出'))).toBe(false)
})

/** AC-6：同一件的兩個寫入同時進行、兩邊都讀到版本 4：這個對話停下流程（寫 stopped），別的對話接手（改 owner），它比較晚寫回、蓋掉這格。
 * 這個對話重讀時看到同版但標記不是自己的，就在最新的紀錄上重套；最後兩邊的改動都在、版本 6，兩邊都算有存。 */
test('test_two_concurrent_writes_to_the_same_record_keep_both_changes', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  betaImplemented(data, clock, { rev: 4 })
  data.store.chains = { ...chains(data), [ALPHA]: { owner: 'other-session', startedAt: 0, round: 0, rev: 1 } }
  quota(data, 75)
  // 別的對話在這個對話寫回之前就讀到版本 4；這個對話第一次寫回後，它才把自己的改動寫回（版本也是 5、標記是它的）。
  const seen = structuredClone(chains(data))
  const theirStamp = 'other-session#1'
  const sets: any[] = []
  data.storeAfterSet = (key: string, value: any) => {
    if (key !== 'chains') return
    sets.push(value[BETA])
    if (sets.length === 1) data.store.chains = { ...seen, [BETA]: { ...seen[BETA], owner: 'other-session', rev: 5, stamp: theirStamp } }
  }
  const h = helpers($, clock)

  await h.refresh()
  await h.step()

  // 這個對話第一次寫成版本 5（被同版的別人蓋掉），重套成 6
  expect(sets.map(v => v.rev)).toEqual([5, 6])
  const final = chains(data)[BETA]
  expect(final.stopped).toBe(REASON)
  expect(final.owner).toBe('other-session')
  expect(final.rev).toBe(6)
  expect(final.stamp).not.toBe(theirStamp)
  expect(chains(data)[ALPHA]).toEqual({ owner: 'other-session', startedAt: 0, round: 0, rev: 1 })
  // 這個對話回有存：照常記暫停、沒有放棄的警告
  expect(log.list.filter(e => e.text === `Beta 流程已暫停：${REASON}`)).toHaveLength(1)
  expect(log.has(CHAIN_OVERWRITTEN)).toBe(false)
  // 別的對話重讀時看到的版本（6）比它寫的（5）大：它的改動也算寫進去了
  expect(final.rev).toBeGreaterThan(5)
})
