import { expect, test } from 'claude-code/testing'
import { fixture, CARD_A, CARD_B, PANE, REGISTRY, result } from './fixture'

const opener = (os: string) => async (e: any) => e.argv[0] === 'uname' ? result(0, `${os}\n`) : result(0, '')

test('macOS opens the card with open', async ($, on) => {
  const { data } = fixture(on)
  data.run = opener('Darwin')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'open Alpha' } as any)
  expect(data.processCalls.map(c => c.argv).filter(a => a[0] !== 'uname')).toEqual([['open', CARD_A]])
})

test('Linux opens the card with xdg-open', async ($, on) => {
  const { data } = fixture(on)
  data.run = opener('Linux')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'open Alpha' } as any)
  expect(data.processCalls.map(c => c.argv).filter(a => a[0] !== 'uname')).toEqual([['xdg-open', CARD_A]])
})

test('a failed open says so', async ($, on) => {
  const { data } = fixture(on)
  data.run = async (e: any) => e.argv[0] === 'uname' ? result(0, 'Linux\n') : result(3, '', 'xdg-open: no method available')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'open Alpha' } as any)
  // refusal-next-step AC-6：說開不了哪個檔、接著怎麼辦
  expect(data.toasts).toContain(`Alpha：無法開啟卡片（${CARD_A}）；用編輯器自己開，或核對登錄表的路徑`)
})

const BETA = '/home/u/wt/beta'
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；可合併'

/** 只留 Beta 一件：審查與檢查都在 c2 過關、沒有 PR、從沒 push 過；卡片的基準欄由呼叫端給（空字串＝舊卡）。 */
function betaAtMerge(data: any, baseLine: string, git: Record<string, unknown> = {}) {
  data.agents = []
  data.gh = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', `${PASSED}${baseLine}`)
  data.git[BETA] = { branch: 'feature/b', head: 'c2', remote: 'git@github.com:acme/shop.git', upstream: false, ...git }
  data.store.chains = { [BETA]: { owner: 'other-session', startedAt: 0, round: 0, passed: true, reviewHead: 'c2', judgedHead: 'c2' } }
  data.store.verifies = { [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' } }
}

async function pressOpenPr($: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(100))
  await ui.press({ key: `case-${CARD_B}-open-pr` })
  await ui.press({ key: `case-${CARD_B}-open-pr` })
  await clock.settle()
  await ui.unmount()
}
const promptOf = (data: any) => String(data.launches[0].argv[data.launches[0].argv.length - 1])

/** card-base-and-fast-path AC-2：origin 最新的 release 線是 v1.4，卡片記的基準是 v1.3。 */
test('open PR targets card base', async ($, on) => {
  const { data, clock } = fixture(on)
  betaAtMerge(data, '\n- 基準：origin/release/v1.3')

  await pressOpenPr($, clock)

  expect(data.launches).toHaveLength(1)
  const p = promptOf(data)
  expect(p.split('\n')[0]).toContain('推送：push feature/b 並對 release/v1.3 開 PR')
  expect(p).toContain('`gh pr create --base release/v1.3 --head feature/b`')
  expect(p).not.toContain('release/v1.4')
})

/** card-base-and-fast-path AC-6：舊卡沒有基準欄，照舊對最新的 release 線開 PR。 */
test('open PR without card base keeps the newest release line', async ($, on) => {
  const { data, clock } = fixture(on)
  betaAtMerge(data, '')

  await pressOpenPr($, clock)

  expect(promptOf(data)).toContain('`gh pr create --base release/v1.4 --head feature/b`')
})

/** card-base-and-fast-path 審查 HIGH：基準欄記的分支已經不在（例如疊放卡的原卡合併後刪掉），開 PR 不對它開、照舊順序找。 */
test('open PR skips a card base that no longer exists', async ($, on) => {
  const { data, clock } = fixture(on)
  betaAtMerge(data, '\n- 基準：feature/a', { missingRefs: ['feature/a'] })

  await pressOpenPr($, clock)

  const p = promptOf(data)
  expect(p).toContain('`gh pr create --base release/v1.4 --head feature/b`')
  expect(p).not.toContain('--base feature/a')
})
