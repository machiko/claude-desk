import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, NOW, leaves, text } from './fixture'

test('the now card shows the case that needs a person; the list holds the rest with digit hotkeys', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  expect(await ui.find({ type: 'Text', text: /^Alpha$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /要 push 嗎？/ })).toBeDefined()
  const beta = await ui.find({ key: '/home/u/wt/beta/.desk/CARD.md'.replace(/^/, 'row-') })
  expect(beta?.text).toContain('Beta')
  expect(beta?.text.replace(/\s+/g, '')).toContain('●◉○○○○')
  expect(beta?.props?.hotkey).toBe('1')
  const gamma = await ui.find({ key: 'row-/home/u/wt/gamma/.desk/CARD.md' })
  expect(gamma?.props?.hotkey).toBe('2')
  expect(data.toasts.length).toBe(0)
  await ui.unmount()
})

test('picking options lights them, fill puts the answer in the prompt and selects the case', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  const fill = `case-${CARD_A}-fill`
  expect((await ui.find({ key: fill }))?.text).toBe('✎ 填入決策')
  await ui.press({ key: fill })
  expect(data.fills.length).toBe(0)
  expect(data.toasts.some(t => t.includes('請先完成每個決策'))).toBe(true)
  await ui.press({ key: `case-${CARD_A}-opt0B` })
  expect((await ui.find({ key: fill }))?.text).toBe('✎ 填入決策：B')
  await ui.press({ key: `case-${CARD_A}-opt0A` })
  expect((await ui.find({ key: fill }))?.text).toBe('✎ 填入決策：A')
  await ui.press({ key: fill })
  expect(data.fills[0]).toEqual({ text: '「Alpha」決策：A', mode: 'replace' })
  await ui.unmount()
})

test('verify asks once per command, runs in the case root, and records the result', async ($, on) => {
  const { data, clock } = fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: 'more' }) // 這張卡在等你決定，檢查鍵平常不出現；測檢查本身先展開全部動作
  const key = `case-${CARD_A}-verify`
  expect((await ui.find({ key }))?.text).toBe('▶ 檢查')
  await ui.press({ key })
  await clock.settle()
  expect(data.asks.length).toBe(1)
  expect(data.processCalls.length).toBe(1)
  expect(data.processCalls[0].argv).toEqual(['sh', '-c', 'node test.mjs'])
  expect(data.processCalls[0].init).toEqual({ cwd: '/home/u/wt/alpha', timeoutMs: 600000 })
  expect(await ui.find({ type: 'Text', text: /✓ 通過/ })).toBeDefined()
  expect(data.store.trustedVerify).toEqual({ [CARD_A]: 'node test.mjs' })
  expect((data.store.verifies as any)[CARD_A].ok).toBe(true)
  data.run = async () => ({ exitCode: 2, stdout: 'one\ntwo\n', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false })
  await ui.press({ key })
  await clock.settle()
  expect(data.asks.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /✕ 未通過 exit 2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /boom/ })).toBeDefined()
  expect(data.toasts.filter(t => t.includes('檢查')).length).toBe(2)
  await ui.unmount()
})

test('a declined verify runs nothing', async ($, on) => {
  const { data, clock } = fixture(on)
  data.answer = '取消'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: 'more' }) // 這張卡在等你決定，檢查鍵平常不出現；測檢查本身先展開全部動作
  await ui.press({ key: `case-${CARD_A}-verify` })
  await clock.settle()
  expect(data.processCalls.length).toBe(0)
  expect(data.store.trustedVerify).toBeUndefined()
  await ui.unmount()
})

test('selecting a row moves it to the now card and attaches its card to the next prompt once', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: 'row-/home/u/wt/beta/.desk/CARD.md' })
  expect(await ui.find({ type: 'Text', text: /^Beta$/ })).toBeDefined()
  expect(await ui.find({ key: `row-${CARD_A}` })).toBeDefined()
  const seen = data.submitted
  await $.prompt.submit({ text: '請看一下' } as any)
  expect(seen.length).toBe(1)
  expect(seen[0].context?.[0]).toContain('案子「Beta」')
  expect(seen[0].context?.[0]).toContain('- 下一步：依審核修正')
  await $.prompt.submit({ text: '再一次' } as any)
  expect(seen[1].context ?? []).toEqual([])
  await ui.unmount()
})

test('every width keeps the six stage icons right after the case name', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  for (const columns of [40, 72, 120]) {
    const ui = await $.ui.mount(PANE(columns))
    const drawn: any = await ui.drawn()
    for (const node of leaves(drawn, 'Text')) if (node.props?.wrap !== 'wrap') expect(text(node).includes('\n')).toBe(false)
    const beta = await ui.find({ key: 'row-/home/u/wt/beta/.desk/CARD.md' })
    expect(beta?.text.replace(/\s+/g, '').includes('●◉○○○○')).toBe(true)
    await ui.unmount()
  }
})

test('without a registry the pane says so and the band stays quiet', async ($, on) => {
  const { data } = fixture(on)
  delete data.files['/home/u/.claude/handoffs/shop/projects-scope.md']
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  expect(await ui.find({ type: 'Text', text: /無法讀取登錄表/ })).toBeDefined()
  await ui.unmount()
})

test('continue launches claude --bg in the case root, confirms the session and shows it running', async ($, on) => {
  const { data, clock } = fixture(on)
  data.files['/home/u/.claude/handoffs/dispatch.json'] = '{"model":"opus","effort":"high"}'
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.agents = []
  const sid = 'aaaaaaaa-0000-4000-8000-000000000000'
  data.launch = async (e: any) => {
    data.agents = [{ id: 'aaaaaaaa', kind: 'background', cwd: '/home/u/wt/alpha', name: e.argv[3], sessionId: sid, state: 'working', status: 'busy', startedAt: NOW }]
    return { exitCode: 0, stdout: 'aaaaaaaa\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: `case-${CARD_A}-continue` })
  await clock.settle()
  expect(data.launches.length).toBe(0)
  expect((await ui.find({ key: `case-${CARD_A}-continue` }))?.text).toBe('再按 g 確認繼續（opus · high）')
  await ui.press({ key: `case-${CARD_A}-continue` })
  await clock.settle()
  expect(data.launches.length).toBe(1)
  const argv = data.launches[0].argv
  expect(argv.slice(0, 3)).toEqual(['claude', '--bg', '--name'])
  expect(argv).toContain('--model')
  expect(argv).not.toContain('--resume')
  expect(data.launches[0].init.cwd).toBe('/home/u/wt/alpha')
  expect(argv[argv.length - 1]).toContain('依卡片的下一步繼續：push')
  expect((data.store.jobs as any)['/home/u/wt/alpha'].sessionId).toBe(sid)
  expect(data.toasts.some(t => t.includes('繼續已派出'))).toBe(true)
  await ui.unmount()
  // 第二次繼續接續同一個 session
  data.agents = [{ ...data.agents[0], status: 'idle', state: 'done' }]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches[1].argv).toContain('--resume')
  expect(data.launches[1].argv[data.launches[1].argv.indexOf('--resume') + 1]).toBe(sid)
})

test('a running case offers no dispatch, and a failed launch is reported without recording a session', async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.launch = async () => ({ exitCode: 1, stdout: '', stderr: 'not logged in', isStdoutTruncated: false, isStderrTruncated: false })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Beta' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(0)
  expect(data.toasts.some(t => t.includes('目前無法繼續'))).toBe(true)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(1)
  expect(data.store.jobs).toBeUndefined()
  expect(data.toasts.some(t => t.includes('not logged in'))).toBe(true)
})

test('the first dispatch of a case resumes the session console-status recorded for it', async ($, on) => {
  const { data, clock } = fixture(on)
  const old = 'cccccccc-0000-4000-8000-000000000000'
  data.files['/home/u/.claude/handoffs/claude-sessions.json'] = JSON.stringify({ version: 1, roots: { '/home/u/wt/alpha': { root: '/home/u/wt/alpha', sessionId: old, jobs: [] } } })
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.launch = async (e: any) => {
    data.agents = [{ id: 'cccccccc', kind: 'background', cwd: '/home/u/wt/alpha', name: e.argv[3], sessionId: old, state: 'working', status: 'busy' }]
    return { exitCode: 0, stdout: 'cccccccc', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  const argv = data.launches[0].argv
  expect(argv[argv.indexOf('--resume') + 1]).toBe(old)
})

test('the status shows one short line by default and the full clauses when expanded', async ($, on) => {
  const { data } = fixture(on)
  data.files[CARD_A] = data.files[CARD_A]!.replace('- 狀態：Alpha 一切就緒', '- 狀態：第一件事（細節 abc1234def）；第二件事；第三件事；第四件事')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  expect(await ui.find({ type: 'Text', text: '第一件事' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '第二件事' })).toBeUndefined()
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: '第四件事' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '第一件事（細節 abc1234def）' })).toBeDefined()
  await ui.unmount()
})
