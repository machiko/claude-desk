import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, PANE, CARD_A, CARD_B, CARD_C, REGISTRY, NOW, result, text, flat } from './fixture'
import { historyEntries } from '../hooks/extras'
import { issueOf, hhmm } from '../hooks/model'
import type { Case, FeedEvent } from '../types'

// 面板的「最近」改成「歷程」：顯示現在這件卡片的 History（預設最新 3 筆，x 展開全部）；
// desk 自己的動態只在最新一筆是錯誤或警告時，在歷程上方多一行說原因。
const ALPHA = '/home/u/wt/alpha'
const CARD_OLD = '/home/u/wt/delta/.console/STATUS.md'
const screen = async (ui: any) => flat(text(await ui.drawn()))
const LONG = '第五筆：PR 已開，這一筆寫得很長，' + '把審查意見、測試數字與檔案清單都塞了進來，'.repeat(6) + '最後一句是結尾'

/** 卡片尾巴的 History：由舊到新寫，最前面還留著模板的佔位；後面還有別的段落，歷程不能讀過頭。 */
const HISTORY = [
  '## History',
  '',
  '- YYYY-MM-DD：',
  '- 2030-01-01：第一筆：開卡',
  '- 2030-01-02：第二筆：規格確認',
  '- 2030-01-03：第三筆：實作第一版',
  '- 2030-01-04：第四筆：審查有 HIGH，修正',
  `- 2030-01-05：${LONG}`,
  '',
  '## 備註',
  '',
  '- 這行不是歷程',
].join('\n')

/** 舊格式卡（.console/STATUS.md、舊欄位名）：History 新舊混排，有「日期 rev n 執行者更新：…」這種寫法。 */
const OLD_CARD = [
  '<!-- DESK -->',
  '- 狀態：Delta 舊卡',
  '- 驗證：無',
  '- 等使用者：無',
  '- 下一步：無',
  '- 關卡：無',
  '<!-- /DESK -->',
  '',
  '## History',
  '',
  '- 2026-10-29：同日較早寫的',
  '- 2026-10-27：最舊的一筆',
  '- 2026-10-28：中間的一筆',
  '- 2026-10-29 rev 43 執行者更新：同日最後寫的',
].join('\n')

/** Alpha（有 History）、Beta、Gamma（沒有 History）、Delta（舊格式卡）；沒有等你、沒有 Agent，完成檢查已核准。 */
function setup(data: any, clock: any) {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Beta | \`${CARD_B}\` |\n| Gamma | \`${CARD_C}\` |\n| Delta | \`${CARD_OLD}\` |`
  data.files[CARD_A] = `${data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')}\n\n${HISTORY}\n`
  data.files[CARD_OLD] = OLD_CARD
  data.mtimes[CARD_OLD] = NOW - 5 * 86_400_000
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.agents = []
  data.gh = []
  let n = 0
  data.launch = async (e: any) => {
    n++
    const id = `a000000${n}`
    data.agents = [{ id, kind: 'background', cwd: ALPHA, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
}

function helpers($: any, clock: any) {
  const run = async (args: string) => { await $.command.run({ command: 'desk', args } as any); await clock.settle() }
  return {
    run,
    refresh: () => run('refresh'),
    /** 讓時間往前走一分鐘：每個事件的時間都不同，問題列比的是誰比較新。 */
    later: async () => { await clock.advance(60_000); await clock.settle() },
  }
}

/** 問題列：畫面上那一行「時:分  動態」，用動態的顏色。 */
async function issueRow(ui: any, pattern: RegExp) {
  return (await ui.findAll({ type: 'Text' })).find((n: any) => pattern.test(String(n.text ?? '')) && (n.props?.color === 'error' || n.props?.color === 'warning'))
}

test('test_history_section_shows_latest_three_entries_newest_first', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  setup(data, clock)
  const h = helpers($, clock)
  await h.refresh()
  // 一般事件：檢查通過、派繼續、開始執行（都有記進動態，面板不顯示）
  await h.run('verify Alpha')
  await h.later()
  await h.run('go Alpha')
  await h.refresh()
  expect(log.has('Alpha 檢查通過')).toBe(true)
  expect(log.has('Alpha 派繼續')).toBe(true)

  for (const columns of [160, 72]) {
    const ui = await $.ui.mount(PANE(columns))
    await ui.press({ key: `row-${CARD_A}` })
    const shown = await screen(ui)
    // 標題「歷程」，不再有「最近」；右邊寫還有幾筆
    expect(shown, `${columns}`).toContain(flat('歷程'))
    expect(shown, `${columns}`).not.toContain('最近')
    expect(shown, `${columns}`).toContain(flat('還有 2 筆（x 展開）'))
    // 最新 3 筆、新的在前，每筆「月-日  內容」
    const at = (s: string) => shown.indexOf(flat(s))
    expect(at('01-05  第五筆：PR 已開'), `${columns}`).toBeGreaterThan(-1)
    expect(at('01-04  第四筆：審查有 HIGH，修正')).toBeGreaterThan(at('01-05  第五筆'))
    expect(at('01-03  第三筆：實作第一版')).toBeGreaterThan(at('01-04  第四筆'))
    expect(shown).not.toContain(flat('第二筆'))
    expect(shown).not.toContain(flat('第一筆'))
    // 太長就截斷成一行；模板佔位與別的段落都不顯示
    expect(shown).not.toContain(flat('最後一句是結尾'))
    const row = (await ui.findAll({ type: 'Text' })).find((n: any) => String(n.text ?? '').startsWith('第五筆'))
    expect(row?.text).toMatch(/…$/)
    expect(shown).not.toContain('YYYY')
    expect(shown).not.toContain(flat('這行不是歷程'))
    // 一般事件不出現在面板
    expect(shown).not.toContain(flat('Alpha 檢查通過'))
    expect(shown).not.toContain(flat('Alpha 派繼續'))
    expect(shown).not.toContain(flat('Alpha 開始執行'))
    await ui.unmount()
  }
})

test('test_expanded_history_shows_every_entry_in_full', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, clock)
  await helpers($, clock).refresh()
  const ui = await $.ui.mount(PANE(100))
  await ui.press({ key: `row-${CARD_A}` })

  // 按 x：全部 5 筆、新的在前，長的那筆換行顯示全文
  await ui.press({ key: 'expand' })
  let shown = await screen(ui)
  const at = (s: string) => shown.indexOf(flat(s))
  expect(at(`01-05  ${LONG}`)).toBeGreaterThan(-1)
  expect(at('01-04  第四筆')).toBeGreaterThan(at('01-05  第五筆'))
  expect(at('01-03  第三筆')).toBeGreaterThan(at('01-04  第四筆'))
  expect(at('01-02  第二筆：規格確認')).toBeGreaterThan(at('01-03  第三筆'))
  expect(at('01-01  第一筆：開卡')).toBeGreaterThan(at('01-02  第二筆'))
  expect(shown).not.toContain(flat('還有 2 筆'))
  const longRows = (await ui.findAll({ type: 'Text' })).filter((n: any) => LONG.includes(String(n.text ?? '')) && String(n.text ?? '').length > 4)
  expect(longRows.length).toBeGreaterThan(1)
  expect(longRows.every((n: any) => !String(n.text).endsWith('…'))).toBe(true)

  // 再按 x：回到 3 筆
  await ui.press({ key: 'expand' })
  shown = await screen(ui)
  expect(shown).toContain(flat('還有 2 筆（x 展開）'))
  expect(shown).not.toContain(flat('第二筆'))
  expect(shown).not.toContain(flat('最後一句是結尾'))

  // 舊格式卡：照日期由新到舊，同一天照卡片裡由後往前；日期欄「10-29」、內容去掉日期
  await ui.press({ key: `row-${CARD_OLD}` })
  shown = await screen(ui)
  expect(at('10-29  rev 43 執行者更新：同日最後寫的')).toBeGreaterThan(-1)
  expect(at('10-29  同日較早寫的')).toBeGreaterThan(at('10-29  rev 43'))
  expect(at('10-28  中間的一筆')).toBeGreaterThan(at('10-29  同日較早寫的'))
  expect(shown).toContain(flat('還有 1 筆（x 展開）'))
  await ui.press({ key: 'expand' })
  shown = await screen(ui)
  expect(at('10-27  最舊的一筆')).toBeGreaterThan(at('10-28  中間的一筆'))
  expect(shown).not.toContain(flat('還有'))
  await ui.press({ key: 'expand' })

  // 沒有 History 的卡：不顯示歷程列
  await ui.press({ key: `row-${CARD_C}` })
  shown = await screen(ui)
  expect(shown).not.toContain(flat('歷程'))
  await ui.unmount()
})

test('test_issue_line_shows_only_the_latest_unresolved_error_or_warning', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, clock)
  // fixture 的 claude plugin 查不到安裝：/desk update 會記一筆不屬於任何一件的「desk 無法更新」
  const run = data.run
  const h = helpers($, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(120))
  await ui.press({ key: `row-${CARD_A}` })

  // 派工失敗（錯誤）
  data.launch = async () => result(1, '', 'launch boom')
  const failedAt = clock.now()
  await h.run('go Alpha')
  let shown = await screen(ui)
  expect(shown).toContain(flat(`${hhmm(failedAt)}  Alpha 繼續失敗：launch boom`))
  expect(await issueRow(ui, /Alpha 繼續失敗/)).toBeDefined()
  // 之後檢查沒過（錯誤）：只看到第二個
  await h.later()
  data.run = async (e: any) => e.argv[0] === 'sh' ? result(1, 'FAILED\n') : run(e)
  await h.run('verify Alpha')
  shown = await screen(ui)
  expect(shown).toContain(flat('Alpha 檢查未通過（exit 1）'))
  expect(shown).not.toContain(flat('Alpha 繼續失敗'))
  expect(await issueRow(ui, /Alpha 檢查未通過/)).toBeDefined()
  // 一般事件（檢查通過）之後，問題列消失
  await h.later()
  data.run = async (e: any) => e.argv[0] === 'sh' ? result(0, 'ok\n') : run(e)
  await h.run('verify Alpha')
  shown = await screen(ui)
  expect(shown).not.toContain(flat('Alpha 檢查未通過'))
  expect(shown).not.toContain(flat('Alpha 繼續失敗'))
  expect(shown).not.toContain(flat('Alpha 檢查通過'))

  // 不屬於任何一件的：比這件最新的錯誤新，就顯示它
  await h.later()
  data.run = async (e: any) => e.argv[0] === 'sh' ? result(1, 'FAILED\n') : run(e)
  await h.run('update')
  shown = await screen(ui)
  expect(shown).toContain(flat('desk 無法更新'))
  expect(await issueRow(ui, /desk 無法更新/)).toBeDefined()
  // 這件之後又有錯誤：換成這件的，只有一行
  await h.later()
  await h.run('verify Alpha')
  shown = await screen(ui)
  expect(shown).toContain(flat('Alpha 檢查未通過（exit 1）'))
  expect(shown).not.toContain(flat('desk 無法更新'))
  await ui.unmount()
})

test('test_chain_pause_reason_is_not_replaced_by_generic_failure', async ($, on) => {
  const { data, clock } = fixture(on)
  const sent: string[] = []
  on('ui.notify', (_: any, e: any) => { sent.push(e.text); return { value: { isSent: true as const, channel: 'terminal_bell' as const } } })
  setup(data, clock)
  const h = helpers($, clock)
  await h.refresh()
  // 一、Alpha 的自動流程：Agent 做完、檢查通過、要派審查時 worktree 有別人改的 3 個檔 → 暫停
  await h.run('go Alpha')
  data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
  await h.refresh()
  data.git[ALPHA]!.changed = 3
  await clock.advance(2500); await clock.settle()
  await clock.advance(2500); await clock.settle()
  expect((data.store.chains as any)[ALPHA].stopped).toContain('3 個檔')
  // 下一次重新整理之後
  await h.refresh()
  await h.refresh()
  const ui = await $.ui.mount(PANE(120))
  await ui.press({ key: `row-${CARD_A}` })
  let shown = await screen(ui)
  expect(shown).toContain(flat('Alpha 流程已暫停：worktree 有未提交的改動（3 個檔）'))
  expect(shown).not.toContain(flat('Alpha 檢查未通過'))
  expect(await issueRow(ui, /Alpha 流程已暫停/)).toBeDefined()
  const aboutAlpha = (list: string[]) => list.filter(t => t.startsWith('Alpha') && (t.includes('流程已暫停') || t.includes('檢查未通過')))
  expect(aboutAlpha(data.toasts)).toHaveLength(1)
  expect(aboutAlpha(sent)).toHaveLength(1)

  // 二、Gamma 按 v 檢查沒過：問題列是「檢查未通過（exit n）」
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 驗證：無', '- 驗證：`npm test`').replace('- 下一步：無', '- 下一步：修測試')
  data.store.trustedVerify = { ...data.store.trustedVerify, [CARD_C]: 'npm test' }
  const run = data.run
  data.run = async (e: any) => e.argv[0] === 'sh' ? result(2, 'FAILED\n') : run(e)
  await h.refresh()
  await h.run('verify Gamma')
  await h.refresh()
  await ui.press({ key: `row-${CARD_C}` })
  shown = await screen(ui)
  expect(shown).toContain(flat('Gamma 檢查未通過（exit 2）'))
  expect(await issueRow(ui, /Gamma 檢查未通過（exit 2）/)).toBeDefined()
  expect(data.toasts.filter((t: string) => t.startsWith('Gamma') && t.includes('檢查未通過'))).toHaveLength(1)

  // 三、Beta 沒有自動流程、手動審查結論有 HIGH：「Beta 審查有要修的問題」，照舊跳 toast 與通知
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', '- 關卡：review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；要修')
  await h.refresh()
  await ui.press({ key: `row-${CARD_B}` })
  shown = await screen(ui)
  expect(shown).toContain(flat('Beta 審查有要修的問題'))
  expect(shown).not.toContain(flat('Beta 檢查未通過'))
  expect(await issueRow(ui, /Beta 審查有要修的問題/)).toBeDefined()
  expect(data.toasts).toContain('Beta 審查有要修的問題')
  expect(sent).toContain('Beta 審查有要修的問題')
  await ui.unmount()
})

/** 按 v 檢查沒過送一次通知（README「通知」那條；審查 MEDIUM，D-04）；通過不送，之後重新整理也不再送。 */
test('test_manual_check_failure_sends_one_notification', async ($, on) => {
  const { data, clock } = fixture(on)
  const sent: string[] = []
  on('ui.notify', (_: any, e: any) => { sent.push(e.text); return { value: { isSent: true as const, channel: 'terminal_bell' as const } } })
  setup(data, clock)
  const h = helpers($, clock)
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 驗證：無', '- 驗證：`npm test`').replace('- 下一步：無', '- 下一步：修測試')
  data.store.trustedVerify = { ...data.store.trustedVerify, [CARD_C]: 'npm test' }
  const run = data.run
  const aboutGamma = () => sent.filter(t => t.startsWith('Gamma'))
  await h.refresh()

  data.run = async (e: any) => e.argv[0] === 'sh' ? result(0, 'ok\n') : run(e)
  await h.run('verify Gamma')
  await h.refresh()
  expect(aboutGamma()).toEqual([])

  data.run = async (e: any) => e.argv[0] === 'sh' ? result(2, 'FAILED\n') : run(e)
  await h.run('verify Gamma')
  await h.refresh()
  await h.refresh()
  expect(aboutGamma()).toEqual(['Gamma：檢查未通過（exit 2）'])
})

/** 同一件連按兩次 v 都沒過、exit 碼一樣：每按一次送一則，不被同一句去重（審查 MEDIUM，D-05）；重新整理不補送。 */
test('test_each_failed_manual_check_sends_its_own_notification', async ($, on) => {
  const { data, clock } = fixture(on)
  const sent: string[] = []
  on('ui.notify', (_: any, e: any) => { sent.push(e.text); return { value: { isSent: true as const, channel: 'terminal_bell' as const } } })
  setup(data, clock)
  const h = helpers($, clock)
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 驗證：無', '- 驗證：`npm test`').replace('- 下一步：無', '- 下一步：修測試')
  data.store.trustedVerify = { ...data.store.trustedVerify, [CARD_C]: 'npm test' }
  const run = data.run
  data.run = async (e: any) => e.argv[0] === 'sh' ? result(1, 'FAILED\n') : run(e)
  const aboutGamma = () => sent.filter(t => t.startsWith('Gamma'))
  await h.refresh()

  await h.run('verify Gamma')
  await h.refresh()
  await h.run('verify Gamma')
  await h.refresh()
  await h.refresh()

  expect(aboutGamma()).toEqual(['Gamma：檢查未通過（exit 1）', 'Gamma：檢查未通過（exit 1）'])
})

test('test_history_reads_only_the_focused_card_and_never_writes_it', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  setup(data, clock)
  data.files[CARD_B] = `${data.files[CARD_B]!}\n\n## History\n\n- 2030-01-04：Beta 的私事：別處的歷程\n`
  const before = { [CARD_A]: data.files[CARD_A], [CARD_B]: data.files[CARD_B] }
  const h = helpers($, clock)
  await h.refresh()
  // Beta 有一筆錯誤動態
  data.launch = async () => result(1, '', 'beta launch boom')
  await h.run('go Beta')
  expect(log.list.some(e => e.card === CARD_B && e.tone === 'error' && e.text.includes('beta launch boom'))).toBe(true)
  const ui = await $.ui.mount(PANE(120))
  await ui.press({ key: `row-${CARD_A}` })
  const check = async () => {
    const shown = await screen(ui)
    expect(shown).toContain(flat('第五筆'))
    expect(shown).not.toContain(flat('Beta 的私事'))
    expect(shown).not.toContain(flat('beta launch boom'))
    expect(shown).not.toContain(flat('Beta 繼續失敗'))
  }
  await check()
  await ui.press({ key: 'expand' })
  await check()
  await h.refresh()
  await check()
  await h.refresh()
  await ui.press({ key: 'expand' })
  await check()
  await ui.unmount()
  // 面板只讀不寫：兩張卡片一字不變
  expect(data.files[CARD_A]).toBe(before[CARD_A])
  expect(data.files[CARD_B]).toBe(before[CARD_B])
  expect(data.writes.filter((p: string) => p === CARD_A || p === CARD_B)).toEqual([])
})

// ── 純函式 ──

test('history entries: placeholder, continuation lines, old mixed format and undated entries', () => {
  expect(historyEntries(null)).toEqual([])
  expect(historyEntries('- 狀態：沒有歷程段')).toEqual([])
  const card = [
    '## History',
    '- YYYY-MM-DD：',
    '- 2030-01-01：',
    '- 2030-01-02：第一行',
    '  接著的續行',
    '- 沒有日期的一筆',
    '- 2030-01-01: 半形冒號',
    '- 2030-01-03 rev 7 執行者更新：舊寫法',
    '## Decisions',
    '- 2030-01-09：不是歷程',
  ].join('\r\n')
  expect(historyEntries(card)).toEqual([
    { date: '2030-01-03', text: 'rev 7 執行者更新：舊寫法' },
    { date: '2030-01-02', text: '第一行 接著的續行' },
    { date: '2030-01-01', text: '半形冒號' },
    { text: '沒有日期的一筆' },
  ])
})

test('issue line: latest error or warning of the focused case or of no case, whichever is newer', () => {
  const ev = (text: string, tone: FeedEvent['tone'], at: number, card?: string): FeedEvent => ({ at, text, tone, ...(card ? { card } : {}) })
  const alpha = { statusPath: CARD_A } as Case
  // feed 新的在前
  expect(issueOf([], alpha)).toBeNull()
  expect(issueOf([ev('A 檢查通過', 'success', 3, CARD_A), ev('A 派工失敗', 'error', 2, CARD_A)], alpha)).toBeNull()
  expect(issueOf([ev('A 排隊沒派出', 'error', 3, CARD_A), ev('A 派工失敗', 'error', 2, CARD_A)], alpha)?.text).toBe('A 排隊沒派出')
  expect(issueOf([ev('B 壞了', 'error', 5, CARD_B), ev('A 檢查通過', 'success', 3, CARD_A)], alpha)).toBeNull()
  expect(issueOf([ev('desk 無法更新', 'warning', 4), ev('A 派工失敗', 'error', 2, CARD_A)], alpha)?.text).toBe('desk 無法更新')
  expect(issueOf([ev('A 派工失敗', 'error', 6, CARD_A), ev('desk 無法更新', 'warning', 4)], alpha)?.text).toBe('A 派工失敗')
  expect(issueOf([ev('desk 已更新', 'success', 7), ev('A 派工失敗', 'error', 2, CARD_A)], alpha)?.text).toBe('A 派工失敗')
  expect(issueOf([ev('desk 無法更新', 'warning', 4)], null)?.text).toBe('desk 無法更新')
})

/** 審查 MEDIUM：已解掉的「等你」或關卡警告不再留在問題列；淡色事件（Agent 已完成）不會收掉停止原因。 */
test('test_issue_line_drops_resolved_state_warnings_and_ignores_faint_events', () => {
  const ev = (text: string, tone: FeedEvent['tone'], at: number, card?: string, whileState?: FeedEvent['whileState']): FeedEvent => ({ at, text, tone, ...(card ? { card } : {}), ...(whileState ? { whileState } : {}) })
  const at = (state: Case['state']) => ({ statusPath: CARD_A, state }) as Case

  const asked = [ev('A 等你：要嗎？', 'warning', 3, CARD_A, 'ask')]
  const gated = [ev('A 進入關卡：spec', 'warning', 3, CARD_A, 'gate')]
  const stopped = [ev('A Agent 已完成', 'subtle', 5, CARD_A), ev('A 流程已暫停：Agent 被停掉', 'error', 4, CARD_A)]

  expect(issueOf(asked, at('ask'))?.text).toBe('A 等你：要嗎？')
  expect(issueOf(asked, at('ready'))).toBeNull()
  expect(issueOf(gated, at('gate'))?.text).toBe('A 進入關卡：spec')
  expect(issueOf(gated, at('running'))).toBeNull()
  expect(issueOf(stopped, at('failed'))?.text).toBe('A 流程已暫停：Agent 被停掉')
  expect(issueOf([ev('A 檢查通過', 'success', 6, CARD_A), ...stopped], at('ready'))).toBeNull()
  expect(issueOf([ev('desk 加入', 'subtle', 9), ev('desk 無法更新', 'warning', 8)], at('ready'))?.text).toBe('desk 無法更新')
})
