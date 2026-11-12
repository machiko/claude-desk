import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, REGISTRY, result } from './fixture'
import { FRESH_SESSION_LEAD, MODEL_KINDS, modelFor, parseSettings } from '../hooks/dispatch'
import { settingsProblems } from '../hooks/settings'
import { startsAgents } from './world'

const SETTINGS = '/home/u/.claude/handoffs/dispatch.json'
const KINDS = { review: { effort: 'xhigh' }, publish: { model: 'haiku', effort: 'low' } }
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 2；可合併'

/** 啟動參數裡的 --model 與 --effort。 */
const flags = (launch: any) => {
  const argv: string[] = launch.argv
  const at = (f: string) => argv.includes(f) ? argv[argv.indexOf(f) + 1] : ''
  return `${at('--model')} ${at('--effort')}`
}
const promptOf = (launch: any) => String(launch.argv[launch.argv.length - 1])

/**
 * 三件可派的任務：Alpha 可審查、Beta 在合併段等開 PR、Gamma 可繼續；沒有 Agent 在跑。
 * 派工會在那個根目錄多一個在跑的 Agent。
 */
function threeCases(data: any, clock: any, settings: object) {
  data.files[SETTINGS] = JSON.stringify(settings)
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED)
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 驗證：無', '- 驗證：`node test.mjs`').replace('- 下一步：無', '- 下一步：實作匯出')
  data.git['/home/u/wt/beta'] = { branch: 'feature/b', head: 'c2', remote: 'git@github.com:acme/shop.git', upstream: false }
  data.gh = []
  data.store.chains = { '/home/u/wt/beta': { owner: 'other-session', startedAt: 0, round: 0, passed: true, reviewHead: 'c2', judgedHead: 'c2' } }
  data.store.verifies = { [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' } }
  // Gamma 的檢查已核准：這裡測的是模型，不是核准（沒核准的 /desk go 不派）。
  data.store.trustedVerify = { [CARD_C]: 'node test.mjs' }
  data.agents = []
  data.launch = async (e: any) => {
    const id = `c000000${data.launches.length}`
    data.agents = [...data.agents, { id, kind: 'background', cwd: e.init.cwd, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
}

/** 審查用指令派、繼續用 /desk go、推送在面板上選 Beta 按兩次「⇡ 開 PR」；回傳三次啟動。 */
async function dispatchThree($: any, data: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'review Alpha' } as any)
  await clock.settle()
  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(100))
  await ui.press({ key: `row-${CARD_B}` })
  await ui.press({ key: `case-${CARD_B}-open-pr` })
  await ui.press({ key: `case-${CARD_B}-open-pr` })
  await clock.settle()
  await ui.unmount()
  const by = (root: string) => data.launches.find((l: any) => l.init.cwd === root)
  return { review: by('/home/u/wt/alpha'), publish: by('/home/u/wt/beta'), cont: by('/home/u/wt/gamma') }
}

test('test_kinds_override_model_and_effort_per_dispatch_kind', async ($, on) => {
  const s = parseSettings(JSON.stringify({ model: 'opus', effort: 'high', kinds: KINDS }))
  expect(modelFor(s, '/p/a', 'review')).toEqual({ model: 'opus', effort: 'xhigh', fresh: true })
  expect(modelFor(s, '/p/a', 'publish')).toEqual({ model: 'haiku', effort: 'low', fresh: true })
  expect(modelFor(s, '/p/a', 'continue')).toEqual({ model: 'opus', effort: 'high', fresh: false })
  expect(modelFor(s, '/p/a', 'reply')).toEqual({ model: 'opus', effort: 'high', fresh: false })
  // kinds 只寫 effort：model 沿用任務覆寫
  const own = parseSettings(JSON.stringify({ model: 'opus', effort: 'high', kinds: KINDS, projects: { '/p/a': { model: 'sonnet' } } }))
  expect(modelFor(own, '/p/a', 'review')).toEqual({ model: 'sonnet', effort: 'xhigh', fresh: true })

  const { data, clock } = fixture(on)
  threeCases(data, clock, { model: 'opus', effort: 'high', kinds: KINDS })
  const { review, publish, cont } = await dispatchThree($, data, clock)
  expect(data.launches).toHaveLength(3)
  expect(promptOf(review)).toContain('程式碼審查')
  expect(flags(review)).toBe('opus xhigh')
  expect(promptOf(publish)).toContain('推送：push feature/b')
  expect(flags(publish)).toBe('haiku low')
  expect(promptOf(cont)).toContain('依卡片的下一步繼續：實作匯出')
  expect(flags(cont)).toBe('opus high')
  expect(data.toasts.some(t => t.includes('Alpha：驗收已派出'))).toBe(true)
  expect(data.toasts.some(t => t.includes('Beta：推送已派出'))).toBe(true)
})

test('test_kinds_win_over_project_override', async ($, on) => {
  const projects = { '/home/u/wt/beta': { effort: 'xhigh' }, '/home/u/wt/gamma': { effort: 'xhigh' } }
  const s = parseSettings(JSON.stringify({ model: 'opus', effort: 'high', kinds: KINDS, projects }))
  expect(modelFor(s, '/home/u/wt/beta', 'publish')).toEqual({ model: 'haiku', effort: 'low', fresh: true })
  expect(modelFor(s, '/home/u/wt/gamma', 'continue')).toEqual({ model: 'opus', effort: 'xhigh', fresh: false })

  const { data, clock } = fixture(on)
  threeCases(data, clock, { model: 'opus', effort: 'high', kinds: KINDS, projects })
  const { publish, cont } = await dispatchThree($, data, clock)
  expect(flags(publish)).toBe('haiku low')
  expect(flags(cont)).toBe('opus xhigh')
})

test('test_fix_rounds_and_security_review_follow_their_kind', async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[SETTINGS] = JSON.stringify({ model: 'opus', effort: 'high', kinds: { continue: { model: 'sonnet', effort: 'medium' }, reply: { model: 'haiku' }, review: { effort: 'xhigh' } } })
  // 碰到中介層是高風險：程式碼審查過了還會加跑資安審查
  data.git['/home/u/wt/alpha'] = { branch: 'feature/alpha', head: 'h1', files: ['app/Http/Middleware/Admin.php'] }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.agents = []
  data.launch = async (e: any) => {
    const id = `d000000${data.launches.length}`
    data.agents = [{ id, kind: 'background', cwd: '/home/u/wt/alpha', name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const finish = async () => {
    data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    await clock.settle(); await step(); await step(); await step()
  }
  const setGate = (g: string) => { data.files[CARD_A] = data.files[CARD_A]!.replace(/- 關卡：.*$/m, `- 關卡：${g}`) }
  const last = () => data.launches[data.launches.length - 1]

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(flags(last())).toBe('sonnet medium')

  // 檢查失敗 → 修正輪派的是繼續：用 kinds.continue
  data.run = async () => result(1, 'boom\n')
  await finish()
  expect(data.launches).toHaveLength(2)
  expect(promptOf(last())).toContain('修正第 1／2 輪：完成檢查')
  expect(flags(last())).toBe('sonnet medium')

  // 修好、檢查綠 → 審查用 kinds.review
  data.run = async () => result(0, 'all green\n')
  data.git['/home/u/wt/alpha']!.head = 'h2'
  await finish()
  expect(data.launches).toHaveLength(3)
  expect(promptOf(last()).startsWith('程式碼審查')).toBe(true)
  expect(flags(last())).toBe('opus xhigh')

  // 審查有 HIGH → 修正輪一樣是繼續
  setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  await finish()
  expect(data.launches).toHaveLength(4)
  expect(promptOf(last())).toContain('修正第 2／2 輪：依 .task/REVIEW.md')
  expect(flags(last())).toBe('sonnet medium')

  // 修完再審過 → 資安審查用 kinds.review
  setGate('無')
  data.git['/home/u/wt/alpha']!.head = 'h3'
  await finish()
  setGate('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；可')
  await finish()
  expect(data.launches).toHaveLength(6)
  expect(promptOf(last()).startsWith('資安審查')).toBe(true)
  expect(flags(last())).toBe('opus xhigh')
})

test('test_invalid_or_unknown_kinds_are_ignored', () => {
  const s = parseSettings(JSON.stringify({
    model: 'opus', effort: 'high', sync: { claude: { model: 'haiku' } }, user: 'Alex',
    kinds: { sync: { model: 'sonnet' }, foo: { model: 'sonnet' }, review: 'opus', continue: ['x'], reply: { model: 5, effort: ' ' }, publish: { model: 7, effort: 'low' } },
  }))
  expect(s.kinds).toEqual({ publish: { effort: 'low' } })
  // 其他設定照常生效；同步只看 sync.claude
  expect(s.user).toBe('Alex')
  expect(modelFor(s, '/p/a', 'sync')).toEqual({ model: 'haiku', effort: 'high', fresh: true })
  expect(modelFor(s, '/p/a', 'review')).toEqual({ model: 'opus', effort: 'high', fresh: true })
  expect(modelFor(s, '/p/a', 'continue')).toEqual({ model: 'opus', effort: 'high', fresh: false })
  expect(modelFor(s, '/p/a', 'publish')).toEqual({ model: 'opus', effort: 'low', fresh: true })
  for (const bad of ['opus', ['review'], null, 3]) {
    expect(parseSettings(JSON.stringify({ model: 'opus', kinds: bad })).kinds).toEqual({})
    expect(parseSettings(JSON.stringify({ model: 'opus', kinds: bad })).model).toBe('opus')
  }
  // 沒寫 kinds：每種派工都跟以前一樣（任務覆寫 > 全域）
  const plain = { model: 'opus', effort: 'high', sync: { claude: { model: 'haiku' } }, projects: { '/p/a': { effort: 'xhigh' } } }
  const withEmpty = parseSettings(JSON.stringify({ ...plain, kinds: {} }))
  const without = parseSettings(JSON.stringify(plain))
  expect(without.kinds).toEqual({})
  // 修正是帶 fix 的繼續（不是派工種類）。
  const pick = (from: typeof without, kind: typeof MODEL_KINDS[number] | 'sync') => kind === 'fix' ? modelFor(from, '/p/a', 'continue', { fix: true }) : modelFor(from, '/p/a', kind)
  for (const kind of [...MODEL_KINDS, 'sync' as const]) {
    expect(pick(without, kind)).toEqual(pick(withEmpty, kind))
    if (kind !== 'sync') expect(pick(without, kind)).toEqual({ model: 'opus', effort: 'xhigh', fresh: kind === 'review' || kind === 'publish' })
  }
})

test('test_footer_and_confirm_text_show_kind_models', async ($, on) => {
  const { data, clock } = fixture(on)
  threeCases(data, clock, { model: 'opus', effort: 'high', kinds: { ...KINDS, continue: { effort: 'high' } }, sync: { claude: { model: 'haiku' } } })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(160))
  const footer = (await ui.findAll({ type: 'Text' })).map((n: any) => n.text).join('')
  // 只列跟派工不同的種類：continue 寫了跟派工一樣的 effort，不列
  expect(footer).toContain('派工 opus high · 驗收 opus xhigh · 推送 haiku low · 同步 haiku')
  expect(footer).not.toContain('繼續 opus high')

  // 「更多動作」只對展開當下那件有效：每換一件都重新展開（Alpha 在實作段，審查鍵平常不出現）。
  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: 'more' })
  await ui.press({ key: `case-${CARD_A}-review` })
  const review = await ui.find({ key: `case-${CARD_A}-review` })
  await ui.press({ key: `row-${CARD_B}` })
  await ui.press({ key: 'more' })
  await ui.press({ key: `case-${CARD_B}-open-pr` })
  const openPr = await ui.find({ key: `case-${CARD_B}-open-pr` })
  await ui.press({ key: `row-${CARD_C}` })
  await ui.press({ key: 'more' })
  await ui.press({ key: `case-${CARD_C}-continue` })
  const cont = await ui.find({ key: `case-${CARD_C}-continue` })
  await ui.unmount()
  expect(review?.text || review?.props?.label).toBe('再按 w 確認驗收（opus · xhigh）')
  expect(openPr?.text || openPr?.props?.label).toContain('派 Agent 開 PR（haiku · low）')
  expect(cont?.text || cont?.props?.label).toBe('再按 g 確認繼續（opus · high）')
  expect(data.launches).toHaveLength(0)

  // 沒設 kinds：footer 跟以前一樣
  data.files[SETTINGS] = JSON.stringify({ model: 'opus', effort: 'high', sync: { claude: { model: 'haiku' } } })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const plain = await $.ui.mount(PANE(160))
  const before = (await plain.findAll({ type: 'Text' })).map((n: any) => n.text).join('')
  await plain.unmount()
  expect(before).toContain('派工 opus high · 同步 haiku')
  expect(before).not.toContain('驗收 opus')
  expect(before).not.toContain('推送 haiku')
})

/** 這件有 projects 覆寫（model sonnet）、kinds.review 只設 effort：確認字寫的跟實際啟動的一樣是 sonnet · xhigh；沒覆寫的那件照 kinds。 */
test('test_confirm_text_uses_project_override_with_kind_effort', async ($, on) => {
  const { data, clock } = fixture(on)
  threeCases(data, clock, { model: 'opus', effort: 'high', kinds: KINDS, projects: { '/home/u/wt/alpha': { model: 'sonnet' } } })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(160))

  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: 'more' })
  await ui.press({ key: `case-${CARD_A}-review` })
  const own = await ui.find({ key: `case-${CARD_A}-review` })
  await ui.press({ key: `case-${CARD_A}-review` })
  await clock.settle()
  await ui.press({ key: `row-${CARD_B}` })
  await ui.press({ key: 'more' })
  await ui.press({ key: `case-${CARD_B}-open-pr` })
  const other = await ui.find({ key: `case-${CARD_B}-open-pr` })
  await ui.unmount()

  expect(own?.text || own?.props?.label).toBe('再按 w 確認驗收（sonnet · xhigh）')
  expect(flags(data.launches[0])).toBe('sonnet xhigh')
  expect(other?.text || other?.props?.label).toContain('派 Agent 開 PR（haiku · low）')
})

/** 自動流程派一次修正輪：實作做完、檢查沒過；回傳修正那次的啟動。 */
async function autoFixLaunch($: any, data: any, clock: any, settings: object) {
  data.files[SETTINGS] = JSON.stringify(settings)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |`
  data.git['/home/u/wt/alpha'] = { branch: 'feature/alpha', head: 'h1' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.agents = []
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    data.agents = [{ id, kind: 'background', cwd: '/home/u/wt/alpha', name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
  const step = async () => { await clock.advance(2500); await clock.settle() }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  data.run = async () => result(1, 'boom\n')
  data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle(); await step(); await step(); await step()
  expect(data.launches).toHaveLength(2)
  return { first: data.launches[0], fix: data.launches[1] }
}

/** 這個對話的 Beta 流程已過關、PR 開著，main 前進後試合併有衝突：自動派解衝突；回傳那次啟動。 */
async function autoCatchupLaunch($: any, data: any, clock: any, settings: object) {
  const BETA = '/home/u/wt/beta'
  data.files[SETTINGS] = JSON.stringify(settings)
  data.agents = []
  data.gh = [{ number: 12, state: 'OPEN', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }]
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = `<!-- DESK -->\n- 狀態：Beta 過關\n- 驗證：\`npm test\`\n- 等你：無\n- 下一步：合併\n${PASSED}\n<!-- /DESK -->`
  data.git[BETA] = { branch: 'feature/b', head: 'h1', remote: 'git@github.com:acme/shop.git', releases: '', conflicts: ['src/a.ts'] }
  data.store.chains = { [BETA]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'h1', reviewBranch: 'feature/b', judgedHead: 'h1', judgedBranch: 'feature/b' } }
  data.store.verifies = { [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h1' } }
  data.store.jobs = { [BETA]: { sessionId: 'b0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'b0000009', sessionId: 'b0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true, ended: { how: 'finished' } } } }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  startsAgents(data, clock, { keep: 'others' })
  for (let i = 0; i < 3; i++) {
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    await clock.settle(); await clock.advance(2500); await clock.settle()
  }
  expect(data.launches).toHaveLength(1)
  expect(promptOf(data.launches[0])).toContain('合併基準分支、解衝突')
  return data.launches[0]
}

/** AC-4：kinds 設了 fix（模型與 effort 跟 continue 不同）與 catchup。 */
test('test_fix_and_catchup_kinds_pick_their_own_model', { timeoutMs: 15_000 }, async ($, on) => {
  const KINDS_FIX = { continue: { model: 'sonnet', effort: 'medium' }, fix: { model: 'haiku', effort: 'low' }, catchup: { model: 'opus', effort: 'max' } }
  const settings = { model: 'opus', effort: 'high', kinds: KINDS_FIX }
  // 設定檢查認得 kinds.fix 與 kinds.catchup
  expect(settingsProblems(JSON.stringify(settings))).toEqual([])
  const s = parseSettings(JSON.stringify(settings))
  expect(s.kinds).toEqual(KINDS_FIX)
  // 修正只在帶 fix 時讀 kinds.fix（按 g 的修正不帶 fix，照 continue）
  expect(modelFor(s, '/p/a', 'continue')).toEqual({ model: 'sonnet', effort: 'medium', fresh: false })
  expect(modelFor(s, '/p/a', 'continue', { fix: true })).toEqual({ model: 'haiku', effort: 'low', fresh: true })
  expect(modelFor(s, '/p/a', 'catchup')).toEqual({ model: 'opus', effort: 'max', fresh: true })
  // 只寫一欄：另一欄退回 continue 的；模型跟 continue 一樣就接原本的對話
  const half = parseSettings(JSON.stringify({ model: 'opus', effort: 'high', kinds: { continue: { model: 'sonnet', effort: 'medium' }, fix: { effort: 'xhigh' }, catchup: { model: 'haiku' } } }))
  expect(modelFor(half, '/p/a', 'continue', { fix: true })).toEqual({ model: 'sonnet', effort: 'xhigh', fresh: false })
  expect(modelFor(half, '/p/a', 'catchup')).toEqual({ model: 'haiku', effort: 'medium', fresh: true })

  // 自動派的修正輪：用 fix 的模型與 effort、開新對話（不帶 --resume），提示開頭說這是新的對話
  const { data, clock } = fixture(on)
  const { first, fix } = await autoFixLaunch($, data, clock, settings)
  expect(flags(first)).toBe('sonnet medium')
  expect(flags(fix)).toBe('haiku low')
  expect(fix.argv).not.toContain('--resume')
  expect(promptOf(fix).startsWith(FRESH_SESSION_LEAD)).toBe(true)
  expect(promptOf(fix)).toContain('修正第 1／2 輪：完成檢查')
  // 修正輪的新對話不換掉任務的對話：之後的繼續照舊接實作那個
  expect((data.store.jobs as any)['/home/u/wt/alpha'].sessionId).toBe('e0000001-0000-4000-8000-000000000000')

  // 面板狀態列列出「修正」「解衝突」的模型
  const ui = await $.ui.mount(PANE(200))
  const footer = (await ui.findAll({ type: 'Text' })).map((n: any) => n.text).join('')
  await ui.unmount()
  expect(footer).toContain('繼續 sonnet medium · 修正 haiku low · 解衝突 opus max')
})

/** AC-4：fix 只設 effort 時照舊接原本的對話。 */
test('test_fix_and_catchup_kinds_pick_their_own_model: fix effort only keeps the session', { timeoutMs: 15_000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  const { first, fix } = await autoFixLaunch($, data, clock, { model: 'opus', effort: 'high', kinds: { fix: { effort: 'xhigh' } } })
  expect(flags(first)).toBe('opus high')
  expect(flags(fix)).toBe('opus xhigh')
  expect(fix.argv[fix.argv.indexOf('--resume') + 1]).toBe('e0000001-0000-4000-8000-000000000000')
  expect(promptOf(fix)).not.toContain(FRESH_SESSION_LEAD)
})

/** AC-4：自動派的解衝突用 catchup 的模型與 effort，模型跟 continue 不同就開新對話。 */
test('test_fix_and_catchup_kinds_pick_their_own_model: catchup', { timeoutMs: 15_000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  const catchup = await autoCatchupLaunch($, data, clock, { model: 'opus', effort: 'high', kinds: { continue: { model: 'sonnet' }, catchup: { model: 'haiku', effort: 'low' } } })
  expect(flags(catchup)).toBe('haiku low')
  expect(catchup.argv).not.toContain('--resume')
  expect(promptOf(catchup).startsWith(FRESH_SESSION_LEAD)).toBe(true)
})
