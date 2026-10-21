import { expect, test } from 'claude-code/testing'
declare const console: { log: (...args: unknown[]) => void }
import { fixture, BAND, PANE, result, text } from './fixture'
import { setFields, tutorialPaths } from '../hooks/tutorial'

const P = tutorialPaths('/home/u')
const DEMO_BETA = '/demo/beta/.desk/CARD.md'
const flat = (x: string) => x.replace(/\s+/g, '')

async function startTutorial($: any, on: any) {
  const { data, clock } = fixture(on)
  data.git[P.wt] = { branch: 'feature/discount', head: 'h0' }
  data.git[P.main] = { branch: 'release/v1.0', head: 'm0' }
  data.run = async (e: any) => {
    if (e.argv.includes('spec-ok')) { data.files[P.card] = setFields(data.files[P.card]!, { 關卡: '無' }); return result(0, 'ok\n') }
    return result(0, '')
  }
  await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  await clock.settle()
  return { data, clock }
}

test('the tutorial shows the sample cases as a read-only background, with the lesson as the current card', async ($, on) => {
  const { data } = await startTutorial($, on)
  // 72 欄是單欄排版：現在卡與進度表上下排，文字不會交錯。
  const ui = await $.ui.mount(PANE(72))
  const screen = flat(text(await ui.drawn()))
  // 現在卡是教學那件，輪到你的那句是教學的
  expect(screen).toContain(flat('看過規格（o 開卡片）後按 t 確認'))
  // 其他任務是示範的那幾件，標題寫明只能看
  expect(screen).toContain('部署流程改版')
  expect(screen).toContain('訂單匯出CSV')
  expect(screen).toContain(flat('示範，只能看'))
  // 摘要列與狀態列跟著教學那件，不被示範任務搶走
  const band = await $.ui.mount(BAND(100))
  const bandText = flat(text(await band.drawn()))
  expect(bandText).toContain('會員折扣')
  expect(bandText).not.toContain('訂單匯出')
  expect(bandText).not.toContain('主工作區')
  expect(String(data.status ?? '')).not.toContain('訂單匯出')
  // 示範任務不發動態、不跳通知
  expect(data.toasts.some(t => /部署流程改版|訂單匯出|會員登入改版|主工作區/.test(t))).toBe(false)
  await band.unmount()
  await ui.unmount()
})

test('sample cases are not clickable: no row button, n skips them, commands cannot find them', async ($, on) => {
  const { data } = await startTutorial($, on)
  const ui = await $.ui.mount(PANE(72))
  // 其他任務那幾列只是畫面，沒有按鈕、沒有數字鍵
  expect(await ui.find({ key: `row-${DEMO_BETA}` })).toBeUndefined()
  expect(flat(text(await ui.drawn()))).toContain('訂單匯出CSV')
  // n（下一件）也不會跳到示範任務，現在卡一直是教學那件
  await ui.press({ key: 'next' })
  expect(flat(text(await ui.drawn()))).toContain(flat('後按 t 確認'))
  // 指令也找不到它
  const r = await $.command.run({ command: 'desk', args: 'verify 訂單匯出' } as any)
  expect(String((r as any).text)).toContain('找不到任務')
  expect(data.writes.some(p => p.startsWith('/demo/'))).toBe(false)
  expect(data.launches).toEqual([])
  await ui.unmount()
})

test('/desk demo is gone: the samples live inside the tutorial', async ($, on) => {
  fixture(on)
  const r = await $.command.run({ command: 'desk', args: 'demo' } as any)
  expect(String((r as any).text)).toContain('可用：')
  expect(String((r as any).text)).not.toContain('demo')
})

test('ending the tutorial removes the sample cases', async ($, on) => {
  const { clock } = await startTutorial($, on)
  await $.command.run({ command: 'desk', args: 'tutorial end' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(100))
  const screen = flat(text(await ui.drawn()))
  expect(screen).not.toContain('部署流程改版')
  expect(screen).toContain('Alpha')
  await ui.unmount()
})

test('after a sync in the tutorial the spec step still offers t', async ($, on) => {
  const { data, clock } = await startTutorial($, on)
  const ui = await $.ui.mount(PANE(72))
  const KEY = (what: string) => `case-${P.card}-${what}`
  await ui.press({ key: KEY('sync') })
  await ui.press({ key: KEY('sync') })
  await clock.advance(2500); await clock.settle()
  await clock.advance(2500); await clock.settle()
  expect(data.files[P.card]).toContain('（教學同步）')
  const screen = flat(text(await ui.drawn()))
  if (!screen.includes(flat('後按 t 確認'))) console.log(text(await ui.drawn()))
  expect(screen).toContain(flat('後按 t 確認'))
  expect(await ui.find({ key: KEY('tutorial') })).toBeDefined()
  await ui.unmount()
})

test('starting the tutorial selects the lesson case; ending it clears the selection', async ($, on) => {
  const { data, clock } = await startTutorial($, on)
  await $.prompt.submit({ text: '這一步要做什麼？' } as any)
  expect(data.submitted[0].context?.[0]).toContain('任務「教學：會員折扣」')
  // 再開一次（教學還在跑）也選回教學那件
  await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  await $.prompt.submit({ text: '再問一次' } as any)
  expect(data.submitted[1].context?.[0]).toContain('任務「教學：會員折扣」')
  await $.command.run({ command: 'desk', args: 'tutorial end' } as any)
  await clock.settle()
  await $.prompt.submit({ text: '結束了' } as any)
  expect(data.submitted[2].context ?? []).toEqual([])
})
