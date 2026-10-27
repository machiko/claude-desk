import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, NOW, PROJECT_DIR, REGISTRY, result } from './fixture'
import { appendTo, setFields } from '../hooks/tutorial'

// 面板做了會改變任務狀態的操作（歸檔、確認規格、上線確認、檢查、派工）：下一則你打的提示附上「面板在對話外做了」那段。

const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const HEAD = '面板在對話外做了'
const ARCHIVED = `${PROJECT_DIR}/archive/beta-CARD.md`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
const PR_MERGED = [{ number: 12, state: 'MERGED', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [] }]
/** 最後一則提示附的內容。 */
const lastContext = (data: any) => (data.submitted.at(-1)?.context ?? []).join('\n')
/** 附上的那段裡，一筆操作的那一行：`- HH:MM 「任務」結果`。 */
const line = (name: string, what: string) => new RegExp(`- \\d\\d:\\d\\d 「${name}」${what.replace(/[()（）]/g, '\\$&')}`)

/** 點那件的列，讓它成為現在卡；已經是現在卡的沒有列可點。 */
async function focus(ui: any, card: string) {
  if (await ui.find({ key: `row-${card}` })) await ui.press({ key: `row-${card}` })
}

/** Beta 已合併、可歸檔；/desk:card archive 的效果照 archive.test 的做法模擬（腳本本身在 skills/card/tests 驗）。 */
function archivable(data: any, ok = true) {
  data.agents = []
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED)
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git', tag: 'v0.19.0' }
  data.gh = PR_MERGED
  data.run = async (e: any) => {
    if (!e.argv.includes('archive')) return result(0, '')
    if (!ok) return result(1, '', 'error: 登錄表沒有 beta 這一列')
    data.files[ARCHIVED] = data.files[CARD_B]!
    data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Gamma | \`${CARD_C}\` |`
    return result(0, `歸檔完成：${PROJECT_DIR}/archive（登錄表移除 1 列）\n`)
  }
}

/** 在面板點 Beta、按兩次「⌫ 歸檔」。 */
async function archiveBeta($: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  await ui.press({ key: `case-${CARD_B}-archive` })
  await ui.press({ key: `case-${CARD_B}-archive` })
  await clock.settle()
  return ui
}

test('test_panel_archive_is_attached_to_next_typed_prompt', async ($, on) => {
  const { data, clock } = fixture(on)
  archivable(data)
  const ui = await archiveBeta($, clock)
  // 歸檔後 Beta 離開工作桌：沒有選取中的任務，照樣附。
  await $.prompt.submit({ text: '接下來做什麼？' } as any)
  const context = lastContext(data)
  expect(context).toContain(HEAD)
  expect(context).toMatch(line('Beta', '已歸檔（worktree 與分支保留）'))
  await ui.unmount()
})

test('test_panel_actions_attach_in_order_with_case_and_result', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  // Beta 停在規格關卡；Gamma 等上線確認（v0.2.0 已打）；Alpha 沒有決策，可以檢查與派實作。
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', '- 關卡：spec：待確認規格（AC-1～AC-2）') + '\n\n## Decisions\n\n- D-01 2030-01-05 Alex：只匯出 CSV\n\n## History\n\n- 2030-01-05：產生規格草稿\n'
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 驗證：無', '- 驗證：`npm test`').replace('- 關卡：無', '- 關卡：release：v0.2.0 待上線確認') + '\n\n## History\n\n- 2030-01-04：合併\n'
  data.git[GAMMA] = { branch: 'feature/c', head: 'h1', tag: 'v0.2.0' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.run = async (e: any) => {
    if (!e.argv.includes('spec-ok')) return result(0, '')
    const withGate = setFields(data.files[CARD_B]!, { 關卡: '無', 狀態: '規格已確認（AC-1～AC-2），可派實作' })
    data.files[CARD_B] = appendTo(withGate, '## History', '- 2030-01-05：規格確認')
    return result(0, '規格已確認\n')
  }
  data.launch = async (e: any) => {
    data.agents = [{ id: 'aaaaaaaa', kind: 'background', cwd: '/home/u/wt/alpha', name: e.argv[3], sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: NOW }]
    return result(0, 'aaaaaaaa\n')
  }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  const twice = async (row: string, key: string) => {
    await focus(ui, row)
    await ui.press({ key }); await ui.press({ key })
    await clock.settle()
    await clock.advance(60_000)
  }
  await twice(CARD_B, `case-${CARD_B}-spec-ok`)
  await twice(CARD_C, `case-${CARD_C}-ship`)
  await focus(ui, CARD_A)
  await ui.press({ key: 'more' })
  await ui.press({ key: `case-${CARD_A}-verify` })
  await clock.settle()
  await clock.advance(60_000)
  await twice(CARD_A, `case-${CARD_A}-continue`)
  expect(data.launches.length).toBe(1)
  await $.prompt.submit({ text: '現在狀況？' } as any)
  const context = lastContext(data)
  const order = [line('Beta', '規格已確認，可以派實作'), line('Gamma', '已確認上線（v0.2.0）'), line('Alpha', '檢查通過'), line('Alpha', '派繼續')]
  const at = order.map(re => context.search(re))
  expect(at.every(i => i >= 0)).toBe(true)
  expect([...at].sort((x, y) => x - y)).toEqual(at)
  await ui.unmount()
})

test('test_attached_panel_actions_are_not_repeated', async ($, on) => {
  const { data, clock } = fixture(on)
  archivable(data)
  const ui = await archiveBeta($, clock)
  await $.prompt.submit({ text: '第一則' } as any)
  expect(lastContext(data)).toMatch(line('Beta', '已歸檔'))
  await $.prompt.submit({ text: '第二則' } as any)
  expect(lastContext(data)).not.toContain(HEAD)
  // 之後在面板又做了一件：只附新的那筆。
  await focus(ui, CARD_A)
  await ui.press({ key: 'more' })
  await ui.press({ key: `case-${CARD_A}-verify` })
  await clock.settle()
  await ui.press({ key: `row-${CARD_C}` })
  await $.prompt.submit({ text: '第三則' } as any)
  const third = lastContext(data)
  expect(third).toMatch(line('Alpha', '檢查通過'))
  expect(third).not.toContain('已歸檔')
  // 有選取任務時也附：卡片之外再加這一段。
  expect(third).toContain('選了任務「Gamma」')
  await ui.unmount()
})

test('test_failed_panel_action_is_attached_as_failure', async ($, on) => {
  const { data, clock } = fixture(on)
  archivable(data, false)
  const ui = await archiveBeta($, clock)
  await $.prompt.submit({ text: 'Beta 歸檔好了嗎？' } as any)
  const context = lastContext(data)
  expect(context).toMatch(line('Beta', '歸檔失敗：.*登錄表沒有 beta 這一列'))
  expect(context).not.toMatch(line('Beta', '已歸檔'))
  await ui.unmount()
})

test('test_panel_actions_wait_for_a_typed_prompt', async ($, on) => {
  const { data, clock } = fixture(on)
  archivable(data)
  const ui = await archiveBeta($, clock)
  await $.prompt.submit({ text: '隊友：看一下 Beta', origin: { kind: 'unclassified' } } as any)
  expect(lastContext(data)).not.toContain(HEAD)
  await $.prompt.submit({ text: '背景工作完成', origin: { kind: 'task-notification' } } as any)
  expect(lastContext(data)).not.toContain(HEAD)
  await $.prompt.submit({ text: '閒置通知', origin: { kind: 'composer' }, isMeta: true } as any)
  expect(lastContext(data)).not.toContain(HEAD)
  await $.prompt.submit({ text: '/desk:card spec alpha', command: { name: 'desk:card', args: 'spec alpha' } } as any)
  expect(lastContext(data)).not.toContain(HEAD)
  // 都不算附過：你打的下一則才附。
  await $.prompt.submit({ text: '我打的', origin: { kind: 'composer' } } as any)
  expect(lastContext(data)).toMatch(line('Beta', '已歸檔（worktree 與分支保留）'))
  await ui.unmount()
})
