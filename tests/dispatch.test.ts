import { expect, test } from 'claude-code/testing'
import { parseSettings, modelFor, launchArgs, parseLaunchToken, confirmLaunch, buildPrompt, dispatchable, dispatchRefusal, replyRefusal, reviewTask, DEFAULT_REVIEW } from '../hooks/dispatch'
import { buildCase } from '../hooks/model'

const card = (next: string, extra = '') => `<!-- DESK -->\n- 狀態：ok\n- 驗證：\`true\`\n- 等你：無\n- 下一步：${next}\n- 關卡：無\n${extra}<!-- /DESK -->`
const mk = (next: string, agents: any = {}) => buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, card(next), 1, agents, undefined)

test('settings: global, project override and sync model; fresh sync is the default once a sync model is set', () => {
  const s = parseSettings(JSON.stringify({ model: 'opus', effort: 'high', sync: { claude: { model: 'haiku' } }, projects: { '/p/a/': { effort: 'xhigh' } } }))
  expect(modelFor(s, '/p/a', 'continue')).toEqual({ model: 'opus', effort: 'xhigh', fresh: false })
  expect(modelFor(s, '/p/b', 'continue')).toEqual({ model: 'opus', effort: 'high', fresh: false })
  expect(modelFor(s, '/p/a', 'sync')).toEqual({ model: 'haiku', effort: 'xhigh', fresh: true })
  expect(modelFor(s, '/p/a', 'review')).toEqual({ model: 'opus', effort: 'xhigh', fresh: true })
  expect(modelFor(parseSettings(JSON.stringify({ sync: { claude: { model: 'haiku' }, session: 'resume' } })), '/x', 'sync').fresh).toBe(false)
  expect(parseSettings('broken')).toEqual(parseSettings(null))
  expect(parseSettings(null)).toMatchObject({ model: '', effort: '', projects: {}, user: '使用者', rules: [], riskHigh: [], checkServices: {} })
})

test('settings: user name, project rules, review words, risk paths and check services; bad entries are skipped', () => {
  const s = parseSettings(JSON.stringify({
    user: 'Alex', rules: ['測試用 make test', ''], projects: { '/p/a': { rules: ['只改 api/'] } },
    review: { high: '漏寫稽核' }, risk: { high: [{ pattern: 'Billing', label: '金流' }, { pattern: '(', label: '壞的' }, { pattern: 'x' }] },
    checkServices: { 'run-tests': ['mysql'], empty: [] },
  }))
  expect(s.user).toBe('Alex')
  expect(s.rules).toEqual(['測試用 make test'])
  expect(s.projects['/p/a']).toEqual({ rules: ['只改 api/'] })
  expect(s.review.high).toBe('漏寫稽核')
  expect(s.review.security).toBe(DEFAULT_REVIEW.security)
  expect(s.riskHigh.map(([re, why]) => [re.source, why])).toEqual([['Billing', '金流']])
  expect(s.checkServices).toEqual({ 'run-tests': ['mysql'] })
})

test('launch args omit empty flags and resume only with a session', () => {
  expect(launchArgs('p', { launchName: 'desk-1' })).toEqual(['claude', '--bg', '--name', 'desk-1', 'p'])
  expect(launchArgs('p', { launchName: 'n', sessionId: 's', model: 'opus', effort: 'high' })).toEqual(['claude', '--bg', '--name', 'n', '--resume', 's', '--model', 'opus', '--effort', 'high', 'p'])
})

test('launch token: short id, uuid, json, or one id inside a sentence; two ids is ambiguous', () => {
  expect(parseLaunchToken('7ed14dbf\n')).toBe('7ed14dbf')
  expect(parseLaunchToken('{"id":"7ed14dbf"}')).toBe('7ed14dbf')
  expect(parseLaunchToken('Started background agent 7ed14dbf (desk-x)')).toBe('7ed14dbf')
  expect(parseLaunchToken('a1b2c3d4 and 0f0f0f0f')).toBeNull()
  expect(parseLaunchToken('')).toBeNull()
})

test('confirm launch needs exactly one new background agent with that name, token and a full session id', () => {
  const sid = '7ed14dbf-fd1e-4446-a3fe-858ca2425e0a'
  const hit = { id: '7ed14dbf', name: 'desk-1', kind: 'background', sessionId: sid }
  expect(confirmLaunch([], [hit], 'desk-1', '7ed14dbf')).toEqual(hit)
  expect(confirmLaunch([], [hit], 'desk-1', sid)).toEqual(hit)
  expect(confirmLaunch([hit], [hit], 'desk-1', '7ed14dbf')).toBeNull()
  expect(confirmLaunch([], [{ ...hit, sessionId: 'nope' }], 'desk-1', '7ed14dbf')).toBeNull()
  expect(confirmLaunch([], [hit, { ...hit, id: '00000000', sessionId: sid.replace('7', '8') }], 'desk-1', '7ed14dbf')).toEqual(hit)
})

test('what can be dispatched follows the card: running none, review needs a check, continue needs a check', () => {
  expect(dispatchable(mk('寫測試'))).toEqual(['continue', 'review', 'sync'])
  const noCheck = buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, card('寫測試').replace('`true`', '無'), 1, {}, undefined)
  expect(dispatchable(noCheck)).toEqual(['sync'])
  expect(dispatchable(mk('.task/review-x.md（審核合併）'))).toEqual(['review', 'sync'])
  expect(reviewTask(mk('.task/review-x.md（審核合併）'))).toBe('.task/review-x.md')
  expect(reviewTask(mk('依 .task/review-x.md 的意見修正'))).toBe('')
  expect(dispatchable(mk('無'))).toEqual(['review', 'sync'])
  expect(dispatchable({ ...mk('寫測試'), manual: true })).toEqual([])
  // 規格還沒確認（關卡 spec：…）：不派實作，只能同步
  expect(dispatchable({ ...mk('寫測試'), gate: 'spec：待確認規格' })).toEqual(['sync'])
  expect(dispatchable({ ...mk('寫測試'), git: { branch: 'release/v1.4', head: 'h' } })).toEqual(['continue', 'sync'])
  expect(dispatchable(mk('寫測試', { '/p/a': { name: 'x', state: 'working', status: 'busy' } }))).toEqual([])
  expect(dispatchable(mk('寫測試', { '/p/a': { name: 'x', state: 'blocked', status: 'idle', asks: true } }))).toEqual(['reply', 'sync'])
})

test('reply refusal names why: waiting agents can be answered, others say why not', () => {
  const asks = { '/p/a': { name: 'x', state: 'blocked', status: 'idle', asks: true } }
  expect(replyRefusal(mk('寫測試', asks))).toBe('')
  expect(replyRefusal({ ...mk('寫測試', asks), gate: 'spec：待確認規格' })).toBe('')
  expect(replyRefusal(mk('寫測試', { '/p/a': { name: 'x', state: 'working', status: 'busy' } }))).toBe('Agent 仍在執行')
  expect(replyRefusal(mk('寫測試'))).toBe('Agent 沒有在等你回覆')
  expect(replyRefusal({ ...mk('寫測試', asks), manual: true })).toBe('登錄表設為 manual，只追蹤不派工')
  expect(replyRefusal({ ...mk('寫測試', asks), demo: true })).toBe('示範任務只能看')
})

test('prompts carry the case, the card rules and the environment limits', () => {
  const c = mk('寫測試')
  const p = buildPrompt(c, 'continue')
  expect(p.startsWith('依卡片的下一步繼續：寫測試')).toBe(true)
  expect(p).toContain('卡片：/p/a/.desk/CARD.md')
  expect(p).toContain('不啟動或重建容器')
  expect(buildPrompt(c, 'review')).toContain('不參考 Agent 的結論')
  expect(buildPrompt(c, 'sync')).toContain('看不出結果的寫「待確認」')
  expect(buildPrompt(c, 'reply', '用 B')).toContain('使用者的回覆：用 B')
  expect(p).toContain('要使用者決定的事寫進 等你')
  // 會改程式的派工（繼續、回覆、修正）先讀規格；同步與審查不加這條
  expect(p).toContain('先讀卡片「## 規格」')
  expect(buildPrompt(c, 'reply', '用 B')).toContain('先讀卡片「## 規格」')
  expect(buildPrompt(c, 'continue', '', { from: 'review', round: 1 })).toContain('先讀卡片「## 規格」')
  expect(buildPrompt(c, 'sync')).not.toContain('先讀卡片「## 規格」')
  expect(buildPrompt(c, 'review')).not.toContain('先讀卡片「## 規格」')
})

test('review prompt: pitfalls first, later rounds diff-only without repeats, security scope, learning write-back', () => {
  const c = mk('寫測試')
  const first = buildPrompt(c, 'review', '', undefined, { round: 0, pitfalls: '/h/pitfalls.md', history: '/h/reviews' })
  expect(first).toContain('先讀專案常犯錯誤清單 /h/pitfalls.md')
  expect(first).toContain('從 git merge-base 起算')
  expect(first).toContain('[等級][類別] 檔案:行')
  expect(first).toContain('在 /h/pitfalls.md 檔尾追加一行')
  expect(first).toContain('.task/REVIEW.md')
  const later = buildPrompt(c, 'review', '', undefined, { round: 1, base: 'abc123', pitfalls: '/h/pitfalls.md', history: '/h/reviews' })
  expect(later).toContain('只看 `git diff abc123..HEAD`')
  expect(later).toContain('不要再提')
  const sec = buildPrompt(c, 'review', '', undefined, { round: 0, security: true, pitfalls: '', history: '/h/reviews' })
  expect(sec.startsWith('資安審查')).toBe(true)
  expect(sec).toContain('.task/SECURITY.md')
  expect(sec).not.toContain('常犯錯誤清單')
})

test('prompts use the configured name, project rules and review words', () => {
  const c = mk('寫測試')
  const s = parseSettings(JSON.stringify({ user: 'Alex', rules: ['測試只能用 make test'], projects: { '/p/a': { rules: ['只改 api/'] } }, review: { high: '漏寫稽核', security: '金流與退款', categories: '金流、稽核' } }))
  const p = buildPrompt(c, 'continue', '', undefined, undefined, s)
  expect(p).toContain('要 Alex 決定的事寫進 等你')
  expect(p.endsWith('測試只能用 make test\n只改 api/')).toBe(true)
  expect(buildPrompt(c, 'reply', '用 B', undefined, undefined, s)).toContain('Alex 的回覆：用 B')
  const review = buildPrompt(c, 'review', '', undefined, { round: 0, pitfalls: '', history: '' }, s)
  expect(review).toContain('HIGH（漏寫稽核）')
  expect(review).toContain('（例如 金流、稽核）')
  expect(buildPrompt(c, 'review', '', undefined, { round: 0, security: true, pitfalls: '', history: '' }, s)).toContain('資安審查只看：金流與退款；')
  // 別的任務不帶這件任務的規則
  expect(buildPrompt({ ...c, root: '/p/b' }, 'continue', '', undefined, undefined, s)).not.toContain('只改 api/')
})

test('dispatch and reply refusals share the same reasons', () => {
  const asks = { '/p/a': { name: 'x', state: 'blocked', status: 'idle', asks: true } } as any
  const busy = { '/p/a': { name: 'x', state: 'working', status: 'busy' } } as any
  expect(dispatchRefusal({ ...mk('寫測試'), manual: true }, 'continue')).toBe(replyRefusal({ ...mk('寫測試', asks), manual: true }))
  expect(dispatchRefusal(mk('寫測試', busy), 'continue')).toBe(replyRefusal(mk('寫測試', busy)))
  expect(dispatchRefusal(mk('寫測試', asks), 'reply')).toBe('')
  expect(dispatchRefusal(mk('寫測試'), 'reply')).toBe('Agent 沒有在等你回覆')
})
