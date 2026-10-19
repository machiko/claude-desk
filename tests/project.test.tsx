import { expect, test } from 'claude-code/testing'
import { fixture, PANE, PROJECT_DIR } from './fixture'
import { mergeSettingsText, projectKey, projectOf } from '../hooks/project'

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
  expect(await ui.find({ type: 'Text', text: /專案「blog」還沒建/ })).toBeDefined()
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
