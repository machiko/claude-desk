import { expect, test } from 'claude-code/testing'
import { fixture, PANE, result, text } from './fixture'
declare const console: { log: (...args: unknown[]) => void }
import { setFields, tutorialPaths, TUTORIAL_TAG } from '../hooks/tutorial'

const P = tutorialPaths('/home/u')
const KEY = (what: string) => `case-${P.card}-${what}`

test('the tutorial walks all six stages with scripted agents, never launches claude, and cleans up', async ($, on) => {
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
  const flat = (x: string) => x.replace(/\s+/g, '')
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

  // 2 實作：按兩次 g，由腳本扮演 Agent
  await turn(ui, '按 g 派 Agent')
  await ui.press({ key: KEY('continue') })
  await ui.press({ key: KEY('continue') })
  await turn(ui, 'Agent 在寫程式')
  await step()
  expect(data.files[`${P.wt}/discount.py`]).toContain('def discount')
  data.git[P.wt]!.head = 'h1'

  // 3 檢查（真的執行卡片的指令）→ 4 審查：第一輪 HIGH → 自動修正 → 檢查 → 複審過關、MEDIUM 等你
  for (let i = 0; i < 12 && !String(data.files[P.card]).includes('MEDIUM 1、LOW 0；過'); i++) {
    if (String(data.files[`${P.wt}/test_discount.py`] ?? '').includes('negative')) data.git[P.wt]!.head = 'h2'
    await step()
  }
  expect(data.processCalls.some((c: any) => c.argv[0] === 'sh' && c.argv[2] === 'python3 -m unittest -q')).toBe(true)
  expect(data.files[`${P.wt}/.task/REVIEW.md`]).toContain('複審')
  expect(data.files[`${P.wt}/discount.py`]).toContain('ValueError')
  expect(data.files[P.card]).toContain('等你：審查建議（不改也能合併）')

  // 5 合併：先決定 MEDIUM（寫回卡片，不送主對話），再按 t 本機合併
  await turn(ui, '按選項字母 → f 寫回卡片')
  await ui.press({ key: `case-${P.card}-opt0A` })
  await ui.press({ key: KEY('fill') })
  expect(data.fills.length).toBe(0)
  expect(data.files[P.card]).toContain('- 等你：無')
  expect(data.files[P.card]).toMatch(/- D-02 \d{4}-\d{2}-\d{2} 使用者：審查 MEDIUM → A/)
  await turn(ui, '按 t 合併到 release/v1.0')
  await ui.press({ key: KEY('tutorial') })

  // 6 上線：t 打 tag、卡片關卡改 release，再按兩次 u
  await turn(ui, '按 t 打 v1.0.0')
  await ui.press({ key: KEY('tutorial') })
  expect(data.files[P.card]).toContain(`關卡：release：${TUTORIAL_TAG} 待上線確認`)
  data.git[P.wt]!.tag = TUTORIAL_TAG
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await turn(ui, '部署 v1.0.0 後按 u 確認上線')
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

test('choosing C in the tutorial commits the change and the chain goes back to check and review before merge', async ($, on) => {
  const { data, clock } = fixture(on)
  data.git[P.wt] = { branch: 'feature/discount', head: 'h0' }
  data.git[P.main] = { branch: 'release/v1.0', head: 'm0' }
  data.run = async (e: any) => {
    if (e.argv.includes('spec-ok')) { data.files[P.card] = setFields(data.files[P.card]!, { 關卡: '無', 狀態: '規格已確認（AC-1～AC-3），可派實作' }); return result(0, 'ok\n') }
    return result(0, '')
  }
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const flat = (x: string) => x.replace(/\s+/g, '')
  await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: KEY('tutorial') })
  await ui.press({ key: KEY('continue') })
  await ui.press({ key: KEY('continue') })
  await step()
  data.git[P.wt]!.head = 'h1'
  for (let i = 0; i < 12 && !String(data.files[P.card]).includes('MEDIUM 1、LOW 0；過'); i++) {
    if (String(data.files[`${P.wt}/test_discount.py`] ?? '').includes('negative')) data.git[P.wt]!.head = 'h2'
    await step()
  }
  expect(data.files[P.card]).toContain('C) 現在改')

  // 選 C：扮演主對話改程式並 commit
  await ui.press({ key: `case-${P.card}-opt0C` })
  await ui.press({ key: KEY('fill') })
  expect(data.files[`${P.wt}/discount.py`]).toContain('GOLD_RATE = 0.9')
  expect(data.files[P.card]).toMatch(/- D-02 \d{4}-\d{2}-\d{2} 使用者：審查 MEDIUM → C/)
  const checks = () => data.processCalls.filter((c: any) => c.argv[0] === 'sh' && c.argv[2] === 'python3 -m unittest -q').length
  const before = checks()
  // fixture 不執行 git：commit 的效果由 HEAD 前進代表
  data.git[P.wt]!.head = 'h3'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  // 審查後有新 commit：自動重新檢查 → 重新審查（只看新 diff）→ 過關
  for (let i = 0; i < 12 && !String(data.files[P.card]).includes('MEDIUM 0、LOW 0；過'); i++) await step()
  expect(checks()).toBeGreaterThan(before)
  expect(data.files[`${P.wt}/.task/REVIEW.md`]).toContain('重新審查')
  expect(data.files[P.card]).toContain('重新審查通過')
  for (let i = 0; i < 4 && !flat(text(await ui.drawn())).includes(flat('按 t 合併到 release/v1.0')); i++) await step()
  expect(flat(text(await ui.drawn())).includes(flat('按 t 合併到 release/v1.0'))).toBe(true)
  expect(data.launches.length).toBe(0)
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

/** 開始教學、確認規格、派實作，停在模擬 Agent「在寫程式」。 */
async function toBuilding($: any, data: any) {
  data.git[P.wt] = { branch: 'feature/discount', head: 'h0' }
  data.run = async (e: any) => {
    if (e.argv.includes('spec-ok')) { data.files[P.card] = setFields(data.files[P.card]!, { 關卡: '無' }); return result(0, '') }
    return result(0, '')
  }
  await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: KEY('tutorial') })
  await ui.press({ key: KEY('continue') })
  await ui.press({ key: KEY('continue') })
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
