import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, REGISTRY } from './fixture'
import { pipeline } from '../hooks/pipeline'
import { buildCase } from '../hooks/model'
import { needsPush, stageActions } from '../hooks/turn'
import type { Case, Verify } from '../types'

const BETA = '/home/u/wt/beta'
const PREFIX = `case-${CARD_B}-`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 2；可合併'
const OPEN_PR = { number: 12, state: 'OPEN', baseRefName: 'release/v1.4', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }

/** 只留 Beta 一件：審查過關、沒有 Agent 在跑；流程是別的對話開的，不會自動派工。 */
function onlyBeta(data: any, git: Record<string, unknown> = {}, gh: any[] = [OPEN_PR]) {
  data.agents = []
  data.gh = gh
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED)
  data.git[BETA] = { branch: 'feature/b', head: 'c2', remote: 'git@github.com:acme/shop.git', ...git }
}

/** desk 派的審查在 head 判定過關，檢查也在 head 跑過。 */
function judgedAt(data: any, head: string) {
  data.store.chains = { [BETA]: { owner: 'other-session', startedAt: 0, round: 0, passed: true, reviewHead: head, judgedHead: head } }
  data.store.verifies = { [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head } }
}

/** 記下 desk 自己跑的指令，確認它沒有 push、沒有開 PR。 */
function recordExec(data: any) {
  const calls: any[] = []
  data.exec = (e: any) => { calls.push(e); return null }
  return calls
}
const wroteRemote = (calls: any[]) => calls.some(e => (e.argv[0] === 'git' && e.argv.includes('push')) || (e.argv[0] === 'gh' && e.argv.includes('create')))

async function mount($: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  return $.ui.mount(PANE(100))
}

const has = async (ui: any, id: string) => !!(await ui.find({ key: `${PREFIX}${id}` }))
const labelOf = (b: any) => b?.text || b?.props?.label

/** 合併段 Beta 的 Case：卡片審查過關、檢查在 c2 過了；git 狀態與 PR 由呼叫端給。 */
function mergeCase(over: Partial<Case>): Case {
  const card = `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：合併\n${PASSED}\n<!-- /DESK -->`
  const v: Verify = { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' }
  const c: Case = { ...buildCase({ name: 'Beta', statusPath: CARD_B }, card, 1, {}, undefined), git: { branch: 'feature/b', head: 'c2' }, ...over }
  return { ...c, pipeline: pipeline(c, v) }
}

/** AC-1 */
test('push buttons: new commits after the PR is open offer push that only fills the prompt', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data, { ahead: 1 })
  judgedAt(data, 'c2')
  const calls = recordExec(data)

  const ui = await mount($)
  const push = await ui.find({ key: `${PREFIX}push` })
  const openPr = await has(ui, 'open-pr')
  const pr = await has(ui, 'pr')
  await ui.press({ key: `${PREFIX}push` })
  data.fillable = false
  await ui.press({ key: `${PREFIX}push` })

  expect(labelOf(push)).toBe('⇡ push')
  expect(openPr).toBe(false)
  expect(pr).toBe(true)
  expect(data.fills).toEqual([
    { text: 'push feature/b', mode: 'replace' },
    { text: 'push feature/b', mode: 'replace' },
  ])
  expect(data.submitted).toHaveLength(0)
  expect(data.toasts.some(t => t.includes('輸入框無法預填，請直接輸入：push feature/b'))).toBe(true)
  expect(wroteRemote(calls)).toBe(false)
  await ui.unmount()
})

/** 沒設追蹤分支（card.py new 會取消追蹤）、用 git push origin <分支> 推過：照 origin 上的同名分支算，已是最新就不出「⇡ push」。 */
test('push buttons: an untracked branch already pushed to origin offers no push', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data, { upstream: false, remoteAb: '0\t0' })
  judgedAt(data, 'c2')

  const ui = await mount($)
  const push = await has(ui, 'push')

  expect(push).toBe(false)
  await ui.unmount()
})

/** 同上，但本機又多了 commit：照 origin 上的同名分支算出領先，出「⇡ push」。 */
test('push buttons: an untracked branch ahead of origin offers push', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data, { upstream: false, remoteAb: '0\t1' })
  judgedAt(data, 'c2')

  const ui = await mount($)
  const push = await has(ui, 'push')

  expect(push).toBe(true)
  await ui.unmount()
})

/** 沒設追蹤分支、本機也沒有 origin 上的同名分支：算不出領先，不出「⇡ push」（規格只在「領先遠端」時出現）。 */
test('push buttons: an untracked branch with no origin ref offers no push', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data, { upstream: false })
  judgedAt(data, 'c2')

  const ui = await mount($)
  const push = await has(ui, 'push')

  expect(push).toBe(false)
  await ui.unmount()
})

/** AC-2 */
test('push buttons: no push outside the merge stage', async ($, on) => {
  const { data } = fixture(on)
  // 審查在 c1 過關、之後多了 c2 且從沒 push 過：退回檢查段
  onlyBeta(data, { upstream: false })
  judgedAt(data, 'c1')

  const ui = await mount($)
  const inCheck = await has(ui, 'push')
  await ui.unmount()

  const unpushed = { gitState: { ahead: 0, behind: 0, changed: 0, untracked: 0, upstream: false } }
  const ahead = { gitState: { ahead: 2, behind: 0, changed: 0, untracked: 0, upstream: true } }
  const card = (gate: string) => `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：繼續\n${gate}\n<!-- /DESK -->`
  const at = (gate: string, v: Verify | undefined, over: Partial<Case>) => {
    const c: Case = { ...buildCase({ name: 'Beta', statusPath: CARD_B }, card(gate), 1, {}, undefined), git: { branch: 'feature/b', head: 'c2' }, pr: { id: 12, state: 'OPEN', ci: 'pass' } as any, ...over }
    return { ...c, pipeline: pipeline(c, v) }
  }
  const ran = (ok: boolean): Verify => ({ command: 'npm test', at: 0, ok, exitCode: ok ? 0 : 1, tail: [], truncated: false, head: 'c2' })
  const build = at('- 關卡：無', undefined, unpushed)
  const check = at('- 關卡：無', ran(false), ahead)
  const review = at('- 關卡：無', ran(true), ahead)

  expect(inCheck).toBe(false)
  expect([build.pipeline!.current, check.pipeline!.current, review.pipeline!.current]).toEqual(['build', 'check', 'review'])
  for (const c of [build, check, review]) {
    expect(needsPush(c)).toBe(false)
    expect(stageActions(c).has('push')).toBe(false)
  }
})

/** AC-3 */
test('push buttons: no push when in sync, running, merged, or open-PR already covers it', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data, { ahead: 0 })
  judgedAt(data, 'c2')
  const ui = await mount($)
  const inSync = await has(ui, 'push')
  // 從沒 push 過、還沒有 PR：只有「⇡ 開 PR」
  data.gh = []
  data.git[BETA]!.upstream = false
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const noPr = { push: await has(ui, 'push'), openPr: await has(ui, 'open-pr') }
  await ui.unmount()

  const ahead = { ahead: 1, behind: 0, changed: 0, untracked: 0, upstream: true }
  const pr = { id: 12, state: 'OPEN', ci: 'pass' } as any
  const running = mergeCase({ gitState: ahead, pr, state: 'running', agent: { name: 'desk-beta', state: 'working', status: 'busy', startedAt: 0 } as any })
  const merged = mergeCase({ gitState: ahead, pr: { ...pr, state: 'MERGED' } })
  const open = mergeCase({ gitState: ahead, pr })

  expect(inSync).toBe(false)
  expect(noPr).toEqual({ push: false, openPr: true })
  // 對照組：同樣條件、沒在跑也沒合併時有 push
  expect(needsPush(open)).toBe(true)
  expect(needsPush(running)).toBe(false)
  expect(stageActions(running).has('push')).toBe(false)
  expect(needsPush(merged)).toBe(false)
  expect(stageActions(merged).has('push')).toBe(false)
})

/** AC-4 */
test('push buttons: uncommitted changes still allow push with a warning', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data, { ahead: 2, changed: 3 })
  judgedAt(data, 'c2')
  const calls = recordExec(data)

  const ui = await mount($)
  await ui.press({ key: `${PREFIX}push` })

  expect(data.fills).toEqual([{ text: 'push feature/b', mode: 'replace' }])
  expect(data.toasts.some(t => t.includes('有 3 檔未提交，只會 push 已 commit 的'))).toBe(true)
  expect(wroteRemote(calls)).toBe(false)
  await ui.unmount()
})

/** AC-5 */
test('push buttons: push and open-PR have no hotkeys; demo cases get no push', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data, { ahead: 1 })
  judgedAt(data, 'c2')
  const ui = await mount($)
  const push = await ui.find({ key: `${PREFIX}push` })
  data.gh = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const openPr = await ui.find({ key: `${PREFIX}open-pr` })
  await ui.unmount()

  const demo = mergeCase({ demo: true, gitState: { ahead: 1, behind: 0, changed: 0, untracked: 0, upstream: true }, pr: { id: 12, state: 'OPEN', ci: 'pass' } as any })

  expect(labelOf(push)).toBe('⇡ push')
  expect(push?.props?.hotkey).toBeUndefined()
  expect(labelOf(openPr)).toBe('⇡ 開 PR')
  expect(openPr?.props?.hotkey).toBeUndefined()
  expect(needsPush(demo)).toBe(false)
  expect(stageActions(demo).has('push')).toBe(false)
  expect(needsPush({ ...demo, demo: false })).toBe(true)
})
