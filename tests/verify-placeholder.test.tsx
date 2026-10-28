import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, REGISTRY, text, flat } from './fixture'
import { setFields } from '../hooks/tutorial'

// 檢查欄不是一條可執行指令（範本佔位、說明文字）時，當作缺完成檢查：不派實作、不執行它，輪到你直說缺什麼。
const BETA = '/home/u/wt/beta'
const PLACEHOLDER = '`<完成檢查：修之前會紅、修好會綠的一條指令>`'
const PROSE = '`待 spec 定，先不跑`'
const MISSING_TURN = '卡片尚缺完成檢查：開卡片（o）在「檢查」欄填一條修之前會紅、修好會綠的指令'
const REFUSED = 'Beta：目前無法繼續（卡片尚缺完成檢查，規格未通過）'
const SPEC = '\n\n## 規格\n\n- 目標：匯出 CSV\n\n### 驗收情境\n\n| # | 給定 | 當 | 則 | 對應測試 |\n| --- | --- | --- | --- | --- |\n| AC-1 | 有訂單 | 按匯出 | 下載 CSV | `export` |\n\n### 實作計畫\n\n| 檔案 | 改什麼 |\n| --- | --- |\n| `a.ts` | 加匯出 |\n'
const screen = async (ui: any) => flat(text(await ui.drawn()))
const sh = (data: any) => data.processCalls.filter((c: any) => c.argv[0] === 'sh')

/** 只留 Beta 一件：規格已填（有 AC-1 與計畫）、關卡無、下一步有事、沒有 Agent 在跑；檢查欄由各測試決定。 */
function onlyBeta(data: any, check: string) {
  data.agents = []
  data.gh = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = setFields(data.files[CARD_B]!, { 驗證: check, 下一步: '依規格實作' }) + SPEC
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
}

/** 重新整理、派實作（/desk go）、跑檢查（/desk verify）：三件都不該發生。 */
async function expectNoCheck($: any, data: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(100))
  const s = await screen(ui)
  expect(s).toContain(flat('尚缺完成檢查'))
  expect(s).toContain(flat(MISSING_TURN))
  expect(s).not.toContain(flat('按 g 派 Agent'))
  expect(await ui.find({ key: `case-${CARD_B}-verify` })).toBeUndefined()
  await ui.unmount()

  await $.command.run({ command: 'desk', args: 'go Beta' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(0)
  expect(data.asks).toHaveLength(0)
  expect(data.toasts.some((t: string) => t.includes(REFUSED))).toBe(true)

  await $.command.run({ command: 'desk', args: 'verify Beta' } as any)
  await clock.settle(); await clock.advance(3000); await clock.settle()
  expect(sh(data)).toHaveLength(0)
  expect(data.toasts.some((t: string) => t.includes('Beta：卡片尚缺完成檢查'))).toBe(true)
}

/** AC-1 */
test('placeholder check: a <…> placeholder in backticks is no check', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, PLACEHOLDER)
  await expectNoCheck($, data, clock)
})

/** AC-2 */
test('placeholder check: prose inside backticks is no check', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, PROSE)
  await expectNoCheck($, data, clock)
})

/** AC-4 */
test('placeholder check: a real command still dispatches and runs', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, '`npm test`')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(100))
  const s = await screen(ui)
  expect(s).toContain(flat('按 g 派 Agent：依規格實作'))
  expect(s).not.toContain(flat('尚缺完成檢查'))
  await ui.unmount()

  await $.command.run({ command: 'desk', args: 'verify Beta' } as any)
  await clock.settle(); await clock.advance(3000); await clock.settle()
  const runs = sh(data)
  expect(runs).toHaveLength(1)
  expect(runs[0].argv).toEqual(['sh', '-c', 'npm test'])
  expect(runs[0].init.cwd).toBe(BETA)
})

/** AC-5 */
test('placeholder check: a legacy CARD 驗證 field follows the same rule', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, PLACEHOLDER)
  data.files[CARD_B] = `<!-- CARD: 說明 -->\n- 更新：2026-10-16 10:00 · rev 3\n- 狀態：舊卡\n- 驗證：${PLACEHOLDER}\n- 等使用者：無\n- 下一步：依規格實作\n- 關卡：無\n<!-- /CARD -->`
  await expectNoCheck($, data, clock)
})
