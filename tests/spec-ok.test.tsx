import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, REGISTRY, result, text, flat, feedLog } from './fixture'
import { appendTo, setFields } from '../hooks/tutorial'
import { awaitsSpecOk } from '../hooks/pipeline'
import { stageActions } from '../hooks/turn'

const BETA = '/home/u/wt/beta'
const KEY = `case-${CARD_B}-spec-ok`
const SPEC_GATE = '- 關卡：spec：待確認規格（AC-1～AC-2）'
const CONFIRMED = '規格已確認（AC-1～AC-2），可派實作'
// 輪到你那一句會依欄寬換行：去掉空白後比對，不管斷在哪裡。
const screen = async (ui: any) => flat(text(await ui.drawn()))
const specRuns = (data: any) => data.processCalls.filter((c: any) => c.argv.includes('spec-ok'))

/** 只留 Beta 一件，停在 spec 關卡，沒有 Agent 在跑。 */
function onlySpec(data: any) {
  data.agents = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
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
  expect(await screen(ui)).toContain(flat('看過規格（o 開卡片）後按 t 確認並派實作（或輸入 /desk:card spec beta ok）'))
  await ui.unmount()
})

/** 審查 MEDIUM 修正：確認規格就核准檢查，所以第二次按 t 之前要看得到整條指令（平常檢查列只顯示去掉前綴、依寬度截斷的短版） */
test('test_arming_t_shows_the_full_check_command_that_confirming_approves', async ($, on) => {
  const { data, clock } = fixture(on)
  onlySpec(data)
  const long = 'docker compose exec -T app npx vitest run tests/orders/export.test.ts && npm run lint'
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 驗證：`npm test`', `- 驗證：\`${long}\``)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  // 還沒按 t：短版，前綴看不到
  expect(await screen(ui)).not.toContain(flat('docker compose exec -T app'))

  await ui.press({ key: KEY })
  await clock.settle()
  // 按了一次：整條指令連前綴列出來（依欄寬換行，去空白後比對）
  expect(await screen(ui)).toContain(flat(`核准這條（再按 t 之後自動執行）：${long}`))
  await ui.unmount()
})

test('pressing t twice confirms the spec like /desk:card spec ok', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  onlySpec(data)
  scriptOk(data)
  // 確認後自動派實作：派出去的 Agent 出現在 Beta 的 worktree
  data.launch = async (e: any) => {
    data.agents = [{ id: 'e0000000', kind: 'background', cwd: e.init.cwd, name: e.argv[3], sessionId: 'e0000000-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, 'e0000000')
  }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  const before = data.files[CARD_B]
  await ui.press({ key: KEY })
  await clock.settle()
  expect((await ui.find({ key: KEY }))?.text).toBe('再按 t 確認規格並核准檢查')
  expect(data.files[CARD_B]).toBe(before)
  expect(specRuns(data)).toHaveLength(0)

  await ui.press({ key: KEY })
  await clock.settle()
  // 跑的是 /desk:card spec <slug> ok 用的那支腳本，在任務的 worktree 裡
  const run = specRuns(data)
  expect(run).toHaveLength(1)
  expect(run[0].argv[0]).toBe('python3')
  expect(String(run[0].argv[1]).endsWith('/skills/card/scripts/card.py')).toBe(true)
  expect(run[0].argv.slice(2)).toEqual(['spec-ok', 'beta'])
  expect(run[0].init.cwd).toBe(BETA)
  // 帶 DESK_SETTINGS，腳本才認得同一個專案的設定與登錄表
  expect(typeof run[0].init.env?.DESK_SETTINGS).toBe('string')
  expect(run[0].init.env.DESK_SETTINGS.length).toBeGreaterThan(0)
  expect(data.files[CARD_B]).toContain('- 關卡：無')
  expect(data.files[CARD_B]).toContain(`- 狀態：${CONFIRMED}`)
  expect(data.files[CARD_B]).toContain('- D-02 2030-01-05 Alex：確認規格（AC-1～AC-2，共 2 條）')
  expect(data.files[CARD_B]).toContain('- 2030-01-05：規格確認，關卡清為無，可派實作')

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(log.list.some(e => e.text === 'Beta 規格已確認，可以派實作' && e.tone === 'success')).toBe(true)
  expect(await screen(ui)).not.toContain(flat('Beta 規格已確認，可以派實作'))
  // 確認後同一次就派出實作，不用再按 g；確認規格就算核准了檢查欄的指令，不再跳「核准並派工」（刻意的行為變更）
  expect(data.asks).toHaveLength(0)
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(BETA)
  expect(await screen(ui)).not.toContain(flat('按 g 派 Agent：依審核修正'))
  expect(await ui.find({ key: KEY })).toBeUndefined()
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

test('a failed spec confirmation shows the exception line, not the Traceback header', async ($, on) => {
  const { data, clock } = fixture(on)
  onlySpec(data)
  data.run = async (e: any) => e.argv.includes('spec-ok')
    ? result(1, '', 'Traceback (most recent call last):\n  File "card.py", line 9, in <module>\n    main()\nUnicodeDecodeError: \'utf-8\' codec can\'t decode byte 0xff\n')
    : result(0, '')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: KEY })
  await ui.press({ key: KEY })
  await clock.settle()
  const exception = "UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff"
  expect(data.toasts.some(t => t.includes('確認規格失敗') && t.includes(exception))).toBe(true)
  expect(data.toasts.some(t => t.includes('Traceback'))).toBe(false)
  const feed = (await ui.findAll({ type: 'Text' })).find((n: any) => /Beta 確認規格失敗/.test(n.text) && n.props?.color === 'error')
  expect(feed?.text).toContain('UnicodeDecodeError')
  expect(feed?.text).not.toContain('Traceback')
  expect(data.files[CARD_B]).toContain(SPEC_GATE)
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

  // 示範任務：停在 spec 關卡也不提供
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
