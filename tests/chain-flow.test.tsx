import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, flat, text, PANE, CARD_A, result } from './fixture'
import { AGENT_STOPPED, recheckFeed, skipsReview } from '../hooks/chain'
import { buildCase, summary } from '../hooks/model'
import { UNREVIEWED_GATE } from '../hooks/card'
import { pipeline, stageLabel } from '../hooks/pipeline'
import { PUBLISH_PR_TURN, turnOf } from '../hooks/turn'
import type { Case } from '../types'

test('continue → auto check → auto review → fix round 1 on HIGH → check → pass without re-review, Bitbucket read only', async ($, on) => {
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

  // 修完：有新 commit → 再檢查一次 → 這條分支審查過，綠了就過關、不再派任何東西（每張卡只審查一次）
  setGate('review：CRITICAL 0、HIGH 0、MEDIUM 2、LOW 0；已依審查修正、未複審（發版時整版審查）')
  data.git['/home/u/wt/alpha']!.head = 'h2'
  await finish()
  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(2)
  expect(data.launches.length).toBe(3)
  expect(data.toasts.some(t => t.includes('測試通過，未重新驗收'))).toBe(true)
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
  expect(data.toasts.some(t => t.includes('整張卡已自動修 2 輪仍有 CRITICAL 0、HIGH 2：開 PR、按 g 再修一輪，或改規格'))).toBe(true)
  expect((data.store.chains as any)['/home/u/wt/alpha'].stopped).toBe('整張卡已自動修 2 輪仍有 CRITICAL 0、HIGH 2：開 PR、按 g 再修一輪，或改規格')
})

test('high risk: code review passes → security review → pass but waits for you; reviews archived; re-review is diff-only', async ($, on) => {
  const { data, clock } = fixture(on)
  data.git['/home/u/wt/alpha'] = { branch: 'feature/alpha', head: 'h1', files: ['app/Http/Middleware/Admin.php'] }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.files['/home/u/.claude/handoffs/shop/review-pitfalls.md'] = '# 清單'
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
  expect(prompt(1)).toContain('/home/u/.claude/handoffs/shop/review-pitfalls.md')
  // 沒設定審查契約就用 plugin 內附的範本
  expect(prompt(1)).toMatch(/契約：\S+\/templates\/review\.md。/)

  // 程式碼審查有 HIGH → 修正 → 複審只看 h1 之後
  setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  await finish()
  expect(prompt(2)).toContain('修正第 1／2 輪')
  expect(data.writes.some(w => /\/handoffs\/shop\/reviews\/alpha-\d{8}-\d{4}-code\.md$/.test(w))).toBe(true)
  // 高風險：第一次審查不記「這條分支審查過」，修完照舊複審（本卡 AC-4）
  expect((data.store.chains as any)['/home/u/wt/alpha'].reviewedBranch).toBeUndefined()
  setGate('無')
  data.git['/home/u/wt/alpha']!.head = 'h2'
  await finish()
  expect(prompt(3)).toContain('只看 `git diff h1..HEAD`')

  // 程式碼審查過了 → 高風險 → 資安審查
  setGate('review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await finish()
  expect(data.launches.length).toBe(5)
  expect(prompt(4).startsWith('資安審查')).toBe(true)
  // 給人看的字樣：資安那一輪叫「資安驗收」（提示詞照舊）
  expect(data.toasts).toContain('Alpha：資安驗收已派出')
  expect(data.launches[4].argv).not.toContain('--resume')

  // 資安也過了 → 過關但等你看
  setGate('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；資安無虞')
  await finish()
  expect(data.launches.length).toBe(5)
  expect(data.toasts.some(t => t.includes('高風險改動（認證／中介層），驗收已過，請你看過再開 PR'))).toBe(true)
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
  expect(data.toasts.some(t => t.includes('只動文件，免驗收'))).toBe(true)
  expect((data.store.chains as any)['/home/u/wt/alpha'].skippedReview).toBe(true)
})

/** 舊紀錄（沒記「這條分支審查過」）：過關後的新 commit 照舊重新檢查並重新審查一次，只看上次審查之後的 diff。新紀錄見 test_new_commit_after_pass_rechecks_without_review。 */
test('a commit after the review passed in a legacy chain reruns the check and a diff-only review, without using fix rounds', async ($, on) => {
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
  expect(run.reviewBranch).toBe('feature/alpha')

  // 重新審查通過：結論算在 h2，回到可開 PR
  data.agents = data.agents.map(a => ({ ...a, status: 'idle', state: 'done' }))
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await step()
  const after = (data.store.chains as any)[root]
  expect(after.passed).toBe(true)
  expect(after.judgedHead).toBe('h2')
  expect(after.judgedBranch).toBe('feature/alpha')
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

const TEMPLATE_SPEC = '\n## 規格\n\n- 目標：<一句話>\n\n### 驗收情境\n\n| # | 給定 | 當 | 則 | 對應測試 |\n| --- | --- | --- | --- | --- |\n| AC-1 | <前提> | <操作> | <看得到的結果> | `<測試名稱>` |\n'

/** 規格還是範本、審查通過後又有新 commit：面板退回規格段只能同步，自動流程也一樣不重新檢查、不派修正，流程停下並寫原因（只寫一次）。 */
test('a stale card whose spec is still a template is not rechecked by the chain, which stops and says why', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/alpha'
  let feed: any[] = []
  on('state.set', (_: any, e: any, next: any) => { if (e?.plugin === 'desk' && e?.key === 'feed') feed = e.value; return next(e) })
  data.git[root] = { branch: 'feature/alpha', head: 'h2' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過') + TEMPLATE_SPEC
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.store.chains = { [root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'h1', judgedHead: 'h1' } }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  data.agents = []

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await clock.advance(2500); await clock.settle()
  await clock.advance(2500); await clock.settle()

  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(0)
  expect(data.launches.length).toBe(0)
  const run = (data.store.chains as any)[root]
  expect(run.recheck).toBeUndefined()
  expect(run.stopped).toContain('/desk:card spec')
  expect(feed.filter(e => e.card === CARD_A && String(e.text).includes('/desk:card spec')).length).toBe(1)
})

test('idle next: the chain never dispatches a waiting-only next step', async ($, on) => {
  // 實作做完後 Agent 常把下一步寫成「等自動檢查與審查；過了開 PR」：流程只跑檢查、派審查、派修正，不會拿這句派實作；手動按 g 也拒絕。
  const { data, clock } = fixture(on)
  data.git['/home/u/wt/alpha'] = { branch: 'feature/alpha', head: 'h1' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace('- 下一步：push', '- 下一步：依規格實作')
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
  const prompts = () => data.launches.map(l => String(l.argv[l.argv.length - 1]))
  const setGate = (g: string) => { data.files[CARD_A] = data.files[CARD_A]!.replace(/- 關卡：.*$/m, `- 關卡：${g}`) }

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(1)

  // Agent 做完，把下一步改成只剩等待
  data.files[CARD_A] = data.files[CARD_A]!.replace('- 下一步：依規格實作', '- 下一步：等自動檢查與審查；過了開 PR')
  await finish()
  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(1)
  expect(data.launches.length).toBe(2)
  expect(prompts()[1]).toContain('程式碼審查')

  // 審查有 HIGH：修正輪照派（修正是真的工作，不看下一步）
  setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  await finish()
  expect(data.launches.length).toBe(3)
  expect(prompts()[2]).toContain('修正第 1／2 輪')

  // 修完、測試通過就過關（不複審）：之後手動按 g 被拒絕、沒有新的派工
  setGate('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；已依審查修正、未複審（發版時整版審查）')
  data.git['/home/u/wt/alpha']!.head = 'h2'
  await finish()
  expect((data.store.chains as any)['/home/u/wt/alpha'].passed).toBe(true)
  expect(data.launches.length).toBe(3)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(3)
  expect(data.toasts.some(t => t.includes('無法繼續（') && t.includes('沒有要 Agent 做的事'))).toBe(true)
  expect(prompts().some(p => p.startsWith('依卡片的下一步繼續：等'))).toBe(false)
})

/** 整張卡用完自動修正上限後停下的那句（AC-3、AC-4 共用）。 */
const limitStop = (high: number) => `整張卡已自動修 2 輪仍有 CRITICAL 0、HIGH ${high}：開 PR、按 g 再修一輪，或改規格`

/** 這張卡（Alpha）只留最新派出去的 Agent 在跑；回傳做完、重新整理、看提示的小工具。 */
function alphaFlow($: any, data: any, clock: any) {
  const root = '/home/u/wt/alpha'
  data.agents = []
  let n = 0
  data.launch = async (e: any) => {
    n++
    const id = `c000000${n}`
    data.agents = [{ id, kind: 'background', cwd: root, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  const finish = async () => {
    data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
    await refresh(); await step(); await step(); await step()
  }
  const setGate = (g: string) => { data.files[CARD_A] = data.files[CARD_A]!.replace(/- 關卡：.*$/m, `- 關卡：${g}`) }
  const prompt = (i: number) => String(data.launches[i].argv.at(-1))
  const chain = () => (data.store.chains as any)[root]
  return { root, step, refresh, finish, setGate, prompt, chain }
}

/** AC-3：這張卡已自動修 2 輪，之後重新驗收、按 w 重開都不歸零：審查又有 HIGH 就停下，不再自動派修正 */
test('test_fix_round_total_counts_across_restarts', async ($, on) => {
  const { data, clock } = fixture(on)
  const f = alphaFlow($, data, clock)
  data.git[f.root] = { branch: 'feature/alpha', head: 'h2' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  f.setGate('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  // 上一輪流程：自動修了 2 輪後在 h1 過關；之後你又改了，分支多了 h2
  data.store.chains = { [f.root]: { owner: 'fixture-session', startedAt: 0, round: 2, fixTotal: 2, fixBranch: 'feature/alpha', passed: true, reviewHead: 'h1', reviewBranch: 'feature/alpha', judgedHead: 'h1', judgedBranch: 'feature/alpha' } }
  data.store.jobs = { [f.root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }

  // 重新驗收：開新一輪流程（round 歸零），累計修正數照帶
  await f.refresh(); await f.step(); await f.step(); await f.step()
  expect(data.launches.length).toBe(1)
  expect(f.prompt(0)).toContain('審查通過後又有新 commit 的重新審查')
  expect(f.chain().round).toBe(0)
  expect(f.chain().fixTotal).toBe(2)

  // 重新審查有 HIGH：不派修正，流程停下，面板寫整張卡已修 2 輪
  f.setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  await f.finish()
  expect(data.launches.length).toBe(1)
  expect(f.chain().stopped).toBe(limitStop(1))
  expect(data.toasts).toContain(`Alpha：流程已暫停，${limitStop(1)}`)

  // 你按 w 重開（手動派審查）：一樣帶著累計數，審查還有 HIGH 就再停，不自動修
  await $.command.run({ command: 'desk', args: 'review Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(2)
  expect(f.prompt(1).startsWith('程式碼審查')).toBe(true)
  expect(f.chain().stopped).toBeUndefined()
  expect(f.chain().fixTotal).toBe(2)
  f.setGate('review：CRITICAL 0、HIGH 2、MEDIUM 0、LOW 0；還有 bug')
  await f.finish()
  expect(data.launches.length).toBe(2)
  expect(data.launches.every((l: any) => !String(l.argv.at(-1)).startsWith('修正第'))).toBe(true)
  expect(f.chain().stopped).toBe(limitStop(2))
})

/** AC-4：上限用完後你按 g：照樣派修正（算一輪）、修完照常檢查與審查；之後再有 HIGH 又停，不自動多修 */
test('test_manual_fix_after_limit_is_dispatched_once', async ($, on) => {
  const { data, clock } = fixture(on)
  const f = alphaFlow($, data, clock)
  data.git[f.root] = { branch: 'feature/alpha', head: 'h1' }
  // 停下後下一步只剩派審查：按 g 派的是修正（說明流程為什麼停、要修什麼）
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace('- 下一步：push', '- 下一步：派審查')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  f.setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  data.store.chains = { [f.root]: { owner: 'fixture-session', startedAt: 0, round: 2, fixTotal: 2, fixBranch: 'feature/alpha', stopped: limitStop(1), reviewHead: 'h1', reviewBranch: 'feature/alpha', judgedHead: 'h1', judgedBranch: 'feature/alpha' } }
  data.store.jobs = { [f.root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  await f.refresh()

  // 你按 g：上限不擋，派出修正；這一輪也算進整張卡的總數
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(1)
  expect(f.prompt(0).startsWith(`修正：流程已暫停（${limitStop(1)}）`)).toBe(true)
  expect(f.chain().stopped).toBeUndefined()
  expect(f.chain().fixTotal).toBe(3)

  // 修完：照常自動檢查、派審查
  f.setGate('無')
  data.git[f.root]!.head = 'h2'
  await f.finish()
  expect(data.processCalls.filter((c: any) => c.argv[0] === 'sh').length).toBe(1)
  expect(data.launches.length).toBe(2)
  expect(f.prompt(1).startsWith('程式碼審查')).toBe(true)

  // 審查又有 HIGH：不自動派修正，又停下
  f.setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；還有一條')
  await f.finish()
  expect(data.launches.length).toBe(2)
  expect(f.chain().stopped).toBe(limitStop(1))
  expect(f.chain().fixTotal).toBe(3)
})

/** 審查 HIGH：Agent 被停掉後按 g 重開是接著把那件事做完，不是修正：累計修正數不加；之後的自動修正照實際派出的輪數算 */
test('test_restart_after_stopped_agent_is_not_counted_as_fix', async ($, on) => {
  const { data, clock } = fixture(on)
  const f = alphaFlow($, data, clock)
  data.git[f.root] = { branch: 'feature/alpha', head: 'h1' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  // 已自動修過 1 輪；之後的實作 Agent 被你停掉
  data.store.chains = { [f.root]: { owner: 'fixture-session', startedAt: 0, round: 0, fixTotal: 1, fixBranch: 'feature/alpha', stopped: AGENT_STOPPED } }
  data.store.jobs = { [f.root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'continue', startedAt: 0, fresh: false, owner: 'fixture-session', handled: true, ended: { how: 'stopped' } } } }
  await f.refresh()

  // 按 g 重開：派出去了，累計數照帶、不加
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(1)
  expect(f.chain().stopped).toBeUndefined()
  expect(f.chain().fixTotal).toBe(1)

  // 做完 → 檢查 → 審查有 HIGH：還能自動修第 2 輪（不是直接停）
  data.git[f.root]!.head = 'h2'
  await f.finish()
  expect(data.launches.length).toBe(2)
  expect(f.prompt(1).startsWith('程式碼審查')).toBe(true)
  f.setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  await f.finish()
  expect(data.launches.length).toBe(3)
  expect(f.prompt(2).startsWith('修正第 2／2 輪：')).toBe(true)
  expect(f.chain().fixTotal).toBe(2)
  expect(f.chain().stopped).toBeUndefined()
})

/** 一般風險的卡走到第一次審查有 HIGH 2、自動派出修正第 1 輪；回傳 alphaFlow 的小工具。 */
async function fixAfterFirstReview($: any, data: any, clock: any) {
  const f = alphaFlow($, data, clock)
  data.git[f.root] = { branch: 'feature/alpha', head: 'h1' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  await f.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  await f.finish()
  expect(f.prompt(1).startsWith('程式碼審查')).toBe(true)
  f.setGate('review：CRITICAL 0、HIGH 2、MEDIUM 1、LOW 0；漏稽核')
  await f.finish()
  expect(data.launches.length).toBe(3)
  expect(f.prompt(2).startsWith('修正第 1／2 輪：')).toBe(true)
  // 第一次審查有結論：記下這條分支審查過
  expect(f.chain().reviewedBranch).toBe('feature/alpha')
  return f
}

/** AC-1（本卡）：一般風險的卡依審查修完、完成檢查通過：不派複審，流程過關可開 PR；修正提示叫 Agent 把關卡寫成未複審，六段寫「已修正・未重新驗收」（面板不用「複審」，見 History） */
test('test_fix_after_review_passes_on_green_check_without_rereview', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const f = await fixAfterFirstReview($, data, clock)
  expect(f.prompt(2)).toContain('卡片 關卡 寫成「review：CRITICAL 0、HIGH 0、MEDIUM <原數>、LOW <原數>；已依審查修正、未複審（發版時整版審查）」')
  expect(f.prompt(2)).toContain('History 加一行列出依審查修了哪幾條')

  // 修正 Agent 照提示寫回關卡、commit；完成檢查通過
  f.setGate('review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；已依審查修正、未複審（發版時整版審查）')
  data.git[f.root]!.head = 'h2'
  await f.finish()
  expect(data.processCalls.filter((c: any) => c.argv[0] === 'sh').length).toBe(2)
  expect(data.launches.length).toBe(3)
  expect(f.chain().passed).toBe(true)
  expect(f.chain().unreviewed).toBe(true)
  // 判定的 HEAD 是檢查時的：過關後不會被當成有新 commit 又重新檢查
  expect(f.chain().judgedHead).toBe('h2')
  expect(log.has('Alpha 測試通過，未重新驗收（發版時整版審查），可開 PR')).toBe(true)
  expect(data.toasts).toContain('Alpha：測試通過，未重新驗收，可以開 PR')
  // 這一輪依審查修正過
  expect(f.chain().reviewFix).toBe(true)
  await f.step(); await f.step()
  expect(data.processCalls.filter((c: any) => c.argv[0] === 'sh').length).toBe(2)
  expect(data.launches.length).toBe(3)

  // 六段：驗收過了，合併段寫「已修正・未重新驗收」，摘要同一句；輪到你照常開 PR
  await f.refresh()
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  const screen = flat(text(await ui.drawn()))
  expect(screen).toContain(flat('按兩次 n 開 PR'))
  await ui.unmount()
  const base = { ...buildCase({ name: 'Alpha', statusPath: CARD_A }, data.files[CARD_A]!, 1, {}, undefined), git: { branch: 'feature/alpha', head: 'h2' }, chain: { round: 1, passed: true, unreviewed: true, reviewFix: true } } as Case
  const c = { ...base, pipeline: pipeline(base, undefined) }
  expect(c.pipeline.stages.find(st => st.id === 'review')!.status).toBe('done')
  expect(stageLabel(c.pipeline)).toBe('合併・已修正・未重新驗收，可開 PR')
  expect(summary({ ...c, state: 'ready' })).toBe('已修正・未重新驗收，可開 PR')
  // 對照：不是依審查修正的未複審過關（過關後你又 commit、按 g 做新的下一步）不寫「已修正」
  const plain = { ...base, chain: { round: 0, passed: true, unreviewed: true } }
  expect(stageLabel(pipeline(plain, undefined))).toBe('合併・測試通過・未重新驗收，可開 PR')
  expect(summary({ ...plain, pipeline: pipeline(plain, undefined), state: 'ready' })).toBe('測試通過・未重新驗收，可開 PR')
  expect(turnOf(c).text).toBe(PUBLISH_PR_TURN)
  // 對照：審查通過過關（沒有 unreviewed）照舊寫「可開 PR」
  const reviewed = { ...base, chain: { round: 0, passed: true } }
  expect(stageLabel(pipeline(reviewed, undefined))).toBe('合併・可開 PR')

  // 狀態列：Alpha 有對話在跑（例如你開的對話）時照流程紀錄寫「已修正」
  data.agents = [{ id: 'd0000001', kind: 'background', cwd: f.root, name: 'my-chat', sessionId: 'd0000001-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: clock.now() }]
  await f.refresh()
  expect(data.status).toContain('已修正・未重新驗收，可開 PR')
})

/** AC-2（本卡）：依審查修完後完成檢查沒過：照舊自動派修正（算進整張卡 2 輪上限），測試過了才過關、一樣不複審；用完就停下 */
test('test_fix_after_review_still_retries_failing_check', async ($, on) => {
  const { data, clock } = fixture(on)
  const f = await fixAfterFirstReview($, data, clock)
  data.run = async () => result(1, '', 'FAIL test_audit')
  data.git[f.root]!.head = 'h2'
  await f.finish()
  expect(data.launches.length).toBe(4)
  expect(f.prompt(3).startsWith('修正第 2／2 輪：完成檢查')).toBe(true)
  expect(f.chain().fixTotal).toBe(2)

  // 第 2 輪修完測試過了：過關，不複審
  data.run = async () => result(0, 'ok')
  data.git[f.root]!.head = 'h3'
  await f.finish()
  expect(data.launches.length).toBe(4)
  expect(data.launches.every((l: any) => !String(l.argv.at(-1)).startsWith('程式碼審查') || l === data.launches[1])).toBe(true)
  expect(f.chain().passed).toBe(true)
  expect(f.chain().unreviewed).toBe(true)
  // 接在審查修正後面的測試修正：這一輪照算依審查修正過
  expect(f.chain().reviewFix).toBe(true)
})

/** AC-2（本卡）：修正輪用完、測試還是沒過：停下，不派複審也不再修 */
test('test_fix_after_review_still_retries_failing_check stops when rounds run out', async ($, on) => {
  const { data, clock } = fixture(on)
  const f = await fixAfterFirstReview($, data, clock)
  // 修正 Agent 照提示寫回關卡（修掉的 CRITICAL、HIGH 歸零、結論寫未複審），下一步寫成等待句
  f.setGate(`review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；${UNREVIEWED_GATE}`)
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 下一步：.*$/m, '- 下一步：等自動驗收')
  data.run = async () => result(1, '', 'FAIL test_audit')
  data.git[f.root]!.head = 'h2'
  await f.finish()
  expect(data.launches.length).toBe(4)
  data.git[f.root]!.head = 'h3'
  await f.finish()
  expect(data.launches.length).toBe(4)
  const limit = '整張卡已自動修 2 輪仍未通過測試：開 PR、按 g 再修一輪，或改規格'
  expect(f.chain().stopped).toBe(limit)
  expect(f.chain().passed).toBeUndefined()
  // 停下原因叫你按 g：卡片算未通過、六段不跳到合併段，按 g 派得出修正（不被「下一步只剩等待」擋下）
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  const screen = flat(text(await ui.drawn()))
  await ui.unmount()
  expect(screen).toContain(flat(limit))
  expect(screen).not.toContain(flat('開 PR 派 Agent push'))
  // 關卡列照卡片原文顯示（不算審查結論，但看得到）
  expect(screen).toContain(flat(`◆ 驗收  CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；${UNREVIEWED_GATE}`))
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(5)
  expect(f.prompt(4).startsWith(`修正：流程已暫停（${limit}）`)).toBe(true)
  // 還沒過關就按 g 重開：這一輪照算依審查修正過（過關時寫「已修正」）
  expect(f.chain().reviewFix).toBe(true)
})

/** AC-3（本卡）：過關後分支又有新 commit：只重跑完成檢查，過了照舊過關、沒過照舊派修正；不派審查 */
test('test_new_commit_after_pass_rechecks_without_review', async ($, on) => {
  const { data, clock } = fixture(on)
  const f = alphaFlow($, data, clock)
  data.git[f.root] = { branch: 'feature/alpha', head: 'h2' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const log = feedLog(on)
  f.setGate('review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；過')
  // 上一輪：在 h1 審查通過（這條分支審查過）；之後你又改了，分支多了 h2
  data.store.chains = { [f.root]: { owner: 'fixture-session', startedAt: 0, round: 0, fixTotal: 1, fixBranch: 'feature/alpha', passed: true, reviewHead: 'h1', reviewBranch: 'feature/alpha', judgedHead: 'h1', judgedBranch: 'feature/alpha', reviewedBranch: 'feature/alpha' } }
  data.store.jobs = { [f.root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }

  // 過了：只跑檢查就過關，不派審查；判定的 HEAD 換成 h2
  await f.refresh(); await f.step(); await f.step(); await f.step()
  expect(log.has('Alpha 驗收通過後有新 commit，自動重新測試，通過就過關、不重新驗收')).toBe(true)
  expect(data.processCalls.filter((c: any) => c.argv[0] === 'sh').length).toBe(1)
  expect(data.launches.length).toBe(0)
  expect(f.chain().passed).toBe(true)
  expect(f.chain().unreviewed).toBe(true)
  expect(f.chain().judgedHead).toBe('h2')
  expect(f.chain().reviewedBranch).toBe('feature/alpha')
  expect(f.chain().fixTotal).toBe(1)
  // 不是依審查修正：面板不寫「已修正」
  expect(f.chain().reviewFix).toBeUndefined()

  // 又有新 commit、這次沒過：照舊派修正（不是審查）
  data.run = async () => result(1, '', 'FAIL')
  data.git[f.root]!.head = 'h3'
  await f.refresh(); await f.step(); await f.step(); await f.step()
  expect(data.processCalls.filter((c: any) => c.argv[0] === 'sh').length).toBe(2)
  expect(data.launches.length).toBe(1)
  expect(f.prompt(0).startsWith('修正第 2／2 輪：完成檢查')).toBe(true)
})

/** 本卡：按 g 重開流程也帶著「這條分支審查過」：改完測試綠就過關、不重新驗收（按 w 才會再派審查） */
test('a manual restart on a reviewed branch keeps the mark and passes on a green check', async ($, on) => {
  const { data, clock } = fixture(on)
  const f = alphaFlow($, data, clock)
  data.git[f.root] = { branch: 'feature/alpha', head: 'h1' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace('- 下一步：push', '- 下一步：補一個邊界情況')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  f.setGate('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.store.chains = { [f.root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'h1', reviewBranch: 'feature/alpha', judgedHead: 'h1', judgedBranch: 'feature/alpha', reviewedBranch: 'feature/alpha' } }
  data.store.jobs = { [f.root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  await f.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(1)
  expect(f.chain().passed).toBeUndefined()
  expect(f.chain().reviewedBranch).toBe('feature/alpha')
  data.git[f.root]!.head = 'h2'
  await f.finish()
  expect(data.processCalls.filter((c: any) => c.argv[0] === 'sh').length).toBe(1)
  expect(data.launches.length).toBe(1)
  expect(f.chain().passed).toBe(true)
  expect(f.chain().unreviewed).toBe(true)
  expect(f.chain().reviewFix).toBeUndefined()
})

/** 審查 MEDIUM（本卡，D-06 ③）：審查過的分支修改後變成高風險：重新測試的動態不說「通過就過關」，測試過了照舊派驗收 */
test('a reviewed branch that turned high risk is rechecked and reviewed again, and says so', async ($, on) => {
  const { data, clock } = fixture(on)
  const f = alphaFlow($, data, clock)
  data.git[f.root] = { branch: 'feature/alpha', head: 'h2', files: ['app/Http/Middleware/Admin.php'] }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const log = feedLog(on)
  f.setGate('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.store.chains = { [f.root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'h1', reviewBranch: 'feature/alpha', judgedHead: 'h1', judgedBranch: 'feature/alpha', reviewedBranch: 'feature/alpha' } }
  data.store.jobs = { [f.root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }

  await f.refresh(); await f.step(); await f.step(); await f.step()
  expect(log.has('Alpha 驗收通過後有新 commit，自動重新測試與驗收')).toBe(true)
  expect(log.has('Alpha 驗收通過後有新 commit，自動重新測試，通過就過關、不重新驗收')).toBe(false)
  expect(data.processCalls.filter((c: any) => c.argv[0] === 'sh').length).toBe(1)
  expect(data.launches.length).toBe(1)
  expect(f.prompt(0).startsWith('程式碼審查')).toBe(true)
  expect(f.chain().passed).toBeUndefined()
})

/** 審查 MEDIUM（本卡，D-06 ③）：「通過就過關、不再驗收」只在審查過、而且不是高風險時成立（nextStep、輪到你、動態共用） */
test('skipsReview needs a reviewed branch and not high risk', () => {
  const run = { reviewedBranch: 'feature/alpha' }
  expect(skipsReview(run, 'feature/alpha')).toBe(true)
  expect(skipsReview(run, 'feature/alpha', { level: 'normal' } as any)).toBe(true)
  expect(skipsReview(run, 'feature/alpha', { level: 'high' } as any)).toBe(false)
  expect(skipsReview(run, 'feature/beta')).toBe(false)
  expect(skipsReview({}, 'feature/alpha')).toBe(false)
  expect(recheckFeed('Alpha', false)).toBe('Alpha 驗收通過後有新 commit，自動重新測試與驗收')
})

/** 審查 MEDIUM（本卡，D-06 ④）：你選修掉的審查 MEDIUM 修完、只跑測試過關：那一輪算依審查修正過，面板寫「已修正」 */
test('a picked medium fix that passes without review counts as fixed by review', async ($, on) => {
  const { data, clock } = fixture(on)
  const f = alphaFlow($, data, clock)
  data.git[f.root] = { branch: 'feature/alpha', head: 'h1' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  f.setGate('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  // 上一輪：派出你選修掉的 MEDIUM 修正（mediumFixed），之後過關停在 h1；修正 Agent commit 了 h2
  data.store.chains = { [f.root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, mediumFixed: true, reviewHead: 'h1', reviewBranch: 'feature/alpha', judgedHead: 'h1', judgedBranch: 'feature/alpha', reviewedBranch: 'feature/alpha' } }
  data.store.jobs = { [f.root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'continue', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  data.git[f.root]!.head = 'h2'
  await f.refresh(); await f.step(); await f.step(); await f.step()
  expect(data.launches.length).toBe(0)
  expect(f.chain().passed).toBe(true)
  expect(f.chain().unreviewed).toBe(true)
  expect(f.chain().reviewFix).toBe(true)
  expect(f.chain().mediumFixed).toBeUndefined()
})


/** 審查 MEDIUM（本卡，D-06 ③）：過關後有新 commit、流程還沒接手時的輪到你：一般風險說「自動過關、不重新驗收」，高風險說會重新驗收 */
for (const [risk, files] of [['normal', ['src/a.ts']], ['high', ['app/Http/Middleware/Admin.php']]] as const) {
  test(`turn hint while rechecking a reviewed branch follows risk (${risk})`, async ($, on) => {
    const { data, clock } = fixture(on)
    const f = alphaFlow($, data, clock)
    data.git[f.root] = { branch: 'feature/alpha', head: 'h2', files: [...files] }
    data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
    data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
    f.setGate('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
    data.store.chains = { [f.root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'h1', reviewBranch: 'feature/alpha', judgedHead: 'h1', judgedBranch: 'feature/alpha', reviewedBranch: 'feature/alpha' } }
    data.store.jobs = { [f.root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
    data.run = async () => new Promise(() => {})
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    const ui = await $.ui.mount(PANE(160))
    await ui.press({ key: `row-${CARD_A}` })
    const screen = flat(text(await ui.drawn()))
    await ui.unmount()
    expect(screen).toContain(flat(`驗收後有新 commit：按 v 重新執行測試；通過後${risk === 'normal' ? '自動過關、不重新驗收' : '自動重新驗收'}`))
  })
}

/** 審查 HIGH（本卡）：PR 開著時，重新整理先算的風險（給輪到你）跟自動流程用同一個基準（PR 目標），不會被沒帶 PR 的那次算錯、快取後蓋掉 */
test('risk after a new commit uses the PR target for the turn hint and the flow alike', async ($, on) => {
  const { data, clock } = fixture(on)
  const f = alphaFlow($, data, clock)
  // PR 目標是 main：相對 main 只改了一般的檔；最新的 release 分叉得早，相對它會多出別張卡合進 main 的 migration
  data.git[f.root] = { branch: 'feature/alpha', head: 'h2', forkPoints: { 'origin/main': 'm1', 'origin/release/v1.4': 'r1' }, filesFrom: { m1: ['src/a.ts'], r1: ['src/a.ts', 'database/migrations/2026_11_06_add.php'] } }
  data.prs = [{ id: 7, state: 'OPEN', dest: 'main', url: 'https://bitbucket.org/x/7' }]
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const log = feedLog(on)
  f.setGate('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.store.chains = { [f.root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'h1', reviewBranch: 'feature/alpha', judgedHead: 'h1', judgedBranch: 'feature/alpha', reviewedBranch: 'feature/alpha' } }
  data.store.jobs = { [f.root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }

  // 流程接手前的輪到你：一般風險，通過就過關
  data.run = async () => new Promise(() => {})
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  expect(flat(text(await ui.drawn()))).toContain(flat('通過後自動過關、不重新驗收'))
  await ui.unmount()
  // 自動流程：同一個判斷，只重新測試、過了就過關，不派驗收
  data.run = async () => result(0, 'ok')
  await f.refresh(); await f.step(); await f.step(); await f.step()
  expect(log.has('Alpha 驗收通過後有新 commit，自動重新測試，通過就過關、不重新驗收')).toBe(true)
  expect(data.launches.length).toBe(0)
  expect(f.chain().passed).toBe(true)
  expect(f.chain().unreviewed).toBe(true)
  expect(f.chain().needsHuman).toBeUndefined()
})
