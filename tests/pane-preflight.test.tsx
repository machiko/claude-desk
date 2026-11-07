import { expect, test } from 'claude-code/testing'
import { fixture, text, PANE, CARD_B, REGISTRY, flat } from './fixture'
import { screen } from './world'
import { COLOR } from '../hooks/theme'

const BETA = '/home/u/wt/beta'
const REVIEW = `${BETA}/.task/REVIEW.md`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'

/** 內容是這段字的 Text（「前置」列的內容那一格）。 */
const cell = async (ui: any, s: string) => (await ui.findAll({ type: 'Text' })).find((n: any) => String(n.text ?? '') === s)

/** 只留 Beta 一件、審查過關、有 git 分支；審查檔由呼叫端給（undefined 是沒有檔案）。 */
function reviewedBeta(data: any, review?: string) {
  data.agents = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 關卡：.*$/m, PASSED)
  data.git[BETA] = { branch: 'feature/b', head: 'b1' }
  if (review === undefined) delete data.files[REVIEW]
  else data.files[REVIEW] = review
}

async function mount($: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(100))
  if (await ui.find({ key: `row-${CARD_B}` })) await ui.press({ key: `row-${CARD_B}` })
  return ui
}

/** AC-1 */
test('test_preflight_row_shows_success_counts', async ($, on) => {
  const { data, clock } = fixture(on)
  reviewedBeta(data, '前置：成功，候選 5 條，採用 2 條\n# 審查\n- [LOW][風格] x.ts:1 — 縮排\n')
  let ui = await mount($, clock)
  const s = await screen(ui)
  const row = flat('前置成功，候選 5 條，採用 2 條')
  expect(s).toContain(row)
  // 在狀態列、git 列之後
  expect(s.indexOf(flat('狀態Beta 修正中'))).toBeGreaterThan(-1)
  expect(s.indexOf(flat('gitfeature/b'))).toBeGreaterThan(-1)
  expect(s.indexOf(row)).toBeGreaterThan(s.indexOf(flat('狀態Beta 修正中')))
  expect(s.indexOf(row)).toBeGreaterThan(s.indexOf(flat('gitfeature/b')))
  expect((await cell(ui, '成功，候選 5 條，採用 2 條'))?.props?.color).toBe(COLOR.dim)
  await ui.unmount()

  // 候選 0 條、採用 0 條也照樣顯示
  data.files[REVIEW] = '前置：成功，候選 0 條，採用 0 條\n# 審查\n'
  ui = await mount($, clock)
  expect(await screen(ui)).toContain(flat('前置成功，候選 0 條，採用 0 條'))
  await ui.unmount()
})

/** AC-2 */
test('test_preflight_row_shows_failure_reason', async ($, on) => {
  const { data, clock } = fixture(on)
  reviewedBeta(data, '前置：失敗（找不到指令 agy-review）\n# 審查\n')
  const ui = await mount($, clock)
  const s = await screen(ui)
  expect(s).toContain(flat('前置失敗（找不到指令 agy-review）'))
  expect((await cell(ui, '失敗（找不到指令 agy-review）'))?.props?.color).toBe(COLOR.attention)
  // 其餘列照舊
  expect(s).toContain(flat('狀態Beta 修正中'))
  expect(s).toContain(flat('gitfeature/b'))
  await ui.unmount()
})

/** AC-3 */
test('test_preflight_row_hidden_without_preflight_line', async ($, on) => {
  const { data, clock } = fixture(on)
  const findings = '- [HIGH][稽核] hooks/a.ts:1 — 漏寫稽核紀錄\n'

  // 基準：既有格式的審查檔（第一行「# 審查」）—（b）
  reviewedBeta(data, `# 審查\n${findings}`)
  let ui = await mount($, clock)
  const baseline = await screen(ui)
  expect(baseline).not.toContain(flat('前置'))
  expect(baseline).toContain(flat('狀態Beta 修正中'))
  expect(baseline).toContain(flat('驗收HIGH 稽核 hooks/a.ts:1'))
  await ui.unmount()

  // （c）「前置：…」在第二行：畫面跟基準完全相同
  data.files[REVIEW] = `# 審查\n前置：成功，候選 5 條，採用 2 條\n${findings}`
  ui = await mount($, clock)
  expect(await screen(ui)).toBe(baseline)
  await ui.unmount()

  // （a）沒有審查檔：沒有前置列，也沒有審查列，狀態列照舊
  reviewedBeta(data, undefined)
  ui = await mount($, clock)
  const s = await screen(ui)
  expect(s).not.toContain(flat('前置'))
  expect(s).not.toContain(flat('HIGH 稽核'))
  expect(s).toContain(flat('狀態Beta 修正中'))
  await ui.unmount()
})
