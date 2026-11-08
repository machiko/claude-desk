// 交叉驗收卡（external-review）的 AC-1～AC-5、AC-7、AC-8：專案設了 review.agent 時，一般驗收改派外部 Agent（card.py send），
// 結束後讀審查檔第一行寫回關卡、照 Claude 驗收的結論往下走；失敗改派 Claude 一次；資安審查照舊用 Claude。
// 外部 Agent 不真的跑：card.py send 由假的 process.run 回 pid、寫信標，結束由測試改信標與審查檔模擬。
import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, flat, text, PANE, CARD_A, NOW, PROJECT_DIR, TRUSTED, result } from './fixture'
import { ROOT, alphaOnly, helpers } from './alpha-chain'
import { picksMediumFix } from '../hooks/card'

const SETTINGS = `${PROJECT_DIR}/dispatch.json`
const BEACON = `${ROOT}/.task/agent-state.json`
const REVIEW = `${ROOT}/.task/REVIEW.md`
const PID = 4242
const OWNER = 'fixture-session'

/** 外部驗收的世界：只看 Alpha、設了 review.agent；card.py send 寫 working 信標、回 pid；kill -0 看 world.alive。 */
function externalWorld(data: any, clock: any, review: object = { agent: 'agy' }) {
  alphaOnly(data, clock)
  data.store.trustedVerify = TRUSTED
  data.files[SETTINGS] = JSON.stringify({ review })
  const world = { alive: true, sentAt: 0 }
  data.run = async (e: any) => {
    const argv = e.argv.map(String)
    if (argv[0] === 'python3' && argv[2] === 'send') {
      world.sentAt = clock.now()
      data.files[BEACON] = JSON.stringify({ state: 'working', agent: 'agy', pid: PID, startedAt: world.sentAt, updatedAt: world.sentAt })
      return result(0, `${JSON.stringify({ name: 'Alpha', root: ROOT, agent: 'agy', pid: PID, background: true })}\n`)
    }
    if (argv[0] === 'kill') return result(world.alive ? 0 : 1)
    return result(0, 'all green\n')
  }
  return world
}

/** card.py send 那幾次呼叫。 */
const sends = (data: any) => data.processCalls.filter((c: any) => c.argv[0] === 'python3' && c.argv[2] === 'send')
const sendPrompt = (data: any, i = 0) => String(sends(data)[i].argv[sends(data)[i].argv.length - 1])
const lastJob = (data: any) => (data.store.jobs as any)[ROOT].last
const chainOf = (data: any) => (data.store.chains as any)[ROOT]
const gateOf = (data: any) => String(data.files[CARD_A]!.match(/^- 關卡：(.*)$/m)![1])
const askOf = (data: any) => String(data.files[CARD_A]!.match(/^- 等你：(.*)$/m)![1])

/** 外部 Agent 做完：審查檔整份覆寫（修改時間是現在）、信標寫 state（同一次派工的 startedAt）。 */
function agentEnds(data: any, clock: any, world: { sentAt: number }, review: string | null, state = 'done') {
  if (review !== null) { data.files[REVIEW] = review; data.mtimes[REVIEW] = clock.now() }
  data.files[BEACON] = JSON.stringify({ state, agent: 'agy', startedAt: world.sentAt, updatedAt: clock.now(), ...(state === 'blocked' ? { waitsFor: 'question', message: '執行失敗（exit 1）' } : {}) })
}

/** 跑到自動流程派出驗收：/desk go → 實作做完 → 自動檢查 → 派驗收。 */
async function toReview($: any, data: any, clock: any) {
  const h = helpers($, data, clock)
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  await h.finish()
  return h
}

test('test_review_dispatches_external_agent_when_review_agent_set', async ($, on) => {
  const { data, clock } = fixture(on)
  const feed = feedLog(on)
  externalWorld(data, clock)
  await toReview($, data, clock)

  // 驗收用 card.py send 在 Alpha 的 worktree 背景啟動 agy，沒有多開 claude --bg（只有一開始的實作那次）
  expect(data.launches.length).toBe(1)
  expect(sends(data).length).toBe(1)
  const argv = sends(data)[0].argv.map(String)
  expect(argv.slice(2, 8)).toEqual(['send', 'alpha', '--to', 'agy', '--bg', '--json'])
  expect(argv[1]).toMatch(/\/skills\/card\/scripts\/card\.py$/)
  expect(sends(data)[0].init?.cwd ?? sends(data)[0].cwd).toBe(ROOT)
  expect(sendPrompt(data).startsWith('程式碼審查')).toBe(true)
  expect(sendPrompt(data)).toContain('第一行固定寫「審查：CRITICAL <n>、HIGH <n>、MEDIUM <n>、LOW <n>」')
  expect(sendPrompt(data)).toContain('不改程式、不改卡片、不 commit。')
  expect(sendPrompt(data)).not.toContain('最後把卡片 關卡 寫成')

  // 派工紀錄記成驗收、標明是外部 Agent；動態寫派給外部 Agent
  expect(lastJob(data).kind).toBe('review')
  expect(lastJob(data).external).toEqual({ agent: 'agy', pid: PID })
  expect(feed.has('Alpha 自動派驗收（外部 Agent agy）')).toBe(true)

  // 面板：重新整理後照信標顯示處理中、Agent 在驗收
  await helpers($, data, clock).refresh()
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  const shown = flat(text(await ui.drawn()))
  expect(shown).toContain(flat('Alpha 處理中'))
  expect(shown).toContain(flat('Agent 在驗收'))
  await ui.unmount()
})

test('test_external_review_result_writes_gate_and_continues_chain', async ($, on) => {
  const { data, clock } = fixture(on)
  const world = externalWorld(data, clock)
  const h = await toReview($, data, clock)
  expect(sends(data).length).toBe(1)

  agentEnds(data, clock, world, '審查：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 2\n- [HIGH][授權] app/a.ts:3 — 漏檢查資料範圍\n- [LOW][命名] app/b.ts:1 — 變數名\n- [LOW][命名] app/c.ts:1 — 變數名\n')
  await h.refresh(); await h.step(); await h.step(); await h.step()

  // 關卡寫回，接著照舊自動派 Claude 修正（接續實作那個 session）
  expect(gateOf(data)).toBe('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 2；外部驗收（agy）')
  expect(data.files[CARD_A]).toMatch(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}：工作桌：外部驗收（agy）寫回結論 → CRITICAL 0、HIGH 1、MEDIUM 0、LOW 2$/m)
  expect(data.launches.length).toBe(2)
  expect(h.prompt(1)).toContain('修正第 1／2 輪')
  expect(sends(data).length).toBe(1)
})

test('test_external_review_result_writes_gate_and_continues_chain：四個數字都是 0 直接過關', async ($, on) => {
  const { data, clock } = fixture(on)
  const world = externalWorld(data, clock)
  const h = await toReview($, data, clock)

  agentEnds(data, clock, world, '審查：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0\n（無）\n')
  await h.refresh(); await h.step(); await h.step(); await h.step()

  expect(gateOf(data)).toBe('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；外部驗收（agy）')
  expect(chainOf(data).passed).toBe(true)
  expect(data.launches.length).toBe(1)
  expect(data.toasts).toContain('Alpha：驗收通過，可以開 PR')
})

/** 外部驗收失敗後：動態寫原因、同一輪改派一次 Claude 驗收；Claude 驗收做完照舊往下走，不再派外部。 */
async function fallsBack($: any, on: any, fail: (data: any, clock: any, world: { alive: boolean; sentAt: number }) => void, why: string) {
  const { data, clock } = fixture(on)
  const feed = feedLog(on)
  const world = externalWorld(data, clock)
  const h = await toReview($, data, clock)
  expect(sends(data).length).toBe(1)

  fail(data, clock, world)
  await h.refresh(); await h.step(); await h.step()

  expect(feed.has(`Alpha 外部驗收沒有結果（${why}），改派 Claude 驗收`)).toBe(true)
  expect(data.launches.length).toBe(2)
  expect(h.prompt(1).startsWith('程式碼審查')).toBe(true)
  expect(h.prompt(1)).toContain('最後把卡片 關卡 寫成')
  expect(data.launches[1].argv).not.toContain('--resume')
  expect(lastJob(data).external).toBeUndefined()
  // 同一次失敗只改派一次：再重新整理幾輪也不會多派
  await h.refresh(); await h.step(); await h.step()
  expect(data.launches.length).toBe(2)
  expect(sends(data).length).toBe(1)

  // Claude 驗收照舊進行：寫了有 HIGH 的結論就派修正，不會改回外部
  h.setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏檢查')
  await h.finish()
  expect(data.launches.length).toBe(3)
  expect(h.prompt(2)).toContain('修正第 1／2 輪')
  expect(sends(data).length).toBe(1)
  return data
}

test('test_external_review_falls_back_to_claude_once_on_failure', async ($, on) => {
  // 信標是 blocked（外部 Agent 回報失敗）：審查檔就算寫了也不算
  const data = await fallsBack($, on, (d, clock, world) => agentEnds(d, clock, world, '審查：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0\n', 'blocked'), '外部 Agent 回報失敗')
  // 回報失敗的信標收成 idle，面板不再當成外部 Agent 在等你
  expect(JSON.parse(data.files[BEACON]!).state).toBe('idle')
})

test('test_external_review_falls_back_to_claude_once_on_failure：行程不在卻沒寫 done', async ($, on) => {
  await fallsBack($, on, (_d, _clock, world) => { world.alive = false }, '外部 Agent 已結束卻沒回報完成')
})

test('test_external_review_falls_back_to_claude_once_on_failure：審查檔沒有在派工後重寫', async ($, on) => {
  await fallsBack($, on, (d, clock, world) => {
    d.files[REVIEW] = '審查：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0\n'
    d.mtimes[REVIEW] = world.sentAt - 60_000
    agentEnds(d, clock, world, null)
  }, '審查檔沒有在派工後更新')
})

test('test_external_review_falls_back_to_claude_once_on_failure：第一行讀不到四個數字', async ($, on) => {
  await fallsBack($, on, (d, clock, world) => agentEnds(d, clock, world, '審查：CRITICAL 0、HIGH 1\n- [HIGH][授權] a.ts:1 — 漏檢查\n'), '審查檔第一行讀不到四個數字')
})

test('test_security_reviews_stay_on_claude_with_review_agent', async ($, on) => {
  // 高風險分支設了 combineSecurity：這次驗收併做資安，照舊派 Claude
  const { data, clock } = fixture(on)
  externalWorld(data, clock, { agent: 'agy', combineSecurity: true })
  data.git[ROOT] = { branch: 'feature/alpha', head: 'h1', files: ['app/Http/Middleware/Admin.php'] }
  const h = await toReview($, data, clock)
  expect(sends(data).length).toBe(0)
  expect(data.launches.length).toBe(2)
  expect(h.prompt(1).startsWith('程式碼審查')).toBe(true)
  expect(h.prompt(1)).toContain('這次審查同時做資安審查')
  expect(h.prompt(1)).toContain('最後把卡片 關卡 寫成')
  expect(h.prompt(1)).not.toContain('第一行固定寫')
  expect(lastJob(data).external).toBeUndefined()
})

test('test_security_reviews_stay_on_claude_with_review_agent：資安審查', async ($, on) => {
  // 高風險分支沒設 combineSecurity：一般驗收派外部，過了之後的資安審查照舊派 Claude
  const { data, clock } = fixture(on)
  const world = externalWorld(data, clock)
  data.git[ROOT] = { branch: 'feature/alpha', head: 'h1', files: ['app/Http/Middleware/Admin.php'] }
  const h = await toReview($, data, clock)
  expect(sends(data).length).toBe(1)

  agentEnds(data, clock, world, '審查：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0\n')
  await h.refresh(); await h.step(); await h.step(); await h.step()
  expect(data.launches.length).toBe(2)
  expect(h.prompt(1).startsWith('資安審查')).toBe(true)
  expect(h.prompt(1)).toContain('最後把卡片 關卡 寫成')
  expect(h.prompt(1)).not.toContain('第一行固定寫')
  expect(data.toasts).toContain('Alpha：資安驗收已派出')
  expect(lastJob(data).security).toBe(true)
  expect(lastJob(data).external).toBeUndefined()
  expect(sends(data).length).toBe(1)
})

test('test_external_review_medium_asks_same_question_as_claude', async ($, on) => {
  const { data, clock } = fixture(on)
  const world = externalWorld(data, clock)
  const h = await toReview($, data, clock)

  agentEnds(data, clock, world, [
    '審查：CRITICAL 0、HIGH 0、MEDIUM 2、LOW 0',
    '- [MEDIUM][命名] app/export.ts:3 — 匯出欄位名稱跟規格不一致（等你決定）',
    '- [MEDIUM][文件] README.md:1 — 設定表少一列（記錄、不修）',
  ].join('\n'))
  await h.refresh(); await h.step(); await h.step(); await h.step()

  const ask = askOf(data)
  expect(ask).toBe('審查 MEDIUM 1 條（匯出欄位名稱跟規格不一致）怎麼處理：A) 不修，記錄原因 B) 另開卡修（推薦，這張先過關） C) 修掉（在這張卡修，多一輪修正） D) 改規格')
  // 跟 Claude 驗收寫的題目同一種：面板選 C 照樣認成「修掉」
  expect(picksMediumFix(ask, 'C')).toBe(true)
  expect(gateOf(data)).toBe('review：CRITICAL 0、HIGH 0、MEDIUM 2、LOW 0；外部驗收（agy）')
  expect(chainOf(data).passed).toBe(true)
  expect(data.launches.length).toBe(1)
})

/** 直接放好一次在跑的外部驗收（流程是 owner 的），外部 Agent 已經做完：信標 done、審查檔有 HIGH。 */
function endedExternal(data: any, clock: any, owner: string, chain: object = {}) {
  alphaOnly(data, clock)
  data.files[SETTINGS] = JSON.stringify({ review: { agent: 'agy' } })
  data.run = async () => result(0, 'all green\n')
  data.store.chains = { [ROOT]: { owner, startedAt: NOW - 120_000, round: 0, ...chain } }
  data.store.jobs = { [ROOT]: { last: { launchName: 'desk-ext', nativeId: String(PID), sessionId: '', kind: 'review', startedAt: NOW - 60_000, fresh: true, owner, external: { agent: 'agy', pid: PID } } } }
  agentEnds(data, clock, { sentAt: NOW - 59_000 }, '審查：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0\n- [HIGH][授權] a.ts:1 — 漏檢查\n')
}

test('test_external_review_handled_only_by_owner_conversation', async ($, on) => {
  const { data, clock } = fixture(on)
  endedExternal(data, clock, 'other-session')
  const h = helpers($, data, clock)

  // 別的對話派的：這個對話看到它結束，不寫關卡、不派修正、也不改派 Claude
  await h.refresh(); await h.step(); await h.step()
  expect(gateOf(data)).toBe('無')
  expect(data.launches.length).toBe(0)
  expect(sends(data).length).toBe(0)
  expect(lastJob(data).external.settled).toBeUndefined()

  // 派工的那個對話（流程擁有者）才寫，寫過一次就不再寫
  data.store.chains = { [ROOT]: { ...chainOf(data), owner: OWNER } }
  await h.refresh(); await h.step(); await h.step(); await h.step()
  expect(gateOf(data)).toBe('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；外部驗收（agy）')
  expect(data.files[CARD_A]!.match(/工作桌：外部驗收（agy）寫回結論/g)!.length).toBe(1)
  expect(data.launches.length).toBe(1)
})

test('test_external_review_respects_paused_chain', async ($, on) => {
  const { data, clock } = fixture(on)
  endedExternal(data, clock, OWNER, { stopped: '你暫停了流程' })
  const h = helpers($, data, clock)

  // 暫停中：結論照樣寫回卡片（跟 Claude 驗收自己寫關卡一樣），但不往下派修正
  await h.refresh(); await h.step(); await h.step()
  expect(gateOf(data)).toBe('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；外部驗收（agy）')
  expect(data.launches.length).toBe(0)
  expect(sends(data).length).toBe(0)

  // 重開（流程不再暫停）：照結果繼續，有 HIGH 派修正
  const { stopped: _, ...open } = chainOf(data)
  data.store.chains = { [ROOT]: open }
  await h.refresh(); await h.step(); await h.step()
  expect(data.launches.length).toBe(1)
  expect(h.prompt(0)).toContain('修正第 1／2 輪')
})

test('test_external_review_respects_paused_chain：沒有結果時暫停中不改派', async ($, on) => {
  const { data, clock } = fixture(on)
  endedExternal(data, clock, OWNER, { stopped: '你暫停了流程' })
  data.files[BEACON] = JSON.stringify({ state: 'blocked', agent: 'agy', startedAt: NOW - 59_000, updatedAt: NOW })
  const h = helpers($, data, clock)

  await h.refresh(); await h.step(); await h.step()
  expect(data.launches.length).toBe(0)
  expect(gateOf(data)).toBe('無')

  const { stopped: _, ...open } = chainOf(data)
  data.store.chains = { [ROOT]: open }
  await h.refresh(); await h.step(); await h.step()
  expect(data.launches.length).toBe(1)
  expect(h.prompt(0).startsWith('程式碼審查')).toBe(true)
  expect(sends(data).length).toBe(0)
})
