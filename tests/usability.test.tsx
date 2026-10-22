import { expect, test } from 'claude-code/testing'
import { fixture, PANE, BAND, CARD_A, CARD_B, NOW, result } from './fixture'
import { AGENT_STOPPED } from '../hooks/chain'

test('a dispatch confirm expires after 3 seconds', async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: `case-${CARD_A}-sync` })
  await clock.advance(3500); await clock.settle()
  await ui.press({ key: `case-${CARD_A}-sync` })
  await clock.settle()
  expect(data.launches.length).toBe(0)
  expect((await ui.find({ key: `case-${CARD_A}-sync` }))?.text.startsWith('再按 s 確認同步')).toBe(true)
  await ui.unmount()
})

test('stop asks twice and only stops the agent desk launched', async ($, on) => {
  const { data, clock } = fixture(on)
  const stops: any[] = []
  data.agents = [{ id: 'dddddddd', kind: 'background', cwd: '/home/u/wt/beta', name: 'desk-abc-0', sessionId: 'dddddddd-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: NOW }]
  data.store.jobs = { '/home/u/wt/beta': { sessionId: 'dddddddd-0000-4000-8000-000000000000', last: { launchName: 'desk-abc-0', nativeId: 'dddddddd', sessionId: 'dddddddd-0000-4000-8000-000000000000', kind: 'continue', startedAt: NOW, fresh: false, owner: 'fixture-session' } } }
  data.store.chains = { '/home/u/wt/beta': { owner: 'fixture-session', startedAt: NOW, round: 0 } }
  const realRun = data.run
  data.run = async (e: any) => { if (e.argv[0] === 'claude' && e.argv[1] === 'stop') { stops.push(e.argv); return result(0, '') } return realRun(e) }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_B}` })
  await ui.press({ key: `case-${CARD_B}-stop` })
  expect(stops.length).toBe(0)
  expect((await ui.find({ key: `case-${CARD_B}-stop` }))?.text).toBe('再按 k 確認停止')
  await ui.press({ key: `case-${CARD_B}-stop` })
  await clock.settle()
  expect(stops).toEqual([['claude', 'stop', 'dddddddd']])
  expect((data.store.chains as any)['/home/u/wt/beta'].stopped).toBe(AGENT_STOPPED)
  await ui.unmount()
})

test('an agent desk did not launch has no stop button', async ($, on) => {
  const { data } = fixture(on)
  data.agents = [{ id: 'eeeeeeee', kind: 'background', cwd: '/home/u/wt/beta', name: 'someone-else', sessionId: 'eeeeeeee-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: NOW }]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ key: `case-${CARD_B}-stop` })).toBeUndefined()
  expect(await ui.find({ key: `case-${CARD_B}-logs` })).toBeDefined()
  await ui.unmount()
})

test('logs open the last lines of the executor output', async ($, on) => {
  const { data, clock } = fixture(on)
  data.logs['bbbbbbbb'] = '● 讀取卡片\nThinking…\n● 修改 CaseImportService.php\n● 執行 php artisan test'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_B}` })
  await ui.press({ key: `case-${CARD_B}-logs` })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '● 修改 CaseImportService.php' })).toBeDefined()
  expect((await ui.find({ key: `case-${CARD_B}-logs` }))?.text).toBe('▴ 收起輸出')
  await ui.unmount()
})

test('deploy steps end with the next ship action and point to archive only once the case is done', async ($, on) => {
  const { data } = fixture(on)
  data.git['/home/u/wt/alpha'] = { branch: 'feature/alpha', head: 'h1' }
  data.prs = [{ id: 7, state: 'MERGED', dest: 'release/v1.4', url: 'https://bitbucket.org/x/7' }]
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無') + '\n## 部署步驟（合併後）\n1. php artisan migrate\n2. 跑回填 --dry-run\n'
  // (a) 還沒有 tag：做完部署步驟之後要打 tag，不是歸檔
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_A}` })
  expect(await ui.find({ type: 'Text', text: '1. php artisan migrate' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2. 跑回填 --dry-run' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '全部做完後：打 tag 發版' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /archive alpha/ })).toBeUndefined()
  expect(await ui.find({ key: `case-${CARD_A}-pr` })).toBeDefined()
  // (b) tag 已打、六段全綠：結尾才指向歸檔
  data.git['/home/u/wt/alpha'] = { branch: 'feature/alpha', head: 'h1', tag: 'v1.4.0' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  expect(await ui.find({ type: 'Text', text: /✓ 完成 v1\.4\.0/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1. php artisan migrate' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '全部做完後：/desk:card archive alpha' })).toBeDefined()
  await ui.unmount()
})

test('a due reminder shows in the meters and on the bar when nobody waits', async ($, on) => {
  const { data } = fixture(on)
  const d = new Date(NOW + 2 * 86_400_000)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  data.files['/home/u/.claude/handoffs/shop/projects-scope.md'] += `\n\n## 提醒\n- ${date} 決定 rag-proxy 是否退役\n- 2099-01-01 很久以後\n`
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: '決定 rag-proxy 是否退役' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /很久以後/ })).toBeUndefined()
  await ui.unmount()
  const band = await $.ui.mount(BAND(120))
  const drawn: any = await band.drawn()
  expect(JSON.stringify(drawn).includes('◷ 決定 rag-proxy 是否退役（還有 2 天）')).toBe(true)
  await band.unmount()
})

test('help lists the keys', async ($, on) => {
  const { data } = fixture(on)
  void data
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: 'help' })
  expect(await ui.find({ type: 'Text', text: '停止 Agent（按兩次確認）' })).toBeDefined()
  await ui.unmount()
})

test('something new that needs you raises one system notification', async ($, on) => {
  const { data } = fixture(on)
  const sent: string[] = []
  on('ui.notify', (_: any, e: any) => { sent.push(e.text); return { value: { isSent: true as const, channel: 'terminal_bell' as const } } })
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  data.files[CARD_A] = data.files[CARD_A]!.replace('- 等你：無', '- 等你：要合併嗎？A) 要 B) 不要')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  expect(sent).toEqual(['Alpha 等你：要合併嗎？'])
})
