import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, NOW, leaves, text } from './fixture'
import { SPIN_MS } from '../hooks/desk-io'
import { COLOR, EDGE, STATE } from '../hooks/theme'
import type { CaseState } from '../types'

const ASK = '要 push 嗎？A) 要 B) 等'
const scrollBy = ($: any, by: number) => $.ui.scroll({ component: 'Pane', requestId: 'desk', offset: 0, by, bodyRows: 16, contentRows: 16, origin: { kind: 'person' } })

/** 清單上每一列的按鈕：數字鍵 → 哪一件（row-<卡片路徑>）。 */
async function digitMap(ui: any): Promise<Record<string, string>> {
  const rows = (await ui.findAll({ type: 'Button' })).filter((b: any) => String(b.key ?? '').startsWith('row-'))
  return Object.fromEntries(rows.map((b: any) => [b.props?.hotkey, b.key]))
}

/** 按數字鍵：找到綁這個鍵的那顆按鈕按下去。 */
async function pressDigit(ui: any, digit: string) {
  const key = (await digitMap(ui))[digit]
  expect(key).toBeDefined()
  await ui.press({ key })
}

/** 清單上各列的順序（row-<卡片路徑>）。 */
async function listOrder(ui: any): Promise<string[]> {
  return (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key ?? '')).filter((k: string) => k.startsWith('row-'))
}

/** 現在卡的邊條：每列一個「▎」。 */
async function edges(ui: any): Promise<any[]> {
  return leaves(await ui.drawn(), 'Text').filter((t: any) => text(t) === EDGE)
}

/** 現在卡逐列的字（以「▎」分列，去掉邊條後那一格空白）；最後一列之後的清單等不算。 */
async function cardRows(ui: any): Promise<{ text: string; color?: string }[][]> {
  const out: { text: string; color?: string }[][] = []
  for (const t of leaves(await ui.drawn(), 'Text')) {
    const s = text(t)
    if (s === EDGE) { out.push([]); continue }
    if (out.length) out[out.length - 1]!.push({ text: s, color: t.props?.color })
  }
  return out.map(row => row.filter((p, i) => !(i === 0 && p.text === ' ')))
}
const rowText = (row: { text: string }[]) => row.map(p => p.text).join('')

/**
 * AC-1：數字鍵依完整清單固定編號；自動挑選時按 2 選第二件，再按一次 2 還是同一件，選取前後每件的數字不變。
 */
test('test_digit_hotkeys_stay_fixed_after_selecting', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  const before = await digitMap(ui)
  expect(Object.keys(before).length).toBeGreaterThanOrEqual(3)
  const second = before['2']!

  await pressDigit(ui, '2')
  expect(await ui.find({ type: 'Text', text: /^Beta$/ })).toBeDefined()
  expect(second).toBe(`row-${CARD_B}`)
  expect(await digitMap(ui)).toEqual(before)

  await pressDigit(ui, '2')
  expect(await ui.find({ type: 'Text', text: /^Beta$/ })).toBeDefined()
  expect(await digitMap(ui)).toEqual(before)
  await ui.unmount()
})

/**
 * AC-2：選取的那件留在清單原位，該列以「▸」開頭並反白；區段標題寫「現在 · 你選的」。
 * 取消選取後標題改回「現在 · 自動挑選」，清單沒有「▸」；清單上有待辦任務時也一樣，「▸」只標你選的那件。
 */
test('test_selected_case_stays_in_list_marked_and_title_says_who_picked', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  const order = await listOrder(ui)
  expect(await ui.find({ type: 'Text', text: '現在 · 自動挑選' })).toBeDefined()

  await pressDigit(ui, '2')
  expect(await listOrder(ui)).toEqual(order)
  const row = await ui.find({ key: `row-${CARD_B}` })
  expect(row?.text.startsWith('▸')).toBe(true)
  expect(leaves(row, 'Text').some((t: any) => t.props?.inverse === true && text(t).startsWith('▸'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: '現在 · 你選的' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '現在 · 自動挑選' })).toBeUndefined()

  await ui.press({ key: 'more' })
  await ui.press({ key: 'deselect' })
  expect(await ui.find({ type: 'Text', text: '現在 · 自動挑選' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '現在 · 你選的' })).toBeUndefined()
  expect(await listOrder(ui)).toEqual(order)
  for (const key of order) expect((await ui.find({ key }))?.text).not.toContain('▸')
  await ui.unmount()

  // 清單上有待辦任務：「▸」只代表選取，待辦的圖示不能跟它撞字。
  data.files[CARD_A] = data.files[CARD_A]!.replace(ASK, '無')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const withReady = await $.ui.mount(PANE(72))
  const marked = async () => {
    const out: string[] = []
    for (const key of await listOrder(withReady)) if ((await withReady.find({ key }))?.text.includes('▸')) out.push(key)
    return out
  }
  expect((await withReady.find({ key: `row-${CARD_A}` }))?.text).toContain(STATE.ready.glyph)
  expect(await marked()).toEqual([])
  await pressDigit(withReady, (await digitEntry(withReady, CARD_A))!)
  expect(await marked()).toEqual([`row-${CARD_A}`])
  // 「更多動作」上一段已經展開過，還開著就直接按取消選取。
  if (!(await withReady.find({ key: 'deselect' }))) await withReady.press({ key: 'more' })
  await withReady.press({ key: 'deselect' })
  expect(await marked()).toEqual([])
  await withReady.unmount()
})

/** 某一件在清單上綁的數字鍵。 */
async function digitEntry(ui: any, card: string): Promise<string | undefined> {
  return Object.entries(await digitMap(ui)).find(([, key]) => key === `row-${card}`)?.[0]
}

/** 讓現在卡落在某個狀態：等你是 Alpha 原樣；關卡、失敗改 Alpha 的卡；執行中讓 Alpha 退成待辦，現在卡換成在跑的 Beta。 */
const SETUP: Record<'ask' | 'gate' | 'failed' | 'running', (data: any) => void> = {
  ask: () => {},
  gate: data => { data.files[CARD_A] = data.files[CARD_A].replace(ASK, '無').replace('- 關卡：無', '- 關卡：spec：待確認規格') },
  failed: data => { data.files[CARD_A] = data.files[CARD_A].replace(ASK, '無').replace('- 關卡：無', '- 關卡：review：CRITICAL 1、HIGH 0、MEDIUM 0、LOW 0；要修') },
  running: data => { data.files[CARD_A] = data.files[CARD_A].replace(ASK, '無') },
}
/** 改動前（fad1c6f）同樣情境下現在卡的列數，依 40、72、120 欄：邊條與徽章不能多出任何一列。 */
const ROWS_BEFORE: Record<keyof typeof SETUP, number[]> = { ask: [11, 10, 10], gate: [10, 9, 9], failed: [11, 8, 9], running: [7, 7, 7] }
const WIDTHS = [40, 72, 120]

/**
 * AC-3：現在卡不論狀態、在 40／72／120 欄，每一列最左邊都有狀態色的「▎」；標題列的狀態字是反白徽章；
 * 列數跟改動前一樣（只多 0 列），捲動提示照常。
 */
test('test_now_card_has_state_colored_edge_and_badge_at_every_width', async ($, on) => {
  const { data } = fixture(on)
  for (const state of Object.keys(SETUP) as (keyof typeof SETUP)[]) {
    data.files[CARD_A] = data.files[CARD_A]!.replace(/<!-- DESK -->[\s\S]*<!-- \/DESK -->/, `<!-- DESK -->\n- 狀態：Alpha 一切就緒\n- 驗證：\`node test.mjs\`\n- 等你：${ASK}\n- 下一步：push\n- 關卡：無\n<!-- /DESK -->`)
    SETUP[state](data)
    // 「已執行多久」是 AC-4 加的內容（40 欄時那句可能多換一行）；這裡只量邊條與徽章，Agent 不帶開始時間。
    if (state === 'running') delete data.agents[0].startedAt
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    const meta = STATE[state as CaseState]
    for (const [i, width] of WIDTHS.entries()) {
      const ui = await $.ui.mount(PANE(width))
      const bars = await edges(ui)
      expect(bars.length).toBe(ROWS_BEFORE[state][i]!)
      for (const bar of bars) expect(bar.props?.color).toBe(meta.color)
      const badge = await ui.find({ type: 'Text', text: ` ${meta.label} ` })
      expect(badge?.props?.inverse).toBe(true)
      expect(badge?.props?.color).toBe(meta.color)
      await ui.unmount()
    }
  }
  // 捲動提示照常：16 列高時內容放不下，細線右端寫還有幾列；捲到底再捲回來，邊條照樣在。
  const short = await $.ui.mount(PANE(72, 'inline', 16))
  expect(await short.find({ type: 'Text', text: /↓\d+$/ })).toBeDefined()
  await scrollBy($, 100)
  expect(await short.find({ type: 'Text', text: / ↑\d+$/ })).toBeDefined()
  await scrollBy($, -100)
  expect((await edges(short)).length).toBeGreaterThan(0)
  await short.unmount()
})

/**
 * AC-4：現在卡是執行中：「處理中」那列的圖示跟著 SPIN 轉、同列寫已執行多久，下一列淡色字是 Agent 最後一句；
 * 六段進行中那段在 ◉／◎ 間交替。Agent 沒有最後一句時不多出那一列。
 */
test('test_running_now_card_animates_and_shows_elapsed_and_last_line', async ($, on) => {
  const { data, clock } = fixture(on)
  SETUP.running(data)
  data.agents[0].startedAt = NOW
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  const busyGlyph = async () => (await ui.find({ type: 'Text', text: /處理中/ }))?.text[0]
  const pulse = async () => text(await ui.drawn()).match(/實作([◉◎])/)?.[1]
  const glyph0 = await busyGlyph()
  const stage0 = await pulse()
  expect(stage0).toBeDefined()

  await clock.advance(SPIN_MS); await clock.settle()
  const stage1 = await pulse()
  expect(stage1).toBeDefined()
  expect(stage1).not.toBe(stage0)
  await clock.advance(SPIN_MS); await clock.settle()
  expect(await busyGlyph()).not.toBe(glyph0)

  // 快轉 4 分 12 秒時先卸下面板（SPIN 每拍都會重畫），再掛回來看。
  await ui.unmount()
  await clock.advance(4 * 60_000 + 12_000); await clock.settle()
  const again = await $.ui.mount(PANE(72))
  const rows = await cardRows(again)
  const at = rows.findIndex(r => rowText(r).includes('處理中'))
  expect(rowText(rows[at]!)).toContain('已執行 4 分 12 秒')
  // 下一列：淡色字的 Agent 最後一句。
  expect(rows[at + 1]).toEqual([{ text: '└ 最新：跑測試中', color: COLOR.dim }])
  const withLast = rows.length
  await again.unmount()

  // 沒有最後一句：不畫「└ 最新」，也不多出一列。
  data.logs.bbbbbbbb = ''
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const quiet = await $.ui.mount(PANE(72))
  const quietRows = await cardRows(quiet)
  expect(quietRows.some(r => rowText(r).startsWith('└'))).toBe(false)
  expect(quietRows.length).toBeLessThanOrEqual(withLast)
  await quiet.unmount()
})

/**
 * AC-5：清單上執行中那列的時間欄寫「▶ <執行時間>」（執行中色），閒置那列照舊寫多久前；
 * 沒有任務在跑時不啟動 SPIN 計時器，面板不再重畫。
 */
test('test_running_row_shows_elapsed_and_no_spin_when_idle', async ($, on) => {
  const { data, clock } = fixture(on)
  const ticks: unknown[] = []
  on('state.set', async (_: any, e: any, next: any) => { if (e?.plugin === 'desk' && e?.key === 'tick') ticks.push(e.value); return next(e) })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  for (const width of [72, 120]) {
    const ui = await $.ui.mount(PANE(width))
    const beta = await ui.find({ key: `row-${CARD_B}` })
    expect(beta?.text).toMatch(/▶ 1 分 0 秒$/)
    const age = leaves(beta, 'Text').find((t: any) => /▶ 1 分 0 秒$/.test(text(t)))
    expect(age?.props?.color).toBe(COLOR.running)
    expect((await ui.find({ key: `row-${CARD_C}` }))?.text).toMatch(/2 天前$/)
    await ui.unmount()
  }

  // 有人在跑：SPIN 計時器每一拍寫一次 tick，面板跟著重畫。
  await clock.advance(SPIN_MS * 3); await clock.settle()
  expect(ticks.length).toBeGreaterThan(0)

  // 沒有人在跑：計時器停掉，tick 不再寫，面板不重畫。
  data.agents = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  ticks.length = 0
  await clock.advance(SPIN_MS * 5); await clock.settle()
  expect(ticks).toEqual([])
})
