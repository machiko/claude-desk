import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, REGISTRY, result, text, flat } from './fixture'

// 推送開 PR 後面板重查 PR（pr-cache-after-publish 卡）：推送 Agent 結束的那一輪強制重查這張卡的 PR，
// 不再沿用開 PR 之前快取 5 分鐘的「沒有 PR」；記下結束後回到快取。
const BETA = '/home/u/wt/beta'
const PREFIX = `case-${CARD_B}-`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 2；可合併'
const OPEN_PR = { number: 12, state: 'OPEN', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }
/** 面板自己的定時重新整理（預設 30 秒一次，不強制重查 PR）。 */
const TICK_MS = 30_000

/** 只留 Beta 一件：審查過關、檢查在 c2 過了、沒有 Agent 在跑；流程是別的對話開的，不會自動派工。 */
function onlyBeta(data: any, git: Record<string, unknown>, gh: any[] = []) {
  data.agents = []
  data.gh = gh
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED)
  data.git[BETA] = { branch: 'feature/b', head: 'c2', remote: 'git@github.com:acme/shop.git', ...git }
  data.store.chains = { [BETA]: { owner: 'other-session', startedAt: 0, round: 0, passed: true, reviewHead: 'c2', judgedHead: 'c2' } }
  data.store.verifies = { [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' } }
}

/** 派工會啟動一個背景 Agent：清單裡多一個同名、在跑的 Agent（照 `claude --bg` 的回應）。 */
function startsAgents(data: any, clock: any) {
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    data.agents = [{ id, kind: 'background', cwd: BETA, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
}

/** 清單裡的 Agent 都做完了（idle／done）。 */
const finishAgents = (data: any) => { data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' })) }

async function mount($: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  return $.ui.mount(PANE(100))
}

/** 面板上按兩次（派工要按兩次確認），等派出去之後的那輪重新整理跑完。 */
async function pressTwice(ui: any, clock: any, id: string) {
  await ui.press({ key: `${PREFIX}${id}` })
  await ui.press({ key: `${PREFIX}${id}` })
  await clock.settle()
  await clock.advance(2500)
  await clock.settle()
}

/** 等下一次定時重新整理（不是按 r）。 */
async function tick(clock: any) {
  await clock.advance(TICK_MS)
  await clock.settle()
}

const screen = async (ui: any) => flat(text(await ui.drawn()))
const has = async (ui: any, id: string) => !!(await ui.find({ key: `${PREFIX}${id}` }))

/** AC-1 */
test('test_pr_shows_on_first_refresh_after_publish_agent_ends', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, { upstream: false }, [])
  startsAgents(data, clock)

  const ui = await mount($, clock)
  const before = await screen(ui)
  await pressTwice(ui, clock, 'open-pr')
  // 推送 Agent 開好 PR、推上分支後結束
  data.gh = [OPEN_PR]
  data.git[BETA] = { ...data.git[BETA]!, upstream: true, ahead: 0 }
  finishAgents(data)
  const mark = data.ghCalls.length
  await tick(clock)
  const after = await screen(ui)
  const openPr = await has(ui, 'open-pr')
  await ui.unmount()

  expect(before).toContain(flat('▶ 輪到你  n 開 PR'))
  expect(data.launches).toHaveLength(1)
  expect(data.ghCalls.length - mark).toBe(1)
  expect(after).toContain(flat('PR #12'))
  expect(after).not.toContain(flat('n 開 PR'))
  expect(openPr).toBe(false)
})

/** AC-2 */
test('test_running_publish_agent_does_not_requery_pr', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, { upstream: false }, [])
  startsAgents(data, clock)

  const ui = await mount($, clock)
  await pressTwice(ui, clock, 'open-pr')
  const mark = data.ghCalls.length
  await tick(clock)
  const running = await screen(ui)
  await ui.unmount()

  expect(data.launches).toHaveLength(1)
  expect(data.ghCalls.length - mark).toBe(0)
  expect(running).toContain(flat('Agent 在 push、開 PR'))
})

/** AC-3 */
test('test_pr_cache_resumes_after_publish_end_is_noted', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, { upstream: false }, [])
  startsAgents(data, clock)

  const ui = await mount($, clock)
  await pressTwice(ui, clock, 'open-pr')
  data.gh = [OPEN_PR]
  data.git[BETA] = { ...data.git[BETA]!, upstream: true, ahead: 0 }
  finishAgents(data)
  await tick(clock)
  const ended = data.ghCalls.length
  await tick(clock)
  await tick(clock)
  await tick(clock)
  const later = await screen(ui)
  await ui.unmount()

  expect(ended).toBeGreaterThan(0)
  expect(data.ghCalls.length - ended).toBe(0)
  expect(later).toContain(flat('PR #12'))
})

/** AC-4 */
test('test_bitbucket_pr_requeried_after_push_agent_ends', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, { ahead: 1, remote: 'git@bitbucket.org:acme/shop.git' })
  data.prs = [{ id: 7, state: 'OPEN', dest: 'main', url: 'https://bitbucket.org/acme/shop/pull-requests/7' }]
  data.statuses = ['SUCCESSFUL']
  startsAgents(data, clock)

  const ui = await mount($, clock)
  const before = await screen(ui)
  await pressTwice(ui, clock, 'push')
  // 推上新 commit 後 CI 沒過
  data.git[BETA] = { ...data.git[BETA]!, ahead: 0 }
  data.statuses = ['FAILED']
  finishAgents(data)
  const mark = data.mcpCalls.length
  await tick(clock)
  const calls = data.mcpCalls.slice(mark)
  const after = await screen(ui)
  await ui.unmount()

  expect(before).not.toContain(flat('CI 失敗'))
  expect(data.launches).toHaveLength(1)
  expect(calls.map((c: any) => String(c.args?.path ?? ''))).toEqual(['/repositories/acme/shop/pullrequests', '/repositories/acme/shop/pullrequests/7/statuses'])
  expect(after).toContain(flat('p 開 PR 看 CI 失敗原因'))
})

/** K-1：實作的 Agent 在合併段之前結束，PR 照舊走快取。 */
test('test_other_agent_end_keeps_pr_cache', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, { upstream: false }, [])
  data.files[CARD_B] = data.files[CARD_B]!.replace(PASSED, '- 關卡：無')
  data.store.chains = {}
  data.store.verifies = {}
  data.store.jobs = { [BETA]: { sessionId: 'b0000001-0000-4000-8000-000000000000', last: { launchName: 'desk-impl', nativeId: 'b0000001', sessionId: 'b0000001-0000-4000-8000-000000000000', kind: 'continue', startedAt: 0, fresh: true, owner: 'other-session' } } }
  data.agents = [{ id: 'b0000001', kind: 'background', cwd: BETA, name: 'desk-impl', sessionId: 'b0000001-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: clock.now() }]

  const ui = await mount($, clock)
  const first = data.ghCalls.length
  finishAgents(data)
  await tick(clock)
  const noted = (data.store.jobs as any)[BETA].last.ended
  await ui.unmount()

  expect(first).toBeGreaterThan(0)
  expect(noted).toBeDefined()
  expect(data.ghCalls.length - first).toBe(0)
})
