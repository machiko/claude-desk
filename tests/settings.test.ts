// dispatch.json 的格式版號（格式版本標記 AC-4）：頂層 format 比這版新時走設定檢查的路回報，認得的鍵照常套用。
import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, PANE, PROJECT_DIR } from './fixture'
import { parseSettings, settingsProblems } from '../hooks/settings'
import { SETTINGS_FORMAT } from '../hooks/formats'

const PROJECT_SETTINGS = `${PROJECT_DIR}/dispatch.json`
const NEWER = 'format 是 2，這份是較新版 desk 的設定，請更新 desk（認得的鍵照常套用）'

test('test_newer_settings_format_is_reported_and_known_keys_still_apply', async ($, on) => {
  // 純函式：format 2 排在第一條（新版多的鍵另列認不得）；1 與沒寫都不報；其他值照「值不對」報
  const newer = JSON.stringify({ format: 2, model: 'opus', user: 'Alex', shiny: true })
  expect(settingsProblems(newer)).toEqual([NEWER, '認不得的鍵，已略過：shiny'])
  expect(parseSettings(newer)).toMatchObject({ model: 'opus', user: 'Alex' })
  expect(settingsProblems(JSON.stringify({ format: SETTINGS_FORMAT, model: 'opus' }))).toEqual([])
  expect(settingsProblems(JSON.stringify({ model: 'opus' }))).toEqual([])
  for (const bad of [0, -1, 1.5, '2']) expect(settingsProblems(JSON.stringify({ format: bad }))).toEqual([`format 要是正整數，視為 ${SETTINGS_FORMAT}`])

  // 面板：動態指出檔名、說明是較新版 desk 的設定，只報一次；認得的鍵照常用在派工
  const { data, clock } = fixture(on)
  const feed = feedLog(on)
  data.files[PROJECT_SETTINGS] = JSON.stringify({ format: 2, model: 'opus', effort: 'high' })
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  await refresh()
  await refresh()
  const reports = feed.list.filter(e => e.text.includes(PROJECT_SETTINGS))
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({ text: `設定檔 ${PROJECT_SETTINGS} 有問題：${NEWER}`, tone: 'error' })
  expect(data.toasts).toContain(reports[0]!.text)
  const ui = await $.ui.mount(PANE(90))
  expect(await ui.find({ type: 'Text', text: '派工 opus high' })).toBeDefined()
  await ui.unmount()
})
