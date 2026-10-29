import { expect, test } from 'claude-code/testing'
import { fixture, PANE, PROJECT_DIR, CARD_A, CARD_B, REGISTRY, result, text, flat } from './fixture'
import { autoPrApplies, autoPrPlan, passWords } from '../hooks/auto-pr'
import { NO_PUSH_NEEDED, parseSettings, queueRefusal } from '../hooks/dispatch'
import { pipeline } from '../hooks/pipeline'
import { buildCase } from '../hooks/model'
import type { Case, Verify } from '../types'

// 審查過關自動開 PR：專案 dispatch.json 設 "autoPr": true 時，過關後自動派推送 Agent（沒 PR 開 PR、PR 已開只 push）。
const SETTINGS = `${PROJECT_DIR}/dispatch.json`
const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const B = `case-${CARD_B}-`
const ME = 'fixture-session'
const PASSED = 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可合併'
const ASK = '審查 MEDIUM 1 條怎麼處理：A) 不修，記錄原因 B) 修掉'
const OPEN_PR = { number: 12, state: 'OPEN', baseRefName: 'release/v1.4', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }
const busy = (name: string, cwd: string) => ({ id: name.slice(-8), kind: 'background', cwd, name, sessionId: `${name.slice(-8)}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: 0 })
/** 三個在跑的工作桌 Agent，都在別的專案。 */
const FULL = () => [busy('desk-m0-0', '/home/u/other/one'), busy('desk-m0-1', '/home/u/other/two'), busy('desk-m0-2', '/home/u/other/three')]

const setGate = (data: any, card: string, gate: string) => { data.files[card] = data.files[card]!.replace(/- 關卡：.*$/m, `- 關卡：${gate}`) }
/** 這個對話的流程剛結束一次派工（還沒處理過）。 */
const lastJob = (kind: string, extra: object = {}) => ({ sessionId: 'r0000001-0000-4000-8000-000000000000', mark: '', last: { launchName: 'desk-old-0', nativeId: 'r0000001', sessionId: 'r0000001-0000-4000-8000-000000000000', kind, startedAt: 0, fresh: kind === 'review', owner: ME, ended: { how: 'finished' }, ...extra } })

/**
 * 只留 Beta 一件：GitHub remote、還沒 push 過、沒有 PR；這個對話的流程剛結束審查、關卡是過關的結論（只剩 MEDIUM）。
 * `settings` 是專案的 dispatch.json（null＝不寫）。
 */
function betaReviewed(data: any, settings: unknown = { autoPr: true }) {
  data.agents = []
  data.gh = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  setGate(data, CARD_B, PASSED)
  data.git[BETA] = { branch: 'feature/b', head: 'c2', remote: 'git@github.com:acme/shop.git', upstream: false }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  data.store.verifies = { [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' } }
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, reviewHead: 'c2', reviewBranch: 'feature/b' } }
  data.store.jobs = { [BETA]: lastJob('review') }
  if (settings !== null) data.files[SETTINGS] = typeof settings === 'string' ? settings : JSON.stringify(settings)
}

/** 派工會在那個根目錄多一個在跑的 Agent（照 `claude --bg` 的回應）。 */
function startsAgents(data: any, clock: any) {
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    data.agents = [...data.agents, { ...busy(e.argv[3], e.init.cwd), id, sessionId: `${id}-0000-4000-8000-000000000000`, startedAt: clock.now() }]
    return result(0, id)
  }
}

/** desk 自己跑的指令裡有沒有寫遠端的（git push、gh pr create／merge）。 */
function recordExec(data: any) {
  const calls: any[] = []
  data.exec = (e: any) => { calls.push(e); return null }
  return calls
}
const wroteRemote = (calls: any[]) => calls.some(e => (e.argv[0] === 'git' && e.argv.includes('push')) || (e.argv[0] === 'gh' && (e.argv.includes('create') || e.argv.includes('merge'))))

function capture(on: any) {
  const notified: string[] = []
  on('ui.notify', (_: any, e: any) => { notified.push(e.text); return { value: { isSent: true as const, channel: 'terminal_bell' as const } } })
  return notified
}

function helpers($: any, data: any, clock: any) {
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  /** 在跑的 Agent 都做完，重新整理後讓流程走幾步。 */
  const finish = async () => {
    data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
    await refresh(); await step(); await step(); await step()
  }
  const screen = async (ui: any) => flat(text(await ui.drawn()))
  const promptOf = (i = 0) => String(data.launches[i].argv.at(-1))
  const checks = () => data.processCalls.filter((c: any) => c.argv[0] === 'sh').length
  return { step, refresh, finish, screen, promptOf, checks }
}

/** AC-1：審查過關、還沒有 PR → 自動派推送 Agent（新對話）push 並開 PR；結束後不跑檢查、不派審查；desk 自己不寫遠端。 */
test('test_review_pass_dispatches_open_pr_agent_when_auto_pr_is_on', async ($, on) => {
  const { data, clock } = fixture(on)
  const notified = capture(on)
  betaReviewed(data)
  startsAgents(data, clock)
  const calls = recordExec(data)
  const h = helpers($, data, clock)

  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  const shown = await h.screen(ui)
  const p = h.promptOf()
  const checksBefore = h.checks()
  await h.finish()
  await h.finish()
  await ui.unmount()

  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(BETA)
  expect(data.launches[0].argv).not.toContain('--resume')
  expect(p.split('\n')[0]).toContain('推送：push feature/b 並對 release/v1.4 開 PR')
  expect(shown).toContain(flat('Beta 審查通過，自動派 Agent 開 PR'))
  expect(shown).toContain(flat('Beta 自動派推送'))
  expect(data.toasts).toContain('Beta：審查通過，自動派 Agent 開 PR')
  expect(notified).toContain('Beta：審查通過，自動派 Agent 開 PR')
  expect(data.toasts.some((t: string) => t.includes('可以開 PR'))).toBe(false)
  // 推送 Agent 結束後：不跑檢查、不派審查或任何 Agent
  expect(h.checks()).toBe(checksBefore)
  expect(data.launches).toHaveLength(1)
  expect(wroteRemote(calls)).toBe(false)
  expect(data.writes).not.toContain(CARD_B)
})

/** AC-1：只動文件、檢查通過免審查 → 一樣自動派開 PR，字是「免審查，自動派 Agent 開 PR」。 */
test('test_review_pass_dispatches_open_pr_agent_when_auto_pr_is_on — docs only skips review', async ($, on) => {
  const { data, clock } = fixture(on)
  const notified = capture(on)
  betaReviewed(data)
  setGate(data, CARD_B, '無')
  data.git[BETA]!.files = ['README.md', 'docs/guide.md']
  data.store.verifies = {}
  data.store.jobs = { [BETA]: lastJob('continue', { fresh: false }) }
  startsAgents(data, clock)
  const calls = recordExec(data)
  const h = helpers($, data, clock)

  await h.refresh()
  for (let i = 0; i < 4; i++) await h.step()
  const ui = await $.ui.mount(PANE(160))
  const shown = await h.screen(ui)
  await ui.unmount()

  expect(h.checks()).toBe(1)
  expect(data.launches).toHaveLength(1)
  expect(h.promptOf().split('\n')[0]).toContain('推送：push feature/b 並對 release/v1.4 開 PR')
  expect(shown).toContain(flat('免審查，自動派 Agent 開 PR'))
  expect(data.toasts).toContain('Beta：只動文件，免審查，自動派 Agent 開 PR')
  expect(notified).toContain('Beta：只動文件，免審查，自動派 Agent 開 PR')
  expect(data.toasts.some((t: string) => t.includes('可以開 PR'))).toBe(false)
  expect(wroteRemote(calls)).toBe(false)
})

/** AC-1：卡片「等你」還有題目（D-02 選 B）→ 照樣派；提示寫明保留原題目、要加的用「；」接在後面；推送結束後原題目還在。 */
test('test_review_pass_dispatches_open_pr_agent_when_auto_pr_is_on — keeps the open question', async ($, on) => {
  const { data, clock } = fixture(on)
  betaReviewed(data)
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 等你：無', `- 等你：${ASK}`)
  startsAgents(data, clock)
  const h = helpers($, data, clock)

  await h.refresh()
  await h.finish()
  const p = h.promptOf()

  expect(data.launches).toHaveLength(1)
  expect(p.split('\n')[0]).toContain('推送：push feature/b 並對 release/v1.4 開 PR')
  expect(p).toContain('沒有 gh 或平台開不了 PR（例如 Bitbucket）時，push 完把開 PR 的網址寫進 等你')
  expect(p).toContain('等你 原有的題目保留，要加的用「；」接在後面，不覆寫')
  expect(data.toasts).toContain('Beta：審查通過，自動派 Agent 開 PR')
  expect(data.files[CARD_B]).toContain(`- 等你：${ASK}`)
  expect(data.launches).toHaveLength(1)
})

/**
 * 審查通過後又有新 commit 的那輪：流程自動重新檢查、重新審查；這次在 c3 再過關。
 * 回傳派出去的推送提示（沒派就是 undefined）與畫面。
 */
async function recheckPasses($: any, on: any, ahead: number) {
  const { data, clock } = fixture(on)
  betaReviewed(data)
  data.gh = [OPEN_PR]
  data.git[BETA] = { branch: 'feature/b', head: 'c3', remote: 'git@github.com:acme/shop.git', upstream: true, ahead }
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, passed: true, reviewHead: 'c2', reviewBranch: 'feature/b', judgedHead: 'c2', judgedBranch: 'feature/b' } }
  data.store.jobs = { [BETA]: lastJob('publish', { handled: true }) }
  startsAgents(data, clock)
  const calls = recordExec(data)
  const h = helpers($, data, clock)

  await h.refresh()
  for (let i = 0; i < 4; i++) await h.step()
  const review = h.promptOf()
  await h.finish()
  const ui = await $.ui.mount(PANE(160))
  const shown = await h.screen(ui)
  await ui.unmount()
  return { data, h, calls, review, shown }
}

/** AC-2：PR #12 開著、重新審查過關、分支領先 2 → 只 push；領先 0 → 不派，等 CI 與合併。兩種都不開第二個 PR。 */
test('test_review_pass_only_pushes_when_pr_is_already_open', async ($, on) => {
  const { data, h, calls, review, shown } = await recheckPasses($, on, 2)

  expect(review.startsWith('程式碼審查')).toBe(true)
  expect(review).toContain('只看 `git diff c2..HEAD`')
  expect(data.launches).toHaveLength(2)
  const p = h.promptOf(1)
  expect(p.split('\n')[0]).toContain('推送：只 push feature/b（PR #12 已開，不開新 PR）')
  expect(p).not.toContain('開 PR，PR 網址寫進歷程')
  expect(shown).toContain(flat('Beta 審查通過，自動派 Agent push 到 PR #12'))
  expect(data.toasts).toContain('Beta：審查通過，自動派 Agent push 到 PR #12')
  expect(wroteRemote(calls)).toBe(false)
})

test('test_review_pass_only_pushes_when_pr_is_already_open — up to date dispatches nothing', async ($, on) => {
  const { data, calls, review, shown } = await recheckPasses($, on, 0)

  expect(review.startsWith('程式碼審查')).toBe(true)
  // 只有那次重新審查；沒有推送
  expect(data.launches).toHaveLength(1)
  expect(shown).toContain(flat('Beta 審查通過，PR #12 已是最新，等 CI 與合併'))
  expect(data.toasts).toContain('Beta：審查通過，PR #12 已是最新，等 CI 與合併')
  expect(wroteRemote(calls)).toBe(false)
})

/** AC-3：名額滿（maxAgents 3、已有 3 個工作桌 Agent）→ 推送排隊；有空位時派出。 */
test('test_auto_pr_waits_in_queue_when_agents_are_full', async ($, on) => {
  const { data, clock } = fixture(on)
  betaReviewed(data, { autoPr: true, maxAgents: 3 })
  data.agents = FULL()
  startsAgents(data, clock)
  const h = helpers($, data, clock)

  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  const queued = await h.screen(ui)
  const launchedWhileFull = data.launches.length
  // 一個做完：空出位子，派出推送
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()
  const after = await h.screen(ui)
  await ui.unmount()

  expect(launchedWhileFull).toBe(0)
  expect(queued).toContain(flat('Beta 自動派推送排隊中（第 1 位）'))
  expect(queued).toContain(flat('… 派工排隊中（第 1 位）'))
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(BETA)
  expect(h.promptOf().split('\n')[0]).toContain('推送：push feature/b 並對 release/v1.4 開 PR')
  expect(after).not.toContain('派工排隊中')
  expect((data.store.chains as any)[BETA].stopped).toBeUndefined()
})

/** AC-3：排隊時按 k 取消 → 流程仍是過關、沒有「流程已暫停」，合併段照舊有「⇡ 開 PR」可以按。 */
test('test_auto_pr_waits_in_queue_when_agents_are_full — cancel keeps the pass', async ($, on) => {
  const { data, clock } = fixture(on)
  betaReviewed(data, { autoPr: true, maxAgents: 3 })
  data.agents = FULL()
  startsAgents(data, clock)
  const h = helpers($, data, clock)

  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `${B}unqueue` }); await clock.settle()
  data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
  await h.refresh(); await h.step()
  const shown = await h.screen(ui)
  const openPr = await ui.find({ key: `${B}open-pr` })
  await ui.press({ key: `${B}open-pr` })
  await ui.press({ key: `${B}open-pr` })
  await clock.settle()
  await ui.unmount()

  const chain = (data.store.chains as any)[BETA]
  expect(chain.passed).toBe(true)
  expect(chain.stopped).toBeUndefined()
  expect(shown).toContain(flat('Beta 已取消排隊'))
  expect(shown).not.toContain(flat('流程已暫停'))
  expect(shown).not.toContain('派工排隊中')
  expect(openPr?.props?.label ?? openPr?.text).toBe('⇡ 開 PR')
  expect(data.launches).toHaveLength(1)
  expect(h.promptOf().split('\n')[0]).toContain('推送：push feature/b 並對 release/v1.4 開 PR')
})

/** AC-3：排隊期間 PR 被開了（例如你按了「⇡ 開 PR」）：派出時改成只 push；分支已是最新就不派，流程照樣是過關。 */
test('test_auto_pr_waits_in_queue_when_agents_are_full — a PR opened while queued is only pushed', async ($, on) => {
  const { data, clock } = fixture(on)
  betaReviewed(data, { autoPr: true, maxAgents: 3 })
  data.agents = FULL()
  startsAgents(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  data.gh = [OPEN_PR]
  data.git[BETA] = { ...data.git[BETA]!, upstream: true, ahead: 1 }
  // 超過 PR 的 5 分鐘快取，重新整理讀得到新開的 PR
  await clock.advance(6 * 60_000)
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()

  expect(data.launches).toHaveLength(1)
  expect(h.promptOf().split('\n')[0]).toContain('推送：只 push feature/b（PR #12 已開，不開新 PR）')
  expect(h.promptOf()).not.toContain('開 PR，PR 網址寫進歷程')
})

test('test_auto_pr_waits_in_queue_when_agents_are_full — dropped when nothing is left to push', async ($, on) => {
  const { data, clock } = fixture(on)
  betaReviewed(data, { autoPr: true, maxAgents: 3 })
  data.agents = FULL()
  startsAgents(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  data.gh = [OPEN_PR]
  data.git[BETA] = { ...data.git[BETA]!, upstream: true, ahead: 0 }
  await clock.advance(6 * 60_000)
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  const shown = await h.screen(ui)
  await ui.unmount()

  expect(data.launches).toHaveLength(0)
  expect(shown).toContain(flat(`Beta 排隊的推送沒有派出：${NO_PUSH_NEEDED}`))
  expect(shown).not.toContain(flat('流程已暫停'))
  expect((data.store.chains as any)[BETA].stopped).toBeUndefined()
  expect((data.store.chains as any)[BETA].passed).toBe(true)
})

/** AC-4：高風險（改到 Middleware）資安審查也過了 → 不派，照舊請你看過再開 PR。 */
test('test_auto_pr_is_skipped_when_high_risk_paused_foreign_or_pr_declined — high risk', async ($, on) => {
  const { data, clock } = fixture(on)
  betaReviewed(data)
  data.git[BETA]!.files = ['app/Http/Middleware/Admin.php']
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, reviewHead: 'c2', reviewBranch: 'feature/b', securityHead: 'c2', securityBranch: 'feature/b' } }
  data.store.jobs = { [BETA]: lastJob('review', { security: true }) }
  startsAgents(data, clock)
  const h = helpers($, data, clock)

  await h.refresh(); await h.step()

  expect(data.launches).toHaveLength(0)
  expect(data.toasts.some((t: string) => t.includes('高風險改動（認證／中介層），審查已過，請你看過再開 PR'))).toBe(true)
  expect(data.toasts.some((t: string) => t.includes('自動派'))).toBe(false)
  expect((data.store.chains as any)[BETA].needsHuman).toContain('認證／中介層')
})

/** AC-4：流程修了 2 輪仍有 HIGH、已暫停 → 不派，照舊「流程已暫停」。 */
test('test_auto_pr_is_skipped_when_high_risk_paused_foreign_or_pr_declined — paused', async ($, on) => {
  const { data, clock } = fixture(on)
  betaReviewed(data)
  setGate(data, CARD_B, 'review：CRITICAL 0、HIGH 2、MEDIUM 0、LOW 0；還有 bug')
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 2, reviewHead: 'c2', reviewBranch: 'feature/b' } }
  startsAgents(data, clock)
  const h = helpers($, data, clock)

  await h.refresh(); await h.step()

  expect(data.launches).toHaveLength(0)
  expect(data.toasts).toContain('Beta：流程已暫停，修了 2 輪仍有 CRITICAL 0、HIGH 2')
  expect(data.toasts.some((t: string) => t.includes('自動派'))).toBe(false)
})

/** AC-4：流程是別的對話開的 → 這個對話不動。 */
test('test_auto_pr_is_skipped_when_high_risk_paused_foreign_or_pr_declined — foreign chain', async ($, on) => {
  const { data, clock } = fixture(on)
  betaReviewed(data)
  const theirs = { owner: 'other-session', startedAt: 0, round: 0, reviewHead: 'c2', reviewBranch: 'feature/b' }
  data.store.chains = { [BETA]: theirs }
  data.store.jobs = { [BETA]: lastJob('review', { owner: 'other-session' }) }
  startsAgents(data, clock)
  const h = helpers($, data, clock)

  await h.refresh(); await h.step()

  expect(data.launches).toHaveLength(0)
  expect((data.store.chains as any)[BETA]).toEqual(theirs)
  expect(data.toasts.some((t: string) => t.includes('審查通過'))).toBe(false)
})

/** AC-4：之前的 PR #9 已被拒絕 → 不自己重開，說要重開請按 ⇡ 開 PR。 */
test('test_auto_pr_is_skipped_when_high_risk_paused_foreign_or_pr_declined — declined PR', async ($, on) => {
  const { data, clock } = fixture(on)
  betaReviewed(data)
  data.gh = [{ ...OPEN_PR, number: 9, state: 'CLOSED', statusCheckRollup: [] }]
  startsAgents(data, clock)
  const h = helpers($, data, clock)

  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  const shown = await h.screen(ui)
  await ui.unmount()

  expect(data.launches).toHaveLength(0)
  expect(shown).toContain(flat('PR #9 已被拒絕，要重開請按 ⇡ 開 PR'))
  expect(data.toasts).toContain('Beta：審查通過，PR #9 已被拒絕，要重開請按 ⇡ 開 PR')
})

/** 發版線（release/* 本身）或 detached HEAD 過關 → 設了 autoPr 也不派、不重讀 PR，字跟沒開一樣（審查 MEDIUM，D-04）。 */
test('test_auto_pr_is_skipped_when_high_risk_paused_foreign_or_pr_declined — release line or detached HEAD', async ($, on) => {
  const { data, clock } = fixture(on)
  betaReviewed(data)
  const calls = recordExec(data)
  startsAgents(data, clock)
  const h = helpers($, data, clock)

  for (const branch of ['release/v1.5', 'HEAD']) {
    data.git[BETA]!.branch = branch
    data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, reviewHead: 'c2', reviewBranch: branch } }
    data.store.jobs = { [BETA]: lastJob('review') }
    const toasts = data.toasts.length
    await h.refresh(); await h.step()
    expect(data.toasts.slice(toasts)).toContain('Beta：審查通過，可以開 PR')
    expect((data.store.chains as any)[BETA].passed).toBe(true)
  }

  expect(data.launches).toHaveLength(0)
  expect(data.toasts.some((t: string) => t.includes('自動派'))).toBe(false)
  expect(calls.some(e => e.argv[0] === 'gh')).toBe(false)
})

/** AC-5：沒設 autoPr（或寫成字串 "true"、數字 1）→ 不派，跟現在一樣說可以開 PR；按兩次「⇡ 開 PR」照舊派推送 Agent。 */
test('test_behaves_as_before_when_auto_pr_is_off_and_never_merges_when_on', async ($, on) => {
  const { data, clock } = fixture(on)
  betaReviewed(data, null)
  startsAgents(data, clock)
  const h = helpers($, data, clock)
  const ui = await $.ui.mount(PANE(160))

  for (const settings of [null, { autoPr: 'true' }, { autoPr: 1 }]) {
    if (settings) data.files[SETTINGS] = JSON.stringify(settings)
    data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, reviewHead: 'c2', reviewBranch: 'feature/b' } }
    data.store.jobs = { [BETA]: lastJob('review') }
    const toasts = data.toasts.length
    await h.refresh(); await h.step()
    expect(data.launches).toHaveLength(0)
    expect(data.toasts.slice(toasts)).toContain('Beta：審查通過，可以開 PR')
    expect((data.store.chains as any)[BETA].passed).toBe(true)
  }
  expect(await h.screen(ui)).toContain(flat('Beta 審查通過，可開 PR'))
  await ui.press({ key: `${B}open-pr` })
  await ui.press({ key: `${B}open-pr` })
  await clock.settle()
  await ui.unmount()

  expect(data.launches).toHaveLength(1)
  expect(h.promptOf().split('\n')[0]).toContain('推送：push feature/b 並對 release/v1.4 開 PR')
  expect(data.toasts.some((t: string) => t.includes('自動派'))).toBe(false)
})

/** AC-5：設了 autoPr、Alpha 也停在合併段沒有 PR → 只派 Beta；提示寫明範圍；desk 自己不 push、不開也不合併 PR。 */
test('test_behaves_as_before_when_auto_pr_is_off_and_never_merges_when_on — only the passing card', async ($, on) => {
  const { data, clock } = fixture(on)
  betaReviewed(data)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  setGate(data, CARD_A, PASSED)
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'a2', remote: 'git@github.com:acme/shop.git', upstream: false }
  data.store.trustedVerify = { ...(data.store.trustedVerify as object), [CARD_A]: 'node test.mjs' }
  data.store.verifies = { ...(data.store.verifies as object), [CARD_A]: { command: 'node test.mjs', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'a2' } }
  data.store.chains = { ...(data.store.chains as object), [ALPHA]: { owner: ME, startedAt: 0, round: 0, passed: true, reviewHead: 'a2', reviewBranch: 'feature/alpha', judgedHead: 'a2', judgedBranch: 'feature/alpha' } }
  startsAgents(data, clock)
  const calls = recordExec(data)
  const h = helpers($, data, clock)

  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  const alpha = { openPr: !!(await ui.find({ key: `case-${CARD_A}-open-pr` })) }
  await h.finish()
  await ui.unmount()

  expect(alpha.openPr).toBe(true)
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(BETA)
  const p = h.promptOf()
  expect(p.split('\n')[0]).toContain('推送：push feature/b 並對 release/v1.4 開 PR')
  expect(p).not.toContain('feature/alpha')
  expect(p).toContain('不 force push')
  expect(p).toContain('不 push 到其他分支')
  expect(p).toContain('不合併 PR')
  expect(p).toContain('不打 tag')
  expect(wroteRemote(calls)).toBe(false)
  expect(calls.filter((e: any) => e.argv[0] === 'gh').every((e: any) => e.argv[1] === 'pr' && e.argv[2] === 'list')).toBe(true)
})

// 純函式

const pr = (state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED', id = 12) => ({ id, state, ci: 'pass' as const })
const ahead = (n: number) => ({ ahead: n, behind: 0, changed: 0, untracked: 0, upstream: true })

test('autoPrPlan: high risk, declined, merged, open ahead, open up to date, no PR', () => {
  expect(autoPrPlan({ pr: undefined }, '高風險改動（認證／中介層），審查已過，請你看過再開 PR')).toEqual({ kind: 'skip', why: '' })
  expect(autoPrPlan({ pr: pr('DECLINED', 9) })).toEqual({ kind: 'skip', why: 'PR #9 已被拒絕，要重開請按 ⇡ 開 PR' })
  expect(autoPrPlan({ pr: pr('SUPERSEDED', 9) })).toEqual({ kind: 'skip', why: 'PR #9 已被拒絕，要重開請按 ⇡ 開 PR' })
  expect(autoPrPlan({ pr: pr('MERGED') })).toEqual({ kind: 'skip', why: 'PR #12 已合併' })
  expect(autoPrPlan({ pr: pr('OPEN'), gitState: ahead(2) })).toEqual({ kind: 'push', pr: 12 })
  expect(autoPrPlan({ pr: pr('OPEN'), gitState: ahead(0) })).toEqual({ kind: 'skip', why: 'PR #12 已是最新，等 CI 與合併' })
  expect(autoPrPlan({ pr: pr('OPEN') })).toEqual({ kind: 'skip', why: 'PR #12 已是最新，等 CI 與合併' })
  expect(autoPrPlan({ pr: undefined })).toEqual({ kind: 'open' })
})

test('autoPrApplies: not on a release line, a detached HEAD or without git', () => {
  const at = (branch: string) => ({ git: { branch, head: 'c2', files: [] } }) as unknown as Pick<Case, 'git'>
  expect(autoPrApplies(at('feature/b'))).toBe(true)
  expect(autoPrApplies(at('fix/release-notes'))).toBe(true)
  expect(autoPrApplies(at('release/v1.5'))).toBe(false)
  expect(autoPrApplies(at('HEAD'))).toBe(false)
  expect(autoPrApplies({ git: undefined })).toBe(false)
})

test('passWords: without autoPr the words are unchanged', () => {
  expect(passWords('Beta', undefined)).toEqual({ feed: 'Beta 審查通過，可開 PR', say: 'Beta：審查通過，可以開 PR' })
  expect(passWords('Beta', undefined, true)).toEqual({ feed: 'Beta 只動文件、檢查通過，免審查，可開 PR', say: 'Beta：只動文件，免審查，可以開 PR' })
  expect(passWords('Beta', { kind: 'open' }, true).say).toBe('Beta：只動文件，免審查，自動派 Agent 開 PR')
  expect(passWords('Beta', { kind: 'push', pr: 12 }).feed).toBe('Beta 審查通過，自動派 Agent push 到 PR #12')
})

test('parseSettings: autoPr only accepts JSON true', () => {
  expect(parseSettings(null).autoPr).toBe(false)
  expect(parseSettings('{}').autoPr).toBe(false)
  expect(parseSettings('{"autoPr": true}').autoPr).toBe(true)
  for (const bad of ['"true"', '1', 'false', '"yes"', 'null']) expect(parseSettings(`{"autoPr": ${bad}}`).autoPr).toBe(false)
})

/** 合併段 Beta 的 Case：卡片審查過關、檢查在 c2 過了；PR 與 git 狀態由呼叫端給。 */
function mergeCase(over: Partial<Case>): Case {
  const card = `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：合併\n- 關卡：${PASSED}\n<!-- /DESK -->`
  const v: Verify = { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' }
  const c: Case = { ...buildCase({ name: 'Beta', statusPath: CARD_B }, card, 1, {}, undefined), git: { branch: 'feature/b', head: 'c2' }, ...over }
  return { ...c, pipeline: pipeline(c, v) }
}

test('queueRefusal: an auto publish ignores the chain and only checks whether a push is still needed', () => {
  const entry = { kind: 'publish' as const, opts: { auto: true, text: 'push' } }
  const stopped = { owner: 'other-session', startedAt: 0, round: 0, stopped: '派工排隊已取消' }
  const noPr = mergeCase({})
  const upToDate = mergeCase({ pr: pr('OPEN'), gitState: ahead(0) })
  const behind = mergeCase({ pr: pr('OPEN'), gitState: ahead(1) })
  const merged = mergeCase({ pr: pr('MERGED') })
  const running = mergeCase({ state: 'running', agent: { name: 'desk-x', state: 'working', status: 'busy', startedAt: 0 } as any })

  expect(noPr.pipeline!.current).toBe('merge')
  expect(queueRefusal(noPr, entry, stopped, ME)).toBe('')
  expect(queueRefusal(noPr, entry, undefined, ME)).toBe('')
  expect(queueRefusal(behind, entry, stopped, ME)).toBe('')
  expect(queueRefusal(upToDate, entry, undefined, ME)).toBe(NO_PUSH_NEEDED)
  expect(queueRefusal(merged, entry, undefined, ME)).toBe('已經合併')
  expect(queueRefusal(running, entry, undefined, ME)).toBe('Agent 仍在執行')
  // 其他自動排的照舊看流程
  expect(queueRefusal(noPr, { kind: 'review', opts: { auto: true } }, undefined, ME)).toBe('流程已不是這個對話的')
})
