import { expect, test } from 'claude-code/testing'
import { fixture, text, flat, PANE, CARD_A, CARD_B, CARD_C, REGISTRY, pressHotkey } from './fixture'
import { RELEASE_CONFIRMED, parseDecisions, releasePrompt } from '../hooks/card'

const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const PREFIX = `case-${CARD_B}-`
const KEY = `${PREFIX}release`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
const GITHUB = 'git@github.com:acme/shop.git'
const FILLED = '發版請求已填入（已確認照慣例版號），按 Esc 回輸入框再按 Enter；要改版號就在送出前改這行'
/** 按一次 z 後發版按鈕的待確認標籤。 */
const ARMED = '再按 z 確認：照慣例版號直接發版（不再問）'
/** 面板按兩次 z 填入的請求括號最後一段。 */
const CONFIRMED = '；已在面板確認：版號照慣例直接做'
const LINE = 'release/v26.2.7'
/** skills/release/SKILL.md 的照做動作順序（tests/release-skill.test.ts 與 skills/card/tests/test_release_skill.py 驗 SKILL.md 本身）。 */
const CHAIN = '整版審查 → 合併 CHANGELOG 片段 → 改版號 → 跑完整檢查 → commit → 打 tag → push 主分支與 tag → 等 CI 通過'
/** 搬進 skills/release/SKILL.md 的規則字句：發版請求裡不再出現。 */
const RULES = ['只問我一次', 'A) 照做', '→', '不 force push', '題目沒列的事']
const pr = (n: number, dest = 'main') => ({ number: n, state: 'MERGED', baseRefName: dest, headRepositoryOwner: { login: 'acme' }, url: `https://github.com/acme/shop/pull/${n}`, statusCheckRollup: [] })
/** 已合併、審查過關（沒有 release 關卡）的卡；root、分支跟 setup 的 git 一致，發版請求的清理段才對得上畫面。 */
const merged = (name: string, id: number, root: string, branch: string) => ({ name, root, git: { branch } as any, gate: PASSED.replace('- 關卡：', ''), pr: { id, state: 'MERGED', ci: 'none' } as any })
const BETA_CASE = merged('Beta', 12, BETA, 'feature/b')
const GAMMA_CASE = merged('Gamma', 13, GAMMA, 'fix/c')

/**
 * Alpha 還沒合併（feature/a，沒有 PR）；Beta（feature/b，PR #12）與 Gamma（fix/c，PR #13）已合併、都沒打 tag。
 * Gamma 的 PR 目標由呼叫端給；所有外部指令（含 git）記在回傳的陣列裡。
 */
function setup(data: any, gammaDest = 'main') {
  data.agents = []
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED)
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 關卡：無', PASSED)
  data.git[ALPHA] = { branch: 'feature/a', head: 'a1', remote: GITHUB }
  data.git[BETA] = { branch: 'feature/b', head: 'b1', remote: GITHUB }
  data.git[GAMMA] = { branch: 'fix/c', head: 'c1', remote: GITHUB }
  const byBranch: Record<string, any[]> = { 'feature/a': [], 'feature/b': [pr(12)], 'fix/c': [pr(13, gammaDest)] }
  const calls: any[] = []
  data.exec = (e: any) => {
    calls.push(e)
    if (e.argv[0] !== 'gh') return null
    const head = e.argv[e.argv.indexOf('--head') + 1]
    return { exitCode: 0, stdout: JSON.stringify(byBranch[head] ?? []), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }
  return calls
}

async function mountBeta($: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(80))
  // Beta 不在現在卡時，點它的列看詳情
  if (await ui.find({ key: `row-${CARD_B}` })) await ui.press({ key: `row-${CARD_B}` })
  return ui
}

/** 按兩次「⚑ 發版」（第一次只待確認），回傳填入輸入框的那句。 */
async function pressRelease(ui: any, data: any, clock: any): Promise<string> {
  await ui.press({ key: KEY })
  await clock.settle()
  expect(data.fills).toHaveLength(0)
  await ui.press({ key: KEY })
  await clock.settle()
  expect(data.fills).toHaveLength(1)
  return data.fills[0].text as string
}

/** AC-2：按兩次後發版請求是一行 `/desk:release`：列卡名、PR、清理對象與確認段，不帶規則字句（確認方式、A／B／C 在 skill 裡），不超過 200 字。 */
test('test_release_prompt_asks_one_question_with_version_cards_and_actions_when_release_pressed', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data)
  const ui = await mountBeta($, clock)
  const asked = await pressRelease(ui, data, clock)

  expect(asked).toBe(releasePrompt([BETA_CASE, GAMMA_CASE], { confirmed: true }))
  expect(asked).toBe('/desk:release 「Beta」PR #12、「Gamma」PR #13（歸檔並移除 worktree 與分支：beta feature/b、gamma fix/c；已在面板確認：版號照慣例直接做）')
  for (const gone of [...RULES, 'Alpha']) expect(asked).not.toContain(gone)
  expect(asked.length).toBeLessThanOrEqual(200)
  // 沒有自動送出；提示寫明已確認照慣例版號、要改版號在送出前改
  expect(data.submitted).toHaveLength(0)
  expect(data.toasts.some((t: string) => t.includes(FILLED))).toBe(true)
  await ui.unmount()
})

/** AC-2：對話照範本寫的確認題：面板只有一個決策、題目整句看得到、選項只有 A／B／C，「#13）」不是選項。 */
test('test_release_question_shows_one_decision_with_three_options_when_it_lists_pr_numbers', async ($, on) => {
  const ask = `發版 v0.38.0（「Beta」PR #12、「Gamma」PR #13，有 feature 分支，升次版號），照做會依序：${CHAIN}：A) 照做 v0.38.0（推薦） B) 改用 v0.37.1 照做 C) 先不發`
  const decisions = parseDecisions(ask)
  expect(decisions).toHaveLength(1)
  expect(decisions[0]!.title).toBe(`發版 v0.38.0（「Beta」PR #12、「Gamma」PR #13，有 feature 分支，升次版號），照做會依序：${CHAIN}`)
  expect(decisions[0]!.options).toEqual([
    { key: 'A', text: '照做 v0.38.0（推薦）' },
    { key: 'B', text: '改用 v0.37.1 照做' },
    { key: 'C', text: '先不發' },
  ])

  const { data, clock } = fixture(on)
  data.agents = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED).replace(/- 等你：.*$/m, `- 等你：${ask}`)
  data.git[BETA] = { branch: 'feature/b', head: 'b1', remote: GITHUB }
  data.gh = [pr(12)]
  const ui = await mountBeta($, clock)
  const screen = flat(text(await ui.drawn()))
  for (const part of ['v0.38.0', '「Beta」PR #12', '「Gamma」PR #13', '升次版號', '合併 CHANGELOG 片段', '等 CI 通過', '先不發']) expect(screen).toContain(flat(part))
  // 選項按鈕只有 A、B、C 三個，都在第一題
  const options = (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key ?? '')).filter((k: string) => k.startsWith(`${PREFIX}opt`)).sort()
  expect(options).toEqual([`${PREFIX}opt0A`, `${PREFIX}opt0B`, `${PREFIX}opt0C`])
  const optA = await ui.find({ key: `${PREFIX}opt0A` })
  expect(optA?.props?.hotkey).toBe('a')
  await ui.press({ key: `${PREFIX}opt0A` })
  const fill = await ui.find({ key: `${PREFIX}fill` })
  expect(fill?.props?.hotkey).toBe('f')
  await ui.press({ key: `${PREFIX}fill` })
  await clock.settle()
  expect(data.fills).toEqual([{ text: '「Beta」決策：A', mode: 'replace' }])
  await ui.unmount()
})

/** AC-2：括號列清理對象（slug 與分支）與有 release 關卡的卡；全部都有 release 關卡時只寫一句、不列 slug 與分支；沒有 PR 的卡只寫卡名。 */
test('test_release_request_lists_cleanup_targets_and_release_gated_cards', () => {
  const gated = (c: ReturnType<typeof merged>) => ({ ...c, gate: 'release：待上線' })
  const beta = merged('Beta', 12, BETA, 'feature/b')
  const gamma = merged('Gamma', 13, GAMMA, 'feature/c')
  expect(releasePrompt([beta, gated(gamma)])).toBe('/desk:release 「Beta」PR #12、「Gamma」PR #13（歸檔並移除 worktree 與分支：beta feature/b；「Gamma」有 release 關卡，部署後按 u）')
  const allGated = releasePrompt([gated(beta), gated(gamma)])
  expect(allGated).toBe('/desk:release 「Beta」PR #12、「Gamma」PR #13（都有 release 關卡，不清理，部署後按 u）')
  for (const target of ['beta', 'gamma', 'feature/']) expect(allGated).not.toContain(target)
  // 沒有 PR 的卡只寫「卡名」
  const delta = { ...merged('Delta', 0, '/home/u/wt/delta', 'fix/d'), pr: undefined }
  expect(releasePrompt([beta, delta])).toBe('/desk:release 「Beta」PR #12、「Delta」（歸檔並移除 worktree 與分支：beta feature/b、delta fix/d）')
  // 面板確認段：接在清理段之後（「；」分隔）；全部有 release 關卡時接在那一句之後；沒有清理段時括號只有它
  const confirmed = { confirmed: true }
  expect(releasePrompt([beta, gated(gamma)], confirmed)).toBe(`/desk:release 「Beta」PR #12、「Gamma」PR #13（歸檔並移除 worktree 與分支：beta feature/b；「Gamma」有 release 關卡，部署後按 u${CONFIRMED}）`)
  expect(releasePrompt([gated(beta), gated(gamma)], confirmed)).toBe(`/desk:release 「Beta」PR #12、「Gamma」PR #13（都有 release 關卡，不清理，部署後按 u${CONFIRMED}）`)
  expect(releasePrompt([], confirmed)).toBe(`/desk:release （${RELEASE_CONFIRMED}）`)
})

/** AC-3：範圍外的卡（沒合併的、併進發版線的）不列；按下只填輸入框，不跑外部指令、卡片不變。 */
test('test_release_prompt_skips_unmerged_cases_and_forbids_unlisted_actions_when_pressed', async ($, on) => {
  const { data, clock } = fixture(on)
  const calls = setup(data, LINE)
  const ui = await mountBeta($, clock)
  const cards = [CARD_A, CARD_B, CARD_C].map(p => data.files[p])
  const before = calls.length
  const launches = data.launches.length
  const asked = await pressRelease(ui, data, clock)

  expect(asked).toBe(releasePrompt([BETA_CASE], { confirmed: true }))
  expect(asked).toBe('/desk:release 「Beta」PR #12（歸檔並移除 worktree 與分支：beta feature/b；已在面板確認：版號照慣例直接做）')
  for (const gone of ['Alpha', 'Gamma', 'PR #13']) expect(asked).not.toContain(gone)
  // 只填輸入框：不送出、不跑 git／gh／claude、三張卡片一字不變
  expect(data.submitted).toHaveLength(0)
  expect(data.launches.length).toBe(launches)
  expect(calls.slice(before).filter((c: any) => ['git', 'gh', 'claude'].includes(c.argv[0]))).toEqual([])
  expect([CARD_A, CARD_B, CARD_C].map(p => data.files[p])).toEqual(cards)
  await ui.unmount()
})

/** 發版按鈕的畫面狀態：加框（variant primary、不是 plain）與標籤。 */
async function releaseButton(ui: any) {
  const b = await ui.find({ key: KEY })
  return { isBoxed: b?.props?.variant === 'primary' && !b?.props?.plain, label: b?.text || b?.props?.label }
}

/** AC-1：按一次 z 只待確認：輸入框不變、按鈕加框改寫確認句，不跑外部指令、卡片一字不變。 */
test('test_release_button_arms_without_filling_when_pressed_once', async ($, on) => {
  const { data, clock } = fixture(on)
  const calls = setup(data)
  const ui = await mountBeta($, clock)
  const cards = [CARD_A, CARD_B, CARD_C].map(p => data.files[p])
  const before = calls.length
  const launches = data.launches.length
  expect(await releaseButton(ui)).toEqual({ isBoxed: false, label: '⚑ 發版' })

  await pressHotkey(ui, 'z')
  await clock.settle()

  expect(data.fills).toEqual([])
  expect(data.submitted).toHaveLength(0)
  expect(await releaseButton(ui)).toEqual({ isBoxed: true, label: ARMED })
  expect(data.launches.length).toBe(launches)
  expect(calls.slice(before).filter((c: any) => ['git', 'gh', 'claude'].includes(c.argv[0]))).toEqual([])
  expect([CARD_A, CARD_B, CARD_C].map(p => data.files[p])).toEqual(cards)
  await ui.unmount()
})

/** AC-3：待確認超過三秒再按：只重新進入待確認，輸入框不變。 */
test('test_release_rearms_instead_of_filling_when_pressed_again_after_three_seconds', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data)
  const ui = await mountBeta($, clock)
  await ui.press({ key: KEY })
  await clock.settle()
  await clock.advance(3500)
  await clock.settle()

  await ui.press({ key: KEY })
  await clock.settle()

  expect(data.fills).toEqual([])
  expect(await releaseButton(ui)).toEqual({ isBoxed: true, label: ARMED })
  await ui.unmount()
})
