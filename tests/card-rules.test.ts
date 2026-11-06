import { expect, test } from 'claude-code/testing'
import { fixture, deskTemplate, feedLog, CARD_B, PROJECT_DIR, REGISTRY } from './fixture'
import { cardWrites } from '../hooks/touch'
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

/**
 * 對話的工具有人回答：Write 寫進假的檔案系統、Edit 照 old_string 換；Bash 把測試排進 bash.writes 的內容寫進檔案（模擬腳本改卡片）再清掉，
 * 沒排就什麼都不做。回傳 bash，測試在下一次 Bash 呼叫前設 writes。
 */
function tools(on: any, data: any) {
  const bash = { writes: {} as Record<string, string> }
  on('tool.call', { tool: 'Write' }, (_: any, e: any) => { data.files[e.file_path] = e.content; return { result: { type: 'update', filePath: e.file_path } } })
  on('tool.call', { tool: 'Edit' }, (_: any, e: any) => { data.files[e.file_path] = data.files[e.file_path].replace(e.old_string, e.new_string); return { result: { filePath: e.file_path } } })
  on('tool.call', { tool: 'Bash' }, () => {
    for (const [path, text] of Object.entries(bash.writes)) data.files[path] = text
    bash.writes = {}
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return bash
}

/** 這次工具結果附給模型看的提示（全部接起來）。 */
const contextOf = (r: any): string => (r?.context ?? []).join('\n')

/** AC-1：規則段跟模板一致（空白行、行尾空白不算），用 Edit、Write、Bash 改卡片都沒有任何提示。 */
test('card rules guard stays quiet when rules match template', async ($, on) => {
  const { data } = fixture(on)
  const feed = feedLog(on)
  deskTemplate(data, TEMPLATE)
  const bash = tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const written = BETA_CARD.replace('- 規則一：卡片要精簡。', '- 規則一：卡片要精簡。   \n')
  const results = [
    await $.tool.call({ tool: 'Write', file_path: CARD_B, content: written } as any),
    await $.tool.call({ tool: 'Edit', file_path: CARD_B, old_string: 'Beta 修正中', new_string: 'Beta 已修好' } as any),
    await (bash.writes = { [CARD_B]: written.replace('Beta 修正中', 'Beta 已送審') }, $.tool.call({ tool: 'Bash', command: `sed -i '' 's/已修好/已送審/' ${CARD_B}` } as any)),
  ]
  expect(data.files[CARD_B]).toContain('Beta 已送審')
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

/** 舊格式的卡（.console/STATUS.md）：登錄表也列著它，讓「已知卡片路徑」那條路徑也走得到。 */
const LEGACY = '/home/u/wt/legacy/.console/STATUS.md'
/** 規則段跟 TEMPLATE 不一致的舊卡內容：被當成 DESK 卡比對就一定會提示。 */
const LEGACY_CARD = '<!-- DESK -->\n- 狀態：舊卡\n- 驗證：無\n- 等你：無\n- 下一步：無\n- 關卡：無\n<!-- /DESK -->\n\n## 卡片規則\n\n- 舊卡自己的規則\n'

/**
 * AC-4：卡片是舊格式（.console/STATUS.md、或 DESK 區塊底下沒有規則段）時，模板有規則段也不比：Write、Edit、Bash 改它都不提示；
 * 模板沒有「## 卡片規則」段時，DESK 卡寫成什麼樣都不提示。
 */
test('card rules guard skips cards without rules section', async ($, on) => {
  const { data } = fixture(on)
  data.files[REGISTRY] += `\n| Legacy | \`${LEGACY}\` |`
  data.files[LEGACY] = LEGACY_CARD
  deskTemplate(data, TEMPLATE)
  const bash = tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const legacyWrites = [
    await $.tool.call({ tool: 'Write', file_path: LEGACY, content: `${LEGACY_CARD}- 再加一條\n` } as any),
    await $.tool.call({ tool: 'Edit', file_path: LEGACY, old_string: '舊卡自己的規則', new_string: '舊卡改過的規則' } as any),
    await (bash.writes = { [LEGACY]: `${LEGACY_CARD}- Bash 加的一條\n` }, $.tool.call({ tool: 'Bash', command: `python3 fix.py ${LEGACY}` } as any)),
  ]
  for (const r of legacyWrites) expect(contextOf(r)).toBe('')
  const noRulesCard = await $.tool.call({ tool: 'Write', file_path: CARD_B, content: BETA_CARD.replace(/## 卡片規則[\s\S]*?(?=## 規格)/, '') } as any)
  expect(contextOf(noRulesCard)).toBe('')
  expect(data.toasts.filter((t: string) => t.includes('卡片規則段'))).toEqual([])

  // 模板沒有規則段：少一條規則的 DESK 卡也不比。
  deskTemplate(data, TEMPLATE.replace(/## 卡片規則[\s\S]*?(?=## 規格)/, ''))
  const noRulesInTemplate = await $.tool.call({ tool: 'Write', file_path: CARD_B, content: BETA_CARD.replace('- 規則一：卡片要精簡。\n', '') } as any)
  expect(contextOf(noRulesInTemplate)).toBe('')
  expect(data.toasts.filter((t: string) => t.includes('卡片規則段'))).toEqual([])
})

/** 卡片 Delta 不在登錄表、Beta 在：Bash 指令裡寫出絕對路徑的腳本一次改壞兩張，兩張各附一段提示、各跳一則 toast。 */
test('card rules guard reports bash writes to absolute card paths in the command', async ($, on) => {
  const { data } = fixture(on)
  deskTemplate(data, TEMPLATE)
  const bash = tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const delta = '/home/u/wt/delta/.desk/CARD.md'
  const deltaCard = TEMPLATE.split('<任務名>').join('Delta')
  bash.writes = { [CARD_B]: BETA_CARD.replace('- 規則二：Beta 的 `檢查` 放完成檢查。\n', ''), [delta]: deltaCard.replace('- 規則一：卡片要精簡。\n', '') }
  const r = await $.tool.call({ tool: 'Bash', command: `python3 fix.py ${CARD_B} '${delta}'` } as any)
  expect(contextOf(r)).toContain('Beta 的卡片規則段跟模板不一致：缺 1 行')
  expect(contextOf(r)).toContain('  模板：- 規則二：Beta 的 `檢查` 放完成檢查。')
  expect(contextOf(r)).toContain('Delta 的卡片規則段跟模板不一致：缺 1 行')
  expect(contextOf(r)).toContain('  模板：- 規則一：卡片要精簡。')
  expect(data.toasts.filter((t: string) => t.includes('卡片規則段'))).toEqual(['Beta 的卡片規則段跟模板不一致：缺 1 行', 'Delta 的卡片規則段跟模板不一致：缺 1 行'])
})

/** 登錄表列的卡片路徑有空白（指令裡的絕對路徑認不出來）：Bash 指令裡出現這個已知路徑、改壞了卡片，照樣提示。 */
test('card rules guard reports bash writes to a known card path', async ($, on) => {
  const { data } = fixture(on)
  const spaced = '/home/u/my wt/epsilon/.desk/CARD.md'
  data.files[REGISTRY] += `\n| Epsilon | \`${spaced}\` |`
  const epsilonCard = TEMPLATE.split('<任務名>').join('Epsilon')
  data.files[spaced] = epsilonCard
  deskTemplate(data, TEMPLATE)
  const bash = tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const command = `python3 fix.py "${spaced}"`
  expect(cardWrites({ tool: 'Bash', command }, [])).toEqual([])
  bash.writes = { [spaced]: epsilonCard.replace('- 規則三：`## 規格` 是唯一依據。\n', '') }
  const r = await $.tool.call({ tool: 'Bash', command } as any)
  expect(contextOf(r)).toContain('Epsilon 的卡片規則段跟模板不一致：缺 1 行')
  expect(data.toasts).toContain('Epsilon 的卡片規則段跟模板不一致：缺 1 行')
})

/** cardWrites：Write、Edit、MultiEdit 取 file_path；Bash 取已知卡片路徑與指令裡的絕對路徑；舊格式、別的檔、別的工具都不算。 */
test('cardWrites picks the DESK cards a tool call may write', () => {
  const known = [REGISTRY, CARD_B, LEGACY]
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    expect(cardWrites({ tool, file_path: CARD_B }, known)).toEqual([CARD_B])
    expect(cardWrites({ tool, file_path: LEGACY }, known)).toEqual([])
    expect(cardWrites({ tool, file_path: REGISTRY }, known)).toEqual([])
  }
  expect(cardWrites({ tool: 'Read', file_path: CARD_B }, known)).toEqual([])
  expect(cardWrites({ tool: 'Bash', command: `sed -i '' s/a/b/ ${CARD_B} ${LEGACY} ${REGISTRY}` }, known)).toEqual([CARD_B])
  expect(cardWrites({ tool: 'Bash', command: `cat "/x/y/.desk/CARD.md";cat /z/.desk/CARD.md.bak` }, [])).toEqual(['/x/y/.desk/CARD.md'])
  // 路徑要從字界開始：~、相對路徑、含空白的路徑不會被截成一條假的絕對路徑（要不要認 ~ 與相對路徑另由規格決定）。
  expect(cardWrites({ tool: 'Bash', command: `x=/a/.desk/CARD.md; sed -i '' s/a/b/ ~/wt/a/.desk/CARD.md wt/b/.desk/CARD.md "/my wt/c/.desk/CARD.md"` }, [])).toEqual(['/a/.desk/CARD.md'])
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
