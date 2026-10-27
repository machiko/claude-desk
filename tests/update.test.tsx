import { expect, test } from 'claude-code/testing'
import { fixture, result, BAND, PANE, NOW, PROJECT_DIR } from './fixture'
import { compareVersions, manifestPath, pickInstall } from '../hooks/update'

const MARKET_DIR = '/home/u/.claude/plugins/marketplaces/claude-desk'
const FOLDER = '/home/u/Workspace/claude-desk'
const DAY = 24 * 60 * 60_000
const UPDATED = 'desk 已更新版本：0.18.0 → 0.19.0，自動重新載入（對話進行中就等回合結束）'
const RELOAD_FILLED = 'desk 沒能自動重新載入：已填入 /reload-plugins，按 Esc 回到輸入框再按 Enter 執行，新版才會生效'
const RELOAD_TYPE = 'desk 沒能自動重新載入：請輸入 /reload-plugins，新版才會生效'

type World = { kind: 'github' | 'folder'; installed: string; latest: string; dirty?: boolean; branch?: string; ahead?: number; fetchFails?: boolean; updateFails?: boolean }

/** 模擬 desk 的安裝（claude plugin list／marketplace list／update）與 desk 自己的 git；記下每個會改東西的指令。 */
function world(data: any, w: World) {
  const calls: string[][] = []
  const changes: string[] = []
  let merged = false
  /** 本機資料夾目前的 HEAD：快轉到 GitHub 的版本、reset --keep 退回。 */
  const folder = { head: 'aaaa111' }
  const dir = w.kind === 'folder' ? FOLDER : MARKET_DIR
  data.deskVersion = w.installed
  data.exec = (e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'claude' && argv[1] === 'plugin') {
      calls.push(argv)
      const rest = argv.slice(2).join(' ')
      if (rest === 'list --json') return result(0, JSON.stringify([
        { id: 'other@x', version: '1.0.0', scope: 'user', enabled: true, installPath: '/home/u/.claude/plugins/cache/x/other/1.0.0' },
        { id: 'desk@claude-desk', version: w.installed, scope: 'user', enabled: true, installPath: `/home/u/.claude/plugins/cache/claude-desk/desk/${w.installed}`, ...(w.kind === 'folder' ? { readFromFolder: FOLDER, folderVersion: w.installed } : {}) },
      ]))
      if (rest === 'marketplace list --json') return result(0, JSON.stringify([
        w.kind === 'folder' ? { name: 'claude-desk', source: 'directory', path: FOLDER, installLocation: FOLDER } : { name: 'claude-desk', source: 'github', repo: 'machiko/claude-desk', installLocation: MARKET_DIR },
      ]))
      if (rest.startsWith('marketplace update')) { changes.push(rest); return result(0, 'updated') }
      if (rest.startsWith('update ')) {
        if (w.updateFails) return result(1, '', 'Failed to update plugin desk@claude-desk: network down\nmore detail')
        changes.push(rest)
        if (w.kind === 'github' || merged) w.installed = w.latest
        return result(0, 'Restart to apply')
      }
      return result(1, '', `unexpected: ${rest}`)
    }
    if (argv[0] === 'git' && argv[2] === dir) {
      calls.push(argv)
      const args = argv.slice(3).join(' ')
      if (args.startsWith('fetch')) return w.fetchFails ? result(128, '', 'fatal: unable to access \'https://github.com/machiko/claude-desk.git/\': Could not resolve host: github.com\nsecond line') : result(0)
      if (args === 'symbolic-ref --short refs/remotes/origin/HEAD') return result(0, 'origin/main\n')
      if (args === 'show origin/main:.claude-plugin/marketplace.json') return result(0, JSON.stringify({ name: 'claude-desk', plugins: [{ name: 'desk', source: './' }] }))
      if (args === 'show origin/main:.claude-plugin/plugin.json') return result(0, JSON.stringify({ name: 'desk', version: w.latest }))
      if (args.startsWith('status --porcelain')) return result(0, w.dirty ? ' M hooks/pane.tsx\n' : '')
      if (args === 'rev-parse --abbrev-ref HEAD') return result(0, `${w.branch ?? 'main'}\n`)
      if (args === 'rev-list --count origin/main..HEAD') return result(0, `${w.ahead ?? 0}\n`)
      if (args === 'rev-parse HEAD') return result(0, `${folder.head}\n`)
      if (args.startsWith('merge')) { changes.push(`git ${args}`); merged = true; folder.head = 'bbbb222'; return result(0) }
      if (args.startsWith('reset --keep')) { changes.push(`git ${args}`); merged = false; folder.head = argv[argv.length - 1]!; return result(0) }
      changes.push(`git ${args}`)
      return result(0)
    }
    return null
  }
  return { calls, changes, w, folder }
}

const feedTexts = async ($: any, ui: any) => (await ui.findAll({ type: 'Text' })).map((n: any) => n.text).join('\n')
/** 關掉工作桌（停掉定時更新）再讓時間過去，像隔天重開 Claude Code；之後 /desk refresh 重新開。 */
async function later($: any, clock: any, ms: number) {
  await $.command.run({ command: 'desk', args: 'off' } as any)
  await clock.advance(ms)
  await clock.settle()
}
/** 「最近」裡這句話有幾筆（面板的動態列）。 */
async function feedCount(ui: any, text: string) {
  return (await ui.findAll({ type: 'Text' })).filter((n: any) => n.text === text && n.props?.color === 'suggestion').length
}
/** 開工作桌（面板要有快照才畫得出「最近」）。 */
async function openDesk($: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
}
/** desk 載入一次（session.start 記下載入計數）；開新對話由引擎發，測試裡補最底下的回答。 */
async function loadDesk($: any, on: any) {
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/home/u', surface: null, isInteractive: true } as any)
}

test('update upgrades a GitHub install and reports the old and new version numbers', async ($, on) => {
  const { data, clock } = fixture(on)
  const { changes, w } = world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0' })
  await openDesk($, clock)
  const out = await $.command.run({ command: 'desk', args: 'update' } as any) as any
  expect(out.text).toBe(UPDATED)
  expect(w.installed).toBe('0.19.0')
  expect(changes).toEqual(['marketplace update claude-desk', 'update desk@claude-desk --scope user'])
  expect(out.text).not.toMatch(/main|origin|[0-9a-f]{7}/)
  expect(data.toasts).toContain(UPDATED)
  await clock.settle()
  expect(data.reloads.length).toBe(1)
  const ui = await $.ui.mount(PANE(100))
  expect(await feedTexts($, ui)).toContain('desk 已更新版本：0.18.0 → 0.19.0')
  expect(await ui.find({ type: 'Text', text: /^ {2}有新版本/ })).toBeUndefined()
  await ui.unmount()
})

test('update reports the current version when desk is already up to date', async ($, on) => {
  const { data } = fixture(on)
  const { changes } = world(data, { kind: 'github', installed: '0.18.0', latest: '0.18.0' })
  const out = await $.command.run({ command: 'desk', args: 'update' } as any) as any
  expect(out.text).toBe('desk 已是最新版本（0.18.0）')
  expect(changes).toEqual([])
  expect(out.text).not.toMatch(/main|origin|[0-9a-f]{7}/)
})

test('update brings a local folder install up to the latest GitHub version', async ($, on) => {
  const { data, clock } = fixture(on)
  const { changes, calls, w } = world(data, { kind: 'folder', installed: '0.18.0', latest: '0.19.0' })
  const out = await $.command.run({ command: 'desk', args: 'update' } as any) as any
  expect(out.text).toBe(UPDATED)
  expect(w.installed).toBe('0.19.0')
  // 只快轉資料夾目前（預設）分支，再更新已安裝的 desk；不動其他分支、worktree，不 stash、不切換。
  expect(changes).toEqual(['git merge --ff-only --quiet origin/main', 'marketplace update claude-desk', 'update desk@claude-desk --scope user'])
  expect(calls.some(a => a.some(x => /^(stash|checkout|switch|reset|worktree|branch|push)$/.test(x)))).toBe(false)
  await clock.settle()
  expect(data.reloads.length).toBe(1)
  expect(data.fills).toEqual([])
})

test('update refuses and explains why when the local folder install is dirty, off the default branch, or has local commits', async ($, on) => {
  const { data, clock } = fixture(on)
  world(data, { kind: 'folder', installed: '0.18.0', latest: '0.19.0' })
  await openDesk($, clock)
  const cases: [Partial<World>, RegExp][] = [
    [{ dirty: true }, /有未提交的改動，請先 commit/],
    [{ branch: 'feat/x' }, /不在預設分支 main（目前 feat\/x），請先切回 main/],
    [{ ahead: 2 }, /有 2 個 GitHub 上沒有的 commit，請先 push/],
  ]
  for (const [extra, reason] of cases) {
    const { changes, w } = world(data, { kind: 'folder', installed: '0.18.0', latest: '0.19.0', ...extra })
    const out = await $.command.run({ command: 'desk', args: 'update' } as any) as any
    expect(out.text).toMatch(/^desk 無法更新，什麼都沒動：/)
    expect(out.text).toMatch(reason)
    expect(changes).toEqual([])
    expect(w.installed).toBe('0.18.0')
    const ui = await $.ui.mount(PANE(100))
    const feed = (await ui.findAll({ type: 'Text' })).find((n: any) => /desk 無法更新/.test(n.text) && n.props?.color === 'warning')
    expect(feed).toBeDefined()
    await ui.unmount()
  }
})

test('update leaves everything unchanged and shows the error when GitHub cannot be reached', async ($, on) => {
  const { data, clock } = fixture(on)
  world(data, { kind: 'github', installed: '0.18.0', latest: '0.18.0' })
  await openDesk($, clock)
  const runs: Partial<World>[] = [{ fetchFails: true }, { updateFails: true }, { kind: 'folder', fetchFails: true }, { kind: 'folder', updateFails: true }]
  for (const extra of runs) {
    const { changes, w, folder } = world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0', ...extra })
    const out = await $.command.run({ command: 'desk', args: 'update' } as any) as any
    expect(out.text).toMatch(/^desk 無法更新：/)
    expect(out.text).toContain(extra.fetchFails ? 'Could not resolve host: github.com' : 'network down')
    expect(out.text).not.toContain('second line')
    expect(out.text).not.toContain('more detail')
    expect(w.installed).toBe('0.18.0')
    // 本機資料夾：更新指令失敗時已經快轉過，要退回原本的 HEAD（資料夾維持原狀）。
    expect(folder.head).toBe('aaaa111')
    if (extra.kind === 'folder' && extra.updateFails) {
      expect(changes.filter(c => c.startsWith('git '))).toEqual(['git merge --ff-only --quiet origin/main', 'git reset --keep --quiet aaaa111'])
      expect(out.text).toContain('本機資料夾已退回原本的版本')
    } else expect(changes.filter(c => !c.startsWith('marketplace update'))).toEqual([])
    const ui = await $.ui.mount(PANE(100))
    const feed = (await ui.findAll({ type: 'Text' })).find((n: any) => /desk 無法更新/.test(n.text) && n.props?.color === 'error')
    expect(feed).toBeDefined()
    await ui.unmount()
  }
})

test('auto check shows a new version notice at most once per version and never installs', async ($, on) => {
  const { data, clock } = fixture(on)
  const { changes, w } = world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(changes).toEqual([])
  expect(w.installed).toBe('0.18.0')
  const pane = await $.ui.mount(PANE(100))
  expect(await pane.find({ type: 'Text', text: '  有新版本 0.19.0' })).toBeDefined()
  expect(await feedCount(pane, 'desk 有新版本 0.19.0')).toBe(1)
  await pane.unmount()
  const band = await $.ui.mount(BAND(100))
  expect(await band.find({ type: 'Text', text: '有新版本 0.19.0' })).toBeDefined()
  await band.unmount()
  expect(data.toasts.filter(t => t.includes('有新版本 0.19.0')).length).toBe(1)
  // 一天後再查到同一版：提示還在，但不再記「最近」、不再跳 toast。
  await later($, clock, DAY + 1000)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(data.toasts.filter(t => t.includes('有新版本')).length).toBe(1)
  const next = await $.ui.mount(PANE(100))
  expect(await next.find({ type: 'Text', text: '  有新版本 0.19.0' })).toBeDefined()
  expect(await feedCount(next, 'desk 有新版本 0.19.0')).toBe(1)
  await next.unmount()
  // 又出了新版：再提示一次。
  w.latest = '0.20.0'
  await later($, clock, DAY + 1000)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(data.toasts.filter(t => t.includes('有新版本 0.20.0')).length).toBe(1)
  const again = await $.ui.mount(PANE(100))
  expect(await again.find({ type: 'Text', text: '  有新版本 0.20.0' })).toBeDefined()
  await again.unmount()
  expect(changes).toEqual([])
  // 已是最新時不提示。
  w.latest = '0.18.0'
  await later($, clock, DAY + 1000)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const quiet = await $.ui.mount(PANE(100))
  expect(await quiet.find({ type: 'Text', text: /^ {2}有新版本/ })).toBeUndefined()
  await quiet.unmount()
})

test('auto check runs at most once every 24 hours across restarts and stays silent on failure', async ($, on) => {
  const { data, clock } = fixture(on)
  const { calls, w } = world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0', fetchFails: true })
  const fetches = () => calls.filter(a => a[3] === 'fetch').length
  // 查失敗：不提示、不記 error、不記時間，下一輪再查。
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(fetches()).toBe(1)
  expect(data.toasts).toEqual([])
  expect(data.store.updateCheck).toBeUndefined()
  const pane = await $.ui.mount(PANE(100))
  expect(await pane.find({ type: 'Text', text: /有新版本|無法更新|GitHub/ })).toBeUndefined()
  await pane.unmount()
  w.fetchFails = false
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(fetches()).toBe(2)
  expect((data.store.updateCheck as any).at).toBe(NOW)
  // 24 小時內不重查，重新整理幾次都一樣。
  await later($, clock, DAY - 60_000)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(fetches()).toBe(2)
  await clock.advance(120_000)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(fetches()).toBe(3)
})

test('auto check remembers the last check across restarts', async ($, on) => {
  const { data, clock } = fixture(on)
  const { calls } = world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0' })
  // 上一次開 Claude Code 時（一小時前）查過、也提示過：重開後不重查，提示照樣顯示，不再記一筆。
  data.store.updateCheck = { at: NOW - 60 * 60_000, latest: '0.19.0', current: '0.18.0', notified: '0.19.0' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(calls.filter(a => a[3] === 'fetch').length).toBe(0)
  expect(data.toasts).toEqual([])
  const band = await $.ui.mount(BAND(100))
  expect(await band.find({ type: 'Text', text: '有新版本 0.19.0' })).toBeDefined()
  await band.unmount()
})

test('auto check does not show a notice once the loaded desk is already the latest version', async ($, on) => {
  const { data, clock } = fixture(on)
  const { calls } = world(data, { kind: 'github', installed: '0.19.0', latest: '0.19.0' })
  // 0.18.0 時查到 0.19.0 存了起來；之後在工作桌以外升到 0.19.0 再重開（不到 24 小時，不會重查）。
  data.store.updateCheck = { at: NOW - 60 * 60_000, latest: '0.19.0', current: '0.18.0', notified: '0.19.0' }
  await openDesk($, clock)
  expect(calls.filter(a => a[3] === 'fetch').length).toBe(0)
  const pane = await $.ui.mount(PANE(100))
  expect(await pane.find({ type: 'Text', text: ' 0.19.0' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /有新版本/ })).toBeUndefined()
  await pane.unmount()
  const band = await $.ui.mount(BAND(100))
  expect(await band.find({ type: 'Text', text: /有新版本/ })).toBeUndefined()
  await band.unmount()
})

test('auto check is skipped when updateCheck is off', async ($, on) => {
  const { data, clock } = fixture(on)
  const { calls } = world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0' })
  data.files[`${PROJECT_DIR}/dispatch.json`] = JSON.stringify({ updateCheck: 'off' })
  data.store.updateCheck = { at: NOW - 2 * DAY, latest: '0.19.0', current: '0.18.0', notified: '0.19.0' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await later($, clock, 2 * DAY)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(calls).toEqual([])
  const band = await $.ui.mount(BAND(100))
  expect(await band.find({ type: 'Text', text: /有新版本/ })).toBeUndefined()
  await band.unmount()
  // 手動更新不受影響。
  const out = await $.command.run({ command: 'desk', args: 'update' } as any) as any
  expect(out.text).toBe(UPDATED)
})

test('the pane update button runs the same update as /desk update and has no hotkey', async ($, on) => {
  const { data, clock } = fixture(on)
  const { changes, w } = world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(100))
  const button = await ui.find({ key: 'update' })
  expect(button?.text).toBe('⇡ 更新到 0.19.0')
  expect(button?.props?.hotkey).toBeUndefined()
  // 面板上其他按鈕的快捷鍵都沒有被它佔用、也沒有重複。
  const hotkeys = (await ui.findAll({ type: 'Button' })).map((b: any) => b.props?.hotkey).filter(Boolean)
  expect(new Set(hotkeys).size).toBe(hotkeys.length)
  await ui.press({ key: 'update' })
  await clock.settle()
  expect(w.installed).toBe('0.19.0')
  expect(changes).toEqual(['marketplace update claude-desk', 'update desk@claude-desk --scope user'])
  expect(data.toasts).toContain(UPDATED)
  expect(data.reloads.length).toBe(1)
  // 更新後提示消失（已安裝的就是最新版），版本格改成「已是最新版本」淡字。
  expect(await ui.find({ type: 'Text', text: /^ {2}有新版本/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '✓ 已是最新版本' })).toBeDefined()
  expect(await ui.find({ key: 'update' })).toBeUndefined()
  await ui.unmount()
  const help = await $.command.run({ command: 'desk', args: 'nope' } as any) as any
  expect(help.text).toContain('update')
})

test('a successful update reloads plugins once after reporting the new version', async ($, on) => {
  const { data, clock } = fixture(on)
  world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0' })
  await openDesk($, clock)
  const ui = await $.ui.mount(PANE(100))
  data.feedAtReload = () => feedTexts($, ui)
  await ui.press({ key: 'update' })
  await clock.settle()
  expect(data.toasts).toContain(UPDATED)
  expect(await feedTexts($, ui)).toContain(UPDATED)
  // 正好重新載入一次，而且執行的時候 toast 與「最近」都已經寫好新版本。
  expect(data.reloads.length).toBe(1)
  expect(data.reloads[0]!.toasts).toContain(UPDATED)
  expect(data.reloads[0]!.seen).toContain(UPDATED)
  expect(data.fills).toEqual([])
  await ui.unmount()
})

/** 面板按「⇡ 更新到」成功、外掛重新載入之後，下一則你打的提示照樣附上更新結果；附過一次就不再附。 */
test('test_update_result_is_attached_to_next_typed_prompt_after_reload', async ($, on) => {
  const { data, clock } = fixture(on)
  world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0' })
  await openDesk($, clock)
  const ui = await $.ui.mount(PANE(100))

  await ui.press({ key: 'update' })
  await clock.settle()
  await ui.unmount()
  await $.prompt.submit({ text: '更新好了嗎？' } as any)
  await $.prompt.submit({ text: '再問一次' } as any)

  expect(data.reloads.length).toBe(1)
  const contexts = data.submitted.slice(-2).map((p: any) => (p.context ?? []).join('\n'))
  expect(contexts[0]).toContain('面板在對話外做了')
  expect(contexts[0]).toMatch(new RegExp(`- \\d\\d:\\d\\d ${UPDATED.replace(/[()（）→]/g, '\\$&')}`))
  expect(contexts[1]).not.toContain(UPDATED)
})

test('a refused reload prefills /reload-plugins, or asks to type it when the prompt cannot be filled', async ($, on) => {
  const { data, clock } = fixture(on)
  data.reloadable = false
  world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0' })
  // 被拒時載入計數還是 desk 自己這次：確定沒重新載入，才預填。
  await loadDesk($, on)
  await openDesk($, clock)
  const ui = await $.ui.mount(PANE(100))
  await ui.press({ key: 'update' })
  await clock.settle()
  expect(data.reloads).toEqual([])
  expect(data.fills).toEqual([{ text: '/reload-plugins', mode: 'replace' }])
  expect(data.toasts).toContain(UPDATED)
  expect(data.toasts).toContain(RELOAD_FILLED)
  expect(data.toasts).not.toContain(RELOAD_TYPE)
  expect((await ui.findAll({ type: 'Text' })).some((n: any) => /沒能自動重新載入：已填入/.test(n.text) && n.props?.color === 'warning')).toBe(true)
  await ui.unmount()
  // 輸入框也無法預填：改請使用者自己輸入。上一次已更新到最新（版本格沒有按鈕），重來一次：裝回 0.18.0、重新查到新版。
  data.fillable = false
  data.toasts = []
  world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0' })
  delete data.store.updateCheck
  await openDesk($, clock)
  const again = await $.ui.mount(PANE(100))
  await again.press({ key: 'update' })
  await clock.settle()
  expect(data.reloads).toEqual([])
  expect(data.toasts).toContain(RELOAD_TYPE)
  expect(data.toasts).not.toContain(RELOAD_FILLED)
  expect((await again.findAll({ type: 'Text' })).some((n: any) => /沒能自動重新載入：請輸入/.test(n.text) && n.props?.color === 'warning')).toBe(true)
  await again.unmount()
})

/** 重新載入其實已讓新版載入（desk 的載入計數又加了一次），舊版這邊才收到拒絕：新版已生效，不預填也不警告 */
test('a reload rejected after the new version already loaded neither prefills nor warns', async ($, on) => {
  const { data, clock } = fixture(on)
  data.reloadable = false
  data.refuseAfterNewLoad = true
  world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0' })
  await loadDesk($, on)
  await openDesk($, clock)
  const ui = await $.ui.mount(PANE(100))

  await ui.press({ key: 'update' })
  await clock.settle()

  expect(data.toasts).toContain(UPDATED)
  expect(data.fills).toEqual([])
  expect(data.toasts.filter(t => /沒能自動重新載入/.test(t))).toEqual([])
  expect(await feedTexts($, ui)).not.toMatch(/沒能自動重新載入/)
  await ui.unmount()
})

/** 這次載入的 desk 沒記到自己的載入次數（session.start 沒跑），session 裡卻已有載入記錄：分不出新版有沒有載入，寧可照樣預填提示，不靜默 */
test('a refused reload still prefills when this load was never counted', async ($, on) => {
  const { data, clock } = fixture(on)
  data.reloadable = false
  data.refuseAfterNewLoad = true
  world(data, { kind: 'github', installed: '0.18.0', latest: '0.19.0' })
  await openDesk($, clock)
  const ui = await $.ui.mount(PANE(100))

  await ui.press({ key: 'update' })
  await clock.settle()

  expect(data.toasts).toContain(UPDATED)
  expect(data.fills).toEqual([{ text: '/reload-plugins', mode: 'replace' }])
  expect(data.toasts).toContain(RELOAD_FILLED)
  expect((await ui.findAll({ type: 'Text' })).some((n: any) => /沒能自動重新載入：已填入/.test(n.text) && n.props?.color === 'warning')).toBe(true)
  await ui.unmount()
})

test('no reload when the update is already current, refused or failed', async ($, on) => {
  const { data, clock } = fixture(on)
  world(data, { kind: 'github', installed: '0.18.0', latest: '0.18.0' })
  await openDesk($, clock)
  const cases: [World, string | RegExp][] = [
    [{ kind: 'github', installed: '0.18.0', latest: '0.18.0' }, 'desk 已是最新版本（0.18.0）'],
    [{ kind: 'folder', installed: '0.18.0', latest: '0.19.0', dirty: true }, /^desk 無法更新，什麼都沒動：/],
    [{ kind: 'github', installed: '0.18.0', latest: '0.19.0', updateFails: true }, /^desk 無法更新：更新指令失敗/],
  ]
  for (const [w, expected] of cases) {
    // 輸入 /desk update 與按版本格的按鈕都一樣。上一輪查到的結果先清掉（當作沒查過），版本格才是「⇡ 檢查並更新」按鈕。
    delete data.store.updateCheck
    world(data, w)
    const out = await $.command.run({ command: 'desk', args: 'update' } as any) as any
    if (typeof expected === 'string') expect(out.text).toBe(expected)
    else expect(out.text).toMatch(expected)
    world(data, w)
    const ui = await $.ui.mount(PANE(100))
    // 已是最新：查到的結果記下來了，版本格只剩「已是最新版本」字樣，沒有按鈕可按。
    if (typeof expected === 'string') expect(await ui.find({ key: 'update' })).toBeUndefined()
    else await ui.press({ key: 'update' })
    await clock.settle()
    await ui.unmount()
  }
  expect(data.reloads).toEqual([])
  expect(data.fills).toEqual([])
  expect(data.toasts.some(t => t.includes('重新載入'))).toBe(false)
})

test('version helpers: compare numbers, pick the loaded install, find the manifest', () => {
  expect(compareVersions('0.19.0', '0.18.0')).toBe(1)
  expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
  expect(compareVersions('v1.2.0', '1.2.0')).toBe(0)
  expect(compareVersions('1.2.0-beta', '1.2.1')).toBe(-1)
  const plugins = [{ id: 'desk@a', version: '1.0.0', installPath: '/x' }, { id: 'desk@b', version: '2.0.0', installPath: '/y', readFromFolder: '/src' }]
  const markets = [{ name: 'a', source: 'github', installLocation: '/m/a' }, { name: 'b', source: 'directory', path: '/src' }]
  expect(pickInstall(plugins, markets, 'desk', '/src')).toEqual({ id: 'desk@b', marketplace: 'b', version: '2.0.0', kind: 'folder', dir: '/src' })
  expect(pickInstall(plugins, markets, 'desk', '/x')).toEqual({ id: 'desk@a', marketplace: 'a', version: '1.0.0', kind: 'github', dir: '/m/a' })
  expect(pickInstall([], markets, 'desk', '/x')).toBeNull()
  expect(manifestPath(JSON.stringify({ plugins: [{ name: 'desk', source: './' }] }), 'desk')).toBe('.claude-plugin/plugin.json')
  expect(manifestPath(JSON.stringify({ plugins: [{ name: 'desk', source: './plugins/desk' }] }), 'desk')).toBe('plugins/desk/.claude-plugin/plugin.json')
  expect(manifestPath(JSON.stringify({ plugins: [{ name: 'desk', source: '../evil' }] }), 'desk')).toBe('.claude-plugin/plugin.json')
  expect(manifestPath(null, 'desk')).toBe('.claude-plugin/plugin.json')
})
