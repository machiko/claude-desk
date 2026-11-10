import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, NOW, PANE, PROJECT_DIR, CARD_A, CARD_B, CARD_C, REGISTRY, text, flat, storedStop } from './fixture'
import { screen, busyAgent as busy, startsAgents } from './world'
import { DEFAULT_CHAIN_QUOTA_STOP, parseSettings } from '../hooks/dispatch'
import { nextStep } from '../hooks/chain'
import { quotaHold, resetText } from '../hooks/model'
import { stopText } from '../hooks/stop-reason'
import { QUOTA_NOTHING_TO_FIX } from '../hooks/prompts/fix'

// 自動流程額度煞車：5 小時額度剩餘低於門檻（dispatch.json 的 chainQuotaStop，預設 30%）時，自動流程不派下一個 Agent、暫停寫原因；手動派工照派。
const SETTINGS = '/home/u/.claude/handoffs/dispatch.json'
const PROJECT_SETTINGS = `${PROJECT_DIR}/dispatch.json`
const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const ME = 'fixture-session'
const RESETS_AT = new Date(NOW + 2.5 * 3_600_000).toISOString()
/** 預設門檻、剩 25% 時的原因句（重置時間跟面板 header 同一種寫法）。 */
const REASON = `5 小時額度剩 25%，低於門檻 30%，${resetText(RESETS_AT, NOW)}後按 g 重開`
/** 解衝突被擋下：合併段沒有 g 可按，結尾改成叫你在對話處理。 */
const CATCHUP_REASON = `5 小時額度剩 25%，低於門檻 30%，${resetText(RESETS_AT, NOW)}後在對話合併基準分支、解衝突`

const FULL = () => [busy('desk-m0-0', '/home/u/other/one'), busy('desk-m0-1', '/home/u/other/two'), busy('desk-m0-2', '/home/u/other/three')]
const setGate = (data: any, card: string, gate: string) => { data.files[card] = data.files[card]!.replace(/- 關卡：.*$/m, `- 關卡：${gate}`) }
const registry = (rows: [string, string][]) => `## 任務\n| Project | path |\n| --- | --- |\n${rows.map(([n, p]) => `| ${n} | \`${p}\` |`).join('\n')}`
const lastJob = (kind: string, extra: object = {}) => ({ sessionId: 'r0000001-0000-4000-8000-000000000000', mark: '', last: { launchName: 'desk-old-0', nativeId: 'r0000001', sessionId: 'r0000001-0000-4000-8000-000000000000', kind, startedAt: 0, fresh: kind === 'review', owner: ME, ended: { how: 'finished' }, ...extra } })
const ok = (head: string) => ({ command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head })

/** 5 小時額度已用 used%（剩 100 - used）；本週那條一起給，煞車只看 five_hour。 */
function quota(data: any, used: number) {
  data.usage = { ...data.usage, rateLimits: [{ kind: 'five_hour', percentUsed: used, resetsAt: RESETS_AT }, { kind: 'seven_day', percentUsed: 95, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() }] }
}

function capture(on: any) {
  const notified: string[] = []
  on('ui.notify', (_: any, e: any) => { notified.push(e.text); return { value: { isSent: true as const, channel: 'terminal_bell' as const } } })
  return notified
}

function helpers($: any, data: any, clock: any) {
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  const checks = () => data.processCalls.filter((c: any) => c.argv[0] === 'sh').length
  return { step, refresh, screen, checks }
}

/** 只留 Beta：這個對話的流程剛結束實作、完成檢查在 c2 跑過且綠了；改的是程式（要派審查）。 */
function betaImplemented(data: any, clock: any) {
  data.agents = []
  data.gh = []
  data.files[REGISTRY] = registry([['Beta', CARD_B]])
  data.git[BETA] = { branch: 'feature/b', head: 'c2', files: ['src/app.ts'] }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  data.store.verifies = { [CARD_B]: ok('c2') }
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0 } }
  data.store.jobs = { [BETA]: lastJob('continue', { fresh: false }) }
  startsAgents(data, clock, { keep: 'others' })
}

/** AC-1：要派審查、5 小時剩 25%：不派，流程暫停；動態、toast、系統通知各一次；面板「輪到你」寫同一句。 */
test('test_auto_chain_stops_before_next_agent_when_five_hour_quota_is_below_threshold', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const notified = capture(on)
  betaImplemented(data, clock)
  quota(data, 75)
  const h = helpers($, data, clock)

  await h.refresh()
  for (let i = 0; i < 3; i++) { await h.step(); await h.refresh() }
  const ui = await $.ui.mount(PANE(160))
  const shown = await h.screen(ui)
  await ui.unmount()

  expect(data.launches).toHaveLength(0)
  expect((data.store.chains as any)[BETA].stopped).toBe('quotaHold')
  expect(log.list.filter(e => e.text === `Beta 流程已暫停：${REASON}`)).toHaveLength(1)
  expect(data.toasts.filter((t: string) => t === `Beta：流程已暫停，${REASON}`)).toHaveLength(1)
  expect(notified.filter(t => t === `Beta：流程已暫停，${REASON}`)).toHaveLength(1)
  expect(shown).toContain(flat(`輪到你 ${REASON}`))
})

/** AC-1 邊界：剛好剩 30%（等於門檻）不停，照常派審查。 */
test('test_auto_chain_stops_before_next_agent_when_five_hour_quota_is_below_threshold — exactly at threshold still dispatches', async ($, on) => {
  const { data, clock } = fixture(on)
  betaImplemented(data, clock)
  quota(data, 70)
  const h = helpers($, data, clock)

  await h.refresh()
  await h.step()

  expect(data.launches).toHaveLength(1)
  expect(String(data.launches[0].argv.at(-1))).toContain('程式碼審查')
  expect((data.store.chains as any)[BETA].stopped).toBeUndefined()
})

/** AC-1 邊界：剩 29% 就停。 */
test('test_auto_chain_stops_before_next_agent_when_five_hour_quota_is_below_threshold — one below threshold stops', async ($, on) => {
  const { data, clock } = fixture(on)
  betaImplemented(data, clock)
  quota(data, 71)
  const h = helpers($, data, clock)

  await h.refresh()
  await h.step()

  expect(data.launches).toHaveLength(0)
  expect(storedStop((data.store.chains as any)[BETA])).toEqual({ code: 'quotaHold', left: 29, threshold: 30, resetsAt: RESETS_AT })
})

/** AC-1：修正、審查、資安審查都是要派 Agent 的步驟，額度不足一律改成停下；本機檢查與過關不受影響。 */
test('test_auto_chain_stops_before_next_agent_when_five_hour_quota_is_below_threshold — every chain dispatch kind', () => {
  const run = { owner: ME, startedAt: 0, round: 0 }
  const ctx = { quotaHold: REASON }
  const verdict = (high: number) => ({ critical: 0, high, medium: 0, low: 0 })
  // 審查
  expect(nextStep(run, 'continue', true, null, true, ctx)).toEqual({ kind: 'stop', reason: REASON, resume: { dispatch: 'review', round: 0 } })
  // 檢查沒過的修正
  expect(nextStep(run, 'continue', false, null, true, ctx)).toEqual({ kind: 'stop', reason: REASON, resume: { dispatch: 'continue', round: 1, reason: 'check' } })
  // 審查的修正
  expect(nextStep(run, 'review', null, verdict(1), true, ctx)).toEqual({ kind: 'stop', reason: REASON, resume: { dispatch: 'continue', round: 1, reason: 'review' } })
  // 高風險的資安審查
  expect(nextStep(run, 'review', null, verdict(0), true, { ...ctx, risk: { level: 'high', reasons: ['認證'] } })).toEqual({ kind: 'stop', reason: REASON, resume: { dispatch: 'review', round: 0, security: true } })
  // 本機檢查、過關照舊
  expect(nextStep(run, 'continue', null, null, true, ctx)).toEqual({ kind: 'verify' })
  expect(nextStep(run, 'review', null, verdict(0), true, ctx)).toEqual({ kind: 'pass' })
  // 沒有煞車原因就照舊派
  expect(nextStep(run, 'continue', true, null, true, {})).toEqual({ kind: 'dispatch', dispatch: 'review', round: 0 })
})

/** AC-1：過關後 autoPr 要派推送、額度不足：不派推送，流程仍是過關（不暫停），動態寫沒派的原因。 */
test('test_auto_chain_stops_before_next_agent_when_five_hour_quota_is_below_threshold — auto PR push is not sent', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  data.agents = []
  data.gh = []
  data.files[REGISTRY] = registry([['Beta', CARD_B]])
  setGate(data, CARD_B, 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；可合併')
  data.git[BETA] = { branch: 'feature/b', head: 'c2', remote: 'git@github.com:acme/shop.git', upstream: false }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  data.store.verifies = { [CARD_B]: ok('c2') }
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, reviewHead: 'c2', reviewBranch: 'feature/b' } }
  data.store.jobs = { [BETA]: lastJob('review') }
  data.files[PROJECT_SETTINGS] = JSON.stringify({ autoPr: true })
  startsAgents(data, clock, { keep: 'others' })
  quota(data, 75)
  const h = helpers($, data, clock)

  await h.refresh()
  await h.step()

  expect(data.launches).toHaveLength(0)
  const chain = (data.store.chains as any)[BETA]
  expect(chain.passed).toBe(true)
  expect(chain.stopped).toBeUndefined()
  expect(log.has('Beta 驗收通過，5 小時額度剩 25%，低於門檻 30%，沒有自動派推送；要推請按 ⇡ 開 PR')).toBe(true)
})

/** AC-1：合併段有衝突、要自動派解衝突、額度不足：不派，流程暫停寫原因。 */
test('test_auto_chain_stops_before_next_agent_when_five_hour_quota_is_below_threshold — conflict agent is not sent', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  data.agents = []
  data.gh = [{ number: 12, state: 'OPEN', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }]
  data.files[REGISTRY] = registry([['Beta', CARD_B]])
  data.files[CARD_B] = '<!-- DESK -->\n- 狀態：Beta 過關\n- 驗證：`npm test`\n- 等你：無\n- 下一步：合併\n- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 1；可合併\n<!-- /DESK -->'
  data.git[BETA] = { branch: 'feature/b', head: 'h1', remote: 'git@github.com:acme/shop.git', releases: '', conflicts: ['src/a.ts', 'src/b.ts'] }
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, passed: true, reviewHead: 'h1', reviewBranch: 'feature/b', judgedHead: 'h1', judgedBranch: 'feature/b' } }
  data.store.verifies = { [CARD_B]: ok('h1') }
  data.store.jobs = { [BETA]: lastJob('review', { handled: true }) }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  startsAgents(data, clock, { keep: 'others' })
  quota(data, 75)
  const h = helpers($, data, clock)

  for (let i = 0; i < 3; i++) { await h.refresh(); await h.step() }
  const ui = await $.ui.mount(PANE(160))
  const shown = await h.screen(ui)
  await ui.unmount()

  expect(data.launches).toHaveLength(0)
  expect((data.store.chains as any)[BETA].stopped).toBe('quotaHoldCatchup')
  expect(log.list.filter(e => e.text === `Beta 流程已暫停：${CATCHUP_REASON}`)).toHaveLength(1)
  // 合併段沒有 g 可按：「輪到你」照既有說法叫你在對話解衝突，括號寫額度原因
  expect(shown).toContain(flat('輪到你 與 main 有衝突：在對話把 main 合併進來、解衝突並 commit（5 小時額度剩 25%，低於門檻 30%）'))
})

/** AC-2：剛結束的審查有 HIGH（和 MEDIUM）、額度不足：審查檔照常歸檔、結論照記，只有派修正不做（MEDIUM 不自動修，不記要修的 MEDIUM 數）。 */
test('test_quota_stop_after_review_still_archives_and_records_verdict', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  data.files[REGISTRY] = registry([['Beta', CARD_B]])
  setGate(data, CARD_B, 'review：CRITICAL 0、HIGH 1、MEDIUM 2、LOW 0；漏稽核')
  data.files[`${BETA}/.task/REVIEW.md`] = '- [HIGH][稽核] a.php:1 — 漏寫稽核紀錄\n- [MEDIUM][命名] b.php:2 — 命名不清\n- [MEDIUM][測試] c.php:3 — 少一支測試'
  data.git[BETA] = { branch: 'feature/b', head: 'c2', files: ['src/app.ts'] }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  data.store.verifies = { [CARD_B]: ok('c2') }
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, reviewHead: 'c2', reviewBranch: 'feature/b' } }
  data.store.jobs = { [BETA]: lastJob('review') }
  startsAgents(data, clock, { keep: 'others' })
  quota(data, 75)
  const h = helpers($, data, clock)

  await h.refresh()
  await h.step()

  expect(data.launches).toHaveLength(0)
  expect(data.writes.some(w => /\/handoffs\/shop\/reviews\/beta-\d{8}-\d{4}-code\.md$/.test(w))).toBe(true)
  const chain = (data.store.chains as any)[BETA]
  expect(chain.stopped).toBe('quotaHold')
  expect(chain.judgedHead).toBe('c2')
  expect(chain.judgedBranch).toBe('feature/b')
  expect(chain.mediumFix).toBeUndefined()
  expect(chain.round).toBe(0)
  expect(data.files[CARD_B]).toContain('- 關卡：review：CRITICAL 0、HIGH 1、MEDIUM 2、LOW 0；漏稽核')
})

/** AC-3：名額滿時排著一筆自動派的修正與一筆你手動排的繼續；排隊期間額度跌到 25%：空出名額時自動那筆移出、流程暫停、動態寫原因，手動那筆照派。 */
test('test_queued_auto_dispatch_is_dropped_when_quota_is_below_threshold', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  data.files[SETTINGS] = JSON.stringify({})
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace('- 下一步：push', '- 下一步：實作匯入')
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 驗證：無', '- 驗證：`node test.mjs`').replace('- 下一步：無', '- 下一步：實作匯出')
  setGate(data, CARD_A, 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1', files: ['src/a.ts'] }
  data.git[GAMMA] = { branch: 'feature/gamma', head: 'g1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test', [CARD_C]: 'node test.mjs' }
  data.store.chains = { [ALPHA]: { owner: ME, startedAt: 0, round: 0, reviewHead: 'h1', reviewBranch: 'feature/alpha' } }
  data.store.jobs = { [ALPHA]: lastJob('review') }
  data.agents = FULL()
  startsAgents(data, clock, { keep: 'others' })
  const h = helpers($, data, clock)

  // 名額滿：流程要派的修正排第 1 位；你手動按兩次 g 派 Gamma 排第 2 位
  await h.refresh()
  await h.step()
  expect(log.has('Alpha 自動派修正第 1 輪排隊中（第 1 位）')).toBe(true)
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_C}` })
  await ui.press({ key: `case-${CARD_C}-continue` }); await clock.settle()
  await ui.press({ key: `case-${CARD_C}-continue` }); await clock.settle()
  expect(data.toasts).toContain('Gamma：同時執行的 Agent 已達上限 3 個，已排隊（第 2 位）')
  expect(data.launches).toHaveLength(0)

  // 排隊期間額度跌到 25%，接著一個 Agent 做完
  quota(data, 75)
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()
  await ui.unmount()

  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(GAMMA)
  expect((data.store.chains as any)[ALPHA].stopped).toBe('quotaHold')
  expect(log.has(`Alpha 排隊的修正第 1 輪沒有派出：${REASON}`)).toBe(true)
  expect(data.toasts).toContain(`Alpha：流程已暫停，${REASON}`)
})

/** 審查 HIGH：自動派的修正排進隊伍、額度不足被丟掉（沒派出）不算一輪；之後你按 g 派出修正才算，整張卡只算 1 輪 */
test('test_dropped_queued_fix_then_g_counts_one_round', async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[SETTINGS] = JSON.stringify({})
  data.files[REGISTRY] = registry([['Alpha', CARD_A]])
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace('- 下一步：push', '- 下一步：派審查')
  setGate(data, CARD_A, 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1', files: ['src/a.ts'] }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.store.chains = { [ALPHA]: { owner: ME, startedAt: 0, round: 0, reviewHead: 'h1', reviewBranch: 'feature/alpha' } }
  data.store.jobs = { [ALPHA]: lastJob('review') }
  data.agents = FULL()
  startsAgents(data, clock, { keep: 'others' })
  const h = helpers($, data, clock)

  // 名額滿：修正排進隊伍，還沒派出，不算
  await h.refresh(); await h.step()
  expect(data.launches).toHaveLength(0)
  expect((data.store.chains as any)[ALPHA].fixTotal ?? 0).toBe(0)
  // 排隊期間額度跌到 25%、空出名額：那筆被丟掉，流程暫停，一樣不算
  quota(data, 75)
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()
  expect(data.launches).toHaveLength(0)
  expect((data.store.chains as any)[ALPHA].stopped).toBe('quotaHold')
  expect((data.store.chains as any)[ALPHA].fixTotal ?? 0).toBe(0)

  // 你按 g：派出修正，整張卡算 1 輪
  data.agents = []
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(ALPHA)
  expect((data.store.chains as any)[ALPHA].fixTotal).toBe(1)
  expect((data.store.chains as any)[ALPHA].stopped).toBeUndefined()
})

/** AC-4：額度剩 25%：面板按兩次 g、w，指令 /desk sync：照常派出，面板與提示不提額度。 */
test('test_manual_dispatch_ignores_quota_threshold', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace('- 下一步：push', '- 下一步：實作匯入')
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'a1' }
  data.git[BETA] = { branch: 'feature/beta', head: 'b1' }
  data.git[GAMMA] = { branch: 'feature/gamma', head: 'g1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test' }
  data.store.verifies = { [CARD_B]: ok('b1') }
  startsAgents(data, clock, { keep: 'others' })
  quota(data, 75)
  const h = helpers($, data, clock)

  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: `case-${CARD_A}-continue` }); await clock.settle()
  await ui.press({ key: `case-${CARD_A}-continue` }); await clock.settle()
  await ui.press({ key: `row-${CARD_B}` })
  await ui.press({ key: `case-${CARD_B}-review` }); await clock.settle()
  await ui.press({ key: `case-${CARD_B}-review` }); await clock.settle()
  await $.command.run({ command: 'desk', args: 'sync Gamma' } as any); await clock.settle()
  await h.refresh()
  const shown = await h.screen(ui)
  await ui.unmount()

  expect(data.launches.map((l: any) => l.init.cwd)).toEqual([ALPHA, BETA, GAMMA])
  expect(shown).not.toContain('低於門檻')
  expect(data.toasts.some((t: string) => t.includes('低於門檻'))).toBe(false)
})

/** AC-5：讀不到額度（usage 回 null、rateLimits 空）不當成額度不足；門檻填 "abc"、150 用預設 30%；"off"／false 關掉。 */
test('test_auto_chain_dispatches_when_quota_unknown_or_threshold_invalid', async ($, on) => {
  // 設定解析
  expect(parseSettings(null).chainQuotaStop).toBe(DEFAULT_CHAIN_QUOTA_STOP)
  expect(DEFAULT_CHAIN_QUOTA_STOP).toBe(30)
  for (const v of ['abc', 150, 0, -5, 12.5, null, '30']) expect(parseSettings(JSON.stringify({ chainQuotaStop: v })).chainQuotaStop).toBe(30)
  expect(parseSettings(JSON.stringify({ chainQuotaStop: 50 })).chainQuotaStop).toBe(50)
  expect(parseSettings(JSON.stringify({ chainQuotaStop: 'off' })).chainQuotaStop).toBe(0)
  expect(parseSettings(JSON.stringify({ chainQuotaStop: 'OFF' })).chainQuotaStop).toBe(0)
  expect(parseSettings(JSON.stringify({ chainQuotaStop: false })).chainQuotaStop).toBe(0)
  // 純函式：沒有 five_hour、門檻 0 都不擋；只看 five_hour
  expect(quotaHold(undefined, 30, NOW)).toBeNull()
  expect(quotaHold([], 30, NOW)).toBeNull()
  expect(quotaHold([{ kind: 'seven_day', remaining: 5 }], 30, NOW)).toBeNull()
  expect(quotaHold([{ kind: 'five_hour', remaining: 25 }], 0, NOW)).toBeNull()
  // 停下原因存代碼與參數（i18n 現在卡 AC-2），顯示時組成「5 小時額度剩 25%，低於門檻 30%，重置後按 g 重開」
  expect(quotaHold([{ kind: 'five_hour', remaining: 25 }], 30, NOW)).toEqual({ code: 'quotaHold', args: { left: 25, threshold: 30, at: NOW } })
  expect(stopText(quotaHold([{ kind: 'five_hour', remaining: 25 }], 30, NOW)!)).toBe('5 小時額度剩 25%，低於門檻 30%，重置後按 g 重開')

  // 整條流程：每一種情況都照常派審查
  const cases: { name: string; usage?: 'null' | 'empty'; used?: number; threshold?: unknown }[] = [
    { name: 'usage 回 null', usage: 'null' },
    { name: 'rateLimits 空', usage: 'empty' },
    { name: '門檻 "abc"（用預設 30，剩 40% 不停）', used: 60, threshold: 'abc' },
    { name: '門檻 150（用預設 30，剩 40% 不停）', used: 60, threshold: 150 },
    { name: '門檻 "off"', used: 75, threshold: 'off' },
    { name: '門檻 false', used: 75, threshold: false },
  ]
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  for (const c of cases) {
    data.launches = []
    betaImplemented(data, clock)
    data.usage = c.usage === 'null' ? null : { startedAt: NOW, context: { percent: 34 }, rateLimits: [] }
    if (c.used !== undefined) quota(data, c.used)
    data.files[SETTINGS] = JSON.stringify(c.threshold === undefined ? {} : { chainQuotaStop: c.threshold })
    await h.refresh()
    await h.step()
    expect({ case: c.name, launches: data.launches.length }).toEqual({ case: c.name, launches: 1 })
    expect(String(data.launches[0].argv.at(-1))).toContain('程式碼審查')
    expect({ case: c.name, stopped: (data.store.chains as any)[BETA].stopped }).toEqual({ case: c.name, stopped: undefined })
  }
})

/** AC-6：實作剛結束、檢查已核准、只動文件、額度剩 25%：本機檢查照跑，通過後免審查過關，流程不因額度暫停。 */
test('test_local_check_and_docs_only_pass_run_even_when_quota_is_low', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  betaImplemented(data, clock)
  data.git[BETA]!.files = ['README.md', 'docs/guide.md']
  data.store.verifies = {}
  quota(data, 75)
  const h = helpers($, data, clock)

  await h.refresh()
  for (let i = 0; i < 4; i++) await h.step()

  expect(h.checks()).toBe(1)
  expect(data.launches).toHaveLength(0)
  const chain = (data.store.chains as any)[BETA]
  expect(chain.passed).toBe(true)
  expect(chain.skippedReview).toBe(true)
  expect(chain.stopped).toBeUndefined()
  expect(log.has('Beta 只動文件、測試通過，免驗收，可開 PR')).toBe(true)
  expect(log.list.some(e => e.text.includes('低於門檻'))).toBe(false)
})

/** 高風險改動：程式碼審查已寫好過關結論、要派資安審查時被額度擋下。 */
function betaSecurityPending(data: any, clock: any) {
  data.agents = []
  data.gh = []
  data.files[REGISTRY] = registry([['Beta', CARD_B]])
  setGate(data, CARD_B, 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；可合併')
  data.files[`${BETA}/.task/REVIEW.md`] = '（無）'
  data.git[BETA] = { branch: 'feature/b', head: 'c2', files: ['app/Http/Middleware/Admin.php'], remote: 'git@github.com:acme/shop.git' }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  data.store.verifies = { [CARD_B]: ok('c2') }
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, reviewHead: 'c2', reviewBranch: 'feature/b' } }
  data.store.jobs = { [BETA]: lastJob('review') }
  startsAgents(data, clock, { keep: 'others' })
}

/** AC-1（審查 HIGH）：要派資安審查時被擋下：不派、不算過關（沒有高風險確認可略過），六段停在審查段寫原因，「輪到你」寫同一句、可按 g，沒有開 PR。 */
test('test_auto_chain_stops_before_next_agent_when_five_hour_quota_is_below_threshold — security review is held at the review stage', async ($, on) => {
  const { data, clock } = fixture(on)
  betaSecurityPending(data, clock)
  quota(data, 75)
  const h = helpers($, data, clock)

  await h.refresh()
  await h.step()
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  const shown = await h.screen(ui)
  const gKey = await ui.find({ key: `case-${CARD_B}-continue` })
  await ui.unmount()

  expect(data.launches).toHaveLength(0)
  const chain = (data.store.chains as any)[BETA]
  expect(chain.stopped).toBe('quotaHold')
  expect(chain.passed).toBeUndefined()
  expect(shown).toContain(flat(`輪到你 ${REASON}`))
  expect(shown).toContain(flat('✕ 驗收'))
  expect(shown).not.toContain('開PR')
  expect(gKey).toBeTruthy()
})

/** AC-1（審查 HIGH）：審查過關後有新 commit、重新檢查通過、要派重新審查時被擋下：「輪到你」寫同一句（不是按 w 重新驗收）。 */
test('test_auto_chain_stops_before_next_agent_when_five_hour_quota_is_below_threshold — re-review after a new commit', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  data.agents = []
  data.files[REGISTRY] = registry([['Alpha', CARD_A]])
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  setGate(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；過')
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h2', files: ['src/a.ts'] }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.store.chains = { [ALPHA]: { owner: ME, startedAt: 0, round: 0, passed: true, reviewHead: 'h1', reviewBranch: 'feature/alpha', judgedHead: 'h1', judgedBranch: 'feature/alpha' } }
  data.store.jobs = { [ALPHA]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: ME, handled: true } } }
  startsAgents(data, clock, { keep: 'others' })
  quota(data, 75)
  const h = helpers($, data, clock)

  await h.refresh()
  for (let i = 0; i < 3; i++) await h.step()
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  const shown = await h.screen(ui)
  await ui.unmount()

  expect(h.checks()).toBe(1)
  expect(data.launches).toHaveLength(0)
  expect((data.store.chains as any)[ALPHA].stopped).toBe('quotaHold')
  expect(log.has(`Alpha 流程已暫停：${REASON}`)).toBe(true)
  expect(shown).toContain(flat(`輪到你 ${REASON}`))
  expect(shown).not.toContain(flat('重新驗收'))
})

/** 別的對話開的流程審查只剩 MEDIUM、額度不足：MEDIUM 不自動修，這個對話不接手、不暫停，紀錄一字不變；額度恢復後也不派。 */
test('test_auto_chain_stops_before_next_agent_when_five_hour_quota_is_below_threshold — a foreign chain with only MEDIUM is left alone', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  data.agents = []
  data.files[REGISTRY] = registry([['Alpha', CARD_A]])
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  setGate(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；空字串沒處理')
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理'
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1', files: ['src/a.ts'] }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.store.verifies = { [CARD_A]: { ...ok('h1'), command: 'node test.mjs' } }
  data.store.chains = { [ALPHA]: { owner: 'other-session', startedAt: 0, round: 1, reviewHead: 'h1', reviewBranch: 'feature/alpha' } }
  data.store.jobs = { [ALPHA]: { ...lastJob('review'), last: { ...lastJob('review').last, owner: 'other-session' } } }
  const before = JSON.parse(JSON.stringify((data.store.chains as any)[ALPHA]))
  startsAgents(data, clock, { keep: 'others' })
  quota(data, 75)
  const h = helpers($, data, clock)

  await h.refresh()
  await h.step()

  expect(data.launches).toHaveLength(0)
  expect((data.store.chains as any)[ALPHA]).toEqual(before)
  expect(log.has(`Alpha 流程已暫停：${REASON}`)).toBe(false)

  // 額度恢復：一樣不派
  quota(data, 10)
  for (let i = 0; i < 2; i++) { await h.refresh(); await h.step() }
  expect(data.launches).toHaveLength(0)
})

/** 審查 MEDIUM（D-04）：擋在派驗收前、按 g 重開：直接派驗收接續原本那輪（不多派實作 Agent），動態寫明；流程不再是暫停、輪數不變。 */
test('test_manual_dispatch_ignores_quota_threshold — g after a hold before review dispatches the review itself', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  betaImplemented(data, clock)
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 下一步：依審核修正', '- 下一步：等驗收')
  quota(data, 75)
  const h = helpers($, data, clock)
  await h.refresh()
  await h.step()
  expect((data.store.chains as any)[BETA].stopped).toBe('quotaHold')
  expect((data.store.chains as any)[BETA].resume).toEqual({ dispatch: 'review', round: 0 })

  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  // 擋下時 g 寫「接續」，不寫「繼續」
  expect(String((await ui.find({ key: `case-${CARD_B}-continue` }))?.props?.label)).toContain('接續')
  await ui.press({ key: `case-${CARD_B}-continue` }); await clock.settle()
  await ui.press({ key: `case-${CARD_B}-continue` }); await clock.settle()
  await ui.unmount()

  expect(data.launches).toHaveLength(1)
  const prompt = String(data.launches[0].argv.at(-1))
  expect(prompt).toContain('程式碼審查')
  expect(prompt).not.toContain(QUOTA_NOTHING_TO_FIX)
  expect(log.has('Beta 額度煞車後按 g 重開：直接派驗收，不多派實作')).toBe(true)
  const chain = (data.store.chains as any)[BETA]
  expect(chain.stopped).toBeUndefined()
  expect(chain.resume).toBeUndefined()
  expect(chain.round).toBe(0)
})

/** 審查 MEDIUM（D-04）：擋在派資安審查前、按 g 重開：直接派資安審查，不重做程式碼審查、不派實作。 */
test('test_manual_dispatch_ignores_quota_threshold — g after a hold before the security review dispatches it directly', async ($, on) => {
  const { data, clock } = fixture(on)
  betaSecurityPending(data, clock)
  quota(data, 75)
  const h = helpers($, data, clock)
  await h.refresh()
  await h.step()
  expect((data.store.chains as any)[BETA].stopped).toBe('quotaHold')
  expect((data.store.chains as any)[BETA].resume).toEqual({ dispatch: 'review', round: 0, security: true })

  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `case-${CARD_B}-continue` }); await clock.settle()
  await ui.press({ key: `case-${CARD_B}-continue` }); await clock.settle()
  await ui.unmount()

  expect(data.launches).toHaveLength(1)
  const prompt = String(data.launches[0].argv.at(-1))
  expect(prompt).toContain('資安審查')
  expect(prompt).not.toContain('這是新的對話，不接續 Agent、不參考 Agent 的結論。\n程式碼審查')
  expect((data.store.chains as any)[BETA].stopped).toBeUndefined()
})

/** 審查 MEDIUM（D-04）：擋在派修正前（檢查沒過、審查有 HIGH）：記下那步是修正，按 g 照舊派修正（走原本的路）。 */
test('test_manual_dispatch_ignores_quota_threshold — a hold before a fix round records the fix step', () => {
  const run = { owner: ME, startedAt: 0, round: 0 }
  const afterCheck = nextStep(run, 'continue', false, null, true, { quotaHold: REASON })
  expect(afterCheck).toEqual({ kind: 'stop', reason: REASON, resume: { dispatch: 'continue', round: 1, reason: 'check' } })
  const afterReview = nextStep(run, 'review', null, { critical: 0, high: 1, medium: 0, low: 0 }, true, { quotaHold: REASON })
  expect(afterReview).toEqual({ kind: 'stop', reason: REASON, resume: { dispatch: 'continue', round: 1, reason: 'review' } })
})

/** 審查 MEDIUM：隊伍裡自動排的推送輪到時額度不足：移出不派，流程仍是過關（不暫停），動態寫原因與要推按哪個鈕。 */
test('test_queued_auto_dispatch_is_dropped_when_quota_is_below_threshold — queued auto push leaves the chain passed', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  data.gh = []
  data.files[REGISTRY] = registry([['Beta', CARD_B]])
  setGate(data, CARD_B, 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；可合併')
  data.git[BETA] = { branch: 'feature/b', head: 'c2', remote: 'git@github.com:acme/shop.git', upstream: false }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  data.store.verifies = { [CARD_B]: ok('c2') }
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, reviewHead: 'c2', reviewBranch: 'feature/b' } }
  data.store.jobs = { [BETA]: lastJob('review') }
  data.files[PROJECT_SETTINGS] = JSON.stringify({ autoPr: true })
  data.agents = FULL()
  startsAgents(data, clock, { keep: 'others' })
  const h = helpers($, data, clock)

  await h.refresh()
  await h.step()
  expect(log.has('Beta 自動派推送排隊中（第 1 位）')).toBe(true)
  expect(data.launches).toHaveLength(0)

  quota(data, 75)
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()

  expect(data.launches).toHaveLength(0)
  const chain = (data.store.chains as any)[BETA]
  expect(chain.passed).toBe(true)
  expect(chain.stopped).toBeUndefined()
  expect(log.has('Beta 排隊的推送沒有派出：5 小時額度剩 25%，低於門檻 30%，要推請按 ⇡ 開 PR')).toBe(true)
})

/**
 * AC-3 × AC-1（審查 HIGH）：名額滿時自動解衝突排進隊伍，排隊期間額度跌到 25%，空出名額：移出不派，
 * 流程停在解衝突的原因句（在對話合併基準分支、解衝突，不叫你按 g）；動態、toast、系統通知各一次。
 */
test('test_queued_auto_dispatch_is_dropped_when_quota_is_below_threshold — queued conflict agent says it once', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const notified = capture(on)
  data.gh = [{ number: 12, state: 'OPEN', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }]
  data.files[REGISTRY] = registry([['Beta', CARD_B]])
  data.files[CARD_B] = '<!-- DESK -->\n- 狀態：Beta 過關\n- 驗證：`npm test`\n- 等你：無\n- 下一步：合併\n- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 1；可合併\n<!-- /DESK -->'
  data.git[BETA] = { branch: 'feature/b', head: 'h1', remote: 'git@github.com:acme/shop.git', releases: '', conflicts: ['src/a.ts', 'src/b.ts'] }
  data.store.chains = { [BETA]: { owner: ME, startedAt: 0, round: 0, passed: true, reviewHead: 'h1', reviewBranch: 'feature/b', judgedHead: 'h1', judgedBranch: 'feature/b' } }
  data.store.verifies = { [CARD_B]: ok('h1') }
  data.store.jobs = { [BETA]: lastJob('review', { handled: true }) }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  data.agents = FULL()
  startsAgents(data, clock, { keep: 'others' })
  const h = helpers($, data, clock)

  for (let i = 0; i < 2; i++) { await h.refresh(); await h.step() }
  expect(log.has('Beta 自動派解衝突排隊中（第 1 位）')).toBe(true)
  expect(data.launches).toHaveLength(0)

  quota(data, 75)
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  for (let i = 0; i < 3; i++) { await h.refresh(); await h.step() }

  expect(data.launches).toHaveLength(0)
  expect((data.store.chains as any)[BETA].stopped).toBe('quotaHoldCatchup')
  expect(log.list.filter(e => e.text.includes(CATCHUP_REASON))).toHaveLength(1)
  expect(log.has(`Beta 排隊的解衝突沒有派出：${CATCHUP_REASON}`)).toBe(true)
  expect(data.toasts.filter((t: string) => t.includes('流程已暫停'))).toEqual([`Beta：流程已暫停，${CATCHUP_REASON}`])
  expect(notified.filter(t => t.includes('流程已暫停'))).toEqual([`Beta：流程已暫停，${CATCHUP_REASON}`])
  expect([...log.list.map(e => e.text), ...data.toasts, ...notified].some(t => t.includes('按 g 重開'))).toBe(false)
})

/** AC-5（審查 MEDIUM）：5 小時額度的重置時間已經過了（usage 還是重置前的用量）：當成讀不到現在的額度，照常派審查。 */
test('test_auto_chain_dispatches_when_quota_unknown_or_threshold_invalid — reset time already passed', async ($, on) => {
  expect(quotaHold([{ kind: 'five_hour', remaining: 25, resetsAt: new Date(NOW - 3_600_000).toISOString() }], 30, NOW)).toBeNull()
  expect(quotaHold([{ kind: 'five_hour', remaining: 25, resetsAt: new Date(NOW).toISOString() }], 30, NOW)).toBeNull()
  expect(quotaHold([{ kind: 'five_hour', remaining: 25, resetsAt: new Date(NOW + 60_000).toISOString() }], 30, NOW)).not.toBeNull()

  const { data, clock } = fixture(on)
  betaImplemented(data, clock)
  data.usage = { ...data.usage, rateLimits: [{ kind: 'five_hour', percentUsed: 75, resetsAt: new Date(NOW - 3_600_000).toISOString() }] }
  const h = helpers($, data, clock)

  await h.refresh()
  await h.step()

  expect(data.launches).toHaveLength(1)
  expect(String(data.launches[0].argv.at(-1))).toContain('程式碼審查')
  expect((data.store.chains as any)[BETA].stopped).toBeUndefined()
})

/** 擋在派驗收前：流程暫停、記下被擋的是驗收（共用的前置）。 */
async function heldBeforeReview($: any, data: any, clock: any, h: ReturnType<typeof helpers>) {
  betaImplemented(data, clock)
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 下一步：依審核修正', '- 下一步：等驗收')
  quota(data, 75)
  await h.refresh()
  await h.step()
  expect((data.store.chains as any)[BETA].resume).toEqual({ dispatch: 'review', round: 0 })
  await h.refresh()
}
const pressG = async (ui: any, clock: any) => {
  await ui.press({ key: `case-${CARD_B}-continue` }); await clock.settle()
  await ui.press({ key: `case-${CARD_B}-continue` }); await clock.settle()
}

/** AC-4（複審 HIGH）：擋在派驗收前、名額滿時按 g 接續：排進隊伍（跟手動派一樣說第幾位），空出名額時額度仍不足也照派，不被額度煞車移出。 */
test('test_manual_dispatch_ignores_quota_threshold — g resume that waits in the queue is still sent while quota is low', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const h = helpers($, data, clock)
  await heldBeforeReview($, data, clock, h)

  data.agents = FULL()
  // 派工沿用 5 秒內讀過的 agents 清單：先整理一輪，名額滿了才看得到
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await pressG(ui, clock)
  await ui.unmount()
  expect(data.launches).toHaveLength(0)
  expect(data.toasts).toContain('Beta：同時執行的 Agent 已達上限 3 個，已排隊（第 1 位）')

  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()

  expect(data.launches).toHaveLength(1)
  expect(String(data.launches[0].argv.at(-1))).toContain('程式碼審查')
  expect((data.store.chains as any)[BETA].stopped).toBeUndefined()
  expect(log.list.some(e => e.text.startsWith('Beta 排隊的驗收沒有派出'))).toBe(false)
})

/** AC-4（複審 HIGH）：流程是別的對話開的（例如關掉後在新對話按 g）：接續時流程改成這個對話的，驗收做完有 HIGH 照常派修正。 */
test('test_manual_dispatch_ignores_quota_threshold — g resume takes over a chain opened by another conversation', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  await heldBeforeReview($, data, clock, h)
  data.store.chains = { [BETA]: { ...(data.store.chains as any)[BETA], owner: 'other-session' } }
  await h.refresh()

  const ui = await $.ui.mount(PANE(160))
  await pressG(ui, clock)
  await ui.unmount()
  expect(data.launches).toHaveLength(1)
  expect((data.store.chains as any)[BETA].owner).toBe(ME)

  // 驗收做完：有 HIGH，這個對話的流程派修正第 1 輪
  quota(data, 10)
  setGate(data, CARD_B, 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  data.files[`${BETA}/.task/REVIEW.md`] = '- [HIGH][稽核] a.php:1 — 漏寫稽核紀錄'
  data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
  await h.refresh()
  await h.step()

  expect(data.launches).toHaveLength(2)
  expect(String(data.launches[1].argv.at(-1)).startsWith('修正第 1／2 輪')).toBe(true)
})

/** AC-4（複審 HIGH）：擋下後你手動派的 Agent 還在跑：/desk go 跟手動派工一樣拒絕（Agent 仍在執行），不在同一個 worktree 再派驗收。 */
test('test_manual_dispatch_ignores_quota_threshold — /desk go resume is refused while an agent runs', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  await heldBeforeReview($, data, clock, h)
  data.agents = [busy('desk-rp-0', BETA)]
  await h.refresh()

  const go = await $.command.run({ command: 'desk', args: 'go Beta' } as any)
  await clock.settle()

  expect(data.launches).toHaveLength(0)
  expect(String((go as any)?.text)).toContain('Beta：無法驗收（')
  expect((data.store.chains as any)[BETA].stopped).toBe('quotaHold')
  expect((data.store.chains as any)[BETA].resume).toEqual({ dispatch: 'review', round: 0 })
})

/** 複審 MEDIUM：排隊中的自動驗收被額度擋下：記下被擋的是驗收（輪數照流程），按 g 直接派驗收、不派實作。 */
test('test_queued_auto_dispatch_is_dropped_when_quota_is_below_threshold — queued review records the step g resumes', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  betaImplemented(data, clock)
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 下一步：依審核修正', '- 下一步：等驗收')
  data.agents = FULL()
  const h = helpers($, data, clock)
  await h.refresh()
  await h.step()
  expect(log.has('Beta 自動派驗收排隊中（第 1 位）')).toBe(true)

  quota(data, 75)
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()
  expect(data.launches).toHaveLength(0)
  const chain = (data.store.chains as any)[BETA]
  expect(chain.stopped).toBe('quotaHold')
  expect(chain.resume).toEqual({ dispatch: 'review', round: 0 })

  data.agents = []
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await pressG(ui, clock)
  await ui.unmount()
  expect(data.launches).toHaveLength(1)
  const prompt = String(data.launches[0].argv.at(-1))
  expect(prompt).toContain('程式碼審查')
  expect(prompt).not.toContain(QUOTA_NOTHING_TO_FIX)
})

/** AC-4（複審 MEDIUM）：擋下後名額滿、你派的同步已排著：/desk go 跟手動派工一樣只回「已在派工隊伍」，額度暫停與記下的那步都留著，空出名額派的是同步。 */
test('test_manual_dispatch_ignores_quota_threshold — /desk go resume while the card is already queued keeps the hold', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  await heldBeforeReview($, data, clock, h)
  data.agents = FULL()
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'sync Beta' } as any)
  await clock.settle()
  expect(data.toasts).toContain('Beta：同時執行的 Agent 已達上限 3 個，已排隊（第 1 位）')

  const go = await $.command.run({ command: 'desk', args: 'go Beta' } as any)
  await clock.settle()

  expect(String((go as any)?.text)).toBe('Beta：已在派工隊伍（第 1 位），k 取消排隊')
  expect(data.launches).toHaveLength(0)
  const chain = (data.store.chains as any)[BETA]
  expect(chain.stopped).toBe('quotaHold')
  expect(chain.resume).toEqual({ dispatch: 'review', round: 0 })
  expect(chain.owner).toBe(ME)

  // 空出名額：派出的是排著的同步，不是驗收；流程仍停在額度原因
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(String(data.launches[0].argv.at(-1))).not.toContain('程式碼審查')
  expect((data.store.chains as any)[BETA].stopped).toBe('quotaHold')
})
