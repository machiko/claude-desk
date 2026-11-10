// Claude Code 最低版本檢查（min-cc-version 卡的 AC-1～AC-4、AC-6、AC-7）：互動對話開始時，引擎比最低版本舊或讀不到版本就報一次。
import { expect, test } from 'claude-code/testing'
import { fixture, feedLog } from './fixture'
import { ENGINE_NOTIFIED_KEY, MIN_CLAUDE_CODE, tooOldText, unknownVersionText, versionNotice } from '../hooks/engine-version'
import { tutorialPaths } from '../hooks/tutorial'

type Log = ReturnType<typeof feedLog>

/** 開一個對話（含 /clear、重新載入）：引擎發 session.start，測試補最底下的回答；記下 desk 註冊了哪些指令（看 desk 有沒有照常啟動）。 */
function sessions($: any, on: any) {
  const registered: string[] = []
  on('command.register', (_: any, e: any) => { registered.push(String(e.name)); return { value: { command: e.name } } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  const open = async (isInteractive = true) => {
    await $.session.start({ cwd: '/home/u', surface: null, isInteractive } as any)
  }
  return { registered, open }
}

/** 跟版本有關的 toast 與動態（版本太舊、讀不到版本）。 */
const versionToasts = (toasts: string[]) => toasts.filter(t => /Claude Code/.test(t))
const versionFeed = (log: Log) => log.list.filter(e => /Claude Code/.test(e.text))

test('test_session_start_warns_when_claude_code_is_older_than_minimum', async ($, on) => {
  const { data } = fixture(on)
  const log = feedLog(on)
  const { registered, open } = sessions($, on)
  data.engine = { version: '2.1.250', base: '2.1.250' }
  await open()
  const text = tooOldText('2.1.250')
  expect(text).toContain('2.1.250')
  expect(text).toContain(MIN_CLAUDE_CODE)
  expect(text).toContain('請更新 Claude Code')
  expect(versionToasts(data.toasts)).toEqual([text])
  const feed = versionFeed(log)
  expect(feed.map(e => [e.text, e.tone, e.card])).toEqual([[text, 'warning', undefined]])
  // 只提示：desk 照常啟動（/desk 指令照樣註冊）。
  expect(registered).toContain('desk')
})

test('test_version_warning_is_reported_once_per_engine_version', async ($, on) => {
  const { data } = fixture(on)
  const log = feedLog(on)
  const { open } = sessions($, on)
  data.engine = { version: '2.1.250', base: '2.1.250' }
  await open()
  // 再開新對話、重新載入：同一個版本不再報。
  await open()
  await open()
  expect(versionToasts(data.toasts)).toEqual([tooOldText('2.1.250')])
  expect(versionFeed(log).length).toBe(1)
  // 升級後還是太舊的另一個版本：再報一次。
  data.engine = { version: '2.1.260', base: '2.1.260' }
  await open()
  await open()
  expect(versionToasts(data.toasts)).toEqual([tooOldText('2.1.250'), tooOldText('2.1.260')])
  expect(versionFeed(log).map(e => e.text)).toEqual([tooOldText('2.1.260'), tooOldText('2.1.250')])
})

test('test_no_warning_when_claude_code_meets_minimum', async ($, on) => {
  const { data } = fixture(on)
  const log = feedLog(on)
  const { registered, open } = sessions($, on)
  for (const engine of [
    { version: '2.1.302', base: '2.1.302' },
    { version: '2.1.318', base: '2.1.318' },
    { version: '2.1.302-dev.20261101.t101500.sha1a2b3c4', base: '2.1.302-dev' },
    { version: '2.2.0' },
  ]) {
    data.engine = engine
    await open()
  }
  expect(versionToasts(data.toasts)).toEqual([])
  expect(versionFeed(log)).toEqual([])
  expect(data.store[ENGINE_NOTIFIED_KEY]).toBeUndefined()
  expect(registered.filter(n => n === 'desk').length).toBe(4)
  // 純函式：開發版的後綴不看，等於或高於最低版本都不報。
  expect(versionNotice('2.1.302-dev', null)).toBeNull()
  expect(versionNotice('2.1.301', null)?.text).toBe(tooOldText('2.1.301'))
})

test('test_unknown_version_warns_once_and_does_not_throw', async ($, on) => {
  const { data } = fixture(on)
  const log = feedLog(on)
  const { registered, open } = sessions($, on)
  // 版本 API 拒絕（丟錯）。
  data.engine = null
  await open()
  // 回答沒有版號（認不得的形狀）也算讀不到；已經報過，不再報。
  data.engine = {} as any
  await open()
  expect(unknownVersionText).toBe(`讀不到 Claude Code 版本，desk 以 ${MIN_CLAUDE_CODE} 開發，太舊可能無法使用`)
  expect(versionToasts(data.toasts)).toEqual([unknownVersionText])
  expect(versionFeed(log).map(e => [e.text, e.tone])).toEqual([[unknownVersionText, 'warning']])
  expect(registered.filter(n => n === 'desk').length).toBe(2)
  // store 也壞掉時照樣啟動、不丟例外（記不下來就下次再報）。
  data.storeDeny = { [ENGINE_NOTIFIED_KEY]: 'store unavailable' }
  delete data.store[ENGINE_NOTIFIED_KEY]
  await open()
  expect(registered.filter(n => n === 'desk').length).toBe(3)
  expect(versionToasts(data.toasts)).toEqual([unknownVersionText, unknownVersionText])
})

test('test_non_interactive_session_skips_version_check', async ($, on) => {
  const { data } = fixture(on)
  const log = feedLog(on)
  const { open } = sessions($, on)
  data.engine = { version: '2.1.250', base: '2.1.250' }
  await open(false)
  expect(data.engineAsked).toBe(0)
  expect(versionToasts(data.toasts)).toEqual([])
  expect(versionFeed(log)).toEqual([])
  expect(data.store[ENGINE_NOTIFIED_KEY]).toBeUndefined()
  // 對照：同樣的版本開互動對話就會報（擋下它的是「非互動」）。
  await open()
  expect(data.engineAsked).toBe(1)
  expect(versionToasts(data.toasts)).toEqual([tooOldText('2.1.250')])
})

test('test_tutorial_does_not_show_version_warning', async ($, on) => {
  const { data } = fixture(on)
  const log = feedLog(on)
  const { open } = sessions($, on)
  data.engine = { version: '2.1.250', base: '2.1.250' }
  data.store.tutorial = { dir: '/home/u/desk-tutorial' }
  await open()
  expect(versionToasts(data.toasts)).toEqual([])
  expect(versionFeed(log)).toEqual([])
  // 教學結束後的下一個對話：照規則報一次。
  data.store.tutorial = null
  await open()
  expect(versionToasts(data.toasts)).toEqual([tooOldText('2.1.250')])
  expect(versionFeed(log).length).toBe(1)
})

/** 0.63 收尾卡 AC-2：教學開始／結束清掉動態後，教學結束時把版本警告補回動態（只一行、不再跳 toast）；版本夠新時不補。 */
test('test_version_warning_returns_to_feed_after_tutorial_clears_it', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const { open } = sessions($, on)
  const P = tutorialPaths('/home/u')
  const tutorialRound = async () => {
    await $.command.run({ command: 'desk', args: 'tutorial' } as any)
    await clock.settle()
    expect(versionFeed(log)).toEqual([])
    await $.command.run({ command: 'desk', args: 'tutorial end' } as any)
    await clock.settle()
    delete data.files[P.dir]
  }
  data.engine = { version: '2.1.250', base: '2.1.250' }
  await open()
  expect(versionFeed(log).length).toBe(1)

  await tutorialRound()

  expect(versionFeed(log).map(e => [e.text, e.tone, e.card])).toEqual([[tooOldText('2.1.250'), 'warning', undefined]])
  expect(versionToasts(data.toasts)).toEqual([tooOldText('2.1.250')])

  // 對照：版本夠新時教學結束不補。
  data.engine = { version: '2.1.302', base: '2.1.302' }
  await tutorialRound()
  expect(versionFeed(log)).toEqual([])
  expect(versionToasts(data.toasts)).toEqual([tooOldText('2.1.250')])
})
