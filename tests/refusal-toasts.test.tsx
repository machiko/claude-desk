import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, NOW, REGISTRY, TRUSTED, result, text, flat, feedLog } from './fixture'
import { setFields, tutorialPaths, TUTORIAL_NAME } from '../hooks/tutorial'
import { DEMO_ONLY, decisionRefusal } from '../hooks/card-actions'

// 拒絕訊息寫原因與下一步（refusal-next-step）：面板按鍵、/desk 指令被拒或派工沒做成時，提示說為什麼、接著怎麼做。

const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
/** 「<任務>：無法<動作>（<原因>）；<下一步>」 */
const SHAPE = /^[^：]+：無法.+（.+）；.+$/
const SPEC = '\n\n## 規格\n\n- 目標：匯出 CSV\n\n### 驗收情境\n\n| # | 給定 | 當 | 則 | 對應測試 |\n| --- | --- | --- | --- | --- |\n| AC-1 | 有訂單 | 按匯出 | 下載 CSV | `export` |\n\n### 實作計畫\n\n| 檔案 | 改什麼 |\n| --- | --- |\n| `a.ts` | 加匯出 |\n'
const MISSING_NEXT = '開卡片（o）在「檢查」欄填一條修之前會紅、修好會綠的指令'
const screen = async (ui: any) => flat(text(await ui.drawn()))
const sh = (data: any) => data.processCalls.filter((c: any) => c.argv[0] === 'sh')
const registry = (rows: [string, string][]) => `## 任務\n| Project | path |\n| --- | --- |\n${rows.map(([n, p]) => `| ${n} | \`${p}\` |`).join('\n')}`
const run = async ($: any, clock: any, args: string) => { const out: any = await $.command.run({ command: 'desk', args } as any); await clock.settle(); return String(out?.text ?? '') }

/** 只留 Beta 一件：規格已填（有 AC-1 與計畫）、沒有 Agent 在跑；其他欄位由各測試決定。 */
function onlyBeta(data: any, fields: Record<string, string>) {
  data.agents = []
  data.gh = []
  data.files[REGISTRY] = registry([['Beta', CARD_B]])
  data.files[CARD_B] = setFields(data.files[CARD_B]!, { 下一步: '依規格實作', ...fields }) + SPEC
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
}

/** AC-1 */
test('spec refusal toast names the t key and the spec ok command', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, { 關卡: 'spec：待確認規格（AC-1）' })
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  await run($, clock, 'refresh')
  const ui = await $.ui.mount(PANE(100))
  // 面板此刻列得出 t（確認規格）與 o（開卡片）
  expect(await ui.find({ key: `case-${CARD_B}-spec-ok` })).toBeDefined()
  expect(await ui.find({ key: `case-${CARD_B}-open` })).toBeDefined()
  await ui.unmount()

  await run($, clock, 'go Beta')
  const said = 'Beta：無法繼續（規格還沒確認）；看過規格（o）後按 t 確認，或輸入 /desk:card spec beta ok'
  expect(data.toasts).toContain(said)
  expect(said).toMatch(SHAPE)
  expect(data.launches).toHaveLength(0)
})

/** AC-2 */
test('missing check refusal reads the same for g and v', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, { 驗證: '`<完成檢查：修之前會紅、修好會綠的一條指令>`' })
  await run($, clock, 'refresh')
  await run($, clock, 'go Beta')
  await run($, clock, 'verify Beta')
  await clock.advance(3000); await clock.settle()

  const go = 'Beta：無法繼續（卡片還沒有測試指令）；' + MISSING_NEXT
  const verify = 'Beta：無法執行測試（卡片還沒有測試指令）；' + MISSING_NEXT
  expect(data.toasts).toContain(go)
  expect(data.toasts).toContain(verify)
  for (const t of [go, verify]) expect(t).toMatch(SHAPE)
  for (const t of data.toasts) expect(t).not.toContain('規格未通過')
  // 下一步跟「輪到你」那句冒號後半一字不差
  const ui = await $.ui.mount(PANE(100))
  expect(await screen(ui)).toContain(flat('▶ 輪到你  o 開卡片填測試指令（卡片還沒有測試指令，在「檢查」欄填一條修之前會紅、修好會綠的指令）'))
  await ui.unmount()
  expect(data.launches).toHaveLength(0)
  expect(sh(data)).toHaveLength(0)
})

/** AC-4 */
test('launch failure toast trims the last error line and says how to retry', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  onlyBeta(data, {})
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  const long = 'x'.repeat(70) + '超過八十字的錯誤訊息尾巴'
  data.launch = async () => result(1, '', `第一行不顯示\n${long}`)
  await run($, clock, 'refresh')
  await run($, clock, 'go Beta')

  const shown = `${long.slice(0, 80)}…`
  const said = `無法派繼續（${shown}）；再按一次重試，一直失敗就到終端機跑 claude agents 看原因`
  expect(data.toasts).toContain(`Beta：${said}`)
  expect(data.toasts.some(t => t.includes('第一行不顯示') || t.includes(long))).toBe(false)
  // 動態與下一則對話提示寫同一句
  expect(log.list.some(e => e.text === `Beta ${said}`)).toBe(true)
  await $.prompt.submit({ text: '怎麼了？' } as any)
  expect((data.submitted.at(-1)?.context ?? []).join('\n')).toContain(`「Beta」${said}`)
})

/** AC-5 */
test('desk command lists task names when the name is unknown', async ($, on) => {
  const { data, clock } = fixture(on)
  await run($, clock, 'refresh')
  for (const verb of ['go', 'sync', 'review', 'reply', 'verify', 'open']) {
    expect(await run($, clock, `${verb} 不存在`)).toBe('找不到任務「不存在」；可用：Alpha、Beta、Gamma（任務名或其中一段）')
  }
  expect(data.launches).toHaveLength(0)

  // 一件都沒有：叫你開卡
  data.files[REGISTRY] = registry([])
  await run($, clock, 'refresh')
  expect(await run($, clock, 'go 不存在')).toBe('目前沒有任務，先用 /desk:card new 開卡')
})

/** AC-5：教學裡的示範任務不在名單上（指令找不到它們）。 */
test('desk command lists task names when the name is unknown — sample cases are left out', async ($, on) => {
  const { data, clock } = fixture(on)
  const P = tutorialPaths('/home/u')
  data.git[P.wt] = { branch: 'feature/discount', head: 'h0' }
  data.git[P.main] = { branch: 'release/v1.0', head: 'm0' }
  data.run = async () => result(0, '')
  await run($, clock, 'tutorial')
  const said = await run($, clock, 'go 不存在')
  expect(said).toBe(`找不到任務「不存在」；可用：${TUTORIAL_NAME}（任務名或其中一段）`)
  expect(said).not.toMatch(/部署流程改版|訂單匯出|會員登入改版|主工作區/)
})

/** AC-6：停止不是 desk 派的 Agent。 */
test('card action refusals end with a next step', async ($, on) => {
  const { data, clock } = fixture(on)
  // Beta 的 Agent 名字像 desk 派的，但這裡沒有它的派工紀錄（例如別台機器、或紀錄已清掉）
  data.agents = [{ ...data.agents[0], name: 'desk-other-0' }]
  await run($, clock, 'refresh')
  const ui = await $.ui.mount(PANE(100))
  await ui.press({ key: `row-${CARD_B}` })
  await ui.press({ key: `case-${CARD_B}-stop` })
  await ui.press({ key: `case-${CARD_B}-stop` })
  await clock.settle()
  expect(data.toasts).toContain('Beta：無法停止（desk-other-0 不是 desk 派的）；到終端機跑 claude stop bbbbbbbb')
  expect(data.stops).toHaveLength(0)
  await ui.unmount()
})

/** AC-6：決策已送出後面板收掉 f（按下時面板還沒重畫才會走到拒絕句，句子由下一支測試核對）。 */
test('card action refusals end with a next step — decision already sent', async ($, on) => {
  const { data, clock } = fixture(on)
  await run($, clock, 'refresh')
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `case-${CARD_A}-opt0A` })
  await ui.press({ key: `case-${CARD_A}-fill` })
  await $.prompt.submit({ text: data.fills[0].text } as any)
  await clock.settle()
  expect(await ui.find({ key: `case-${CARD_A}-fill` })).toBeUndefined()
  expect(await ui.find({ key: `case-${CARD_A}-open` })).toBeDefined()
  await ui.unmount()
})

/** AC-6：按 f 被擋下的三種，從送出決策後記下的那筆（同一個「等你」、還沒寫回）算出整句。 */
test('card action refusals end with a next step — decision refusals', () => {
  const ask = '要不要加快取：A) 加 B) 不加'
  const c = { demo: false, name: 'Alpha', ask, statusPath: '/w/a/.desk/CARD.md', state: 'ask' as const }
  const sent = { [c.statusPath]: { ask, during: 't1' } }
  expect(decisionRefusal(c, { 0: 'A' }, sent)).toBe('Alpha：決策已送出，等對話寫回卡片；這一回合結束沒寫回會再提示（可按 o 自己改「等你」）')
  expect(decisionRefusal(c, {}, {})).toBe('Alpha：請先完成每個決策的選擇（點選項或按選項字母；多題時用點的）')
  expect(decisionRefusal({ ...c, demo: true }, { 0: 'A' }, {})).toBe(DEMO_ONLY)
  // 回合結束已記下沒寫回（done）、或「等你」換了：不再擋，可以重新填入
  expect(decisionRefusal(c, { 0: 'A' }, { [c.statusPath]: { ask, done: true } })).toBeNull()
  expect(decisionRefusal(c, { 0: 'A' }, { [c.statusPath]: { ask: '舊的問題：A) 是 B) 否' } })).toBeNull()
})

/** AC-6：上線確認寫卡片失敗。 */
test('card action refusals end with a next step — ship write fails', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 驗證：無', '- 驗證：`npm test`').replace('- 關卡：無', '- 關卡：release：v0.2.0 待上線確認')
  data.git[GAMMA] = { branch: 'feature/c', head: 'h1', tag: 'v0.2.0' }
  // 寫 Gamma 的卡片時失敗（磁碟唯讀之類）：fixture 的 fs.write 照常存進 data.files，這裡讓那一筆存不進去
  const files = data.files
  data.files = new Proxy(files, { set: (t, k, v) => { if (k === CARD_C && v !== t[CARD_C]) throw new Error('EACCES: permission denied'); t[k as string] = v; return true } })
  await run($, clock, 'refresh')
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_C}` })
  await ui.press({ key: `case-${CARD_C}-ship` })
  await ui.press({ key: `case-${CARD_C}-ship` })
  await clock.settle()
  const said = data.toasts.find(t => t.startsWith('Gamma：無法確認上線（寫入卡片失敗：'))
  expect(said).toBeDefined()
  expect(said!).toMatch(/^Gamma：無法確認上線（寫入卡片失敗：.+）；關卡沒清，修好檔案後再按 u$/)
  expect(data.files[CARD_C]).toContain('- 關卡：release：')
  await ui.unmount()
})

/** AC-6：測試在跑時再按 v、測試已排隊時再按 v。 */
test('card action refusals end with a next step — test running or queued', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  data.store.trustedVerify = { ...TRUSTED }
  let release: (() => void) | null = null
  data.run = (e: any) => e.argv[0] === 'sh' ? new Promise(resolve => { release = () => resolve(result(0, 'ok\n')) }) : Promise.resolve(result(0, ''))
  await run($, clock, 'refresh')
  void $.command.run({ command: 'desk', args: 'verify Alpha' } as any)
  await clock.settle()
  await run($, clock, 'verify Beta')
  const ui = await $.ui.mount(PANE(100))
  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: `case-${CARD_A}-verify` })
  await clock.settle()
  await ui.press({ key: `row-${CARD_B}` })
  await ui.press({ key: `case-${CARD_B}-verify` })
  await clock.settle()
  expect(data.toasts).toContain('Alpha：測試在跑；跑完結果會列在測試列')
  expect(data.toasts).toContain('Beta：測試已排隊；前面跑完自動開始')
  expect(sh(data)).toHaveLength(1)
  release!()
  await clock.settle()
  await ui.unmount()
})

/** AC-6：額度煞車擋在派驗收前、按 g 接續，但驗收沒派出（啟動失敗）。 */
test('card action refusals end with a next step — quota resume not sent', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  data.gh = []
  data.files[REGISTRY] = registry([['Beta', CARD_B]])
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 下一步：依審核修正', '- 下一步：等驗收')
  data.git[BETA] = { branch: 'feature/b', head: 'c2', files: ['src/app.ts'] }
  data.store.trustedVerify = { [CARD_B]: 'npm test' }
  data.store.verifies = { [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' } }
  data.store.chains = { [BETA]: { owner: 'fixture-session', startedAt: 0, round: 0 } }
  data.store.jobs = { [BETA]: { sessionId: 'r0000001-0000-4000-8000-000000000000', mark: '', last: { launchName: 'desk-old-0', nativeId: 'r0000001', sessionId: 'r0000001-0000-4000-8000-000000000000', kind: 'continue', startedAt: 0, fresh: false, owner: 'fixture-session', ended: { how: 'finished' } } } }
  data.usage = { ...data.usage, rateLimits: [{ kind: 'five_hour', percentUsed: 75, resetsAt: new Date(NOW + 2.5 * 3_600_000).toISOString() }] }
  data.launch = async () => result(1, '', 'not logged in')
  await run($, clock, 'refresh')
  await clock.advance(2500); await clock.settle()
  expect((data.store.chains as any)[BETA].resume).toEqual({ dispatch: 'review', round: 0 })
  await run($, clock, 'refresh')

  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `case-${CARD_B}-continue` }); await clock.settle()
  await ui.press({ key: `case-${CARD_B}-continue` }); await clock.settle()
  await ui.unmount()
  expect(data.toasts).toContain('Beta：驗收沒派出（啟動中或啟動失敗）；流程照原因停著，稍後再按 g')
  expect((data.store.chains as any)[BETA].stopped).toBeDefined()
})
