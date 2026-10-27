import { expect, test } from 'claude-code/testing'
import { parseSettings, modelFor, launchArgs, parseLaunchToken, confirmLaunch, buildPrompt, dispatchable, dispatchRefusal, idleNext, markOf, markRefusal, replyRefusal, reviewTask, DEFAULT_REVIEW, PUBLISH_ONLY_AT_MERGE, openPrRequest, pushRequest } from '../hooks/dispatch'
import type { JobRecord, RootJobs } from '../hooks/dispatch'
import { buildCase } from '../hooks/model'
import { pipeline } from '../hooks/pipeline'
import type { Case, Verify } from '../types'

const card = (next: string, extra = '') => `<!-- DESK -->\n- 狀態：ok\n- 驗證：\`true\`\n- 等你：無\n- 下一步：${next}\n- 關卡：無\n${extra}<!-- /DESK -->`
const mk = (next: string, agents: any = {}) => buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, card(next), 1, agents, undefined)
const TEMPLATE_SPEC = '\n## 規格\n\n### 驗收情境\n\n| # | 給定 | 當 | 則 | 對應測試 |\n| --- | --- | --- | --- | --- |\n| AC-1 | <前提> | <操作> | <看得到的結果> | `<測試名稱>` |\n'

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

test('spec template without AC refuses continue', () => {
  const c = buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, card('寫測試') + TEMPLATE_SPEC, 1, {}, undefined)
  const staged = { ...c, pipeline: pipeline(c, undefined) }
  for (const x of [c, staged]) {
    expect(dispatchable(x)).toEqual(['sync'])
    expect(dispatchRefusal(x, 'continue')).toBe('規格沒有驗收情境：先輸入 /desk:card spec a')
    expect(dispatchRefusal(x, 'review')).toContain('/desk:card spec')
    expect(dispatchRefusal(x, 'sync')).toBe('')
  }
  // 填好 AC 就跟現在一樣
  const filled = buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, card('寫測試') + TEMPLATE_SPEC.replace('| AC-1 | <前提> | <操作> | <看得到的結果> |', '| AC-1 | 會員 | 結帳 | 回傳 100 |'), 1, {}, undefined)
  expect(dispatchable(filled)).toEqual(['continue', 'review', 'sync'])
})

test('implementation prompt follows confirmed plan', () => {
  const c = mk('寫測試')
  for (const p of [buildPrompt(c, 'continue'), buildPrompt(c, 'reply', '用 B'), buildPrompt(c, 'continue', '', { from: 'check', round: 1, tail: [] })]) {
    expect(p).toContain('照「### 實作計畫」做，不用再停下來交計畫')
    expect(p).toContain('要改範圍或做法寫進 等你')
  }
  expect(buildPrompt(c, 'sync')).not.toContain('實作計畫')
  expect(buildPrompt(c, 'review')).not.toContain('照「### 實作計畫」做')
})

/** AC-1：會改程式的派工（繼續、回覆、修正）可以 push 自己的分支、開 PR，但不 force push、不推別的分支、不合併。 */
test('agent push: implementation prompts allow pushing the own branch and opening a PR', () => {
  const c = mk('push 後開 PR')

  const prompts = [buildPrompt(c, 'continue'), buildPrompt(c, 'reply', '用 B'), buildPrompt(c, 'continue', '', { from: 'check', round: 1, tail: [] }), buildPrompt(c, 'continue', '', { from: 'review', round: 2 })]

  for (const p of prompts) {
    expect(p).toContain('可以 push 這件任務自己的分支')
    expect(p).toContain('開 PR')
    expect(p).toContain('不 force push')
    expect(p).toContain('不 push 到其他分支')
    expect(p).toContain('不合併 PR')
    expect(p).toContain('PR 網址寫進歷程')
    expect(p).not.toContain('不 push、不開 PR')
    // 其他環境限制照舊
    expect(p).toContain('不碰正式環境')
    expect(p).toContain('不啟動或重建容器')
  }
})

/** AC-2：範圍外：同步與審查（含資安審查）仍不 push、不開 PR。 */
test('agent push: sync and review prompts still forbid push and PR', () => {
  const c = mk('push 後開 PR')

  const prompts = [buildPrompt(c, 'sync'), buildPrompt(c, 'review'), buildPrompt(c, 'review', '', undefined, { round: 0, security: true, pitfalls: '', history: '' })]

  for (const p of prompts) {
    expect(p).toContain('不 push、不開 PR')
    expect(p).not.toContain('可以 push')
  }
})

test('implementation prompt asks for a changelog fragment instead of CHANGELOG.md', () => {
  const c = mk('寫測試')
  for (const p of [buildPrompt(c, 'continue'), buildPrompt(c, 'reply', '用 B'), buildPrompt(c, 'continue', '', { from: 'check', round: 1, tail: [] }), buildPrompt(c, 'continue', '', { from: 'review', round: 1 })]) {
    expect(p).toContain('changelog.d/a.md')
    expect(p).toContain('不要改 CHANGELOG.md')
  }
  expect(buildPrompt(c, 'sync')).not.toContain('changelog.d/')
  expect(buildPrompt(c, 'review')).not.toContain('changelog.d/')
  // 片段檔名跟著任務根目錄
  expect(buildPrompt({ ...c, root: '/p/order-export' }, 'continue')).toContain('changelog.d/order-export.md')
})

test('idle next: waiting-only next steps refuse continue and say what to do', () => {
  // feed-current、spec-gate 實際派出去的句子，與幾種常見寫法
  for (const next of ['等自動檢查與審查；過了開 PR', '等完成檢查與審查', '等檢查', '等審查', '等合併', '等 PR', '開 PR', '等你確認', '等 Reyes 確認', '待合併', '等 CI 通過', '等你', '等審查結果；通過後開 PR', '到面板按 v 執行完成檢查', '按 v', '按 v 跑檢查；等審查']) {
    const why = idleNext(next)
    expect(why).toContain('沒有要 Agent 做的事')
    expect(why).toContain('先把下一步寫成要做的事')
    const c = mk(next)
    expect(dispatchable(c)).toEqual(['review', 'sync'])
    expect(dispatchRefusal(c, 'continue')).toBe(why)
    expect(dispatchRefusal(c, 'sync')).toBe('')
  }
})

test('idle next: a next step with real work is still dispatched', () => {
  for (const next of ['等檢查；補 AC-3 的測試', '依規格實作', 'push 後開 PR', '依 .task/REVIEW.md 的意見修正', '等審查通過後修 bug', '確認規格', '合併 main 進來', '寫測試']) {
    expect(idleNext(next)).toBe('')
    expect(dispatchable(mk(next))).toEqual(['continue', 'review', 'sync'])
    expect(buildPrompt(mk(next), 'continue').startsWith(`依卡片的下一步繼續：${next}`)).toBe(true)
  }
  // 空白與「無」另有狀態處理，不算空派工
  expect(idleNext('')).toBe('')
  expect(idleNext('無')).toBe('')
})

test('sync prompt: no new facts means no History line and untouched fields', () => {
  const p = buildPrompt(mk('寫測試'), 'sync')
  expect(p).toContain('只在狀態、下一步、檢查確實與事實不符時才改那一欄')
  expect(p).toContain('歷程只在有新的事實（新 commit、新測試結果、新發現）時加一行，並寫出那個事實')
  expect(p).toContain('什麼都沒變就一個字都不寫、直接結束')
  expect(p).not.toContain('已同步')
})

// 工作桌與主對話撞同一個 worktree：Agent 要知道自己的名字；派工前分辨未提交改動是不是上一個 Agent 留下的。
test('prompts tell the agent its own launch name', () => {
  const c = mk('寫測試')
  for (const p of [buildPrompt(c, 'continue', '', undefined, undefined, undefined, 'desk-abc-1'), buildPrompt(c, 'reply', '用 B', undefined, undefined, undefined, 'desk-abc-1'), buildPrompt(c, 'sync', '', undefined, undefined, undefined, 'desk-abc-1'), buildPrompt(c, 'review', '', undefined, { round: 0, pitfalls: '', history: '' }, undefined, 'desk-abc-1')]) {
    expect(p).toContain('你的背景 Agent 名字是 desk-abc-1')
    expect(p).toContain('清單裡這個名字就是你自己')
  }
  // 沒給名字（例如教學）就不寫這句；規則仍排在最後
  expect(buildPrompt(c, 'continue')).not.toContain('你的背景 Agent 名字')
  const s = parseSettings(JSON.stringify({ rules: ['測試只能用 make test'] }))
  expect(buildPrompt(c, 'continue', '', undefined, undefined, s, 'desk-abc-1').endsWith('測試只能用 make test')).toBe(true)
})

test('worktree mark: clean, same or foreign leftovers', () => {
  const FOREIGN = '不是上一個 Agent 留下的'
  const clean = markOf('# branch.oid h1\n# branch.head x\n', '')
  expect(clean).toEqual({ files: 0, hash: '' })
  const two = markOf('# branch.oid h1\n1 .M N... 100644 100644 100644 a b x.ts\n? y.ts\n', 'diff --git a/x.ts b/x.ts\n+1')
  expect(two.files).toBe(2)
  expect(two.hash).toMatch(/^[0-9a-f]{8}$/)
  // 同樣的狀態與 diff 指紋相同；內容不同就不同
  expect(markOf('1 .M N... 100644 100644 100644 a b x.ts\n? y.ts\n', 'diff --git a/x.ts b/x.ts\n+1')).toEqual(two)
  expect(markOf('1 .M N... 100644 100644 100644 a b x.ts\n? y.ts\n', 'diff --git a/x.ts b/x.ts\n+2').hash).not.toBe(two.hash)
  const own = (last?: Partial<JobRecord>, mark?: string): RootJobs => ({ ...(last ? { last: { launchName: 'desk-1', nativeId: 'x', sessionId: 's', kind: 'continue' as const, startedAt: 0, fresh: false, ...last } } : {}), ...(mark !== undefined ? { mark } : {}) })
  const refused = `worktree 有未提交的改動（2 個檔），${FOREIGN}；可能有別的對話在改，commit 或還原後再派`
  // 乾淨：一律可派
  expect(markRefusal(clean, undefined)).toBe('')
  expect(markRefusal(clean, own({ ended: { how: 'finished' } }, 'ffffffff'))).toBe('')
  // 從沒派過工、worktree 髒：拒絕
  expect(markRefusal(two, undefined)).toBe(refused)
  expect(markRefusal(two, {})).toBe(refused)
  // 上一個會改程式的 Agent 還在（例如停在提問）：改動是它的
  expect(markRefusal(two, own({}))).toBe('')
  expect(markRefusal(two, own({ kind: 'reply' }))).toBe('')
  // 它結束時留下的（指紋相同），做完或被停掉都一樣；之後只派過審查、同步也不影響
  expect(markRefusal(two, own({ ended: { how: 'finished' } }, two.hash))).toBe('')
  expect(markRefusal(two, own({ ended: { how: 'stopped' } }, two.hash))).toBe('')
  expect(markRefusal(two, own({ kind: 'review', ended: { how: 'finished' } }, two.hash))).toBe('')
  expect(markRefusal(two, own({ kind: 'sync', ended: { how: 'finished' } }, two.hash))).toBe('')
  // 指紋不同、或只派過同步／審查而沒有指紋：別人改的
  expect(markRefusal(two, own({ ended: { how: 'finished' } }, 'ffffffff'))).toBe(refused)
  expect(markRefusal(two, own({ ended: { how: 'finished' } }, ''))).toBe(refused)
  expect(markRefusal(two, own({ kind: 'sync', ended: { how: 'finished' } }))).toBe(refused)
})

// 下一步還是範本佔位（例如舊卡沒跑 spec-ok）：不把佔位文字原樣送給 Agent。
test('dispatch: a placeholder next step is not sent to the agent', () => {
  const p = buildPrompt(mk('<可以直接派給 Agent 的一件事>'), 'continue')
  expect(p.startsWith('依卡片的規格與實作計畫實作')).toBe(true)
  expect(p).not.toContain('依卡片的下一步繼續')
  expect(p).not.toContain('<可以直接派給 Agent 的一件事>')
  // 具體的下一步照舊
  expect(buildPrompt(mk('寫測試'), 'continue').startsWith('依卡片的下一步繼續：寫測試')).toBe(true)
})

/** 合併段的 Case：審查過關、檢查在 h 過了；PR、git 狀態、Agent 由呼叫端給。 */
function atMerge(over: Partial<Case> = {}): Case {
  const passedCard = card('合併').replace('- 關卡：無', '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 1；可合併')
  const v: Verify = { command: 'true', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h' }
  const c: Case = { ...buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, passedCard, 1, {}, v), git: { branch: 'feature/a', head: 'h' }, ...over }
  return { ...c, pipeline: pipeline(c, v) }
}

/** AC-5 */
test('dispatch: publish is only dispatchable at the merge stage', () => {
  const ahead = (n: number) => ({ ahead: n, behind: 0, changed: 0, untracked: 0, upstream: true })
  const open = { id: 12, state: 'OPEN', ci: 'pass' } as any
  const noPr = atMerge()
  const pushable = atMerge({ pr: open, gitState: ahead(1) })
  const inSync = atMerge({ pr: open, gitState: ahead(0) })
  const risky = atMerge({ chain: { round: 0, passed: true, needsHuman: '高風險改動' } })
  const running = { ...atMerge(), state: 'running' as const, agent: { name: 'x', state: 'working', status: 'busy' } }
  const building = mk('寫測試')

  expect([noPr, pushable, inSync, risky].map(c => c.pipeline!.current)).toEqual(['merge', 'merge', 'merge', 'merge'])
  expect(building.pipeline?.current ?? 'build').not.toBe('merge')
  expect(dispatchable(noPr)).toContain('publish')
  expect(dispatchRefusal(noPr, 'publish')).toBe('')
  expect(dispatchable(pushable)).toContain('publish')
  expect(dispatchRefusal(pushable, 'publish')).toBe('')
  // 高風險改動也能派：面板上照列「⇡ 開 PR」，第一次按只提醒先看審查檔（merge-actions.test.tsx）
  expect(dispatchable(risky)).toContain('publish')
  expect(dispatchRefusal(risky, 'publish')).toBe('')
  // 沒有要推的、不在合併段：拒絕並說原因
  for (const c of [inSync, building]) {
    expect(dispatchable(c)).not.toContain('publish')
    expect(dispatchRefusal(c, 'publish')).toBe(PUBLISH_ONLY_AT_MERGE)
  }
  expect(PUBLISH_ONLY_AT_MERGE).toBe('只有合併段還要 push 或開 PR 時才能推送')
  // Agent 在跑：說它在跑
  expect(dispatchable(running)).toEqual([])
  expect(dispatchRefusal(running, 'publish')).toBe('Agent 仍在執行')
  // 推送 Agent 在跑、卡片「等你」有內容（state 是 ask，不是 running）：一樣不能再派，說它在跑
  const busy = { name: 'desk-p', state: 'working', status: 'busy', kind: 'publish' as const }
  const ask = '審查 MEDIUM 1 條怎麼處理：A) 現在改 B) 之後再說'
  for (const c of [atMerge({ ask, state: 'ask', agent: busy }), atMerge({ ask, state: 'ask', agent: busy, pr: open, gitState: ahead(1) })]) {
    expect(c.pipeline!.current).toBe('merge')
    expect(dispatchable(c)).not.toContain('publish')
    expect(dispatchRefusal(c, 'publish')).toBe('Agent 仍在執行')
  }
  expect(dispatchRefusal({ ...noPr, manual: true }, 'publish')).toBe('登錄表設為 manual，只追蹤不派工')
})

test('publish prompt: push and PR only, keeps the gate, no spec or changelog duties, fresh session', () => {
  const p = buildPrompt(atMerge(), 'publish', openPrRequest('feature/a', 'origin/main'))
  const pushOnly = buildPrompt(atMerge(), 'publish', pushRequest('feature/a', 12))

  expect(p.split('\n')[0]).toBe('推送：push feature/a 並對 main 開 PR，PR 網址寫進歷程；沒有 gh 或平台開不了 PR（例如 Bitbucket）時，push 完把開 PR 的網址寫進 等你 後結束。只推已 commit 的：不 commit、不改程式、不 rebase。')
  // 只 push：不叫它開 PR，也沒有開不了 PR 時寫等你那句
  expect(pushOnly.split('\n')[0]).toBe('推送：只 push feature/a（PR #12 已開，不開新 PR），push 後把分支頂端 commit 寫進歷程。只推已 commit 的：不 commit、不改程式、不 rebase。')
  expect(pushOnly).not.toContain('開不了 PR')
  expect(openPrRequest('feature/a', '')).toBe('push feature/a 並開 PR，PR 網址寫進歷程；沒有 gh 或平台開不了 PR（例如 Bitbucket）時，push 完把開 PR 的網址寫進 等你 後結束')
  expect(pushRequest('feature/a', undefined)).toContain('只 push feature/a（PR 已開，不開新 PR）')
  expect(p).toContain('可以 push 這件任務自己的分支')
  expect(p).toContain('不 force push')
  expect(p).toContain('不合併 PR')
  expect(p).toContain('不打 tag')
  expect(p).toContain('關卡與檢查欄保持原樣')
  expect(p).not.toContain('做完實作：關卡留 無')
  expect(p).not.toContain('## 規格')
  expect(p).not.toContain('changelog.d/')
  expect(modelFor(parseSettings('{"model":"opus"}'), '/p/a', 'publish')).toEqual({ model: 'opus', effort: '', fresh: true })
})
