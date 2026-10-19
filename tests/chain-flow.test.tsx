import { expect, test } from 'claude-code/testing'
import { fixture, CARD_A, result } from './fixture'

test('continue → auto check → auto review → fix round 1 on HIGH → check → review → pass, Bitbucket read only', async ($, on) => {
  const { data, clock } = fixture(on)
  data.git['/home/u/wt/alpha'] = { branch: 'feature/alpha', head: 'h1' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.agents = []
  let n = 0
  data.launch = async (e: any) => {
    n++
    const id = `a000000${n}`
    data.agents = [{ id, kind: 'background', cwd: '/home/u/wt/alpha', name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const finish = async () => {
    data.agents = data.agents.map(a => ({ ...a, status: 'idle', state: 'done' }))
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    await clock.settle()
    await step(); await step(); await step()
  }
  const prompt = (i: number) => String(data.launches[i].argv[data.launches[i].argv.length - 1])
  const setGate = (g: string) => { data.files[CARD_A] = data.files[CARD_A]!.replace(/- 關卡：.*$/m, `- 關卡：${g}`) }

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(1)

  // 實作結束：自動檢查（不問），綠了自動派審查到新對話
  await finish()
  expect(data.asks.length).toBe(0)
  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(1)
  expect(data.launches.length).toBe(2)
  expect(prompt(1)).toContain('程式碼審查')
  expect(data.launches[1].argv).not.toContain('--resume')

  // 審查有 HIGH：自動修正第 1 輪，接續實作那個 session
  setGate('review：CRITICAL 0、HIGH 1、MEDIUM 2、LOW 0；漏稽核')
  await finish()
  expect(data.launches.length).toBe(3)
  expect(prompt(2)).toContain('修正第 1／2 輪')
  expect(data.launches[2].argv[data.launches[2].argv.indexOf('--resume') + 1]).toBe('a0000001-0000-4000-8000-000000000000')

  // 修完：關卡改回無、有新 commit → 再檢查一次 → 再審查
  setGate('無')
  data.git['/home/u/wt/alpha']!.head = 'h2'
  await finish()
  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(2)
  expect(data.launches.length).toBe(4)
  expect(prompt(3)).toContain('程式碼審查')

  // 只剩 MEDIUM：過關，不再派任何東西
  setGate('review：CRITICAL 0、HIGH 0、MEDIUM 2、LOW 1；可合併')
  await finish()
  expect(data.launches.length).toBe(4)
  expect(data.toasts.some(t => t.includes('審查通過'))).toBe(true)
  expect((data.store.chains as any)['/home/u/wt/alpha'].passed).toBe(true)

  expect(data.mcpCalls.length > 0).toBe(true)
  expect(data.mcpCalls.every(c => c.server === 'bitbucket' && c.tool === 'bb_get')).toBe(true)
})

test('two rounds of HIGH stop the chain and say why', async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.store.chains = { '/home/u/wt/alpha': { owner: 'fixture-session', startedAt: 0, round: 2 } }
  data.store.jobs = { '/home/u/wt/alpha': { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session' } } }
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 2、MEDIUM 0、LOW 0；還有 bug')
  data.agents = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(0)
  expect(data.toasts.some(t => t.includes('修了 2 輪仍有 CRITICAL 0、HIGH 2'))).toBe(true)
  expect((data.store.chains as any)['/home/u/wt/alpha'].stopped).toBe('修了 2 輪仍有 CRITICAL 0、HIGH 2')
})

test('high risk: code review passes → security review → pass but waits for you; reviews archived; re-review is diff-only', async ($, on) => {
  const { data, clock } = fixture(on)
  data.git['/home/u/wt/alpha'] = { branch: 'feature/alpha', head: 'h1', files: ['app/Http/Middleware/Admin.php'] }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.files['/home/u/.claude/handoffs/review-pitfalls.md'] = '# 清單'
  data.files['/home/u/wt/alpha/.task/REVIEW.md'] = '- [HIGH][稽核] a.php:1 — 漏寫稽核紀錄'
  data.files['/home/u/wt/alpha/.task/SECURITY.md'] = '（無）'
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.agents = []
  let n = 0
  data.launch = async (e: any) => {
    n++
    const id = `b000000${n}`
    data.agents = [{ id, kind: 'background', cwd: '/home/u/wt/alpha', name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const finish = async () => {
    data.agents = data.agents.map(a => ({ ...a, status: 'idle', state: 'done' }))
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    await clock.settle(); await step(); await step(); await step()
  }
  const prompt = (i: number) => String(data.launches[i].argv[data.launches[i].argv.length - 1])
  const setGate = (g: string) => { data.files[CARD_A] = data.files[CARD_A]!.replace(/- 關卡：.*$/m, `- 關卡：${g}`) }

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  await finish()
  expect(prompt(1).startsWith('程式碼審查')).toBe(true)
  expect(prompt(1)).toContain('/home/u/.claude/handoffs/review-pitfalls.md')
  // 沒設定審查契約就用 plugin 內附的範本
  expect(prompt(1)).toMatch(/契約：\S+\/templates\/review\.md。/)

  // 程式碼審查有 HIGH → 修正 → 複審只看 h1 之後
  setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  await finish()
  expect(prompt(2)).toContain('修正第 1／2 輪')
  expect(data.writes.some(w => /\/handoffs\/reviews\/alpha-\d{8}-\d{4}-code\.md$/.test(w))).toBe(true)
  setGate('無')
  data.git['/home/u/wt/alpha']!.head = 'h2'
  await finish()
  expect(prompt(3)).toContain('只看 `git diff h1..HEAD`')

  // 程式碼審查過了 → 高風險 → 資安審查
  setGate('review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await finish()
  expect(data.launches.length).toBe(5)
  expect(prompt(4).startsWith('資安審查')).toBe(true)
  expect(data.launches[4].argv).not.toContain('--resume')

  // 資安也過了 → 過關但等你看
  setGate('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；資安無虞')
  await finish()
  expect(data.launches.length).toBe(5)
  expect(data.toasts.some(t => t.includes('高風險改動（認證／中介層），審查已過，請你看過再開 PR'))).toBe(true)
  expect((data.store.chains as any)['/home/u/wt/alpha'].needsHuman).toContain('認證／中介層')
  expect(data.writes.some(w => w.endsWith('-security.md'))).toBe(true)
})

test('docs-only change skips review after the check passes', async ($, on) => {
  const { data, clock } = fixture(on)
  data.git['/home/u/wt/alpha'] = { branch: 'feature/alpha', head: 'h1', files: ['CHANGELOG.md', 'docs/X.md'] }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.agents = []
  data.launch = async (e: any) => {
    data.agents = [{ id: 'c0000001', kind: 'background', cwd: '/home/u/wt/alpha', name: e.argv[3], sessionId: 'c0000001-0000-4000-8000-000000000000', state: 'working', status: 'busy' }]
    return result(0, 'c0000001')
  }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  data.agents = data.agents.map(a => ({ ...a, status: 'idle', state: 'done' }))
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  for (let i = 0; i < 3; i++) { await clock.advance(2500); await clock.settle() }
  expect(data.launches.length).toBe(1)
  expect(data.toasts.some(t => t.includes('只動文件，免審查'))).toBe(true)
  expect((data.store.chains as any)['/home/u/wt/alpha'].skippedReview).toBe(true)
})

test('a commit after the review passed reruns the check and a diff-only review, without using fix rounds', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/alpha'
  data.git[root] = { branch: 'feature/alpha', head: 'h2' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；過')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  // 上一輪：在 h1 派的審查已通過；之後你決定要改，分支多了 h2
  data.store.chains = { [root]: { owner: 'fixture-session', startedAt: 0, round: 2, passed: true, reviewHead: 'h1', judgedHead: 'h1' } }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  data.agents = []
  data.launch = async (e: any) => {
    data.agents = [{ id: 'a0000001', kind: 'background', cwd: root, name: e.argv[3], sessionId: 'a0000001-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, 'a0000001')
  }
  const step = async () => { await clock.advance(2500); await clock.settle() }

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await step(); await step(); await step()
  // 自動重新檢查，接著派審查：只看 h1 之後的 diff
  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(1)
  expect(data.launches.length).toBe(1)
  const prompt = String(data.launches[0].argv[data.launches[0].argv.length - 1])
  expect(prompt).toContain('審查通過後又有新 commit 的重新審查')
  expect(prompt).toContain('git diff h1..HEAD')
  const run = (data.store.chains as any)[root]
  expect(run.round).toBe(0)
  expect(run.recheck).toBe(true)
  expect(run.passed).toBeUndefined()
  expect(run.reviewHead).toBe('h2')

  // 重新審查通過：結論算在 h2，回到可開 PR
  data.agents = data.agents.map(a => ({ ...a, status: 'idle', state: 'done' }))
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await step()
  const after = (data.store.chains as any)[root]
  expect(after.passed).toBe(true)
  expect(after.judgedHead).toBe('h2')
  expect(data.launches.length).toBe(1)
})

test('a commit after the pass in a chain this console did not start only steps back, nothing is dispatched', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/alpha'
  data.git[root] = { branch: 'feature/alpha', head: 'h2' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.store.chains = { [root]: { owner: 'other-session', startedAt: 0, round: 0, passed: true, reviewHead: 'h1', judgedHead: 'h1' } }
  data.agents = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(0)
  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(0)
  expect((data.store.chains as any)[root].passed).toBe(true)
})
