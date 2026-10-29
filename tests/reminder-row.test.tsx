import { expect, test } from 'claude-code/testing'
import { fixture, PANE, BAND, CARD_A, CARD_B, NOW, REGISTRY, text } from './fixture'
import { COLOR } from '../hooks/theme'

const ASK = '要 push 嗎？A) 要 B) 等'
const RAG = '決定 rag-proxy 是否退役'

/** 距 NOW 幾天的本地日期 YYYY-MM-DD。 */
function dayFrom(days: number): string {
  const d = new Date(NOW + days * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 登錄表加一段「## 提醒」。 */
const remind = (data: any, lines: string[]) => { data.files[REGISTRY] += `\n\n## 提醒\n${lines.join('\n')}\n` }
const FOUR = [`- ${dayFrom(2)} ${RAG}`, '- 改名：清單標題改成全部任務', '- 修正：下一步提示', '- 2099-01-01 很久以後']

async function mount($: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  return $.ui.mount(PANE(80))
}

/** header 的列：面板最外層 column 裡、內容區之前每個高 1 的列。 */
async function headerRows(ui: any): Promise<any[]> {
  const root: any = await ui.drawn()
  const kids: any[] = root.children ?? []
  const end = kids.findIndex(k => k.props?.height !== 1)
  return end < 0 ? kids : kids.slice(0, end)
}
/** header 裡以「◷」開頭的列：每列的字與每段的顏色。 */
async function reminderRows(ui: any): Promise<{ text: string; colors: string[] }[]> {
  const parts = (n: any): any[] => typeof n === 'string' ? [] : n?.type === 'Text' && (n.children ?? []).every((c: any) => typeof c === 'string') ? [n] : (n?.children ?? []).flatMap(parts)
  return (await headerRows(ui))
    .map(r => ({ text: text(r), colors: parts(r).map(p => p.props?.color).filter(Boolean) }))
    .filter(r => r.text.startsWith('◷') || /^\s{2}\S/.test(r.text))
}

/** AC-1：4 條提醒（2 天後、2 條沒日期、2099）收成 1 列，件數＋第一條＋距今天數；header 列數跟只有 1 條時一樣。 */
test('test_reminders_collapse_to_one_row_with_count_and_first_item', async ($, on) => {
  const { data } = fixture(on)
  const base = data.files[REGISTRY]!
  remind(data, [`- ${dayFrom(2)} ${RAG}`])
  const single = await mount($)
  const singleHeader = (await headerRows(single)).length
  await single.unmount()

  data.files[REGISTRY] = base
  remind(data, FOUR)
  const ui = await mount($)
  const rows = await reminderRows(ui)
  expect(rows.length).toBe(1)
  expect(rows[0]!.text.startsWith(`◷ 提醒 3 件 · ${RAG}`)).toBe(true)
  expect(rows[0]!.text.endsWith('還有 2 天')).toBe(true)
  expect(rows[0]!.text.includes('很久以後')).toBe(false)
  expect((await headerRows(ui)).length).toBe(singleHeader)
  await ui.unmount()
})

/** AC-2：只有 1 條昨天到期：寫事項與「已過 1 天」，不寫件數；用提醒色（warning），沒有紅色（error）。 */
test('test_single_overdue_reminder_uses_attention_color_without_count', async ($, on) => {
  const { data } = fixture(on)
  remind(data, [`- ${dayFrom(-1)} 續約網域`])
  const ui = await mount($)
  const rows = await reminderRows(ui)
  expect(rows.length).toBe(1)
  expect(rows[0]!.text.startsWith('◷ 續約網域')).toBe(true)
  expect(rows[0]!.text.endsWith('已過 1 天')).toBe(true)
  expect(rows[0]!.text.includes('件')).toBe(false)
  expect(rows[0]!.colors[0]).toBe(COLOR.attention)
  expect(rows[0]!.colors.includes(COLOR.attention)).toBe(true)
  expect(rows[0]!.colors.includes(COLOR.bad)).toBe(false)
  await ui.unmount()
})

/** AC-3：按 m 列出 3 條全文（太長換行、不截斷；有日期寫 MM-DD 與天數，沒日期不寫）；換選別件回到 1 列。 */
test('test_more_lists_all_reminders_in_full_and_collapses_on_switch', async ($, on) => {
  const { data } = fixture(on)
  const long = '- 修正：下一步提示在窄面板會被截斷，要確認換行後每一列都對齊，而且不會把後面的按鈕擠出畫面之外，這條故意寫得很長'
  remind(data, [...FOUR.slice(0, 2), long, FOUR[3]!])
  const ui = await mount($)
  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: 'more' })

  const rows = await reminderRows(ui)
  const firsts = rows.filter(r => r.text.startsWith('◷'))
  expect(firsts.length).toBe(3)
  expect(firsts[0]!.text).toBe(`◷ ${dayFrom(2).slice(5)} ${RAG}  還有 2 天`)
  expect(firsts[1]!.text).toBe('◷ 改名：清單標題改成全部任務')
  expect(firsts[2]!.text.startsWith('◷ 修正：下一步提示')).toBe(true)
  // 長的那條換成多列，接起來就是全文
  expect(rows.length).toBeGreaterThan(3)
  const joined = rows.slice(2).map(r => r.text.replace(/^◷ |^ {2}/, '')).join('').replace(/\s/g, '')
  expect(joined).toBe(long.slice(2).replace(/\s/g, ''))
  expect(rows.some(r => r.text.includes('很久以後'))).toBe(false)

  await ui.press({ key: `row-${CARD_B}` })
  const back = await reminderRows(ui)
  expect(back.length).toBe(1)
  expect(back[0]!.text.startsWith(`◷ 提醒 3 件 · ${RAG}`)).toBe(true)
  await ui.unmount()
})

/** AC-4：只有沒日期的提醒、沒人等你：提示列不出現提醒；另有 1 條昨天到期的就照舊顯示，用提醒色不用紅色。 */
test('test_undated_reminders_stay_off_the_band', async ($, on) => {
  const { data } = fixture(on)
  data.files[CARD_A] = data.files[CARD_A]!.replace(ASK, '無')
  remind(data, ['- 改名：清單標題改成全部任務', '- 修正：下一步提示'])
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const band = await $.ui.mount(BAND(120))
  expect(JSON.stringify(await band.drawn()).includes('◷')).toBe(false)
  await band.unmount()

  data.files[REGISTRY] = data.files[REGISTRY]!.replace('## 提醒\n', `## 提醒\n- ${dayFrom(-1)} 續約網域\n`)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const again = await $.ui.mount(BAND(120))
  const drawn: any = await again.drawn()
  const find = (n: any): any => typeof n === 'string' ? null : text(n).startsWith('◷') && n.type === 'Text' ? n : (n?.children ?? []).map(find).find(Boolean)
  const node = find(drawn)
  expect(text(node)).toBe('◷ 續約網域（已過 1 天）')
  expect(node.props?.color).toBe(COLOR.attention)
  expect(JSON.stringify(drawn).includes('改名')).toBe(false)
  await again.unmount()
})
