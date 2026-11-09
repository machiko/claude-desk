import { expect, test } from 'claude-code/testing'
import { feedLog, fixture, PANE, PROJECT_DIR, result, text, flat } from './fixture'
declare const console: { log: (...args: unknown[]) => void }
import { cardAfter, cardAfterDecision, cardText, setFields, tutorialPaths, TUTORIAL_INTRO, TUTORIAL_TAG } from '../hooks/tutorial'

const P = tutorialPaths('/home/u')
const KEY = (what: string) => `case-${P.card}-${what}`
/** 模擬驗收寫進卡片 History 的筆數（每輪驗收一筆）。 */
const reviewRounds = (card: string | undefined) => (String(card).match(/（教學驗收）/g) ?? []).length

// 端到端走完六段：單獨跑約 0.8 秒，整套 50 檔並行時實測 2～5.6 秒，預設 5 秒會偶發逾時。
// 單獨跑超過 2 秒就該查效能，不是再調上限。
test('the tutorial walks all six stages with scripted agents, never launches claude, and cleans up', { timeoutMs: 15000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  data.git[P.wt] = { branch: 'feature/discount', head: 'h0' }
  data.git[P.main] = { branch: 'release/v1.0', head: 'm0' }
  // /desk:card spec-ok 是真的腳本；這裡照它的效果改卡片。
  data.run = async (e: any) => {
    if (e.argv.includes('spec-ok')) { data.files[P.card] = setFields(data.files[P.card]!, { 關卡: '無', 狀態: '規格已確認（AC-1～AC-3），可派實作' }); return result(0, 'ok\n') }
    return result(0, '')
  }
  const step = async () => { await clock.advance(2500); await clock.settle() }
  // 輪到你那一句會依欄寬換行：去掉空白後比對，不管斷在哪裡。
  const turn = async (ui: any, phrase: string) => {
    const screen = flat(text(await ui.drawn()))
    if (!screen.includes(flat(phrase))) console.log(`找不到「${phrase}」：\n${text(await ui.drawn())}`)
    expect(screen.includes(flat(phrase))).toBe(true)
  }

  const started = await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  expect(String((started as any).text)).toContain('教學已開始')
  expect(data.processCalls.some((c: any) => c.argv[0] === 'sh' && String(c.argv[2]).includes('git worktree add'))).toBe(true)
  expect(data.files[P.card]).toContain('關卡：spec：待確認規格')
  const ui = await $.ui.mount(PANE(72))
  expect(await ui.find({ type: 'Text', text: /教學模式/ })).toBeDefined()

  // 1 規格：t 執行 /desk:card 的腳本，設定檔指向沙盒；DESK_PROJECT_DIR 留空，免得依 cwd 認到真實專案、拿它的登錄表
  await turn(ui, '後按 t 確認（實際：/desk:card spec discount ok）')
  await ui.press({ key: KEY('tutorial') })
  const specOk = data.processCalls.find((c: any) => c.argv.includes('spec-ok'))
  expect(specOk.argv[0]).toBe('python3')
  expect(specOk.init.env).toEqual({ DESK_SETTINGS: P.settings, DESK_PROJECT_DIR: '' })

  // 2 實作：確認規格後自動派，由腳本扮演 Agent（不用按 g）
  await turn(ui, 'Agent 在寫程式')
  await step()
  expect(data.files[`${P.wt}/discount.py`]).toContain('def discount')
  data.git[P.wt]!.head = 'h1'

  // 3 檢查（真的執行卡片的指令）→ 4 驗收：第一輪 HIGH → 自動修正 → 只重新測試就過關（跟真實流程一樣，每張卡只驗收一次）
  for (let i = 0; i < 12 && !flat(text(await ui.drawn())).includes(flat('按 t 合併到 release/v1.0')); i++) {
    if (String(data.files[`${P.wt}/test_discount.py`] ?? '').includes('negative')) data.git[P.wt]!.head = 'h2'
    await step()
  }
  expect(data.processCalls.some((c: any) => c.argv[0] === 'sh' && c.argv[2] === 'python3 -m unittest -q')).toBe(true)
  expect(data.files[`${P.wt}/discount.py`]).toContain('ValueError')
  // 第一輪：HIGH 1（負數金額）與 MEDIUM 1；HIGH 自動修正後只重新測試，不再驗收
  expect(data.files[P.card]).toContain('（教學驗收）HIGH 1、MEDIUM 1')
  expect(reviewRounds(data.files[P.card])).toBe(1)
  // 驗收 MEDIUM 記錄後繼續 AC-4：會影響金額的捨入問題（規格沒寫）只記錄、不問：審查檔標「記錄、不修」，等你留 無
  expect(data.files[`${P.wt}/.task/REVIEW.md`]).toMatch(/^- \[MEDIUM\]\[規格\].*銀行家捨入.*金卡金額 5 會算成 4.*（記錄、不修）$/m)
  expect(data.files[`${P.wt}/.task/REVIEW.md`]).not.toContain('等你決定')
  expect(data.files[P.card]).toContain('- 等你：無')

  // 5 合併：不用回答 MEDIUM，直接按 t 本機合併
  await turn(ui, '已修正・未重新驗收；按 t 合併到 release/v1.0')
  expect(flat(text(await ui.drawn())).includes(flat('按選項字母'))).toBe(false)
  expect(data.fills.length).toBe(0)
  // 「⇡ 開 PR」按兩次也不派真的 Agent，只提示照教學按 t
  const sim = data.launches.length
  await ui.press({ key: KEY('open-pr') })
  await ui.press({ key: KEY('open-pr') })
  await clock.settle()
  expect(data.launches.length).toBe(sim)
  expect(data.toasts.some(t => t.includes('教學不會真的 push：照教學的指示按 t 合併'))).toBe(true)
  await ui.press({ key: KEY('tutorial') })

  // 6 上線：t 打 tag、卡片關卡改 release，再按兩次 u
  await turn(ui, '按 t 打 v1.0.0')
  await ui.press({ key: KEY('tutorial') })
  expect(data.files[P.card]).toContain(`關卡：release：${TUTORIAL_TAG} 待上線確認`)
  data.git[P.wt]!.tag = TUTORIAL_TAG
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await turn(ui, 'u 確認上線（部署 v1.0.0 後按')
  await ui.press({ key: KEY('ship') })
  await ui.press({ key: KEY('ship') })
  await clock.settle()
  await turn(ui, '教學完成！輸入 /desk tutorial end 清除沙盒')

  // 從頭到尾沒有啟動任何真的 Agent，也沒有送通知
  expect(data.launches.length).toBe(0)
  // 教學的審查不會寫進真實的審查存底
  expect(data.writes.some((w: string) => w.includes('/handoffs/reviews/'))).toBe(false)

  // 結束：只刪沙盒，面板回到原本的任務
  const ended = await $.command.run({ command: 'desk', args: 'tutorial end' } as any)
  expect(String((ended as any).text)).toContain('沙盒已刪除')
  expect(data.processCalls.some((c: any) => c.argv.join(' ') === `rm -rf ${P.dir}`)).toBe(true)
  await turn(ui, 'Alpha')
  expect(await ui.find({ type: 'Text', text: /教學模式/ })).toBeUndefined()

  // 再開一次（新的沙盒、新的 commit）：上一輪的紀錄不留下，第一步照樣是確認規格
  data.git[P.wt] = { branch: 'feature/discount', head: 'h0-again' }
  data.git[P.main] = { branch: 'release/v1.0', head: 'm0-again' }
  const again = await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  expect(String((again as any).text)).toContain('教學已開始')
  await clock.settle()
  await turn(ui, '後按 t 確認（實際：/desk:card spec discount ok）')
  expect(await ui.find({ key: KEY('tutorial') })).toBeDefined()
  const screen = text(await ui.drawn())
  if (/已確認上線|已合併|已打 v1\.0\.0/.test(screen)) console.log(screen)
  expect(/已確認上線|已合併|已打 v1\.0\.0/.test(screen)).toBe(false)
  await ui.unmount()
})

test('a leftover sandbox is not overwritten or deleted without the marker; end without a sandbox says so', async ($, on) => {
  const { data } = fixture(on)
  data.files[P.dir] = ''
  const r = await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  expect(String((r as any).text)).toContain('已經存在')
  expect(data.processCalls.some((c: any) => c.argv[0] === 'sh')).toBe(false)
  // 沒有 desk 的標記檔：不是教學建的，不刪
  const kept = await $.command.run({ command: 'desk', args: 'tutorial end' } as any)
  expect(String((kept as any).text)).toContain('沒有 desk 的標記檔')
  expect(data.processCalls.some((c: any) => c.argv[0] === 'rm')).toBe(false)
  delete data.files[P.dir]
  const e = await $.command.run({ command: 'desk', args: 'tutorial end' } as any)
  expect(String((e as any).text)).toBe('目前沒有教學沙盒。')
  expect(data.processCalls.some((c: any) => c.argv[0] === 'rm')).toBe(false)
})

test('only the tutorial folder can be removed', () => {
  expect(tutorialPaths('/home/u/').dir).toBe('/home/u/.claude/desk-tutorial')
})

/** 開始教學、確認規格（自動派實作），停在模擬 Agent「在寫程式」。 */
async function toBuilding($: any, data: any) {
  data.git[P.wt] = { branch: 'feature/discount', head: 'h0' }
  data.run = async (e: any) => {
    if (e.argv.includes('spec-ok')) { data.files[P.card] = setFields(data.files[P.card]!, { 關卡: '無' }); return result(0, '') }
    return result(0, '')
  }
  await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: KEY('tutorial') })
  return ui
}

test('ending the tutorial while the scripted agent works writes nothing afterwards', async ($, on) => {
  const { data, clock } = fixture(on)
  const ui = await toBuilding($, data)
  await $.command.run({ command: 'desk', args: 'tutorial end' } as any)
  const after = data.writes.length
  await clock.advance(5000); await clock.settle()
  expect(data.files[`${P.wt}/discount.py`]).toBeUndefined()
  expect(data.writes.slice(after).some((w: string) => w.startsWith(P.dir))).toBe(false)
  await ui.unmount()
})

test('/desk off stops the scripted agent', async ($, on) => {
  const { data, clock } = fixture(on)
  const ui = await toBuilding($, data)
  await ui.unmount()
  await $.command.run({ command: 'desk', args: 'off' } as any)
  await clock.advance(5000); await clock.settle()
  expect(data.files[`${P.wt}/discount.py`]).toBeUndefined()
})

test('while the scripted agent works, a refresh still sees it busy and runs no check', async ($, on) => {
  const { data, clock } = fixture(on)
  const ui = await toBuilding($, data)
  await clock.advance(1000)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(data.processCalls.some((c: any) => c.argv[0] === 'sh' && c.argv[2] === 'python3 -m unittest -q')).toBe(false)
  expect(String(text(await ui.drawn())).replace(/\s+/g, '')).toContain('Agent在寫程式')
  await ui.unmount()
})

/** 設定檔驗證卡 AC-7：教學模式不讀也不報設定錯誤；真的設定檔與教學沙盒的設定檔都壞著也一樣。 */
test('tutorial mode reports no dispatch.json problems even when the real ones are broken', async ($, on) => {
  const { data, clock } = fixture(on)
  const feed = feedLog(on)
  for (const path of ['/home/u/.claude/handoffs/dispatch.json', `${PROJECT_DIR}/dispatch.json`, P.settings]) data.files[path] = '{ "executor": '
  const ui = await toBuilding($, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.advance(1000); await clock.settle()
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  expect(feed.list.some(e => e.text.includes('設定檔'))).toBe(false)
  expect(data.toasts.some(t => t.includes('設定檔'))).toBe(false)
  await ui.unmount()
})

/** 六段說法（別張卡的 AC-5）：教學卡片寫回的狀態與下一步用「測試」「驗收」，審查檔本文不動；說明照現行規則（教學規則卡 AC-4、驗收 MEDIUM 記錄後繼續 AC-4）。 */
test('the tutorial card writes back test and acceptance words', () => {
  const day = '2030-01-05'
  const base = cardText(day)
  const field = (text: string, name: string) => text.match(new RegExp(`^- ${name}：(.*)$`, 'm'))?.[1]
  const built = cardAfter(base, 'build', day)
  expect(field(built, '下一步')).toBe('等測試與驗收')
  const fixed = cardAfter(built, 'fix', day)
  expect(field(fixed, '下一步')).toBe('等重新測試')
  expect(field(fixed, '狀態')).toBe('已修正驗收的 HIGH：負數金額丟出 ValueError')
  expect(field(cardAfter(fixed, 'review-2', day), '狀態')).toBe('重新驗收通過：三條驗收情境都做到')
  // 驗收的 MEDIUM 只記錄、不問：手動重新驗收（review-2）也不在等你出題，下一步直接開 PR
  expect(field(cardAfter(fixed, 'review-2', day), '等你')).toBe('無')
  expect(field(cardAfter(fixed, 'review-2', day), '下一步')).toBe('開 PR 合併')
  // 你自己在教學卡片寫了題目、在面板回答：只記下選項、清掉等你
  const asked = setFields(fixed, { 等你: '要先發 beta 嗎？A) 要 B) 不要' })
  const changed = cardAfterDecision(asked, 'A', day, '使用者')
  expect(field(changed, '等你')).toBe('無')
  expect(changed).toMatch(/^- D-02 2030-01-05 使用者：決策 → A$/m)
  const old = /完成檢查|重新檢查|複審|審查通過|審查建議|審查發現|教學審查/
  for (const text of [built, fixed, cardAfter(fixed, 'review-1', day), cardAfter(fixed, 'review-2', day), cardAfter(fixed, 'review-3', day), changed]) {
    // 只看寫回時改動或新增的列（卡片範本本身不在這次範圍）
    const added = text.split('\n').filter(l => !base.split('\n').includes(l)).join('\n')
    expect(added).not.toMatch(old)
  }
  // 驗收 MEDIUM 記錄後繼續 AC-4：第一輪 HIGH 自動修正後只重新測試；MEDIUM 只記錄、不問；開場說明不再要你回答 a、b、c 或 d
  expect(TUTORIAL_INTRO).toContain('第一輪會挑出一條 HIGH，自動修正後只重新測試（每張卡只驗收一次）；會影響金額的那條 MEDIUM 只記錄、不問你')
  expect(TUTORIAL_INTRO).not.toMatch(/a、b、c 或 d|選 c 修掉/)
  expect(TUTORIAL_INTRO).not.toContain('現在改')
  expect(TUTORIAL_INTRO).not.toMatch(old)
})
