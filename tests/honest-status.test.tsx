import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, REGISTRY, leaves, text } from './fixture'
import { gitLine, parseGitStatus } from '../hooks/extras'
import { checkStands, pipeline, stageLabel } from '../hooks/pipeline'
import { buildCase } from '../hooks/model'
import type { Case, Verify } from '../types'

const BETA = '/home/u/wt/beta'
const PREFIX = `case-${CARD_B}-`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 2；可合併'
const UNAPPROVED = '完成檢查的指令改過、還沒經你核准：按 v 看指令並核准，核准後流程接著走'
const flat = (x: string) => x.replace(/\s+/g, '')
const screen = async (ui: any) => flat(text(await ui.drawn()))

/** 只留 Beta 一件：審查過關、沒有 PR、沒有 Agent 在跑；接力是別的對話開的，不會自動派工。 */
function onlyBeta(data: any, git: Record<string, unknown> = {}) {
  data.agents = []
  data.gh = []
  data.files[REGISTRY] = `## 案子\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED)
  data.git[BETA] = { branch: 'feature/b', head: 'c2', remote: 'git@github.com:acme/shop.git', ...git }
}

/** desk 派的審查在 head 判定過關，檢查也在 head 跑過。 */
function judgedAt(data: any, head: string) {
  data.store.chains = { [BETA]: { owner: 'other-session', startedAt: 0, round: 0, passed: true, reviewHead: head, judgedHead: head } }
  data.store.verifies = { [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head } }
}

const checkAt = (head: string): Verify => ({ command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head })

/** 六段現在那一段與它的註記（面板不畫註記，只在狀態列用 stageLabel 顯示）：Beta 審查過關、HEAD 在 c2。 */
function noteOf(chain: Case['chain'], v?: Verify): string {
  const card = `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：開 PR\n${PASSED}\n<!-- /DESK -->`
  const c: Case = { ...buildCase({ name: 'Beta', statusPath: CARD_B }, card, 1, {}, undefined), git: { branch: 'feature/b', head: 'c2' }, chain }
  return stageLabel(pipeline(c, v))
}

async function mount($: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  return $.ui.mount(PANE(100))
}

async function refreshed($: any, ui: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  return screen(ui)
}

/** AC-1 */
test('git line says not pushed when the branch has no upstream', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data, { upstream: false })
  judgedAt(data, 'c2')

  const ui = await mount($)
  const never = await screen(ui)
  data.git[BETA]!.upstream = true
  const pushed = await refreshed($, ui)

  expect(never).toContain(flat('feature/b · 未 push（沒有遠端分支）'))
  expect(never).not.toContain(flat('與遠端一致'))
  expect(pushed).toContain(flat('feature/b · 與遠端一致、無未提交變更'))
  expect(gitLine(parseGitStatus('# branch.oid c2\n# branch.head feature/b\n1 .M N... 100644 100644 100644 a b x.ts\n'))).toBe('未 push（沒有遠端分支） · 未提交 1 檔')
  await ui.unmount()
})

/** AC-2 */
test('a new commit after review sends the case back to check, while old branch-name records stay valid', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data, { head: 'c2' })
  judgedAt(data, 'c1')

  const ui = await mount($)
  const moved = await screen(ui)
  data.git[BETA]!.head = 'c1'
  const same = await refreshed($, ui)
  // 修正前留下的審查紀錄存的是分支名稱：沒有 commit 可比，當作仍有效
  data.store.chains = { [BETA]: { owner: 'other-session', startedAt: 0, round: 0, passed: true, reviewHead: 'feature/b', judgedHead: 'feature/b' } }
  const legacy = await refreshed($, ui)
  const git = { branch: 'feature/b', head: 'c9' }
  const oldCheck = { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'feature/b' }

  expect(moved).toContain(flat('▶ 輪到你  審查後有新 commit：按 v 重新執行完成檢查'))
  expect(moved).toContain(flat('實作● 檢查◆'))
  expect(noteOf({ round: 0, passed: true, stale: true }, checkAt('c1'))).toBe('檢查・審查後有新 commit，需重新檢查')
  expect(moved).not.toContain(flat('push 分支並開 PR'))
  expect(same).toContain(flat('▶ 輪到你  push 分支並開 PR'))
  expect(same).not.toContain(flat('審查後有新 commit'))
  expect(legacy).toContain(flat('▶ 輪到你  push 分支並開 PR'))
  expect(legacy).not.toContain(flat('審查後有新 commit'))
  expect(noteOf({ round: 0, passed: true }, checkAt('feature/b'))).toBe('合併・可開 PR')
  expect(checkStands({ verify: 'npm test', git }, oldCheck)).toBe(true)
  expect(checkStands({ verify: 'npm test', git }, { ...oldCheck, head: 'c1' })).toBeNull()
  await ui.unmount()
})

/** AC-3 */
test('the merge stage offers an open-PR button that only fills the prompt', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data)
  judgedAt(data, 'c2')
  const calls: any[] = []
  data.exec = (e: any) => { calls.push(e); return null }

  const ui = await mount($)
  const button = await ui.find({ key: `${PREFIX}open-pr` })
  await ui.press({ key: `${PREFIX}open-pr` })
  data.fillable = false
  await ui.press({ key: `${PREFIX}open-pr` })

  expect(button?.text || button?.props?.label).toBe('⇡ 開 PR')
  expect(data.fills).toEqual([
    { text: 'push feature/b 並對 release/v1.4 開 PR', mode: 'replace' },
    { text: 'push feature/b 並對 release/v1.4 開 PR', mode: 'replace' },
  ])
  expect(data.submitted).toHaveLength(0)
  expect(data.toasts.some(t => t.includes('輸入框無法預填') && t.includes('push feature/b 並對 release/v1.4 開 PR'))).toBe(true)
  expect(calls.some(e => e.argv[0] === 'git' && e.argv.includes('push'))).toBe(false)
  expect(calls.some(e => e.argv[0] === 'gh' && e.argv.includes('create'))).toBe(false)
  await ui.unmount()
})

/** AC-4 */
test('a verdict the agent wrote itself counts but is marked self-review with w offered', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data)
  // 完全沒有接力紀錄（結論是在別的對話寫進卡片的），或這次接力只有派實作（g）：都不是 desk 派的審查
  data.store.verifies = { [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' } }

  const ui = await mount($)
  const noChain = await screen(ui)
  const noChainW = await ui.find({ key: `${PREFIX}review` })
  data.store.chains = { [BETA]: { owner: 'other-session', startedAt: 0, round: 0 } }
  const self = await refreshed($, ui)
  const selfW = await ui.find({ key: `${PREFIX}review` })
  judgedAt(data, 'c2')
  const independent = await refreshed($, ui)
  const independentW = await ui.find({ key: `${PREFIX}review` })

  expect(noChain).toContain(flat('push 分支並開 PR（審查是自審，可按 w 派獨立審查）'))
  expect(noChain).toContain(flat('◆ 審查  CRITICAL 0、HIGH 0、MEDIUM 0、LOW 2；可合併（自審）'))
  expect(noChainW?.props?.hotkey).toBe('w')
  expect(self).toContain(flat('規格● 實作● 檢查● 審查● 合併◆'))
  expect(self).toContain(flat('push 分支並開 PR（審查是自審，可按 w 派獨立審查）'))
  expect(self).toContain(flat('◆ 審查  CRITICAL 0、HIGH 0、MEDIUM 0、LOW 2；可合併（自審）'))
  expect(noteOf({ round: 0, selfReview: true }, checkAt('c2'))).toBe('合併・可開 PR（自審）')
  expect(selfW?.props?.hotkey).toBe('w')
  expect(independent).toContain(flat('◆ 審查  CRITICAL 0、HIGH 0、MEDIUM 0、LOW 2；可合併'))
  expect(independent).not.toContain(flat('自審'))
  expect(noteOf({ round: 0, passed: true }, checkAt('c2'))).toBe('合併・可開 PR')
  expect(independentW).toBeUndefined()
  await ui.unmount()
})

/** AC-5 */
test('a stopped chain shows its reason and the key to press instead of the next stage', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data)
  data.store.chains = { [BETA]: { owner: 'other-session', startedAt: 0, round: 0, stopped: UNAPPROVED, heldAtCheck: true } }

  const ui = await mount($)
  const shown = await screen(ui)
  const verify = await ui.find({ key: `${PREFIX}verify` })

  expect(shown).toContain(flat(`▶ 輪到你  ${UNAPPROVED}`))
  expect(shown).toContain(flat('實作● 檢查✕ 審查'))
  expect(noteOf({ round: 0, stopped: UNAPPROVED })).toBe(`檢查・${UNAPPROVED}`)
  expect(shown).not.toContain(flat('push 分支並開 PR'))
  expect(shown).not.toContain(flat('✓ 完成'))
  expect(leaves(verify, 'Text').some((t: any) => t.props?.bold)).toBe(true)
  await ui.unmount()
})
