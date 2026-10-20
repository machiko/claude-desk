import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, REGISTRY, result, text } from './fixture'
import { appendTo, setFields } from '../hooks/tutorial'
import { awaitsSpecOk } from '../hooks/pipeline'
import { stageActions } from '../hooks/turn'

const BETA = '/home/u/wt/beta'
const KEY = `case-${CARD_B}-spec-ok`
const SPEC_GATE = '- 關卡：spec：待確認規格（AC-1～AC-2）'
const CONFIRMED = '規格已確認（AC-1～AC-2），可派實作'
// 輪到你那一句會依欄寬換行：去掉空白後比對，不管斷在哪裡。
const flat = (x: string) => x.replace(/\s+/g, '')
const screen = async (ui: any) => flat(text(await ui.drawn()))
const specRuns = (data: any) => data.processCalls.filter((c: any) => c.argv.includes('spec-ok'))

/** 只留 Beta 一件，停在 spec 關卡，沒有 Agent 在跑。 */
function onlySpec(data: any) {
  data.agents = []
  data.files[REGISTRY] = `## 案子\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', SPEC_GATE) + '\n\n## Decisions\n\n- D-01 2030-01-05 Alex：只匯出 CSV\n\n## History\n\n- 2030-01-05：產生規格草稿\n'
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
  data.gh = []
}

/** /desk:card spec-ok 是真的腳本（skills/card/tests 驗它）；這裡照它的效果改卡片。 */
function scriptOk(data: any) {
  data.run = async (e: any) => {
    if (!e.argv.includes('spec-ok')) return result(0, '')
    const withGate = setFields(data.files[CARD_B]!, { 關卡: '無', 狀態: CONFIRMED })
    data.files[CARD_B] = appendTo(appendTo(withGate, '## Decisions', '- D-02 2030-01-05 Alex：確認規格（AC-1～AC-2，共 2 條）'), '## History', '- 2030-01-05：規格確認，關卡清為無，可派實作')
    return result(0, `規格已確認（AC-1～AC-2），關卡清為「無」：${CARD_B}\n`)
  }
}

test('a real case waiting on its spec offers t to confirm it', async ($, on) => {
  const { data } = fixture(on)
  onlySpec(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  const button = await ui.find({ key: KEY })
  expect(button?.text).toBe('✓ 確認規格')
  expect(button?.props?.hotkey).toBe('t')
  expect(button?.props?.variant).toBe('primary')
  expect(await screen(ui)).toContain(flat('▶ 輪到你'))
  expect(await screen(ui)).toContain(flat('看過規格（o 開卡片）後按 t 確認（或輸入 /desk:card spec beta ok）'))
  await ui.unmount()
})

test('pressing t twice confirms the spec like /desk:card spec ok and launches nothing', async ($, on) => {
  const { data, clock } = fixture(on)
  onlySpec(data)
  scriptOk(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  const before = data.files[CARD_B]
  await ui.press({ key: KEY })
  await clock.settle()
  expect((await ui.find({ key: KEY }))?.text).toBe('再按 t 確認規格')
  expect(data.files[CARD_B]).toBe(before)
  expect(specRuns(data)).toHaveLength(0)

  await ui.press({ key: KEY })
  await clock.settle()
  // 跑的是 /desk:card spec <slug> ok 用的那支腳本，在案子的 worktree 裡
  const run = specRuns(data)
  expect(run).toHaveLength(1)
  expect(run[0].argv[0]).toBe('python3')
  expect(String(run[0].argv[1]).endsWith('/skills/card/scripts/card.py')).toBe(true)
  expect(run[0].argv.slice(2)).toEqual(['spec-ok', 'beta'])
  expect(run[0].init.cwd).toBe(BETA)
  expect(data.files[CARD_B]).toContain('- 關卡：無')
  expect(data.files[CARD_B]).toContain(`- 狀態：${CONFIRMED}`)
  expect(data.files[CARD_B]).toContain('- D-02 2030-01-05 Alex：確認規格（AC-1～AC-2，共 2 條）')
  expect(data.files[CARD_B]).toContain('- 2030-01-05：規格確認，關卡清為無，可派實作')

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(await screen(ui)).toContain(flat('Beta 規格已確認，可以派實作'))
  expect(await screen(ui)).toContain(flat('按 g 派 Agent：依審核修正'))
  expect(await ui.find({ key: KEY })).toBeUndefined()
  expect(data.launches).toHaveLength(0)
  await ui.unmount()
})

test('a failed spec confirmation shows the error and keeps the spec gate', async ($, on) => {
  const { data, clock } = fixture(on)
  onlySpec(data)
  data.run = async (e: any) => e.argv.includes('spec-ok')
    ? result(1, '', '關卡不是 spec：…（目前是「無」），不動卡片\n')
    : result(0, '')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: KEY })
  await ui.press({ key: KEY })
  await clock.settle()
  expect(specRuns(data)).toHaveLength(1)
  expect(data.toasts.some(t => t.includes('確認規格失敗') && t.includes('關卡不是 spec：…（目前是「無」），不動卡片'))).toBe(true)
  const feed = (await ui.findAll({ type: 'Text' })).find((n: any) => /Beta 確認規格失敗/.test(n.text) && n.props?.color === 'error')
  expect(feed).toBeDefined()
  expect(data.files[CARD_B]).toContain(SPEC_GATE)
  expect((await ui.find({ key: KEY }))?.text).toBe('✓ 確認規格')
  expect(data.launches).toHaveLength(0)
  await ui.unmount()
})

test('t does nothing outside the spec gate, while an agent runs, or on sample cases', async ($, on) => {
  const { data, clock } = fixture(on)
  const tButtons = async (ui: any) => (await ui.findAll({ type: 'Button' })).filter((b: any) => b.props?.hotkey === 't')
  const noSpecOk = async (ui: any) => {
    expect(await tButtons(ui)).toHaveLength(0)
    // 展開全部動作也一樣沒有
    await ui.press({ key: 'more' })
    expect(await tButtons(ui)).toHaveLength(0)
    await ui.press({ key: 'more' })
  }
  onlySpec(data)
  const cards = { build: data.files[CARD_B]!.replace(SPEC_GATE, '- 關卡：無'), review: data.files[CARD_B]!.replace(SPEC_GATE, '- 關卡：review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；修'), spec: data.files[CARD_B]! }
  const before = { ...data.files }

  // spec 關卡但 Agent 在跑
  data.agents = [{ id: 'bbbbbbbb', kind: 'background', cwd: BETA, state: 'working', status: 'busy', name: 'beta-agent', sessionId: 'bbbbbbbb-0000-4000-8000-000000000000', startedAt: 0 }]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  let ui = await $.ui.mount(PANE(80))
  expect(await screen(ui)).toContain(flat('Agent 在寫程式'))
  await noSpecOk(ui)
  await ui.unmount()
  data.agents = []

  // 實作段、審查段
  for (const card of [cards.build, cards.review]) {
    data.files[CARD_B] = card
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    const ui = await $.ui.mount(PANE(80))
    await noSpecOk(ui)
    await ui.unmount()
  }
  // 已上線
  data.files[CARD_B] = cards.build.replace('- 狀態：Beta 修正中', '- 狀態：v0.2.0 已上線（工作桌確認）')
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', '- 關卡：release：v0.2.0 待上線確認')
  data.git[BETA] = { ...data.git[BETA]!, tag: 'v0.2.0' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  ui = await $.ui.mount(PANE(80))
  await noSpecOk(ui)
  await ui.unmount()
  await clock.settle()

  // 示範案子：停在 spec 關卡也不提供
  const demo: any = { demo: true, state: 'gate', gate: 'spec：待確認規格', pipeline: { current: 'spec', stages: [], note: '' } }
  expect(awaitsSpecOk(demo)).toBe(false)
  expect(stageActions(demo).has('spec-ok')).toBe(false)
  expect(awaitsSpecOk({ ...demo, demo: false })).toBe(true)
  expect(stageActions({ ...demo, demo: false } as any).has('spec-ok')).toBe(true)
  expect(stageActions({ ...demo, demo: false } as any, { tutorial: true }).has('spec-ok')).toBe(false)

  expect(specRuns(data)).toHaveLength(0)
  expect(data.writes).not.toContain(CARD_B)
  expect(data.files[REGISTRY]).toBe(before[REGISTRY])
})

test('help lists t for confirming the spec in real mode and for the tutorial step', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(120))
  await ui.press({ key: 'help' })
  expect(await screen(ui)).toContain(flat('確認規格（按兩次）；教學模式的下一步'))
  await ui.unmount()
})
