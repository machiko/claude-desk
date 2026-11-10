// 格式版本標記：卡片與登錄表帶格式版號；讀到比這版認得的新的格式時，動態警告一次、那張卡不派工（docs/FORMATS.md）。
import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, flat, text, PANE, CARD_A, REGISTRY, result } from './fixture'
import { REGISTRY_TEMPLATE, parseCard, parseRegistry } from '../hooks/card'
import { CARD_FORMAT, NEWER_CARD_WHY, REGISTRY_FORMAT, cardFormat, newerFormatNotices, newerFormatText, registryFormat } from '../hooks/formats'
import { TURN_TEXT } from '../hooks/turn'

/** 格式版本標記 AC-1：新卡（模板的開頭標記）與新建的空登錄表帶格式 1 的標記；區塊與表格的解析跟沒有標記時一樣。 */
test('test_new_card_and_registry_carry_format_marker', () => {
  const body = '\n- 狀態：開卡\n- 檢查：`make test`\n- 等你：無\n- 下一步：<可以直接派給 Agent 的一件事>\n- 關卡：無\n<!-- /DESK -->\n'
  const marked = `# 訂單匯出 DESK\n\n<!-- DESK 格式=1：工作桌只讀這個區塊。五個中文欄位名是解析契約，不可改名；每欄一行。 -->${body}`
  const unmarked = `# 訂單匯出 DESK\n\n<!-- DESK: 工作桌只讀這個區塊。五個中文欄位名是解析契約，不可改名；每欄一行。 -->${body}`
  expect(cardFormat(marked)).toBe(CARD_FORMAT)
  expect(parseCard(marked)).toEqual(parseCard(unmarked))
  expect(parseCard(marked)?.['關卡']).toBe('無')

  expect(REGISTRY_TEMPLATE.split('\n')[1]).toBe('<!-- desk 登錄表 格式=1 -->')
  expect(registryFormat(REGISTRY_TEMPLATE)).toBe(REGISTRY_FORMAT)
  const row = '| 訂單匯出 | `/w/order-export/.desk/CARD.md` | | | |\n'
  expect(parseRegistry(REGISTRY_TEMPLATE, '/home/u')).toEqual([])
  expect(parseRegistry(`${REGISTRY_TEMPLATE}${row}`, '/home/u')).toEqual([{ name: '訂單匯出', statusPath: '/w/order-export/.desk/CARD.md' }])
  // 沒有標記的既有登錄表當格式 1
  expect(registryFormat('# 任務登錄表\n\n| Project | 卡片路徑 |\n| --- | --- |\n')).toBe(1)
})

/** 格式版本標記 AC-2：較新格式的卡警告一次（寫卡名）、照常顯示、不自動派工；手動派工也拒絕。/desk off 清掉報過的紀錄，重開再報。 */
test('test_newer_card_format_warns_once_and_blocks_auto_dispatch', async ($, on) => {
  const { data, clock } = fixture(on)
  const feed = feedLog(on)
  // 登錄表只留 Alpha：面板的現在卡就是它
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |`
  data.git['/home/u/wt/alpha'] = { branch: 'feature/alpha', head: 'h1' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.agents = []
  data.launch = async (e: any) => {
    data.agents = [{ id: 'a0000001', kind: 'background', cwd: '/home/u/wt/alpha', name: e.argv[3], sessionId: 'a0000001-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, 'a0000001')
  }
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const warning = newerFormatText({ kind: 'card', path: CARD_A, name: 'Alpha', format: 2 })
  const warnings = () => feed.list.filter(e => e.text === warning)

  await refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(1)

  // 實作做完時，卡片被較新版 desk 改成格式 2：不跑自動檢查、不派審查
  data.files[CARD_A] = data.files[CARD_A]!.replace('<!-- DESK -->', '<!-- DESK 格式=2：工作桌只讀這個區塊。 -->')
  data.agents = data.agents.map(a => ({ ...a, status: 'idle', state: 'done' }))
  await refresh()
  await step(); await step(); await step()
  expect(data.processCalls.filter(c => c.argv[0] === 'sh')).toHaveLength(0)
  expect(data.launches.length).toBe(1)

  // 動態警告一次、寫卡名；連續重新整理不再報
  await refresh()
  expect(warnings()).toHaveLength(1)
  expect(warnings()[0]).toMatchObject({ tone: 'warning', card: CARD_A })
  expect(warning).toContain('「Alpha」')
  expect(warning).toContain('請更新 desk')
  expect(data.toasts.filter(t => t === warning)).toHaveLength(1)

  // 照常顯示：卡片在面板上，「輪到你」說要先更新 desk
  const ui = await $.ui.mount(PANE(100))
  const shown = flat(text(await ui.drawn()))
  expect(shown).toContain(flat('Alpha'))
  expect(shown).toContain(flat(TURN_TEXT.newerFormat()))
  await ui.unmount()

  // 手動派工也拒絕，說原因與下一步
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(1)
  expect(data.toasts).toContain(`Alpha：無法繼續（${NEWER_CARD_WHY}）；輸入 /desk update 更新 desk`)

  // /desk off 清掉報過的紀錄：重開後再報一次
  await $.command.run({ command: 'desk', args: 'off' } as any)
  await refresh()
  expect(warnings()).toHaveLength(2)
  await refresh()
  expect(warnings()).toHaveLength(2)

  // 卡片回到認得的格式：不再擋派工、不再報
  data.files[CARD_A] = data.files[CARD_A]!.replace('<!-- DESK 格式=2：工作桌只讀這個區塊。 -->', '<!-- DESK 格式=1：工作桌只讀這個區塊。 -->')
  await refresh()
  expect(warnings()).toHaveLength(2)
})

/** 格式版本標記 AC-4：登錄表標記是格式 2 時動態警告一次，表格照常讀；格式 1 與沒有標記不報。 */
test('test_newer_registry_format_warns_once', async ($, on) => {
  const { data, clock } = fixture(on)
  const feed = feedLog(on)
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  const warning = newerFormatText({ kind: 'registry', path: REGISTRY, format: 2 })
  const original = data.files[REGISTRY]!

  data.files[REGISTRY] = original.replace('## 任務\n', '## 任務\n<!-- desk 登錄表 格式=1 -->\n')
  await refresh()
  expect(feed.list.some(e => e.text.includes('較新版 desk'))).toBe(false)

  data.files[REGISTRY] = original.replace('## 任務\n', '## 任務\n<!-- desk 登錄表 格式=2 -->\n')
  await refresh()
  await refresh()
  expect(feed.list.filter(e => e.text === warning)).toHaveLength(1)
  expect(warning).toBe(`登錄表 ${REGISTRY} 是較新版 desk 的格式（格式 2），請更新 desk`)
  expect(data.toasts.filter(t => t === warning)).toHaveLength(1)
  // 表格照常讀：三件都在
  const ui = await $.ui.mount(PANE(100))
  const shown = flat(text(await ui.drawn()))
  for (const name of ['Alpha', 'Beta', 'Gamma']) expect(shown).toContain(name)
  await ui.unmount()
})

/** 較新格式的動態：同一份檔同一個版號只報一次；版號變了再報；回到認得的格式就從紀錄拿掉，之後再變新又報。 */
test('newerFormatNotices reports each file and version once', () => {
  const card = { kind: 'card' as const, path: CARD_A, name: 'Alpha', format: 2 }
  const first = newerFormatNotices([card], {}, 1)
  expect(first.events).toEqual([{ at: 1, text: newerFormatText(card), tone: 'warning', card: CARD_A }])
  const again = newerFormatNotices([card], first.seen, 2)
  expect(again.events).toEqual([])
  const bumped = newerFormatNotices([{ ...card, format: 3 }], again.seen, 3)
  expect(bumped.events).toHaveLength(1)
  const back = newerFormatNotices([], bumped.seen, 4)
  expect(back).toEqual({ seen: {}, events: [] })
  expect(newerFormatNotices([{ ...card, format: 3 }], back.seen, 5).events).toHaveLength(1)
})
