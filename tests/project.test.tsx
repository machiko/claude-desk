import { expect, test } from 'claude-code/testing'
import { fixture, PANE, PROJECT_DIR, text, flat } from './fixture'
import { mergeSettingsText, projectKey, projectOf } from '../hooks/project'
import { REGISTRY_TEMPLATE } from '../hooks/card'
import { tutorialPaths } from '../hooks/tutorial'

const CREATE = 'create-registry'
const BLOG_REGISTRY = '/home/u/.claude/handoffs/blog/projects-scope.md'
/** 面板建的與 /desk:card new 建的一樣；兩份模板一致由 skills/card/tests/test_card.py 檢查。 */
const EMPTY_REGISTRY = REGISTRY_TEMPLATE
const TUTORIAL = tutorialPaths('/home/u')
const screen = async (ui: any) => flat(text(await ui.drawn()))
/** 對話換到另一個 repo（blog），它還沒有自己的登錄表。 */
const inBlog = (data: any) => { data.root = '/home/u/blog'; data.repos['/home/u/blog'] = '/home/u/blog/.git' }

const KEY_CASES: [string, string][] = [
  ['/home/u/My Project/.git', 'My Project'],
  ['/home/u/訂單平台/.git', '訂單平台'],
  ['/home/u/shop/.bare', 'shop'],
  ['/home/u/shop/.git/modules/lib', 'lib'],
  ['/home/u/.hidden/.git', ''],
]

test('project key: folder above .git; bare repo without .git; nothing usable is empty', () => {
  expect(projectKey('/home/u/shop/.git')).toBe('shop')
  expect(projectKey('/home/u/shop/.git/')).toBe('shop')
  expect(projectKey('C:\\code\\shop\\.git')).toBe('shop')
  expect(projectKey('/srv/git/shop.git')).toBe('shop')
  expect(projectKey('')).toBe('')
  expect(projectKey('/.git')).toBe('')
  // 與 card.py 的 project_key 同一張表（skills/card/tests/test_card.py 的 KEY_CASES）
  for (const [dir, key] of KEY_CASES) expect(projectKey(dir)).toBe(key)
  expect(projectOf('/home/u/shop/.git\n', '/home/u')).toEqual({ key: 'shop', dir: '/home/u/.claude/handoffs/shop' })
  expect(projectOf(null, '/home/u')).toBeNull()
})

test('settings merge: project top-level keys replace the global ones; a broken file counts as missing', () => {
  const merged = JSON.parse(mergeSettingsText(
    JSON.stringify({ model: 'opus', user: 'Alex', rules: ['全域'], review: { high: 'g' } }),
    JSON.stringify({ rules: ['專案'], review: { categories: 'p' }, composeDir: '~/shop' }),
  )!)
  expect(merged).toEqual({ model: 'opus', user: 'Alex', rules: ['專案'], review: { categories: 'p' }, composeDir: '~/shop' })
  expect(JSON.parse(mergeSettingsText('{"model":"opus"}', 'broken')!)).toEqual({ model: 'opus' })
  expect(JSON.parse(mergeSettingsText(null, '{"user":"Alex"}')!)).toEqual({ user: 'Alex' })
  expect(mergeSettingsText(null, null)).toBeNull()
})

test('a worktree of the repo shows the same project and its cases; the header names the project', async ($, on) => {
  const { data } = fixture(on)
  data.root = '/home/u/wt/alpha'
  data.repos['/home/u/wt/alpha'] = '/home/u/shop/.git'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: 'Alpha' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · shop' })).toBeDefined()
  await ui.unmount()
})

test('another repo without its own registry shows none of the other project cases', async ($, on) => {
  const { data } = fixture(on)
  data.root = '/home/u/blog'
  data.repos['/home/u/blog'] = '/home/u/blog/.git'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: /專案「blog」還沒有登錄表/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Alpha' })).toBeUndefined()
  await ui.unmount()
})

test('outside any git repo the pane asks to open desk inside a project', async ($, on) => {
  const { data } = fixture(on)
  data.root = '/home/u/notes'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: /不在 git repo 裡/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Alpha' })).toBeUndefined()
  // 不知道專案就不知道登錄表該建在哪：不給建立按鈕
  expect(await ui.find({ key: CREATE })).toBeUndefined()
  await ui.unmount()
})

/** 新專案還沒有登錄表：用一般字色說明怎麼開始（不是紅字錯誤），動作列有「＋ 建立空的登錄表」（n） */
test('a repo without its registry explains how to start and offers to create an empty one', async ($, on) => {
  const { data } = fixture(on)
  inBlog(data)

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))

  const shown = await screen(ui)
  expect(shown).toContain(flat('專案「blog」還沒有登錄表'))
  expect(shown).toContain(flat('~/.claude/handoffs/blog/projects-scope.md'))
  expect(shown).toContain(flat('/desk:card new'))
  const lead = (await ui.findAll({ type: 'Text' })).find((n: any) => /專案「blog」還沒有登錄表/.test(n.text))
  expect(lead?.props?.color).toBe('text')
  const button = await ui.find({ key: CREATE })
  expect(button?.text).toContain('建立空的登錄表')
  expect(button?.props?.hotkey).toBe('n')
  await ui.unmount()
})

/** 按下建立：專案資料夾寫出只有表頭的登錄表；面板改成空狀態，指向 /desk:card new 與 /desk tutorial */
test('pressing create writes an empty registry and the pane shows how to open the first card', async ($, on) => {
  const { data, clock } = fixture(on)
  inBlog(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))

  await ui.press({ key: CREATE })
  await clock.settle()

  expect(data.writes.filter(p => p === BLOG_REGISTRY)).toHaveLength(1)
  expect(data.files[BLOG_REGISTRY]).toBe(EMPTY_REGISTRY)
  expect(data.toasts.some(t => t.includes('已建立空的登錄表'))).toBe(true)
  const shown = await screen(ui)
  expect(shown).toContain(flat('尚無任務：用 /desk:card new'))
  expect(shown).toContain(flat('/desk tutorial'))
  expect(shown).not.toContain(flat('/desk demo'))
  expect(shown).not.toContain(flat('還沒有登錄表'))
  expect(await ui.find({ key: CREATE })).toBeUndefined()
  await ui.unmount()
})

/** 按鈕還在、登錄表卻已經被別處建好（對話或 /desk:card new）：不覆寫，提示後重讀 */
test('create never overwrites a registry that appeared after the last refresh', async ($, on) => {
  const { data, clock } = fixture(on)
  inBlog(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  const existing = `${EMPTY_REGISTRY}| 部落格改版 | \`/home/u/blog-worktrees/redesign/.desk/CARD.md\` | | | |\n`
  data.files[BLOG_REGISTRY] = existing

  await ui.press({ key: CREATE })
  await clock.settle()

  expect(data.writes).not.toContain(BLOG_REGISTRY)
  expect(data.files[BLOG_REGISTRY]).toBe(existing)
  expect(data.toasts.some(t => t.includes('已經有登錄表'))).toBe(true)
  expect(await screen(ui)).toContain(flat('部落格改版'))
  await ui.unmount()
})

/** registryPath 是使用者自己指定的共用登錄表：讀不到照舊報錯，不替他建 */
test('no create button for a registryPath set in the options', { options: { registryPath: '~/all-cases.md' } }, async ($, on) => {
  const { data } = fixture(on)
  inBlog(data)

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))

  expect(await ui.find({ type: 'Text', text: /無法讀取登錄表 \/home\/u\/all-cases\.md/ })).toBeDefined()
  expect(await ui.find({ key: CREATE })).toBeUndefined()
  await ui.unmount()
})

/** registryPath 指到專案資料夾裡的另一個檔：一樣是使用者自己指定的，讀不到照舊紅字報錯，不替他建 */
test('no create button for a registryPath inside the project folder', { options: { registryPath: '~/.claude/handoffs/blog/all.md' } }, async ($, on) => {
  const { data } = fixture(on)
  inBlog(data)

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))

  const lead = (await ui.findAll({ type: 'Text' })).find((n: any) => /無法讀取登錄表 \/home\/u\/\.claude\/handoffs\/blog\/all\.md/.test(n.text))
  expect(lead?.props?.color).toBe('error')
  expect(await ui.find({ key: CREATE })).toBeUndefined()
  await ui.unmount()
})

/** 登錄表在、卻讀不到（權限、是資料夾）：照實說讀不到、維持紅字，不給建立按鈕（建了也會被擋下） */
test('an unreadable registry is reported as unreadable, in red, without a create button', async ($, on) => {
  const { data } = fixture(on)
  inBlog(data)
  data.files[BLOG_REGISTRY] = EMPTY_REGISTRY
  data.unreadable.push(BLOG_REGISTRY)

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))

  const lead = (await ui.findAll({ type: 'Text' })).find((n: any) => /無法讀取登錄表/.test(n.text))
  expect(lead?.props?.color).toBe('error')
  expect(await screen(ui)).not.toContain(flat('還沒有登錄表'))
  expect(await ui.find({ key: CREATE })).toBeUndefined()
  await ui.unmount()
})

/** 按鈕是上一輪讀到的：對話換回有登錄表的 repo、還沒重讀就按，不在上一個專案建，提示後重讀 */
test('create after switching to another repo writes nothing into the previous project', async ($, on) => {
  const { data, clock } = fixture(on)
  inBlog(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  data.root = '/home/u/shop'

  await ui.press({ key: CREATE })
  await clock.settle()

  expect(data.writes).not.toContain(BLOG_REGISTRY)
  expect(data.files[BLOG_REGISTRY]).toBeUndefined()
  expect(data.toasts.some(t => t.includes('專案或登錄表已經變了'))).toBe(true)
  expect(await screen(ui)).toContain('Alpha')
  await ui.unmount()
})

/** 教學模式讀不到沙盒的登錄表：照舊提示結束教學，不給建立按鈕 */
test('tutorial mode never offers to create a registry', async ($, on) => {
  const { data } = fixture(on)
  inBlog(data)
  data.git[TUTORIAL.wt] = { branch: 'feature/discount', head: 'h0' }
  data.git[TUTORIAL.main] = { branch: 'release/v1.0', head: 'm0' }
  await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  delete data.files[TUTORIAL.registry]

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))

  expect(await screen(ui)).toContain(flat('無法讀取教學的登錄表'))
  expect(await ui.find({ key: CREATE })).toBeUndefined()
  await ui.unmount()
})

test('a folder that becomes a repo later is picked up on the next refresh', async ($, on) => {
  const { data } = fixture(on)
  data.root = '/home/u/later'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  data.repos['/home/u/later'] = '/home/u/shop/.git'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: 'Alpha' })).toBeDefined()
  await ui.unmount()
})

test('registryPath set in the options is read in every project', { options: { registryPath: '~/all-cases.md' } }, async ($, on) => {
  const { data } = fixture(on)
  data.files['/home/u/all-cases.md'] = data.files[`${PROJECT_DIR}/projects-scope.md`]!
  data.root = '/home/u/blog'
  data.repos['/home/u/blog'] = '/home/u/blog/.git'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: 'Alpha' })).toBeDefined()
  await ui.unmount()
})

test('composeDir in the project dispatch.json wins over the option and moves the container probe', { options: { composeDir: '/home/u/other' } }, async ($, on) => {
  const { data } = fixture(on)
  data.files['/home/u/.claude/handoffs/dispatch.json'] = '{"model":"opus"}'
  data.files[`${PROJECT_DIR}/dispatch.json`] = '{"composeDir":"~/shop"}'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  expect(data.composeCalls.at(-1)?.init?.cwd).toBe('/home/u/shop')
})
