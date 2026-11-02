import { expect, test } from 'claude-code/testing'
import { fixture, PANE, REGISTRY, CARD_A, CARD_B, CARD_C, NOW, text } from './fixture'
import { stateCounts, waitingBesides, displayWidth } from '../hooks/model'
import { STAGES } from '../hooks/pipeline'
import type { Case, CaseState } from '../types'

const card = (status: string, ask: string, next: string, gate = '無') =>
  `<!-- DESK -->\n- 狀態：${status}\n- 驗證：無\n- 等你：${ask}\n- 下一步：${next}\n- 關卡：${gate}\n<!-- /DESK -->`
const ASK = '要 push 嗎？A) 要 B) 等'
const SPEC_GATE = 'spec：待確認規格'
const pathOf = (slug: string) => `/home/u/wt/${slug}/.desk/CARD.md`
const waitingAgent = (slug: string) => ({ id: `w-${slug}`, kind: 'background', cwd: `/home/u/wt/${slug}`, state: 'blocked', status: 'waiting', waitingFor: 'input needed', name: `${slug}-agent`, sessionId: `w-${slug}-0000-4000-8000-000000000000` })
const busyAgent = (slug: string) => ({ id: `b-${slug}`, kind: 'background', cwd: `/home/u/wt/${slug}`, state: 'working', status: 'busy', name: `${slug}-agent`, sessionId: `b-${slug}-0000-4000-8000-000000000000`, startedAt: NOW - 60_000 })

/** 登錄表換成這幾件：[任務名, slug, 卡片]。 */
function seed(data: any, rows: [string, string, string][]) {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n${rows.map(([name, slug]) => `| ${name} | \`${pathOf(slug)}\` |`).join('\n')}`
  for (const [, slug, body] of rows) {
    data.files[pathOf(slug)] = body
    data.mtimes[pathOf(slug)] = NOW - 10 * 60_000
  }
}

/** AC-1 的七件：等你（問題）、等回覆（Agent）、關卡、進行中、三件閒置。 */
function sevenCases(data: any, names: Partial<Record<string, string>> = {}) {
  const n = (slug: string, fallback: string) => names[slug] ?? fallback
  seed(data, [
    [n('alpha', 'Alpha'), 'alpha', card('Alpha 等決策', ASK, 'push')],
    [n('beta', 'Beta'), 'beta', card('Beta 修正中', '無', '依審核修正')],
    [n('gamma', 'Gamma'), 'gamma', card('Gamma 規格草稿', '無', '確認規格', SPEC_GATE)],
    [n('delta', 'Delta'), 'delta', card('Delta 實作中', '無', '實作')],
    [n('eps', 'Eps'), 'eps', card('Eps 閒置', '無', '無')],
    [n('zeta', 'Zeta'), 'zeta', card('Zeta 閒置', '無', '無')],
    [n('eta', 'Eta'), 'eta', card('Eta 閒置', '無', '無')],
  ])
  data.agents = [waitingAgent('beta'), busyAgent('delta')]
}

/** 畫面上 content 的每一列（面板一列一個 key 為 c<n> 的 Box），依序。 */
async function contentLines(ui: any): Promise<string[]> {
  const out: string[] = []
  const walk = (node: any) => {
    if (!node || typeof node === 'string') return
    if (/^c\d+$/.test(String(node.props?.key ?? ''))) { out.push(text(node)); return }
    for (const child of node.children ?? []) walk(child)
  }
  walk(await ui.drawn())
  return out
}
const titleRow = async (ui: any) => (await contentLines(ui)).find(l => l.startsWith('全部任務'))
const fake = (state: CaseState, demo = false) => ({ state, statusPath: `/x/${state}-${demo}`, ...(demo ? { demo: true } : {}) }) as unknown as Case
const TALLY = /[●◆✕▶▷○] \d/

/**
 * AC-1：72 欄、7 件（2 件等你、1 關卡、1 進行中、3 閒置）：「全部任務」標題列右邊接「● 2 ◆ 1 ▶ 1 ○ 3」，
 * 依等你、關卡、失敗、進行中、待辦、閒置排序，0 件的不出現；等你、等回覆、等批准合計成 ●；示範任務不計入。
 */
test('test_pane_displays_nonzero_state_counts_in_order', async ($, on) => {
  const { data } = fixture(on)
  sevenCases(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  const row = (await titleRow(ui))!
  expect(row).toBeDefined()
  for (const st of STAGES) expect(row).toContain(st.label)
  expect(row.trimEnd().endsWith('● 2 ◆ 1 ▶ 1 ○ 3')).toBe(true)
  expect(row).not.toMatch(/[✕▷] \d/)
  await ui.unmount()

  // 同樣七件再加上教學模式的示範任務（等你、進行中、閒置、關卡各有）：計數不變；等回覆、等批准都併進 ●。
  const real = [fake('ask'), fake('reply'), fake('gate'), fake('running'), fake('idle'), fake('idle'), fake('idle')]
  const demos = [fake('ask', true), fake('running', true), fake('idle', true), fake('gate', true), fake('failed', true)]
  const expected = [{ state: 'ask', count: 2 }, { state: 'gate', count: 1 }, { state: 'running', count: 1 }, { state: 'idle', count: 3 }]
  expect(stateCounts([...real, ...demos])).toEqual(expected)
  expect(stateCounts([fake('approve'), fake('reply'), fake('ask'), fake('failed'), fake('ready')])).toEqual([{ state: 'ask', count: 3 }, { state: 'failed', count: 1 }, { state: 'ready', count: 1 }])
})

/** AC-2：同 AC-1，但任務名長到標題列放不下計數：標題列照舊只有「全部任務」與六段欄名，計數整段不顯示、不換行。 */
test('test_list_title_moves_counts_to_own_row_when_no_room', async ($, on) => {
  const { data } = fixture(on)
  // 10 個中文字（20 格）：欄位版放得下（不縮成一串），但段名後面剩不到計數的寬度。
  sevenCases(data, { eps: '會員點數兌換流程改版' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  const lines = await contentLines(ui)
  const at = lines.findIndex(l => l.startsWith('全部任務'))
  expect(at).toBeGreaterThanOrEqual(0)
  // 區名＋細線＋計數一列，六段欄名另起一列；兩列都不超寬、不截字。
  expect(lines[at]!).toMatch(/^全部任務 ─+ ● 2 ◆ 1 ▶ 1 ○ 3\s*$/)
  expect(lines[at + 1]!.replace(/\s+/g, ' ').trim()).toBe(STAGES.map(s => s.label).join(' '))
  expect(displayWidth(lines[at]!.trimEnd())).toBeLessThanOrEqual(70)
  expect(displayWidth(lines[at + 1]!.trimEnd())).toBeLessThanOrEqual(70)
  // 長名字完整、沒被截
  expect(text(await ui.find({ key: `row-${pathOf('eps')}` }))).toContain('會員點數兌換流程改版')
  await ui.unmount()
})

/** 寬版（100 欄起左右並排）清單那欄只有 49–64 格：計數一樣不消失，改接在區名後、六段欄名另起一列。 */
test('test_list_title_keeps_counts_at_wide_widths', async ($, on) => {
  const { data } = fixture(on)
  sevenCases(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  for (const cols of [102, 122]) {
    const ui = await $.ui.mount(PANE(cols))
    const lines = await contentLines(ui)
    // 並排時一列同時含現在卡那欄與清單那欄的字。
    const at = lines.findIndex(l => l.includes('全部任務'))
    expect(at).toBeGreaterThanOrEqual(0)
    // 放得下就跟欄名同一列（122 欄），放不下就區名＋計數一列、欄名下一列（102 欄）；兩種都不能少掉計數。
    expect(lines[at]!).toContain('● 2 ◆ 1 ▶ 1 ○ 3')
    const labels = new RegExp(STAGES.map(s => s.label).join('\\s+'))
    expect(labels.test(lines[at]!) || labels.test(lines[at + 1]!)).toBe(true)
    await ui.unmount()
  }
})

/**
 * AC-3：Alpha 等你答問題、Beta 的 Agent 等回覆、Gamma 停在關卡，現在卡是 Alpha：
 * 區段標題「現在 · 自動挑選」後接「另有 2 件等你」；只有現在卡在等你時沒有這段；示範任務不算。
 */
test('test_now_label_counts_other_waiting_cases', async ($, on) => {
  const { data } = fixture(on)
  data.files[CARD_C] = card('Gamma 規格草稿', '無', '確認規格', SPEC_GATE)
  data.agents = [waitingAgent('beta')]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  expect((await contentLines(ui))[0]).toBe('現在 · 自動挑選  另有 2 件等你')
  expect(await ui.find({ type: 'Text', text: '另有 2 件等你' })).toBeDefined()
  await ui.unmount()

  // 只有 Alpha 在等你：Beta 沒有 Agent、Gamma 沒有關卡。
  data.files[CARD_C] = card('Gamma 閒置', '無', '無')
  data.agents = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const alone = await $.ui.mount(PANE(72))
  expect((await contentLines(alone))[0]).toBe('現在 · 自動挑選')
  expect(await alone.find({ type: 'Text', text: /另有 \d+ 件等你/ })).toBeUndefined()
  await alone.unmount()

  // 等你、等回覆、等批准、關卡、失敗都算；示範任務與現在卡不算。
  const focus = fake('ask')
  expect(waitingBesides([focus, fake('reply'), fake('approve'), fake('gate'), fake('failed'), fake('running'), fake('idle'), fake('ask', true)], focus)).toBe(4)
  expect(waitingBesides([focus, fake('ask', true), fake('reply', true)], focus)).toBe(0)
})

/**
 * AC-4：72 欄、一件任務名 20 個中文字：進度表不列六段欄名，每列六段縮成連續六個圖示，長名字完整不截斷；
 * 全部任務名都短時維持欄名與五格寬欄位。
 */
test('test_grid_compacts_stages_only_when_a_name_would_truncate', async ($, on) => {
  const { data } = fixture(on)
  const NAME = '會員點數兌換流程改版與舊資料搬移及報表整'
  expect(NAME.length).toBe(20)
  data.files[REGISTRY] = data.files[REGISTRY]!.replace('| Gamma |', `| ${NAME} |`)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  const lines = await contentLines(ui)
  const heads = STAGES.map(s => s.label)
  // 標題列是「全部任務 ───」，下面也沒有另起一列段名（現在卡自己的六段不算）。
  const title = lines.findIndex(l => l.startsWith('全部任務'))
  expect(lines[title]).toMatch(/^全部任務 ─+/)
  expect(heads.some(h => lines[title]!.includes(h) || lines[title + 1]!.includes(h))).toBe(false)
  for (const key of [CARD_A, CARD_B, CARD_C]) expect(text(await ui.find({ key: `row-${key}` }))).toMatch(/[●◉◎◆✕○·]{6}/)
  expect(text(await ui.find({ key: `row-${CARD_C}` }))).toContain(NAME)
  await ui.unmount()

  data.files[REGISTRY] = data.files[REGISTRY]!.replace(`| ${NAME} |`, '| Gamma |')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const short = await $.ui.mount(PANE(72))
  const shortLines = await contentLines(short)
  expect(shortLines.some(l => l.startsWith('全部任務') && heads.every(h => l.includes(h)))).toBe(true)
  // 五格寬欄位：相鄰兩段圖示之間隔 4 格。
  for (const key of [CARD_A, CARD_B, CARD_C]) {
    const row = text(await short.find({ key: `row-${key}` }))
    expect(row).not.toMatch(/[●◉◎◆✕○·]{2}/)
    expect(row).toMatch(/[●◉◎◆✕○·] {4}[●◉◎◆✕○·] {4}[●◉◎◆✕○·] {4}[●◉◎◆✕○·] {4}[●◉◎◆✕○·] {4}[●◉◎◆✕○·]/)
  }
  await short.unmount()
})

/**
 * AC-5：按數字鍵選了 Beta：區段標題「現在 · 你選的」後接「Beta · 之後每則對話都附上它的卡」與「✕ 取消選取」按鈕（不綁快捷鍵）；
 * 點它回到「現在 · 自動挑選」、列上沒有按鈕；沒選任務時也沒有這段與按鈕。
 */
test('test_now_label_shows_selected_case_with_deselect_button', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  expect(await ui.find({ key: 'deselect-title' })).toBeUndefined()
  expect(text(await ui.drawn())).not.toContain('之後每則對話都附上它的卡')

  // 數字鍵：Beta 那列綁的是數字，按那顆按鈕。
  expect(String((await ui.find({ key: `row-${CARD_B}` }))?.props?.hotkey)).toMatch(/^[1-9]$/)
  await ui.press({ key: `row-${CARD_B}` })
  // 按鈕的字在 label 上，畫面字串裡只到它前面的間隔。
  expect((await contentLines(ui))[0]!.trimEnd()).toBe('現在 · 你選的  Beta · 之後每則對話都附上它的卡')
  const button = await ui.find({ key: 'deselect-title' })
  expect(button).toBeDefined()
  expect(button?.type).toBe('Button')
  expect(button?.props?.hotkey).toBeUndefined()
  expect(button?.props?.label).toBe('✕ 取消選取')

  await ui.press({ key: 'deselect-title' })
  expect((await contentLines(ui))[0]!.startsWith('現在 · 自動挑選')).toBe(true)
  expect(await ui.find({ key: 'deselect-title' })).toBeUndefined()
  expect(text(await ui.drawn())).not.toContain('之後每則對話都附上它的卡')
  await ui.unmount()
})

/**
 * AC-5 的退讓：寬版並排時現在卡那欄只有 46–61 格。放不下整句提示就只留任務名與按鈕；任務名也放不下就只留按鈕；
 * 每一級都不截字，「✕ 取消選取」一直都在。
 */
test('test_now_label_keeps_deselect_button_at_wide_widths', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  for (const cols of [102, 122]) {
    const ui = await $.ui.mount(PANE(cols))
    await ui.press({ key: `row-${CARD_B}` })
    const first = (await contentLines(ui))[0]!
    expect(first.startsWith('現在 · 你選的  Beta')).toBe(true)
    // 提示字要嘛整句在、要嘛整句不在。
    if (!first.includes('之後每則對話都附上它的卡')) expect(first).not.toContain('之後每則')
    const button = await ui.find({ key: 'deselect-title' })
    expect(button?.props?.label).toBe('✕ 取消選取')
    expect(button?.props?.hotkey).toBeUndefined()
    await ui.press({ key: 'deselect-title' })
    expect(await ui.find({ key: 'deselect-title' })).toBeUndefined()
    await ui.unmount()
  }
})

test('test_now_label_keeps_only_deselect_button_when_name_does_not_fit', async ($, on) => {
  const { data } = fixture(on)
  // 12 個中文字（24 格）：102 欄時現在卡那欄 47 格，區名之後放不下任務名＋按鈕，只留按鈕。
  sevenCases(data, { beta: '會員點數兌換流程改版再改版' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(102))
  await ui.press({ key: `row-${pathOf('beta')}` })
  const first = (await contentLines(ui))[0]!
  expect(first.startsWith('現在 · 你選的')).toBe(true)
  expect(first).not.toContain('會員點數')
  expect(first).not.toContain('之後每則')
  expect((await ui.find({ key: 'deselect-title' }))?.props?.label).toBe('✕ 取消選取')
  await ui.unmount()
})
