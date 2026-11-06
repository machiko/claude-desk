import { expect, test } from 'claude-code/testing'
import { fixture, deskTemplate, feedLog, CARD_B, PROJECT_DIR } from './fixture'
import { RULES_LINE_MAX, rulesDiff, rulesNotice, rulesSection } from '../hooks/card-rules'

// 卡片規則段守門：對話或 Agent 寫入 DESK 卡後，「## 卡片規則」段跟模板比，不一致就在工具結果附提示、跳 toast。

/** 最小的 fixture 模板：規則段三條，規格段直接接在後面（沒有空行）。 */
const TEMPLATE = [
  '# <任務名> DESK', '', '<!-- DESK -->', '- 狀態：<一句話>', '- 驗證：`<指令>`', '- 等你：無', '- 下一步：<一件事>', '- 關卡：無', '<!-- /DESK -->', '',
  '## 卡片規則', '', '- 規則一：卡片要精簡。', '- 規則二：<任務名> 的 `檢查` 放完成檢查。', '- 規則三：`## 規格` 是唯一依據。', '## 規格', '', '- 目標：<一句話>', '', '## History', '',
].join('\n')
/** 照模板開的 Beta 卡（卡名佔位換成 Beta，跟 card.py new 一樣）。 */
const BETA_CARD = TEMPLATE.split('<任務名>').join('Beta').replace('<一句話>', 'Beta 修正中')
/** 專案自訂的模板：規則段不同。 */
const CUSTOM = '# <任務名> DESK\n\n<!-- DESK -->\n- 狀態：x\n- 驗證：無\n- 等你：無\n- 下一步：無\n- 關卡：無\n<!-- /DESK -->\n\n## 卡片規則\n\n- 本專案規則：只寫中文。\n\n## 規格\n'
const CUSTOM_PATH = '/home/u/tpl/custom-card.md'

/** 對話的工具有人回答：Write 寫進假的檔案系統、Edit 照 old_string 換、Bash 什麼都不做。 */
function tools(on: any, data: any) {
  on('tool.call', { tool: 'Write' }, (_: any, e: any) => { data.files[e.file_path] = e.content; return { result: { type: 'update', filePath: e.file_path } } })
  on('tool.call', { tool: 'Edit' }, (_: any, e: any) => { data.files[e.file_path] = data.files[e.file_path].replace(e.old_string, e.new_string); return { result: { filePath: e.file_path } } })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
}

/** 這次工具結果附給模型看的提示（全部接起來）。 */
const contextOf = (r: any): string => (r?.context ?? []).join('\n')

/** AC-1：規則段跟模板一致（空白行、行尾空白不算），用 Edit、Write、Bash 改卡片都沒有任何提示。 */
test('card rules guard stays quiet when rules match template', async ($, on) => {
  const { data } = fixture(on)
  const feed = feedLog(on)
  deskTemplate(data, TEMPLATE)
  tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const written = BETA_CARD.replace('- 規則一：卡片要精簡。', '- 規則一：卡片要精簡。   \n')
  const results = [
    await $.tool.call({ tool: 'Write', file_path: CARD_B, content: written } as any),
    await $.tool.call({ tool: 'Edit', file_path: CARD_B, old_string: 'Beta 修正中', new_string: 'Beta 已修好' } as any),
    await $.tool.call({ tool: 'Bash', command: `sed -i '' 's/已修好/已送審/' ${CARD_B}` } as any),
  ]
  for (const r of results) expect(contextOf(r)).toBe('')
  expect(data.toasts.filter((t: string) => t.includes('卡片規則段'))).toEqual([])
  expect(feed.has('卡片規則段')).toBe(false)
  expect(rulesDiff(written, TEMPLATE.split('<任務名>').join('Beta'))).toBeNull()
})

/** AC-2：一次寫入蓋掉最後一條規則、「## 規格」標題也不見：提示缺幾行／多幾行、第一個不一致的行、照模板補回；toast 同一句。 */
test('card rules guard reports missing and changed lines after card write', async ($, on) => {
  const { data } = fixture(on)
  deskTemplate(data, TEMPLATE)
  tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const broken = BETA_CARD.replace('- 規則三：`## 規格` 是唯一依據。\n## 規格\n', '')
  const r = await $.tool.call({ tool: 'Write', file_path: CARD_B, content: broken } as any)
  const notice = contextOf(r)
  expect(notice).toContain('Beta 的卡片規則段跟模板不一致：缺 1 行、多 1 行')
  expect(notice).toContain('  模板：- 規則三：`## 規格` 是唯一依據。')
  expect(notice).toContain('  卡片：- 目標：<一句話>')
  expect(notice).toContain('照模板補回後再繼續')
  expect(data.toasts).toContain('Beta 的卡片規則段跟模板不一致：缺 1 行、多 1 行')
})

/** AC-2：第一個不一致的行太長時，模板那行與卡片那行各截到 80 字內。 */
test('card rules notice clips each mismatched line to 80 characters', () => {
  const long = (c: string) => `- ${c.repeat(120)}`
  const d = rulesDiff(`## 卡片規則\n${long('卡')}\n`, `## 卡片規則\n${long('模')}\n`)!
  expect(d).toEqual({ missing: 1, extra: 1, first: { template: long('模'), card: long('卡') } })
  const lines = rulesNotice('Beta', d).split('\n')
  for (const line of lines.filter(l => l.includes('模板：') || l.includes('卡片：'))) {
    expect([...line.replace(/^ *(模板|卡片)：/, '')].length).toBeLessThanOrEqual(RULES_LINE_MAX)
  }
})

/** AC-3：專案 dispatch.json 設了 card.template（疊在全域上、整個 card 鍵以專案的為準）：用它比，不拿內附模板比。 */
test('card rules guard uses project card template', async ($, on) => {
  const { data } = fixture(on)
  deskTemplate(data, TEMPLATE)
  data.files['/home/u/.claude/handoffs/dispatch.json'] = JSON.stringify({ card: { template: '/home/u/tpl/global.md' } })
  data.files[`${PROJECT_DIR}/dispatch.json`] = JSON.stringify({ card: { template: '~/tpl/custom-card.md' } })
  data.files[CUSTOM_PATH] = CUSTOM
  data.files['/home/u/tpl/global.md'] = TEMPLATE
  tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ownCard = CUSTOM.replace('<任務名>', 'Beta')
  const quiet = await $.tool.call({ tool: 'Write', file_path: CARD_B, content: ownCard } as any)
  expect(contextOf(quiet)).toBe('')
  const builtin = await $.tool.call({ tool: 'Write', file_path: CARD_B, content: BETA_CARD } as any)
  expect(contextOf(builtin)).toContain('Beta 的卡片規則段跟模板不一致：缺 1 行、多 3 行')
  expect(contextOf(builtin)).toContain('  模板：- 本專案規則：只寫中文。')
})

/** AC-4：模板沒有「## 卡片規則」段、卡片是舊格式（沒有這一段，或 .console/STATUS.md）：不檢查、不提示。 */
test('card rules guard skips cards without rules section', async ($, on) => {
  const { data } = fixture(on)
  deskTemplate(data, TEMPLATE.replace(/## 卡片規則[\s\S]*?(?=## 規格)/, ''))
  tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const noRulesInTemplate = await $.tool.call({ tool: 'Write', file_path: CARD_B, content: BETA_CARD.replace('- 規則一：卡片要精簡。\n', '') } as any)
  expect(contextOf(noRulesInTemplate)).toBe('')
  expect(rulesDiff(BETA_CARD, '# x\n\n## 規格\n')).toBeNull()

  // 舊格式：卡片沒有規則段、或是 .console/STATUS.md，模板有規則段也不比。
  expect(rulesDiff(data.files[CARD_B]!.replace(/## 卡片規則[\s\S]*?(?=## 規格)/, ''), TEMPLATE)).toBeNull()
  const legacy = '/home/u/wt/beta/.console/STATUS.md'
  const legacyWrite = await $.tool.call({ tool: 'Write', file_path: legacy, content: '## 卡片規則\n\n- 舊卡自己的規則\n' } as any)
  expect(contextOf(legacyWrite)).toBe('')
  expect(data.toasts.filter((t: string) => t.includes('卡片規則段'))).toEqual([])
})

/** 寫壞之後只是 cat、grep 卡片（內容沒變）：不重複提示；再寫一次還是壞的才再提示。 */
test('card rules guard does not repeat for an unchanged broken card', async ($, on) => {
  const { data } = fixture(on)
  deskTemplate(data, TEMPLATE)
  tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const broken = BETA_CARD.replace('- 規則二：Beta 的 `檢查` 放完成檢查。\n', '')
  expect(contextOf(await $.tool.call({ tool: 'Write', file_path: CARD_B, content: broken } as any))).toContain('缺 1 行')
  expect(contextOf(await $.tool.call({ tool: 'Bash', command: `cat ${CARD_B}` } as any))).toBe('')
  expect(contextOf(await $.tool.call({ tool: 'Write', file_path: CARD_B, content: `${broken}\n- 2030-01-05：再寫一次\n` } as any))).toContain('缺 1 行')
  expect(data.toasts.filter((t: string) => t.includes('卡片規則段')).length).toBe(2)
})

/** rulesSection 行首錨定：規則段裡的說明句提到「## 卡片規則」或「## 規格」不算段落標題。 */
test('rules section is anchored at line start', () => {
  const text = '## 卡片規則\n- 說明：`## 規格` 與 ## 卡片規則 都只是字\n\n## 規格\n- 目標'
  expect(rulesSection(text)).toBe('- 說明：`## 規格` 與 ## 卡片規則 都只是字\n\n')
  expect(rulesSection('- 提到 ## 卡片規則 的一行\n')).toBeNull()
})
