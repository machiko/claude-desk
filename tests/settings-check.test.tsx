import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, flat, PANE, PROJECT_DIR, text } from './fixture'
import { parseSettings, settingsFeedText, settingsNotices, settingsProblems } from '../hooks/settings'
import { mergeSettingsText } from '../hooks/project'
import { issueOf } from '../hooks/model'
import type { FeedEvent } from '../types'

// 設定檔驗證（卡片「設定檔驗證」AC-1～AC-5）：dispatch.json 寫錯時面板說出哪個檔、哪個鍵、改用了什麼；解析結果不變。
const SETTINGS = '/home/u/.claude/handoffs/dispatch.json'
const PROJECT_SETTINGS = `${PROJECT_DIR}/dispatch.json`
const JSON_BROKEN = 'JSON 格式錯誤，這份設定沒有套用'

test('settingsProblems reports a JSON syntax error', () => {
  const broken = '{ "model": "opus", }'
  expect(settingsProblems(broken)).toEqual([JSON_BROKEN])
  expect(settingsProblems('[1, 2]')).toEqual(['最外層不是物件，這份設定沒有套用'])
  // 空檔跟沒有這份一樣；開頭的 BOM 照解析時一樣略過。
  expect(settingsProblems('')).toEqual([])
  expect(settingsProblems('\uFEFF{"model":"opus"}')).toEqual([])
  // 另一份正確的設定照常生效
  const good = JSON.stringify({ model: 'sonnet', user: 'Alex' })
  expect(parseSettings(mergeSettingsText(broken, good))).toMatchObject({ model: 'sonnet', user: 'Alex' })
  expect(parseSettings(mergeSettingsText(good, broken))).toMatchObject({ model: 'sonnet', user: 'Alex' })
})

test('settingsProblems lists unknown keys with their full path', () => {
  const problems = settingsProblems(JSON.stringify({
    executor: 'agy',
    model: 'opus',
    review: { agent: 'codex', high: 'bug' },
    card: { foo: 1, base: 'origin/main', changelog: { style: 'x' } },
    kinds: { sync: { model: 'haiku' }, review: { effort: 'high', temperature: 1 } },
    sync: { claude: { model: 'haiku', speed: 'fast' } },
    projects: { '/code/shop': { effort: 'xhigh', modle: 'opus' } },
    risk: { high: [{ pattern: 'Billing/', label: '金流', why: '錢' }], low: [] },
    pr: { open: 'glab mr create', draft: true },
  }))
  expect(problems).toEqual([
    '認不得的鍵，已略過：executor、review.agent、card.foo、card.changelog.style、kinds.sync、kinds.review.temperature、sync.claude.speed、projects./code/shop.modle、risk.high[0].why、risk.low、pr.draft',
  ])
})

test('settingsProblems names bad values and the value used instead', () => {
  const text = JSON.stringify({ maxAgents: -1, autoPr: 'true', chainQuotaStop: 200, risk: { high: [{ pattern: '(', label: '金流' }] }, user: 3 })
  const problems = settingsProblems(text)
  expect(problems).toContain('maxAgents 不是非負整數，改用 3')
  expect(problems).toContain('autoPr 只認 JSON 的 true，視為關')
  expect(problems).toContain('chainQuotaStop 要是 1–100 的整數或 "off"，改用 30')
  expect(problems).toContain('user 不是字串，改用「使用者」')
  expect(problems.filter(p => /^risk\.high\[0\] 的正規式寫錯（.+），這條略過$/.test(p))).toHaveLength(1)
  expect(problems).toHaveLength(5)
  // 寫出的「改用」就是解析實際用的值
  expect(parseSettings(text)).toMatchObject({ maxAgents: 3, autoPr: false, chainQuotaStop: 30, user: '使用者', riskHigh: [] })

  const more = JSON.stringify({
    mcp: 1, stopDone: 'no', updateCheck: 'never', model: 5, rules: ['a', 2], sync: { session: 'resume' },
    review: { preflightMinFiles: 1.5, combineSecurity: 'yes', high: 1 }, projects: { '/code/shop': 'opus' },
    risk: { high: [{ pattern: 'x' }] }, checkServices: { 'run-tests': 'mysql' },
    card: { specPreflightMinFiles: 0, changelog: { format: 'kac' }, main: 1 },
  })
  expect(settingsProblems(more)).toEqual([
    'mcp 只認 JSON 的 true，視為關',
    'stopDone 只認 JSON 的 false，視為開',
    'updateCheck 只認 "off"，照常檢查新版本',
    'model 不是字串，視為沒設',
    'rules 有不是字串的項目，那幾項略過',
    'sync.session 只認 "fresh"，視為接著任務原本的對話',
    'review.preflightMinFiles 不是非負整數，改用 0',
    'review.combineSecurity 只認 JSON 的 true，視為關',
    'review.high 不是字串，改用預設',
    'projects./code/shop 不是物件，整段略過',
    'risk.high[0] 少了 pattern 或 label，這條略過',
    'checkServices.run-tests 不是字串陣列，視為沒設',
    'card.specPreflightMinFiles 不是正整數，改用 3',
    'card.changelog.format 只能是 "keepachangelog"，合併 changelog 時會停下報錯',
    'card.main 不是字串，視為沒設',
  ])
  expect(parseSettings(more)).toMatchObject({ mcp: false, stopDone: true, updateCheck: '', model: '', rules: ['a'], review: { preflightMinFiles: 0, combineSecurity: false } })

  // 動態一句最多列 3 條，其餘寫總數
  const line = settingsFeedText(SETTINGS, problems)
  expect(line).toBe(`設定檔 ${SETTINGS} 有問題：${problems.slice(0, 3).join('；')} 等 5 條`)
  expect(settingsFeedText(SETTINGS, [JSON_BROKEN])).toBe(`設定檔 ${SETTINGS} 有問題：${JSON_BROKEN}`)
})

test('settingsProblems accepts every documented key', () => {
  const documented = {
    $schema: 'https://example.com/dispatch.schema.json',
    _comment: '註解鍵不算錯',
    model: 'opus',
    effort: 'high',
    sync: { claude: { model: 'haiku', effort: 'low' }, session: 'fresh' },
    kinds: { continue: { model: 'opus' }, reply: { effort: 'low' }, review: { effort: 'xhigh' }, publish: { model: 'haiku', effort: 'low' } },
    projects: { '~/code/shop-worktrees/order-export': { model: 'opus', effort: 'xhigh', rules: ['只改 api/ 底下'] } },
    user: 'Alex',
    maxAgents: 0,
    chainQuotaStop: 'off',
    mcp: false,
    stopDone: false,
    autoPr: true,
    updateCheck: 'off',
    pr: { open: 'glab mr create --source-branch {branch} --target-branch {target}' },
    rules: ['測試只能用 make test，不要自己起資料庫'],
    review: {
      _note: '巢狀的註解鍵也略過',
      high: '實際的 bug', security: '授權與資料範圍', categories: '授權、稽核', template: '~/my-templates/review.md',
      preflight: 'agy-review --root {root} --base {base}', pitfalls: '~/code/shop/docs/review-pitfalls.md',
      preflightMinFiles: 3, combineSecurity: true,
    },
    risk: { high: [{ pattern: '(^|/)Billing/', label: '金流' }] },
    checkServices: { 'run-tests': ['mysql'] },
    composeDir: '~/code/shop',
    card: {
      main: '~/code/shop', worktrees: '~/code/shop-worktrees', base: 'origin/main', check: 'make test-worktree SLUG={slug}',
      registry: '~/code/shop/projects-scope.md', template: '~/my-templates/DESK-template.md', archive: '~/code/shop/archive',
      specRules: ['寫入操作的「則」要包含稽核紀錄'], specPreflight: 'agy-spec --root {root} --card {card} --paths {paths}',
      specPreflightMinFiles: 3, retro: 'desk-retro {slug}', changelog: { format: 'keepachangelog' },
    },
  }
  expect(settingsProblems(JSON.stringify(documented))).toEqual([])
  // 其他合法寫法：chainQuotaStop 的 false 與 1–100、updateCheck 的 false、null 跟沒寫一樣
  expect(settingsProblems(JSON.stringify({ chainQuotaStop: false, updateCheck: false, model: null }))).toEqual([])
  expect(settingsProblems(JSON.stringify({ chainQuotaStop: 100, maxAgents: 5 }))).toEqual([])
})

test('refresh reports a broken dispatch.json in the feed once', async ($, on) => {
  const { data } = fixture(on)
  const feed = feedLog(on)
  data.files[SETTINGS] = '{ "model": "sonnet", }'
  data.files[PROJECT_SETTINGS] = JSON.stringify({ model: 'opus', effort: 'high' })
  const reports = () => feed.list.filter(e => e.text.includes(SETTINGS))
  const refresh = () => $.command.run({ command: 'desk', args: 'refresh' } as any)

  await refresh()
  expect(reports()).toHaveLength(1)
  const first = reports()[0]!
  expect(first.text).toBe(`設定檔 ${SETTINGS} 有問題：${JSON_BROKEN}`)
  expect(first.tone).toBe('error')
  expect(first.card).toBeUndefined()
  expect(data.toasts).toContain(first.text)
  // 另一份（專案的）設定沒問題、照常生效
  expect(feed.list.some(e => e.text.includes(PROJECT_SETTINGS))).toBe(false)
  const ui = await $.ui.mount(PANE(90))
  expect(await ui.find({ type: 'Text', text: '派工 opus high' })).toBeDefined()
  await ui.unmount()

  // 內容沒變：連續重新整理不再報
  await refresh()
  await refresh()
  expect(reports()).toHaveLength(1)
  expect(data.toasts.filter(t => t === first.text)).toHaveLength(1)

  // 改成另一種錯誤：再報一次
  data.files[SETTINGS] = JSON.stringify({ executor: 'agy' })
  await refresh()
  await refresh()
  expect(reports()).toHaveLength(2)
  expect(reports()[0]!.text).toBe(`設定檔 ${SETTINGS} 有問題：認不得的鍵，已略過：executor`)

  // 改正後不再報錯，記一筆「已改正」，問題列不再掛著舊錯誤
  data.files[SETTINGS] = JSON.stringify({ model: 'sonnet' })
  await refresh()
  await refresh()
  expect(reports().filter(e => e.tone === 'error')).toHaveLength(2)
  expect(reports()).toHaveLength(3)
  expect(reports()[0]).toMatchObject({ text: `設定檔 ${SETTINGS} 已改正`, tone: 'success' })
  expect(issueOf(feed.list as FeedEvent[], null)).toBeNull()
})

test('refresh reports a broken project dispatch.json and the global one still applies', async ($, on) => {
  const { data } = fixture(on)
  const feed = feedLog(on)
  data.files[SETTINGS] = JSON.stringify({ model: 'opus', effort: 'high' })
  data.files[PROJECT_SETTINGS] = '{ "autoPr": true'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const line = `設定檔 ${PROJECT_SETTINGS} 有問題：${JSON_BROKEN}`
  expect(feed.list.filter(e => e.text.includes(PROJECT_SETTINGS))).toEqual([expect.objectContaining({ text: line, tone: 'error' })])
  expect(data.toasts).toContain(line)
  expect(feed.list.some(e => e.text.includes(SETTINGS))).toBe(false)
  const ui = await $.ui.mount(PANE(90))
  expect(await ui.find({ type: 'Text', text: '派工 opus high' })).toBeDefined()
  await ui.unmount()
})

test('a reported dispatch.json that is fixed or removed no longer shows on the issue row', async ($, on) => {
  const { data } = fixture(on)
  const feed = feedLog(on)
  const refresh = () => $.command.run({ command: 'desk', args: 'refresh' } as any)
  const screen = async () => { const ui = await $.ui.mount(PANE(120)); const s = flat(text(await ui.drawn())); await ui.unmount(); return s }
  data.files[SETTINGS] = '{'
  data.files[PROJECT_SETTINGS] = JSON.stringify({ executor: 'agy' })
  await refresh()
  expect(await screen()).toContain(flat(`設定檔 ${SETTINGS} 有問題`))

  // 全域那份改正、專案那份還壞著：問題列改顯示還壞著的那份，不是「已改正」就收掉
  data.files[SETTINGS] = JSON.stringify({ model: 'opus' })
  await refresh()
  const still = `設定檔 ${SETTINGS} 已改正；設定檔 ${PROJECT_SETTINGS} 有問題：認不得的鍵，已略過：executor`
  expect(feed.list[0]).toMatchObject({ text: still, tone: 'error' })
  expect(issueOf(feed.list as FeedEvent[], null)?.text).toBe(still)

  // 專案那份刪掉：兩份都沒問題了，問題列收掉
  delete data.files[PROJECT_SETTINGS]
  await refresh()
  expect(feed.list[0]).toMatchObject({ text: `設定檔 ${PROJECT_SETTINGS} 已移除，不再報錯`, tone: 'success' })
  expect(issueOf(feed.list as FeedEvent[], null)).toBeNull()
  expect(await screen()).not.toContain(flat('有問題'))

  // 再建一份同樣的壞檔：再報一次
  data.files[PROJECT_SETTINGS] = JSON.stringify({ executor: 'agy' })
  await refresh()
  expect(feed.list[0]).toMatchObject({ text: `設定檔 ${PROJECT_SETTINGS} 有問題：認不得的鍵，已略過：executor`, tone: 'error' })
})

test('settingsNotices clears a reported file that no longer belongs to this project', () => {
  const before = { '/p/shop/dispatch.json': { text: '{', problems: [JSON_BROKEN] }, [SETTINGS]: { text: '{}', problems: [] } }
  const { checked, events } = settingsNotices([{ path: SETTINGS, text: '{}', problems: [] }], before, 1)
  expect(events).toEqual([{ at: 1, text: '設定檔 /p/shop/dispatch.json 不屬於目前專案，不再報錯', tone: 'success' }])
  expect(checked).toEqual({ [SETTINGS]: { text: '{}', problems: [] } })
  // 沒有之前報過的：什麼都不報
  expect(settingsNotices([{ path: SETTINGS, text: '{}', problems: [] }], {}, 1).events).toEqual([])
})
