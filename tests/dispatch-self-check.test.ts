// build-like-review：會改程式的派工（實作、回覆、修正）交出前先做審查會做的檢查；同步、審查、推送、解衝突不帶。
import { expect, test } from 'claude-code/testing'
import { buildPrompt, openPrRequest, pushRequest, readsPitfalls, writesCode } from '../hooks/dispatch'
import { AGENT_STOPPED, MEDIUM_FIX_NOT_SENT } from '../hooks/chain'
import { QUOTA_NOTHING_TO_FIX } from '../hooks/prompts/fix'
import { buildCase } from '../hooks/model'
import { pipeline } from '../hooks/pipeline'
import type { Case, Verify } from '../types'
import { fixture, result, CARD_A, CARD_B, NOW, PROJECT_DIR, REGISTRY } from './fixture'
import { setFields } from '../hooks/tutorial'

const card = (next: string) => `<!-- DESK -->\n- 狀態：ok\n- 驗證：\`true\`\n- 等你：無\n- 下一步：${next}\n- 關卡：無\n<!-- /DESK -->`
const mk = (next: string) => buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, card(next), 1, {}, undefined)
/** 停在合併段（審查過了）：推送、解衝突派得出去的那種卡。 */
function atMerge(): Case {
  const passedCard = card('合併').replace('- 關卡：無', '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 1；可合併')
  const v: Verify = { command: 'true', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h' }
  const c: Case = { ...buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, passedCard, 1, {}, v), git: { branch: 'feature/a', head: 'h' } }
  return { ...c, pipeline: pipeline(c, v) }
}

const PITFALLS_FILE = `${PROJECT_DIR}/review-pitfalls.md`
/** 實作、回覆與審查共用的讀清單句（dispatch-slim AC-2）。 */
const PITFALLS_LINE = (path: string) => `先讀專案常犯錯誤清單 ${path}，逐條對照這次的改動。`
const READ_LIST = '常犯錯誤清單'
const SELF_CHECK = '交出前自我檢查：每條驗收情境挑一處最關鍵的改動拿掉、只跑對應的測試確認會紅'
const ADJACENT = '改到自動流程時才在暫存複本對照 main 跑相鄰路徑'
const WHOLE_CLASS = '先把同一類情況全部列出'
const writingPrompts = (c: Case, pitfalls = '') => ({
  continue: buildPrompt(c, 'continue', '', undefined, undefined, undefined, '', pitfalls),
  reply: buildPrompt(c, 'reply', '用 B', undefined, undefined, undefined, '', pitfalls),
  fixCheck: buildPrompt(c, 'continue', '', { from: 'check', round: 1, tail: ['boom'] }, undefined, undefined, '', pitfalls),
  fixReview: buildPrompt(c, 'continue', '', { from: 'review', round: 1 }, undefined, undefined, '', pitfalls),
})

/**
 * build-like-review AC-1（dispatch-slim AC-2 改：修正輪不再讀，見 dispatch-slim D-02）：設了常犯錯誤清單、檔案也在，實作與回覆的提示先叫 Agent 讀清單，
 * 跟審查用同一句；沒設或檔案不在就沒有這句。
 */
test('test_writing_prompts_include_pitfalls_when_list_exists', async ($, on) => {
  const c = mk('依規格實作')
  const withPath = writingPrompts(c, '/h/pitfalls.md')
  for (const p of [withPath.continue, withPath.reply]) expect(p).toContain(PITFALLS_LINE('/h/pitfalls.md'))
  for (const p of Object.values(writingPrompts(c))) expect(p).not.toContain(READ_LIST)
  // 實作與審查讀清單是同一句（逐字）
  const review = buildPrompt(c, 'review', '', undefined, { round: 0, pitfalls: '/h/pitfalls.md' })
  const line = (p: string) => p.split('\n').find(l => l.includes(READ_LIST) && l.startsWith('先讀'))
  expect(line(review)).toBe(PITFALLS_LINE('/h/pitfalls.md'))
  expect(line(withPath.continue)).toBe(line(review))

  // 真的派出去：清單檔不在時派 Beta 不帶這句；建了清單再派 Alpha 就帶路徑
  const { data, clock } = fixture(on)
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test' }
  data.agents = []
  let n = 0
  data.launch = async () => result(0, `c000000${++n}`)
  const go = async (name: string) => {
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    await $.command.run({ command: 'desk', args: `go ${name}` } as any)
    await clock.settle()
    return String(data.launches.at(-1).argv.at(-1))
  }
  const without = await go('Beta')
  expect(without.startsWith('依卡片的下一步繼續：依審核修正')).toBe(true)
  expect(without).not.toContain(READ_LIST)
  data.files[PITFALLS_FILE] = '# 清單'
  const withList = await go('Alpha')
  expect(withList).toContain('任務：Alpha')
  expect(withList).toContain(PITFALLS_LINE(PITFALLS_FILE))
})

/** AC-1：會改程式的派工包含實作、回覆與每種修正；派工端算清單路徑與 buildPrompt 加清單句用同一份「實作與回覆」條件，修正不算（dispatch-slim AC-2）。 */
test('test_writing_prompts_include_pitfalls_when_list_exists: writes code covers continue, reply and every fix', () => {
  expect(writesCode('continue')).toBe(true)
  expect(writesCode('reply')).toBe(true)
  expect(writesCode('continue', { from: 'check', round: 1 })).toBe(true)
  expect(writesCode('continue', { from: 'review', round: 2, security: true })).toBe(true)
  for (const kind of ['sync', 'review', 'publish', 'catchup'] as const) expect(writesCode(kind)).toBe(false)
  const c = mk('依規格實作')
  expect(readsPitfalls(c, 'continue')).toBe(true)
  expect(readsPitfalls(c, 'reply')).toBe(true)
  for (const from of ['check', 'review', 'medium'] as const) expect(readsPitfalls(c, 'continue', { from, round: 1 })).toBe(false)
  for (const kind of ['sync', 'review', 'publish', 'catchup'] as const) expect(readsPitfalls(c, kind)).toBe(false)
})

/** AC-1：真的派回覆（Agent 停在提問、/desk reply）：清單在就帶路徑。 */
test('test_writing_prompts_include_pitfalls_when_list_exists: reply dispatch', async ($, on) => {
  const { data, clock } = fixture(on)
  const BETA = '/home/u/wt/beta'
  const SID = 'bbbbbbbb-0000-4000-8000-000000000000'
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[PITFALLS_FILE] = '# 清單'
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
  data.gh = []
  data.agents = [{ id: 'bbbbbbbb', kind: 'background', cwd: BETA, name: 'desk-launch-1', sessionId: SID, state: 'blocked', status: 'waiting', waitingFor: 'input needed', startedAt: NOW - 60_000 }]
  data.logs = { bbbbbbbb: '要先跑整套測試嗎？\n' }
  data.store.jobs = { [BETA]: { sessionId: SID, last: { launchName: 'desk-launch-1', nativeId: 'bbbbbbbb', sessionId: SID, kind: 'continue', startedAt: NOW - 60_000, fresh: false } } }
  data.launch = async () => result(0, 'cccccccc\n')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'reply Beta 先跑整套' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  const p = String(data.launches[0].argv.at(-1))
  expect(p).toContain('的回覆：先跑整套')
  expect(p).toContain(PITFALLS_LINE(PITFALLS_FILE))
})

/** dispatch-slim AC-6（原 build-like-review AC-1 的修正輪）：自動流程的修正輪（審查有 HIGH）照舊派出去，清單在也不帶。 */
test('test_writing_prompts_include_pitfalls_when_list_exists: auto fix round dispatch', async ($, on) => {
  const { data, clock } = fixture(on)
  const ALPHA = '/home/u/wt/alpha'
  data.agents = []
  data.files[PITFALLS_FILE] = '# 清單'
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test' }
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '無', 關卡: 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核' })
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [HIGH][稽核] a.ts:1 — 漏寫稽核紀錄'
  // 派審查前的完成檢查在這個 HEAD 通過過；這個對話的流程在第 0 輪、剛審完這個 HEAD
  data.store.verifies = { [CARD_A]: { command: 'node test.mjs', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h1' } }
  data.store.chains = { [ALPHA]: { owner: 'fixture-session', startedAt: 0, round: 0, reviewHead: 'h1', reviewBranch: 'feature/alpha' } }
  data.store.jobs = { [ALPHA]: { sessionId: 'a0000001-0000-4000-8000-000000000000', last: { launchName: 'desk-rv-0', nativeId: 'r0000001', sessionId: 'r0000001-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session' } } }
  data.launch = async () => result(0, 'f0000001')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  const p = String(data.launches[0].argv.at(-1))
  expect(p.startsWith('修正第 1／2 輪：')).toBe(true)
  expect(p).not.toContain(READ_LIST)
  expect(p).not.toContain(PITFALLS_FILE)
  expect(p).toContain(WHOLE_CLASS)
  expect(p).toContain(SELF_CHECK)
})

/** 停在失敗的卡（按 g 派修正的那種）：`gate` 是關卡，`chain` 是流程紀錄；下一步只剩等待，g 派出去的開頭才走修正句。 */
function failed(gate = '無', chain?: Case['chain'], over: Partial<Case> = {}): Case {
  const base = buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：等審查\n- 關卡：${gate}\n<!-- /DESK -->`, 1, {}, undefined)
  return { ...base, state: 'failed', ...(chain ? { chain } : {}), ...over } as Case
}
const BLOCKED_GATE = 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；不過'
const QUOTA_STOP = '5 小時額度剩 25%，低於門檻 30%，14:00 重置後按 g 重開'

/** dispatch-slim AC-1：設了清單、檔案也在，派修正（檢查沒過、依審查、資安審查、你選修掉 MEDIUM；自動流程的與按 g 派的）不叫 Agent 讀清單；整類列出與自我檢查照舊。 */
test('test_fix_prompts_skip_pitfalls_list', () => {
  const c = mk('依規格實作')
  const P = '/h/pitfalls.md'
  const fix = (f: Parameters<typeof buildPrompt>[3]) => buildPrompt(c, 'continue', '', f, undefined, undefined, '', P)
  const byG = (x: Case) => buildPrompt(x, 'continue', '', undefined, undefined, undefined, '', P)
  const check = fix({ from: 'check', round: 1, tail: ['boom'] })
  const byReview = [fix({ from: 'review', round: 1 }), fix({ from: 'review', round: 2, security: true }), fix({ from: 'medium', round: 3 }), fix({ from: 'medium', round: 3, security: true })]
  // 按 g：檢查沒過、審查 HIGH 還在、流程停下、選了修掉 MEDIUM 沒派出、額度煞車擋下時審查還要修、PR 的 CI 失敗
  const gCheck = byG(failed())
  const gByReview = [
    byG(failed(BLOCKED_GATE)),
    byG(failed(BLOCKED_GATE, { round: 2, lastKind: 'fix', stopped: '修了 2 輪仍有 CRITICAL 0、HIGH 1' } as Case['chain'])),
    byG(failed('無', { round: 0, passed: true, stopped: MEDIUM_FIX_NOT_SENT } as Case['chain'])),
    byG(failed(BLOCKED_GATE, { round: 1, stopped: QUOTA_STOP } as Case['chain'])),
  ]
  const ciCase = { ...atMerge(), pr: { id: 7, state: 'OPEN', ci: 'fail' } } as Case
  const gCi = byG({ ...ciCase, next: '等 CI' } as Case)
  for (const p of [check, ...byReview, gCheck, ...gByReview, gCi]) {
    expect(p.split('\n')[0]).toContain('修正')
    expect(p).not.toContain(READ_LIST)
    expect(p).not.toContain(P)
    expect(p).toContain(SELF_CHECK)
  }
  for (const p of [...byReview, ...gByReview]) expect(p).toContain(WHOLE_CLASS)
  for (const x of [failed(), failed(BLOCKED_GATE), ciCase]) expect(readsPitfalls(x, 'continue')).toBe(false)
})

/** dispatch-slim AC-1 的另一面：按 g 但不是在修東西（Agent 被停止後重開、額度煞車擋在派驗收前沒東西要修）照實作讀清單。 */
test('test_fix_prompts_skip_pitfalls_list: restarts that fix nothing still read the list', () => {
  const P = '/h/pitfalls.md'
  const stopped = failed('無', { round: 0, stopped: AGENT_STOPPED } as Case['chain'])
  const quotaIdle = failed('無', { round: 0, stopped: QUOTA_STOP } as Case['chain'], { pipeline: { current: 'review' } } as Partial<Case>)
  const restart = buildPrompt(stopped, 'continue', '', undefined, undefined, undefined, '', P)
  const resume = buildPrompt(quotaIdle, 'continue', '', undefined, undefined, undefined, '', P)
  expect(restart.startsWith('上一個 Agent 被停止')).toBe(true)
  expect(resume.startsWith(QUOTA_NOTHING_TO_FIX)).toBe(true)
  for (const p of [restart, resume]) expect(p).toContain(PITFALLS_LINE(P))
})

/** dispatch-slim AC-1：真的按 g 派出去（檢查沒過、卡片下一步只剩等待）：清單檔在也不帶。 */
test('test_fix_prompts_skip_pitfalls_list: g dispatch on a failed check', async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[PITFALLS_FILE] = '# 清單'
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '無', 下一步: '等檢查' })
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test' }
  data.store.verifies = { [CARD_A]: { command: 'node test.mjs', at: NOW - 60_000, ok: false, exitCode: 1, tail: ['boom'], truncated: false } }
  data.agents = []
  data.launch = async () => result(0, 'g0000001')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  const p = String(data.launches[0].argv.at(-1))
  expect(p.startsWith('修正：完成檢查 `node test.mjs` 未通過')).toBe(true)
  expect(p).not.toContain(READ_LIST)
  expect(p).toContain(SELF_CHECK)
})

/** build-like-review AC-2：實作、回覆與修正的提示要求交出前自我檢查（突變檢查、對照 main 跑相鄰路徑、寫進歷程），有沒有清單都要。 */
test('test_writing_prompts_require_self_check_before_push', () => {
  const c = mk('依規格實作')
  for (const pitfalls of ['/h/pitfalls.md', '']) {
    for (const p of Object.values(writingPrompts(c, pitfalls))) {
      expect(p).toContain(SELF_CHECK)
      expect(p).toContain('沒斷言到「則」那欄，要補')
      expect(p).toContain('拿掉改動在暫存複本做，或 commit 後才在 worktree 做、做完用 git diff 確認已還原，不要用 git stash')
      expect(p).toContain(ADJACENT)
      expect(p).toContain('做了什麼寫進歷程')
    }
  }
})

/** lean-fix-loop AC-1：自我檢查只做必要的：每條驗收情境拿掉一處最關鍵的改動、只跑對應測試，不每處都拿、拿掉後不跑整套；相鄰路徑只在改到自動流程時對照 main，也只跑那些路徑的測試。 */
test('test_self_check_rule_limits_mutations_to_one_per_ac', () => {
  const c = mk('依規格實作')
  for (const p of Object.values(writingPrompts(c, '/h/pitfalls.md'))) {
    expect(p).toContain('每條驗收情境挑一處最關鍵的改動拿掉、只跑對應的測試確認會紅')
    expect(p).toContain('不要每處改動都拿，拿掉後不要跑整套')
    expect(p).toContain('改到自動流程時才在暫存複本對照 main 跑相鄰路徑（例如暫停後重開、別的對話、重新驗收），也只跑那些路徑的測試')
    // 舊句：每條驗收情境的測試都把對應改動拿掉、狀態判斷或解析也要對照 main
    expect(p).not.toContain('每條驗收情境的測試，把對應改動拿掉要會紅')
    expect(p).not.toContain('改到自動流程、狀態判斷或解析的')
  }
})

/** build-like-review AC-3：依審查檔修（自動修正輪、資安修正輪、按 g 修審查結論、流程停下後按 g）都要求整類列出、每種都修並補測試、寫進歷程。 */
test('test_fix_prompts_require_fixing_the_whole_class', () => {
  const c = mk('依規格實作')
  const blocked = buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, '<!-- DESK -->\n- 狀態：ok\n- 檢查：`npm test`\n- 等你：無\n- 下一步：等審查\n- 關卡：review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；不過\n<!-- /DESK -->', 1, {}, undefined)
  const fixes = [
    buildPrompt(c, 'continue', '', { from: 'review', round: 1 }),
    buildPrompt(c, 'continue', '', { from: 'review', round: 2, security: true }),
    buildPrompt({ ...blocked, state: 'failed' }, 'continue'),
    buildPrompt({ ...blocked, state: 'failed', chain: { round: 2, lastKind: 'fix', stopped: '修了 2 輪仍有 CRITICAL 0、HIGH 1' } } as Case, 'continue'),
    // 你在等你對審查 MEDIUM 選了修掉：自動派的修正（流程跑過資安審查時兩份都看），與沒派出停下後按 g 重派
    buildPrompt(c, 'continue', '', { from: 'medium', round: 3 }),
    buildPrompt(c, 'continue', '', { from: 'medium', round: 3, security: true }),
    buildPrompt({ ...blocked, state: 'failed', chain: { round: 0, passed: true, stopped: MEDIUM_FIX_NOT_SENT } } as Case, 'continue'),
  ]
  for (const p of fixes) {
    expect(p.split('\n')[0]).toContain('修正')
    expect(p).toContain(WHOLE_CLASS)
    expect(p).toContain('每種都修並補測試，不只修審查舉的例子')
    expect(p).toContain('列了哪些情況寫進 .task/REPORT.md')
  }
  // 檢查沒過的修正輪不是依審查檔修：沒有這句
  expect(buildPrompt(c, 'continue', '', { from: 'check', round: 1, tail: ['boom'] })).not.toContain(WHOLE_CLASS)
})

/** build-like-review AC-4：同步、審查、推送、解衝突不帶清單、自我檢查與整類修那三句；審查照舊讀清單。 */
test('test_non_writing_prompts_skip_self_check_rules', () => {
  const c = mk('依規格實作')
  const review = buildPrompt(c, 'review', '', undefined, { round: 0, pitfalls: '/h/pitfalls.md' }, undefined, '', '/h/pitfalls.md')
  const others = [
    buildPrompt(c, 'sync', '', undefined, undefined, undefined, '', '/h/pitfalls.md'),
    review,
    buildPrompt(atMerge(), 'publish', pushRequest('feature/a', 12), undefined, undefined, undefined, '', '/h/pitfalls.md'),
    buildPrompt(atMerge(), 'catchup', '把 origin/main 合併進來', undefined, undefined, undefined, '', '/h/pitfalls.md'),
  ]
  for (const p of others) {
    expect(p).not.toContain('交出前自我檢查')
    expect(p).not.toContain(WHOLE_CLASS)
  }
  // 審查照舊讀清單（跟實作同一句，dispatch-slim AC-2）；其他三種不讀
  for (const p of others.filter(p => p !== review)) expect(p).not.toContain(PITFALLS_LINE('/h/pitfalls.md'))
  expect(review).toContain('先讀專案常犯錯誤清單 /h/pitfalls.md，逐條對照這次的改動。')
})

/**
 * dispatch-slim AC-5：同一張卡組實作、修正、解衝突、推送的提示，修正、解衝突、推送都比改之前短，實作不變。
 * BEFORE 是改之前（main bc98d6f）用這裡同一組參數量到的長度；之後改了共用規則讓實作那格不相等時，照新長度重量整組基準。
 */
const BEFORE = { continue: 1677, fixCheck: 1722, fixReview: 1990, fixSecurity: 1992, fixMedium: 2020, catchup: 1445, openPr: 1240, push: 1094 }
test('test_slim_prompts_are_shorter_than_before', () => {
  const c = mk('依規格實作')
  const P = '/h/pitfalls.md'
  const now = {
    continue: buildPrompt(c, 'continue', '', undefined, undefined, undefined, '', P).length,
    fixCheck: buildPrompt(c, 'continue', '', { from: 'check', round: 1, tail: ['boom'] }, undefined, undefined, '', P).length,
    fixReview: buildPrompt(c, 'continue', '', { from: 'review', round: 1 }, undefined, undefined, '', P).length,
    fixSecurity: buildPrompt(c, 'continue', '', { from: 'review', round: 2, security: true }, undefined, undefined, '', P).length,
    fixMedium: buildPrompt(c, 'continue', '', { from: 'medium', round: 3 }, undefined, undefined, '', P).length,
    catchup: buildPrompt(atMerge(), 'catchup', 'origin/main').length,
    openPr: buildPrompt(atMerge(), 'publish', openPrRequest('feature/a', 'origin/main', { host: 'github', repo: 'acme/shop' })).length,
    push: buildPrompt(atMerge(), 'publish', pushRequest('feature/a', 12)).length,
  }
  expect(now.continue).toBe(BEFORE.continue)
  for (const k of ['fixCheck', 'fixReview', 'fixSecurity', 'fixMedium', 'catchup', 'openPr', 'push'] as const) expect([k, now[k] < BEFORE[k]]).toEqual([k, true])
})
