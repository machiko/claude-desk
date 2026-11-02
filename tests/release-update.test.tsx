import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, CARD_A, CARD_B, NOW, REGISTRY } from './fixture'
import { setFields } from '../hooks/tutorial'
import { world } from './update-world'

// desk 自己發版後自動更新：回合中重新整理看到 desk 專案的卡寫「已發版」就記下，回合結束跑一次 /desk update 的流程。
const BETA = '/home/u/wt/beta'
const RELEASED = '已發版 v0.44.0：tag 與 main 已推送，main 的 CI 通過'
const NOTE = 'Beta 已發版 v0.44.0：自動更新 desk'
const turnDone = (turnId = 't1') => ({ answer: '', durationMs: 4000, isAborted: false, turnId, reason: 'answer' }) as any
const feedTexts = (log: ReturnType<typeof feedLog>) => log.list.map(e => e.text).join('\n')

/** Beta 卡寫「已發版」；isDesk 時 Beta 的根目錄是 desk 自己（plugin.json 的 name 是 desk）。自動檢查剛查過，不在重新整理時多跑 claude plugin。 */
function released(data: any, isDesk: boolean) {
  data.files[CARD_B] = setFields(data.files[CARD_B]!, { 狀態: RELEASED })
  if (isDesk) data.files[`${BETA}/.claude-plugin/plugin.json`] = JSON.stringify({ name: 'desk', version: '0.44.0' })
  data.store.updateCheck = { at: NOW, latest: '0.43.0', current: '0.43.0' }
}

async function refresh($: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
}

async function endTurn($: any, clock: any, turnId?: string) {
  await $.turn.complete(turnDone(turnId))
  await clock.settle()
}

test('test_turn_end_after_release_status_updates_desk_and_reloads_once', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  on('turn.complete', () => ({ text: '' }))
  const { changes } = world(data, { kind: 'github', installed: '0.43.0', latest: '0.44.0' })
  released(data, true)
  await refresh($, clock)
  // 回合還沒結束：只記在這個對話自己的狀態，不更新，也不寫進所有對話共用的 store
  expect(changes).toEqual([])
  expect(data.store.releaseUpdate).toBeUndefined()

  await endTurn($, clock)
  expect(changes).toEqual(['marketplace update claude-desk', 'update desk@claude-desk --scope user'])
  expect(data.reloads.length).toBe(1)
  expect(feedTexts(log)).toContain(NOTE)
  expect(feedTexts(log)).toContain('desk 已更新版本：0.43.0 → 0.44.0')
  expect(data.store.releaseUpdate).toMatchObject({ version: '0.44.0', handled: true })

  // 同一版只跑一次
  await endTurn($, clock, 't2')
  expect(changes).toHaveLength(2)
  expect(data.reloads.length).toBe(1)
})

test('test_release_status_seen_mid_turn_still_updates_after_the_card_is_archived', async ($, on) => {
  const { data, clock } = fixture(on)
  on('turn.complete', () => ({ text: '' }))
  const { changes } = world(data, { kind: 'github', installed: '0.43.0', latest: '0.44.0' })
  released(data, true)
  await refresh($, clock)
  // 同一回合 archive --cleanup：Beta 從登錄表拿掉、卡片檔刪掉
  data.files[REGISTRY] = data.files[REGISTRY]!.split('\n').filter(l => !l.startsWith('| Beta |')).join('\n')
  delete data.files[CARD_B]

  await endTurn($, clock)
  expect(changes).toEqual(['marketplace update claude-desk', 'update desk@claude-desk --scope user'])
  expect(data.reloads.length).toBe(1)
})

test('test_release_in_another_project_never_touches_desk', async ($, on) => {
  const { data, clock } = fixture(on)
  on('turn.complete', () => ({ text: '' }))
  const { calls } = world(data, { kind: 'github', installed: '0.43.0', latest: '0.44.0' })
  released(data, false)
  await refresh($, clock)
  await endTurn($, clock)
  expect(calls.filter(a => a[0] === 'claude' && a[1] === 'plugin')).toEqual([])
  expect(data.reloads.length).toBe(0)
  expect(data.store.releaseUpdate).toBeUndefined()
})

test('test_blocked_folder_install_reports_once_and_does_not_retry', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  on('turn.complete', () => ({ text: '' }))
  const { changes } = world(data, { kind: 'folder', installed: '0.43.0', latest: '0.44.0', dirty: true })
  released(data, true)
  await refresh($, clock)

  await endTurn($, clock)
  const blocked = () => log.list.filter(e => e.tone === 'warning' && /^desk 無法更新，什麼都沒動：.*未提交的改動/.test(e.text))
  expect(blocked()).toHaveLength(1)
  expect(changes.some(c => c.startsWith('update '))).toBe(false)
  expect(data.reloads.length).toBe(0)
  await $.prompt.submit({ text: '發版好了嗎？' } as any)
  expect((data.submitted.at(-1)?.context ?? []).join('\n')).toContain(blocked()[0]!.text)

  await endTurn($, clock, 't2')
  expect(blocked()).toHaveLength(1)
  expect(changes).toEqual([])
})

const ALPHA = '/home/u/wt/alpha'
/** Alpha 是上一版留在登錄表的已發版卡（例如有 release 關卡、還沒按 u）。 */
function olderReleased(data: any) {
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 狀態: '已發版 0.43.0：tag 與 main 已推送，main 的 CI 通過' })
  data.files[`${ALPHA}/.claude-plugin/plugin.json`] = JSON.stringify({ name: 'desk', version: '0.43.0' })
}

test('test_older_released_card_ahead_in_the_registry_does_not_hide_the_new_release', async ($, on) => {
  const { data, clock } = fixture(on)
  on('turn.complete', () => ({ text: '' }))
  const { changes } = world(data, { kind: 'github', installed: '0.43.0', latest: '0.44.0' })
  released(data, true)
  olderReleased(data)
  data.store.releaseUpdate = { version: '0.43.0', name: 'Alpha', handled: true }
  await refresh($, clock)

  await endTurn($, clock)
  expect(changes).toEqual(['marketplace update claude-desk', 'update desk@claude-desk --scope user'])
  expect(data.reloads.length).toBe(1)
  expect(data.store.releaseUpdate).toMatchObject({ version: '0.44.0', name: 'Beta', handled: true })
})

test('test_archiving_the_new_release_card_does_not_roll_the_pending_back_to_an_older_card', async ($, on) => {
  const { data, clock } = fixture(on)
  on('turn.complete', () => ({ text: '' }))
  const { changes } = world(data, { kind: 'github', installed: '0.43.0', latest: '0.44.0' })
  released(data, true)
  olderReleased(data)
  await refresh($, clock)
  // 同一回合 archive --cleanup 只拿掉 Beta：剩下上一版的 Alpha
  data.files[REGISTRY] = data.files[REGISTRY]!.split('\n').filter(l => !l.startsWith('| Beta |')).join('\n')
  delete data.files[CARD_B]

  await endTurn($, clock)
  expect(data.store.releaseUpdate).toMatchObject({ version: '0.44.0', handled: true })
  expect(changes).toEqual(['marketplace update claude-desk', 'update desk@claude-desk --scope user'])
})

test('test_release_status_is_noted_before_a_cleanup_mid_refresh_removes_the_worktree', async ($, on) => {
  const { data, clock } = fixture(on)
  on('turn.complete', () => ({ text: '' }))
  const { changes } = world(data, { kind: 'github', installed: '0.43.0', latest: '0.44.0' })
  released(data, true)
  // archive --cleanup 在這輪重新整理跑探測（claude agents）時完成：登錄表列、卡片與 worktree 都不見了
  const exec = data.exec
  let cleaned = false
  data.exec = (e: any) => {
    if (!cleaned && e.argv[0] === 'claude' && e.argv[1] === 'agents') {
      cleaned = true
      data.files[REGISTRY] = data.files[REGISTRY]!.split('\n').filter((l: string) => !l.startsWith('| Beta |')).join('\n')
      for (const path of Object.keys(data.files)) if (path.startsWith(`${BETA}/`)) delete data.files[path]
    }
    return exec(e)
  }
  await refresh($, clock)
  expect(cleaned).toBe(true)

  await endTurn($, clock)
  expect(changes).toEqual(['marketplace update claude-desk', 'update desk@claude-desk --scope user'])
  expect(data.reloads.length).toBe(1)
})

test('test_release_noted_by_another_conversation_is_not_taken_at_this_turn_end', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  on('turn.complete', () => ({ text: '' }))
  const { calls } = world(data, { kind: 'github', installed: '0.43.0', latest: '0.44.0' })
  data.store.updateCheck = { at: NOW, latest: '0.43.0', current: '0.43.0' }
  // 別的對話（desk 專案）記下、還沒處理的發版；這個對話的登錄表沒有 desk 的已發版卡
  data.store.releaseUpdate = { version: '0.44.0', name: 'Beta', handled: false }
  await refresh($, clock)
  await endTurn($, clock)
  expect(calls.filter(a => a[0] === 'claude' && a[1] === 'plugin')).toEqual([])
  expect(data.reloads.length).toBe(0)
  expect(feedTexts(log)).not.toContain(NOTE)
  expect(data.store.releaseUpdate).toEqual({ version: '0.44.0', name: 'Beta', handled: false })
})

test('test_release_already_handled_by_another_conversation_is_not_run_again', async ($, on) => {
  const { data, clock } = fixture(on)
  on('turn.complete', () => ({ text: '' }))
  const { calls } = world(data, { kind: 'github', installed: '0.43.0', latest: '0.44.0' })
  released(data, true)
  data.store.releaseUpdate = { version: '0.44.0', name: 'Beta', handled: true }
  await refresh($, clock)
  await endTurn($, clock)
  expect(calls.filter(a => a[0] === 'claude' && a[1] === 'plugin')).toEqual([])
  expect(data.reloads.length).toBe(0)
})

test('test_card_written_while_a_refresh_is_running_is_noted_before_waiting_for_it', async ($, on) => {
  const { data, clock } = fixture(on)
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'Write' }, (_: any, e: any) => { data.files[e.file_path] = e.content; return { result: { type: 'update', filePath: e.file_path } } })
  const { changes } = world(data, { kind: 'github', installed: '0.43.0', latest: '0.44.0' })
  data.files[`${BETA}/.claude-plugin/plugin.json`] = JSON.stringify({ name: 'desk', version: '0.44.0' })
  data.store.updateCheck = { at: NOW, latest: '0.43.0', current: '0.43.0' }
  await refresh($, clock)
  // 下一輪重新整理卡在 claude agents（例如 git 觸發的那輪還在跑探測）
  const exec = data.exec
  let hold: (() => void) | null = null
  const held = new Promise<void>(resolve => { hold = resolve })
  let entered = false
  data.exec = (e: any) => {
    if (!entered && e.argv[0] === 'claude' && e.argv[1] === 'agents') { entered = true; return held.then(() => exec(e)) }
    return exec(e)
  }
  const running = $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(entered).toBe(true)
  // 這時對話寫了「已發版」，800ms 後要重讀；接著 archive --cleanup 拿掉 Beta 的登錄表列、卡片與 worktree
  await $.tool.call({ tool: 'Write', file_path: CARD_B, content: setFields(data.files[CARD_B]!, { 狀態: RELEASED }) } as any)
  await clock.advance(800)
  await clock.settle()
  data.files[REGISTRY] = data.files[REGISTRY]!.split('\n').filter(l => !l.startsWith('| Beta |')).join('\n')
  for (const path of Object.keys(data.files)) if (path.startsWith(`${BETA}/`)) delete data.files[path]
  hold!()
  await running
  await clock.settle()

  await endTurn($, clock)
  expect(changes).toEqual(['marketplace update claude-desk', 'update desk@claude-desk --scope user'])
  expect(data.reloads.length).toBe(1)
})
