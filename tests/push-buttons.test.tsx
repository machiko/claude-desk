import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, REGISTRY, result, text, flat } from './fixture'
import { pipeline } from '../hooks/pipeline'
import { buildCase } from '../hooks/model'
import { needsPr, needsPush, stageActions } from '../hooks/turn'
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

const has = async (ui: any, id: string) => !!(await ui.find({ key: `${PREFIX}${id}` }))
const labelOf = (b: any) => b?.text || b?.props?.label

/** 合併段 Beta 的 Case：卡片審查過關、檢查在 c2 過了；git 狀態與 PR 由呼叫端給。 */
function mergeCase(over: Partial<Case>): Case {
  const card = `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：合併\n${PASSED}\n<!-- /DESK -->`
  const v: Verify = { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' }
  const c: Case = { ...buildCase({ name: 'Beta', statusPath: CARD_B }, card, 1, {}, undefined), git: { branch: 'feature/b', head: 'c2' }, ...over }
  return { ...c, pipeline: pipeline(c, v) }
}

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

const screen = async (ui: any) => flat(text(await ui.drawn()))

/** 沒設追蹤分支、origin 上有同名分支：git 列照它算（與遠端一致、領先 n），不再說「未 push（沒有遠端分支）」；origin 沒有才說。 */
test('push buttons: the git line of an untracked branch that origin has does not say unpushed', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data, { upstream: false, remoteAb: '0\t0' })
  judgedAt(data, 'c2')

  const ui = await mount($)
  const inSync = await screen(ui)
  data.git[BETA]!.remoteAb = '0\t1'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ahead = await screen(ui)
  delete data.git[BETA]!.remoteAb
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const noRef = await screen(ui)
  await ui.unmount()

  expect(inSync).toContain(flat('feature/b · 與遠端一致、無未提交變更'))
  expect(inSync).not.toContain(flat('未 push'))
  expect(ahead).toContain(flat('feature/b · 領先 1'))
  expect(ahead).not.toContain(flat('未 push'))
  expect(noRef).toContain(flat('feature/b · 未 push（沒有遠端分支）'))
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

/** AC-4 */
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
  // 推送 Agent 在跑、但卡片「等你」有一題決策（state 是 ask）：也沒有開 PR／push
  const busy = { name: 'desk-p', state: 'working', status: 'busy', kind: 'publish' } as any
  const ask = '審查 MEDIUM 1 條怎麼處理：A) 現在改 B) 之後再說'
  const askingNoPr = mergeCase({ ask, state: 'ask', agent: busy })
  const askingAhead = mergeCase({ ask, state: 'ask', agent: busy, gitState: ahead, pr })
  expect([askingNoPr.pipeline!.current, askingAhead.pipeline!.current]).toEqual(['merge', 'merge'])
  expect(needsPr(askingNoPr)).toBe(false)
  expect(stageActions(askingNoPr).has('open-pr')).toBe(false)
  expect(needsPush(askingAhead)).toBe(false)
  expect(stageActions(askingAhead).has('push')).toBe(false)
  // 對照組：同樣「等你」、Agent 停下（idle）時照常有開 PR
  expect(needsPr(mergeCase({ ask, state: 'ask' }))).toBe(true)
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

/** AC-1 */
test('push buttons: open-PR dispatches a publish agent', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, { upstream: false }, [])
  judgedAt(data, 'c2')
  startsAgents(data, clock)
  const calls = recordExec(data)

  const ui = await mount($)
  const before = await screen(ui)
  await ui.press({ key: `${PREFIX}open-pr` })
  const armed = labelOf(await ui.find({ key: `${PREFIX}open-pr` }))
  const afterOne = data.launches.length
  await ui.press({ key: `${PREFIX}open-pr` })
  await clock.settle()
  const after = await screen(ui)
  const feed = (await ui.findAll({ type: 'Text' })).find((n: any) => /Beta 派推送/.test(n.text))
  const p = promptOf(data)
  await ui.unmount()

  expect(before).toContain(flat('▶ 輪到你  按 ⇡ 開 PR 派 Agent push 並開 PR'))
  expect(armed).toContain('再按一次確認派 Agent 開 PR')
  expect(afterOne).toBe(0)
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].argv).not.toContain('--resume')
  expect(data.launches[0].init.cwd).toBe(BETA)
  expect(p.split('\n')[0]).toContain('推送：push feature/b 並對 release/v1.4 開 PR，PR 網址寫進歷程')
  expect(p).toContain('不 force push')
  expect(p).toContain('不合併 PR')
  expect(p).toContain('不打 tag')
  expect(after).toContain(flat('Agent 在 push、開 PR'))
  expect(feed).toBeDefined()
  expect(data.toasts.some(t => t.includes('Beta：推送已派出'))).toBe(true)
  // desk 自己不 push、不開 PR，也不預填輸入框
  expect(data.fills).toHaveLength(0)
  expect(wroteRemote(calls)).toBe(false)
})

/** AC-2 */
test('push buttons: push dispatches a publish agent that only pushes', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, { ahead: 2, changed: 3 })
  judgedAt(data, 'c2')
  startsAgents(data, clock)
  const calls = recordExec(data)

  const ui = await mount($)
  const push = await ui.find({ key: `${PREFIX}push` })
  const openPr = await has(ui, 'open-pr')
  await ui.press({ key: `${PREFIX}push` })
  const afterOne = data.launches.length
  await ui.press({ key: `${PREFIX}push` })
  await clock.settle()
  const p = promptOf(data)
  await ui.unmount()

  expect(labelOf(push)).toBe('⇡ push')
  expect(openPr).toBe(false)
  expect(afterOne).toBe(0)
  expect(data.launches).toHaveLength(1)
  expect(p.split('\n')[0]).toContain('推送：只 push feature/b（PR #12 已開，不開新 PR）')
  expect(p).not.toContain('並對 release/v1.4 開 PR')
  expect(p).not.toContain('開不了 PR')
  expect(p).toContain('不 force push')
  // 有未提交的檔案：照樣派（Agent 只推已 commit 的），並提醒
  expect(data.toasts.some(t => t.includes('有 3 檔未提交，只會 push 已 commit 的'))).toBe(true)
  expect(data.toasts.some(t => t.includes('目前無法推送') || t.includes('推送失敗'))).toBe(false)
  expect(data.toasts.some(t => t.includes('Beta：推送已派出'))).toBe(true)
  expect(data.fills).toHaveLength(0)
  expect(wroteRemote(calls)).toBe(false)
})

/** AC-3 */
test('push buttons: after publish the stage is merge', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, { upstream: false }, [])
  judgedAt(data, 'c2')
  // 這個對話自己的流程（會自動往下走的那種），而且還沒標過關：推送結束後流程也不能接著跑
  data.store.chains = { [BETA]: { owner: 'fixture-session', startedAt: 0, round: 0, reviewHead: 'c2', reviewBranch: 'feature/b', judgedHead: 'c2', judgedBranch: 'feature/b' } }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  startsAgents(data, clock)
  const step = async () => { await clock.advance(2500); await clock.settle() }

  const ui = await mount($)
  await ui.press({ key: `${PREFIX}open-pr` })
  await ui.press({ key: `${PREFIX}open-pr` })
  await clock.settle()
  const running = await screen(ui)
  // 推送做完：PR 開了、CI 在跑；分支推上去了
  data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
  data.gh = [{ ...OPEN_PR, statusCheckRollup: [{ conclusion: null, status: 'IN_PROGRESS' }] }]
  data.git[BETA] = { ...data.git[BETA]!, upstream: true, ahead: 0 }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await step(); await step(); await step()
  const pending = await screen(ui)
  // CI 過了：可以合併
  data.gh = [OPEN_PR]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await step(); await step()
  const ready = await screen(ui)
  const chain = (data.store.chains as any)[BETA]
  await ui.unmount()

  expect(running).toContain(flat('合併◆'))
  expect(pending).toContain(flat('規格● 實作● 檢查● 審查● 合併◉'))
  expect(pending).toContain(flat('PR 的 CI 在跑'))
  expect(ready).toContain(flat('規格● 實作● 檢查● 審查● 合併◆'))
  expect(ready).toContain(flat('▶ 輪到你  合併 PR #12（p 在瀏覽器開啟）；合併後打 tag 發版'))
  // 不跑檢查、不派審查或修正、不算修正輪、不停下流程
  expect(data.processCalls.filter((c: any) => c.argv[0] === 'sh')).toHaveLength(0)
  expect(data.launches).toHaveLength(1)
  expect(chain.round).toBe(0)
  expect(chain.stopped).toBeUndefined()
  expect(ready).not.toContain(flat('流程已暫停'))
  expect(ready).not.toContain(flat('推送失敗'))
})

/** 「有 n 檔未提交」只跟著真的派出去的 push：啟動失敗時不說，免得跟失敗訊息矛盾。 */
test('push buttons: the uncommitted reminder only follows a dispatched push', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, { ahead: 2, changed: 3 })
  judgedAt(data, 'c2')
  data.launch = async () => result(1, '', 'boom')

  const ui = await mount($)
  await ui.press({ key: `${PREFIX}push` })
  await ui.press({ key: `${PREFIX}push` })
  await clock.settle()
  await ui.unmount()

  expect(data.launches).toHaveLength(1)
  expect(data.toasts.some(t => t.includes('推送失敗'))).toBe(true)
  expect(data.toasts.some(t => t.includes('只會 push 已 commit 的'))).toBe(false)
})
