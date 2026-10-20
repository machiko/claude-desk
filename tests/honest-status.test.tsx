import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, REGISTRY, leaves, text } from './fixture'
import { gitLine, parseGitStatus } from '../hooks/extras'
import { checkStands } from '../hooks/pipeline'

const BETA = '/home/u/wt/beta'
const PREFIX = `case-${CARD_B}-`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 2；可合併'
const UNAUTHORIZED = '完成檢查尚未授權：請先按 v 執行一次，之後才會自動執行'
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
  expect(moved).not.toContain(flat('push 分支並開 PR'))
  expect(same).toContain(flat('▶ 輪到你  push 分支並開 PR'))
  expect(same).not.toContain(flat('審查後有新 commit'))
  expect(legacy).toContain(flat('▶ 輪到你  push 分支並開 PR'))
  expect(legacy).not.toContain(flat('審查後有新 commit'))
  expect(checkStands({ verify: 'npm test', git }, oldCheck)).toBe(true)
  expect(checkStands({ verify: 'npm test', git }, { ...oldCheck, head: 'c1' })).toBeNull()
  await ui.unmount()
})

/** AC-5 */
test('a stopped chain shows its reason and the key to press instead of the next stage', async ($, on) => {
  const { data } = fixture(on)
  onlyBeta(data)
  data.store.chains = { [BETA]: { owner: 'other-session', startedAt: 0, round: 0, stopped: UNAUTHORIZED } }

  const ui = await mount($)
  const shown = await screen(ui)
  const verify = await ui.find({ key: `${PREFIX}verify` })

  expect(shown).toContain(flat(`▶ 輪到你  接力已暫停（${UNAUTHORIZED}）`))
  expect(shown).toContain(flat('實作● 檢查✕ 審查'))
  expect(shown).not.toContain(flat('push 分支並開 PR'))
  expect(shown).not.toContain(flat('✓ 完成'))
  expect(leaves(verify, 'Text').some((t: any) => t.props?.bold)).toBe(true)
  await ui.unmount()
})
