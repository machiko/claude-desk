import { expect, test } from 'claude-code/testing'
import { fixture, text, flat, PANE, CARD_A, CARD_B, CARD_C, REGISTRY } from './fixture'
import { parseDecisions, releasePrompt, RELEASE_ACTIONS } from '../hooks/card'

const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const PREFIX = `case-${CARD_B}-`
const KEY = `${PREFIX}release`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
const GITHUB = 'git@github.com:acme/shop.git'
const FILLED = '發版請求已填入，按 Esc 回到輸入框再按 Enter 送出'
const LINE = 'release/v26.2.7'
const CHAIN = RELEASE_ACTIONS.join(' → ')
const pr = (n: number, dest = 'main') => ({ number: n, state: 'MERGED', baseRefName: dest, headRepositoryOwner: { login: 'acme' }, url: `https://github.com/acme/shop/pull/${n}`, statusCheckRollup: [] })
const merged = (name: string, id: number) => ({ name, pr: { id, state: 'MERGED', ci: 'none' } as any })

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

/** 按「⚑ 發版」，回傳填入輸入框的那句。 */
async function pressRelease(ui: any, data: any, clock: any): Promise<string> {
  await ui.press({ key: KEY })
  await clock.settle()
  expect(data.fills).toHaveLength(1)
  return data.fills[0].text as string
}

/** AC-1：發版請求只問一次：一題寫建議版號與理由、包含的卡與 PR、照做的動作，選項 A／B／C；不再有兩個確認點。 */
test('test_release_prompt_asks_one_question_with_version_cards_and_actions_when_release_pressed', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data)
  const ui = await mountBeta($, clock)
  const asked = await pressRelease(ui, data, clock)

  expect(asked).toBe(releasePrompt([merged('Beta', 12), merged('Gamma', 13)]))
  expect(asked).toStartWith('發版：已合併待發版 2 件（「Beta」PR #12、「Gamma」PR #13）；照這個專案的發版流程準備，只問我一次')
  expect(CHAIN).toBe('合併 CHANGELOG 片段 → 改版號 → 跑完整檢查 → commit → 打 tag → push 主分支與 tag → 等 CI 通過')
  for (const part of ['只問我一次', '這幾張卡的「等你」寫同一題', '版號', '理由', '「Beta」PR #12', '「Gamma」PR #13', CHAIN, 'A) 照做', 'B) 改用', 'C) 先不發']) expect(asked).toContain(part)
  for (const gone of ['先提版號給我確認', '打 tag 並 push', 'Alpha']) expect(asked).not.toContain(gone)
  // 沒有自動送出，toast 照舊
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

/** AC-3：選照做後做到底、失敗就停；動作清單多一項時照順序列在「等 CI 通過」之後，仍只問一題、選項仍是 A／B／C。 */
test('test_release_prompt_runs_listed_actions_to_end_and_stops_when_a_step_fails', () => {
  const cases = [merged('Beta', 12), merged('Gamma', 13)]
  const asked = releasePrompt(cases, [...RELEASE_ACTIONS, '歸檔這幾張卡'])
  for (const part of [
    '回答任一張就算數',
    '收到決策先把每張的「等你」清成無',
    '選 A 或 B 後照順序做完、中間不再問',
    '「狀態」寫做到哪一步',
    '任何一步失敗就停、後面的不做',
    '還沒 push 就不 push',
    '已 push 的不回退、不 force push',
    '失敗的步驟與原因寫進「狀態」',
    '要我決定的才寫進「等你」',
    '選 C 就清掉「等你」、什麼都不做',
    `${CHAIN} → 歸檔這幾張卡`,
  ]) expect(asked).toContain(part)
  // 仍只要一題、選項仍是 A／B／C
  expect(asked.match(/只問我一次/g)).toHaveLength(2)
  for (const key of ['A) 照做', 'B) 改用', 'C) 先不發']) expect(asked.split(key)).toHaveLength(2)
  expect(asked).not.toMatch(/D\) /)
  // 預設的請求不多出那一項
  expect(releasePrompt(cases)).not.toContain('歸檔這幾張卡')
})

/** AC-5：範圍外的卡不列；按下只填輸入框，不跑外部指令、卡片不變；請求寫明題目沒列的事不做、release 關卡留給使用者。 */
test('test_release_prompt_skips_unmerged_cases_and_forbids_unlisted_actions_when_pressed', async ($, on) => {
  const { data, clock } = fixture(on)
  const calls = setup(data, LINE)
  const ui = await mountBeta($, clock)
  const cards = [CARD_A, CARD_B, CARD_C].map(p => data.files[p])
  const before = calls.length
  const launches = data.launches.length
  const asked = await pressRelease(ui, data, clock)

  expect(asked).toBe(releasePrompt([merged('Beta', 12)]))
  expect(asked).toContain('已合併待發版 1 件（「Beta」PR #12）')
  for (const gone of ['Alpha', 'Gamma', 'PR #13']) expect(asked).not.toContain(gone)
  expect(asked).toContain('題目沒列的事一律不做（force push、改寫歷史、合併 PR、刪分支、改清單外的卡），要做就另外問')
  expect(asked).toContain('有 `release：` 關卡的卡留給我部署後按 u')
  // 只填輸入框：不送出、不跑 git／gh／claude、三張卡片一字不變
  expect(data.submitted).toHaveLength(0)
  expect(data.launches.length).toBe(launches)
  expect(calls.slice(before).filter((c: any) => ['git', 'gh', 'claude'].includes(c.argv[0]))).toEqual([])
  expect([CARD_A, CARD_B, CARD_C].map(p => data.files[p])).toEqual(cards)
  await ui.unmount()
})
