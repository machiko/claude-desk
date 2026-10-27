import { expect, test } from 'claude-code/testing'
import { buildCase, sorted, counts, focusCase, summary, events, parseAgents, asksFor, fit, displayWidth, ago, demoSnapshot, errorLine, reasonLine, slugOf } from '../hooks/model'

const row = (name: string) => ({ name, statusPath: `/p/${name}/.desk/CARD.md` })
const card = (f: Partial<Record<'狀態' | '驗證' | '等你' | '下一步' | '關卡', string>>) =>
  `<!-- DESK -->\n- 狀態：${f.狀態 ?? 'ok'}\n- 驗證：${f.驗證 ?? '`true`'}\n- 等你：${f.等你 ?? '無'}\n- 下一步：${f.下一步 ?? '做事'}\n- 關卡：${f.關卡 ?? '無'}\n<!-- /DESK -->`

test('state words rank: ask > reply > gate > running > failed > ready > idle > nocard', () => {
  const agents = { '/p/run': { name: 'a', state: 'working', status: 'busy' }, '/p/wait': { name: 'b', state: 'blocked', status: 'waiting', waitingFor: '權限' }, '/p/asks': { name: 'c', state: 'blocked', status: 'idle', asks: true } }
  expect(buildCase(row('asks'), card({}), 1, agents, undefined).state).toBe('reply')
  expect(buildCase(row('ask'), card({ 等你: '要嗎？A) 要 B) 不要' }), 1, {}, undefined).state).toBe('ask')
  expect(buildCase(row('wait'), card({}), 1, agents, undefined).state).toBe('reply')
  expect(buildCase(row('gate'), card({ 關卡: 'review：看' }), 1, {}, undefined).state).toBe('gate')
  expect(buildCase(row('run'), card({}), 1, agents, undefined).state).toBe('running')
  expect(buildCase(row('fail'), card({ 驗證: '`npm t`' }), 1, {}, { command: 'npm t', at: 1, ok: false, exitCode: 1, tail: [], truncated: false }).state).toBe('failed')
  expect(buildCase(row('stalev'), card({ 驗證: '`npm t`' }), 1, {}, { command: 'other', at: 1, ok: false, exitCode: 1, tail: [], truncated: false }).state).toBe('ready')
  expect(buildCase(row('idle'), card({ 下一步: '無' }), 1, {}, undefined).state).toBe('idle')
  expect(buildCase(row('none'), null, null, {}, undefined).state).toBe('nocard')
  // ask wins even while an agent runs; a waiting agent wins over a gate
  expect(buildCase(row('run'), card({ 等你: '問' }), 1, agents, undefined).state).toBe('ask')
  expect(buildCase(row('wait'), card({ 關卡: 'review：x' }), 1, agents, undefined).state).toBe('reply')
})

test('sorted puts what needs a person first, newest first within a state; focus skips idle', () => {
  const a = buildCase(row('a'), card({ 下一步: '無' }), 5, {}, undefined)
  const b = buildCase(row('b'), card({ 等你: '問' }), 1, {}, undefined)
  const c = buildCase(row('c'), card({}), 9, {}, undefined)
  const d = buildCase(row('d'), card({ 等你: '問' }), 7, {}, undefined)
  expect(sorted([a, b, c, d]).map(x => x.name)).toEqual(['d', 'b', 'c', 'a'])
  expect(counts([a, b, c, d])).toEqual({ ask: 2, reply: 0, approve: 0, gate: 0, failed: 0, running: 0, ready: 1, done: 0, idle: 1, nocard: 0 })
  expect(focusCase([a, b, c, d])?.name).toBe('d')
  expect(focusCase([a])).toBeNull()
  expect(summary(b)).toBe('問')
  expect(summary(buildCase(row('e'), card({ 等你: '要嗎？A) 要 B) 不要' }), 1, {}, undefined))).toBe('要嗎？')
  expect(summary(c)).toBe('做事')
})

test('agents json: only busy or waiting background agents count; newest per cwd kept', () => {
  const json = JSON.stringify([
    { kind: 'background', cwd: '/p/x/', state: 'working', status: 'busy', name: 'one', startedAt: 10 },
    { kind: 'background', cwd: '/p/x', state: 'working', status: 'busy', name: 'two', startedAt: 20 },
    { kind: 'background', cwd: '/p/y', state: 'done', status: 'idle', name: 'gone' },
    { kind: 'background', cwd: '/p/z', state: 'blocked', status: 'idle', name: 'finished-asking' },
    { kind: 'interactive', cwd: '/p/i', state: 'working', status: 'busy', name: 'me' },
    { kind: 'background', state: 'working', status: 'busy', name: 'nocwd' },
  ])
  const out = parseAgents(json)
  expect(Object.keys(out)).toEqual(['/p/x'])
  expect(out['/p/x']!.name).toBe('two')
  expect(parseAgents('not json')).toEqual({})
  expect(parseAgents('{"agents":[{"kind":"background","cwd":"/q","state":"blocked","status":"waiting","waitingFor":"權限"}]}')['/q']!.waitingFor).toBe('權限')
  const list = JSON.parse(json)
  expect(asksFor(list, 'finished-asking')?.asks).toBe(true)
  expect(asksFor(list, 'two')).toBeNull()
  expect(asksFor(list, 'gone')).toBeNull()
  expect(asksFor(list, undefined)).toBeNull()
})

test('events name the change; the first snapshot is quiet', () => {
  const now = 1_000_000
  const before = { at: now - 1, cases: [buildCase(row('a'), card({}), 1, {}, undefined)], error: null, contextPercent: null }
  const after = { at: now, cases: [buildCase(row('a'), card({ 等你: '要嗎？A) 要 B) 不要' }), 2, {}, undefined), buildCase(row('b'), card({}), 2, {}, undefined)], error: null, contextPercent: null }
  expect(events(null, after)).toEqual([])
  expect(events(before, after)).toEqual([
    { at: now, text: 'a 等你：要嗎？', tone: 'warning', card: row('a').statusPath },
    { at: now, text: 'b 加入工作桌', tone: 'subtle', card: row('b').statusPath },
  ])
  // 換了專案：另一份登錄表的任務不是「加入」，不發動態
  expect(events({ ...before, project: 'shop' }, { ...after, project: 'blog' })).toEqual([])
})

test('width helpers and ago', () => {
  expect(displayWidth('主工作區 ab')).toBe(11)
  expect(fit('主工作區（release/v1.4）', 10)).toBe('主工作區…')
  expect(fit('主工作區（release/v1.4）', 11)).toBe('主工作區（…')
  expect(fit('short', 10)).toBe('short')
  expect(ago(null, 10)).toBe('')
  expect(ago(10_000, 40_000)).toBe('剛剛')
  expect(ago(0, 5 * 60_000)).toBe('5 分鐘')
  expect(ago(0, 3 * 3_600_000)).toBe('3 小時')
  expect(ago(0, 49 * 3_600_000)).toBe('2 天')
  const demo = demoSnapshot(now_())
  expect(demo.cases.map(c => c.state)).toEqual(['ask', 'running', 'idle', 'gate'])
})
const now_ = () => Date.parse('2030-01-05T12:00:00Z')

test('a case slug is its worktree folder, and a failed command reports its last line', () => {
  expect(slugOf({ root: '/home/u/wt/spec-ok-button/' })).toBe('spec-ok-button')
  expect(slugOf({ root: '/' })).toBe('')
  expect(errorLine({ stderr: 'warn\n找不到卡片：beta\n', stdout: 'x' })).toBe('找不到卡片：beta')
  expect(errorLine({ stderr: '', stdout: 'only stdout\n' })).toBe('only stdout')
  expect(errorLine({ stderr: '  ', stdout: '' })).toBe('沒有輸出')
  expect(errorLine(null, 'claude stop 失敗')).toBe('claude stop 失敗')
})

test('a failed card script reports its reason line, or the exception line after a Traceback', () => {
  expect(reasonLine({ stderr: '找不到任務：beta\n登錄表：\n  alpha\n  gamma\n' })).toBe('找不到任務：beta')
  expect(reasonLine({ stderr: 'Traceback (most recent call last):\n  File "card.py", line 9, in <module>\n    main()\nPermissionError: [Errno 13] Permission denied: \'CARD.md\'\n\n' }))
    .toBe("PermissionError: [Errno 13] Permission denied: 'CARD.md'")
  expect(reasonLine({ stderr: '\n  \n  關卡不是 spec\n細節' })).toBe('關卡不是 spec')
  expect(reasonLine({ stderr: '', stdout: 'only stdout\nmore\n' })).toBe('only stdout')
  expect(reasonLine({ stderr: '  ', stdout: '' })).toBe('沒有輸出')
  expect(reasonLine(null, '腳本失敗')).toBe('腳本失敗')
})
