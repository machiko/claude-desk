import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, REGISTRY, leaves, result, text } from './fixture'
import { pipeline } from '../hooks/pipeline'
import { buildCase } from '../hooks/model'
import { stageActions } from '../hooks/turn'
import { caseActions } from '../hooks/pane-card'
import type { Case, Verify } from '../types'

const BETA = '/home/u/wt/beta'
const PREFIX = `case-${CARD_B}-`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 2；可合併'
const RISK = '高風險改動（認證／中介層），審查已過，請你看過再開 PR'
const PUBLISH_HEAD = '推送：push feature/b 並對 release/v1.4 開 PR，PR 網址寫進歷程'

/** 只留 Beta 一件：審查過關、還沒有 PR、沒有 Agent 在跑。 */
function onlyBeta(data: any) {
  data.agents = []
  data.gh = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED)
  data.git[BETA] = { branch: 'feature/b', head: 'c2', remote: 'git@github.com:acme/shop.git', upstream: false }
}

/** desk 派的審查在 c2 判定過關、檢查也在 c2 跑過；needsHuman 是流程標的高風險。 */
function judged(data: any, needsHuman?: string) {
  data.store.chains = { [BETA]: { owner: 'other-session', startedAt: 0, round: 0, passed: true, reviewHead: 'c2', judgedHead: 'c2', ...(needsHuman ? { needsHuman } : {}) } }
  data.store.verifies = { [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' } }
}

/** 記下 desk 自己跑的指令，確認它沒有 push、沒有開 PR。 */
function recordExec(data: any) {
  const calls: any[] = []
  data.exec = (e: any) => { calls.push(e); return null }
  return calls
}
const wroteRemote = (calls: any[]) => calls.some(e => (e.argv[0] === 'git' && e.argv.includes('push')) || (e.argv[0] === 'gh' && e.argv.includes('create')))

/** 派工會啟動一個背景 Agent：清單裡多一個同名、在跑的 Agent（照 `claude --bg` 的回應）。 */
function startsAgents(data: any, clock: any) {
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    data.agents = [{ id, kind: 'background', cwd: BETA, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
}
const promptOf = (data: any, i = 0) => String(data.launches[i].argv[data.launches[i].argv.length - 1])

async function mount($: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  return $.ui.mount(PANE(100))
}

const find = (ui: any, id: string) => ui.find({ key: `${PREFIX}${id}` })
const labelOf = (b: any) => b?.text || b?.props?.label
/** 帶頭的按鈕：粗體（或已待確認的加框）。 */
const isLead = (b: any) => b?.props?.variant === 'primary' || leaves(b, 'Text').some((t: any) => t.props?.bold)
const flat = (x: string) => x.replace(/\s+/g, '')
const screen = async (ui: any) => flat(text(await ui.drawn()))

/** 畫面上這件任務的按鈕。 */
const buttonKeys = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key ?? '')).filter((k: string) => k.startsWith(PREFIX)).map((k: string) => k.slice(PREFIX.length))

/** 動作列（按鈕與「退回：」字樣）照排列的順序；showAll 是按了 m 展開全部，armed 是按過一次、等確認的動作。 */
function actionsOf(c: Case, showAll: boolean, armed?: string) {
  const view = { s: { tutorial: false, cases: [c] }, picks: {}, verifying: {}, queue: [], launching: {}, armed: armed ? { key: `${CARD_B}\n${armed}`, at: 0 } : null, now: 0, logsOpen: null, sent: {}, showAll } as any
  const act = new Proxy({}, { get: () => () => {} }) as any
  return caseActions(view, c, act).map(a => ({ ...a, id: a.key.slice(PREFIX.length) }))
}
const actionOrder = (c: Case, showAll: boolean) => actionsOf(c, showAll).map(a => a.id)

const PASS_C2: Verify = { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' }

/** Beta 的 Case：預設審查過關、檢查在 c2 過了（合併段）；關卡、檢查與其餘由呼叫端給。 */
function mergeCase(over: Partial<Case>, gate = PASSED, v: Verify | undefined = PASS_C2): Case {
  const card = `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：依審核修正\n${gate}\n<!-- /DESK -->`
  const c: Case = { ...buildCase({ name: 'Beta', statusPath: CARD_B }, card, 1, {}, undefined), git: { branch: 'feature/b', head: 'c2' }, ...over }
  return { ...c, pipeline: pipeline(c, v) }
}

/** AC-1 */
test('merge actions: a high-risk case offers open-PR as the lead and dispatches the publish agent on the second press', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data)
  judged(data, RISK)
  startsAgents(data, clock)
  const calls = recordExec(data)

  const ui = await mount($)
  const before = await find(ui, 'open-pr')
  await ui.press({ key: `${PREFIX}open-pr` })
  const armed = await find(ui, 'open-pr')
  const launchesAfterFirst = data.launches.length
  // 超過確認時間才按第二次：重新待確認，不派
  await clock.advance(4000)
  await clock.settle()
  await ui.press({ key: `${PREFIX}open-pr` })
  const launchesAfterLate = data.launches.length
  await ui.press({ key: `${PREFIX}open-pr` })
  await clock.settle()
  const after = await find(ui, 'open-pr')
  await ui.unmount()

  expect(labelOf(before)).toBe('⇡ 開 PR')
  expect(isLead(before)).toBe(true)
  expect(labelOf(armed)).toContain('看過審查檔了？再按一次確認派 Agent 開 PR')
  expect(launchesAfterFirst).toBe(0)
  expect(launchesAfterLate).toBe(0)
  expect(data.launches).toHaveLength(1)
  expect(promptOf(data).split('\n')[0]).toContain(PUBLISH_HEAD)
  // 推送 Agent 在跑：「⇡ 開 PR」收起，不能再派一個
  expect(after).toBeUndefined()
  // desk 自己不 push、不開 PR，也不預填輸入框
  expect(data.fills).toHaveLength(0)
  expect(data.submitted).toHaveLength(0)
  expect(wroteRemote(calls)).toBe(false)
})

/** AC-2 */
test('merge actions: a high-risk case says to read the review file and press open-PR twice', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data)
  judged(data, RISK)

  const ui = await mount($)
  const shown = await screen(ui)
  const reviewFile = await find(ui, 'review-file')
  const openPr = await find(ui, 'open-pr')
  await ui.unmount()

  expect(shown).toContain(flat('▶ 輪到你  高風險改動：看過審查檔（e）後按兩次 ⇡ 開 PR 派 Agent push 並開 PR'))
  expect(labelOf(reviewFile)).toBe('↗ 審查檔')
  expect(isLead(reviewFile)).toBe(false)
  expect(reviewFile?.props?.dimColor).toBe(true)
  expect(isLead(openPr)).toBe(true)
})

/** AC-3 */
test('merge actions: the merge stage lists no continue, review or verify by default', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data)
  judged(data)
  const ui = await mount($)
  const normal = await buttonKeys(ui)
  judged(data, RISK)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const risky = await buttonKeys(ui)
  await ui.unmount()

  const selfReviewed = mergeCase({ chain: { round: 0, selfReview: true } })
  const failedCi = mergeCase({ chain: { round: 0, passed: true }, pr: { id: 12, state: 'OPEN', ci: 'fail', url: 'https://github.com/acme/shop/pull/12' } as any })

  for (const keys of [normal, risky]) {
    expect(keys).toContain('open-pr')
    expect(keys.filter((k: string) => k === 'continue' || k === 'review' || k === 'verify')).toEqual([])
  }
  expect(selfReviewed.pipeline!.current).toBe('merge')
  expect(stageActions(selfReviewed).has('review')).toBe(true)
  expect(stageActions(selfReviewed).has('continue')).toBe(false)
  expect(stageActions(selfReviewed).has('verify')).toBe(false)
  // CI 失敗：「輪到你」叫你按 g 修正，g 就要在列上
  expect(failedCi.pipeline!.current).toBe('merge')
  expect(stageActions(failedCi).has('continue')).toBe(true)
  expect(stageActions(failedCi).has('review')).toBe(false)
  expect(stageActions(failedCi).has('verify')).toBe(false)
  // 失敗的是舊 commit、本機已有新 commit 沒 push：該按的是 ⇡ push，不再列 g
  const fixedLocally = mergeCase({ chain: { round: 0, passed: true }, pr: failedCi.pr, gitState: { ahead: 1, behind: 0, changed: 0, untracked: 0, upstream: true } })
  expect(stageActions(fixedLocally).has('push')).toBe(true)
  expect(stageActions(fixedLocally).has('continue')).toBe(false)
})

/** AC-4 */
test('merge actions: show-all puts the retreat actions last, dimmed and labelled', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data)
  judged(data, RISK)

  const ui = await mount($)
  const normal = await buttonKeys(ui)
  await ui.press({ key: 'more' })
  const shown = await buttonKeys(ui)
  const labels = (await ui.findAll({ type: 'Text' })).filter((n: any) => n.text === '退回：')
  const back = await Promise.all(['continue', 'review', 'verify'].map(id => find(ui, id)))
  const openPr = await find(ui, 'open-pr')
  await ui.unmount()

  const risky = mergeCase({ chain: { round: 0, passed: true, needsHuman: RISK } })
  const failedCi = mergeCase({ chain: { round: 0, passed: true }, pr: { id: 12, state: 'OPEN', ci: 'fail', url: 'https://github.com/acme/shop/pull/12' } as any })

  expect(normal).toEqual(['review-file', 'open-pr', 'open'])
  expect(shown).toEqual(['sync', 'review-file', 'open-pr', 'open', 'continue', 'review', 'verify'])
  // 畫面上有一段不可按的「退回：」（不是按鈕）
  expect(labels).toHaveLength(1)
  for (const b of back) {
    expect(b?.props?.dimColor).toBe(true)
    expect(isLead(b)).toBe(false)
  }
  expect(isLead(openPr)).toBe(true)
  // 「退回：」在本段的動作與退回的動作之間
  expect(actionOrder(risky, true)).toEqual(['sync', 'review-file', 'open-pr', 'open', 'retreat', 'continue', 'review', 'verify'])
  expect(actionOrder(risky, false)).toEqual(['review-file', 'open-pr', 'open'])
  // PR 開著、CI 失敗：帶頭是 ↗ PR，g 留在本段，審查與檢查一樣排後
  expect(actionOrder(failedCi, false)).toEqual(['continue', 'pr', 'open'])
  expect(actionOrder(failedCi, true)).toEqual(['continue', 'sync', 'pr', 'open', 'retreat', 'review', 'verify'])
  expect(actionsOf(failedCi, true).filter(a => a.isLead).map(a => a.id)).toEqual(['pr'])
  // 退回的動作按過一次、等確認：照樣加框、寫確認字樣
  const armedBack = actionsOf(risky, true, 'review').find(a => a.id === 'review')!
  expect(armedBack.isBoxed).toBe(true)
  expect(armedBack.label).toContain('再按 w 確認')
})

/** AC-4：Agent 執行中展開更多動作：開 PR 不列（Agent 在跑不能派推送），退回組只有檢查。 */
test('merge actions: show-all while an agent runs lists no open-PR and only verify retreats', () => {
  const running = mergeCase({ state: 'running', agent: { id: 'x', name: 'desk-beta-1', state: 'working', status: 'busy', kind: 'sync', startedAt: 0 } as any, chain: { round: 0, passed: true, needsHuman: RISK } })
  const shown = actionsOf(running, true)

  expect(running.pipeline!.current).toBe('merge')
  expect(shown.map(a => a.id)).toEqual(['stop', 'logs', 'review-file', 'open', 'retreat', 'verify'])
})

/** AC-4：其他段落展開更多動作時不分組，順序照舊。 */
test('merge actions: show-all outside the merge stage has no retreat group', () => {
  // 卡片沒有審查結論、檢查沒跑過：還沒到合併段
  const earlier = mergeCase({}, '- 關卡：無', undefined)

  expect(earlier.pipeline!.current).not.toBe('merge')
  expect(actionOrder(earlier, true)).toEqual(['continue', 'review', 'sync', 'verify', 'open'])
})

/** AC-5 */
test('merge actions: a normal case confirms without the review-file reminder and dispatches on the second press', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data)
  judged(data)
  startsAgents(data, clock)

  const ui = await mount($)
  const shown = await screen(ui)
  await ui.press({ key: `${PREFIX}open-pr` })
  const armed = await find(ui, 'open-pr')
  const launchesAfterFirst = data.launches.length
  await ui.press({ key: `${PREFIX}open-pr` })
  await clock.settle()
  await ui.unmount()

  expect(shown).toContain(flat('▶ 輪到你  按 ⇡ 開 PR 派 Agent push 並開 PR'))
  expect(shown).not.toContain(flat('按兩次'))
  expect(labelOf(armed)).toContain('再按一次確認派 Agent 開 PR')
  expect(labelOf(armed)).not.toContain('看過審查檔')
  expect(launchesAfterFirst).toBe(0)
  expect(data.launches).toHaveLength(1)
  expect(promptOf(data).split('\n')[0]).toContain(PUBLISH_HEAD)
  expect(data.fills).toHaveLength(0)
})
