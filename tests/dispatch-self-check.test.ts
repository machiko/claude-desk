// build-like-review：會改程式的派工（實作、回覆、修正）交出前先做審查會做的檢查；同步、審查、推送、解衝突不帶。
import { expect, test } from 'claude-code/testing'
import { buildPrompt, pushRequest, writesCode } from '../hooks/dispatch'
import { MEDIUM_FIX_NOT_SENT } from '../hooks/chain'
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
const PITFALLS_LINE = (path: string) => `先讀常犯錯誤清單 ${path}，逐條對照這次要寫的改動。`
const SELF_CHECK = '交出前自我檢查：每條驗收情境挑一處最關鍵的改動拿掉、只跑對應的測試確認會紅'
const ADJACENT = '改到自動流程時才在暫存複本對照 main 跑相鄰路徑'
const WHOLE_CLASS = '先把同一類情況全部列出'
const writingPrompts = (c: Case, pitfalls = '') => ({
  continue: buildPrompt(c, 'continue', '', undefined, undefined, undefined, '', pitfalls),
  reply: buildPrompt(c, 'reply', '用 B', undefined, undefined, undefined, '', pitfalls),
  fixCheck: buildPrompt(c, 'continue', '', { from: 'check', round: 1, tail: ['boom'] }, undefined, undefined, '', pitfalls),
  fixReview: buildPrompt(c, 'continue', '', { from: 'review', round: 1 }, undefined, undefined, '', pitfalls),
})

/** build-like-review AC-1：設了常犯錯誤清單、檔案也在，實作、回覆與修正的提示先叫 Agent 讀清單；沒設或檔案不在就沒有這句。 */
test('test_writing_prompts_include_pitfalls_when_list_exists', async ($, on) => {
  const c = mk('依規格實作')
  for (const p of Object.values(writingPrompts(c, '/h/pitfalls.md'))) expect(p).toContain(PITFALLS_LINE('/h/pitfalls.md'))
  for (const p of Object.values(writingPrompts(c))) expect(p).not.toContain('先讀常犯錯誤清單')

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
  expect(without).not.toContain('先讀常犯錯誤清單')
  data.files[PITFALLS_FILE] = '# 清單'
  const withList = await go('Alpha')
  expect(withList).toContain('任務：Alpha')
  expect(withList).toContain(PITFALLS_LINE(PITFALLS_FILE))
})

/** AC-1：派工端算清單路徑與 buildPrompt 加規則用同一份「會改程式的派工」條件。 */
test('test_writing_prompts_include_pitfalls_when_list_exists: writes code covers continue, reply and every fix', () => {
  expect(writesCode('continue')).toBe(true)
  expect(writesCode('reply')).toBe(true)
  expect(writesCode('continue', { from: 'check', round: 1 })).toBe(true)
  expect(writesCode('continue', { from: 'review', round: 2, security: true })).toBe(true)
  for (const kind of ['sync', 'review', 'publish', 'catchup'] as const) expect(writesCode(kind)).toBe(false)
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

/** AC-1：自動流程的修正輪（審查有 HIGH）真的派出去：清單在就帶路徑。 */
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
  expect(p).toContain(PITFALLS_LINE(PITFALLS_FILE))
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
  const review = buildPrompt(c, 'review', '', undefined, { round: 0, pitfalls: '/h/pitfalls.md', history: '/h/reviews' }, undefined, '', '/h/pitfalls.md')
  const others = [
    buildPrompt(c, 'sync', '', undefined, undefined, undefined, '', '/h/pitfalls.md'),
    review,
    buildPrompt(atMerge(), 'publish', pushRequest('feature/a', 12), undefined, undefined, undefined, '', '/h/pitfalls.md'),
    buildPrompt(atMerge(), 'catchup', '把 origin/main 合併進來', undefined, undefined, undefined, '', '/h/pitfalls.md'),
  ]
  for (const p of others) {
    expect(p).not.toContain(PITFALLS_LINE('/h/pitfalls.md'))
    expect(p).not.toContain('交出前自我檢查')
    expect(p).not.toContain(WHOLE_CLASS)
  }
  expect(review).toContain('先讀專案常犯錯誤清單 /h/pitfalls.md，逐條對照這次的改動。')
})
