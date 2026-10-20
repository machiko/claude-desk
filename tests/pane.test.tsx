import { expect, test } from 'claude-code/testing'
import { fixture, PANE, BAND, CARD_A, CARD_B, NOW, leaves, text } from './fixture'

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

test('picking options lights them and fill puts the answer in the prompt', async ($, on) => {
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

/** 選了案子之後，每次送出都以它為主：卡片沒變只附一句提醒，變了附全文；再點案名才取消。 */
test('a selected case stays the subject of every prompt until its name is clicked again', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /^Beta$/ })).toBeDefined()
  expect(await ui.find({ key: `row-${CARD_A}` })).toBeDefined()
  const seen = data.submitted

  await $.prompt.submit({ text: '請看一下' } as any)
  expect(seen[0].context?.[0]).toContain('案子「Beta」')
  expect(seen[0].context?.[0]).toContain('預設以它為主')
  expect(seen[0].context?.[0]).toContain('- 下一步：依審核修正')

  await $.prompt.submit({ text: '再一次' } as any)
  expect(seen[1].context?.[0]).toContain('案子「Beta」')
  expect(seen[1].context?.[0]).toContain('沒有變動')
  expect(seen[1].context?.[0]).not.toContain('- 下一步')

  data.files[CARD_B] = data.files[CARD_B]!.replace('- 下一步：依審核修正', '- 下一步：補測試')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.prompt.submit({ text: '卡片改了' } as any)
  expect(seen[2].context?.[0]).toContain('- 下一步：補測試')

  await ui.press({ key: `case-${CARD_B}-name` })
  await $.prompt.submit({ text: '取消選取後' } as any)
  expect(seen[3].context ?? []).toEqual([])
  await ui.unmount()
})

test('a selected case that leaves the registry is no longer attached', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_B}` })
  data.files['/home/u/.claude/handoffs/shop/projects-scope.md'] = `## 案子\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |`
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.prompt.submit({ text: 'Beta 歸檔了' } as any)
  expect(data.submitted[0].context ?? []).toEqual([])
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

const ASK = (data: any, ask: string) => { data.files[CARD_A] = data.files[CARD_A]!.replace(/- 等你：.*/, `- 等你：${ask}`) }
/** 畫面上的字（換行處接起來）都找得到。 */
const shows = async (ui: any, ...parts: string[]) => { const all = leaves(await ui.drawn(), 'Text').map(text).join(''); return parts.every(p => all.includes(p)) }
const GH_LOGIN = '在對話輸入 `! gh auth login` 登入 GitHub，好了說一聲'

test('an ask without options shows its text and offers no fill', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  ASK(data, GH_LOGIN)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(100))
  // 「▶ 輪到你」那句就是卡片上的原句，案子仍是等你。
  expect(await ui.find({ type: 'Text', text: '▶ 輪到你  ' })).toBeDefined()
  expect(await shows(ui, 'gh auth login', '好了說一聲')).toBe(true)
  expect(await ui.find({ type: 'Text', text: '  等你' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /按選項字母/ })).toBeUndefined()
  expect(await ui.find({ key: `case-${CARD_A}-fill` })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /填入決策/ })).toBeUndefined()
  const hotkeys = (await ui.findAll({ type: 'Button' })).map((b: any) => b.props?.hotkey)
  expect(hotkeys.includes('f')).toBe(false)
  // 按 m 展開全部動作也一樣：沒有任何按鈕綁 f，所以按 f 不會填入
  await ui.press({ key: 'more' })
  expect((await ui.find({ key: 'more' }))?.text).toBe('▴ 精簡動作')
  expect((await ui.findAll({ type: 'Button' })).some((b: any) => b.props?.hotkey === 'f')).toBe(false)
  expect(await ui.find({ key: `case-${CARD_A}-fill` })).toBeUndefined()
  await ui.press({ key: 'more' })
  // 摘要列也是那句話。
  const band = await $.ui.mount(BAND(160))
  const line = leaves(await band.drawn(), 'Text').map(text).join('')
  expect(line.startsWith('● Alpha')).toBe(true)
  expect(line).toContain('輪到你：在對話輸入 `! gh auth login` 登入 GitHub，好了說一聲')
  expect(line.includes('按選項字母')).toBe(false)
  await band.unmount()
  await ui.unmount()
})

test('a mixed ask lets you fill the decision and only shows the plain line', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  ASK(data, `${GH_LOGIN}；要 push 嗎？A) 要 B) 等`)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(100))
  expect(await ui.find({ type: 'Text', text: /按選項字母/ })).toBeDefined()
  // 沒選項那條只顯示文字，沒有選項按鈕。
  expect(await shows(ui, 'gh auth login', '好了說一聲')).toBe(true)
  expect((await ui.findAll({ type: 'Button' })).some((b: any) => String(b.key ?? '').startsWith(`case-${CARD_A}-opt0`))).toBe(false)
  // 有選項那條照舊可以按字母。
  expect((await ui.find({ key: `case-${CARD_A}-opt1A` }))?.props?.hotkey).toBe('a')
  expect((await ui.find({ key: `case-${CARD_A}-opt1B` }))?.props?.hotkey).toBe('b')
  const fill = `case-${CARD_A}-fill`
  expect((await ui.find({ key: fill }))?.text).toBe('✎ 填入決策')
  await ui.press({ key: `case-${CARD_A}-opt1A` })
  expect((await ui.find({ key: fill }))?.text).toBe('✎ 填入決策：A')
  await ui.press({ key: fill })
  expect(data.fills[0]).toEqual({ text: '「Alpha」決策：A', mode: 'replace' })
  await ui.unmount()
})
