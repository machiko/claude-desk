// build-like-review：會改程式的派工（實作、回覆、修正）交出前先做審查會做的檢查；同步、審查、推送、解衝突不帶。
import { expect, test } from 'claude-code/testing'
import { buildPrompt, pushRequest } from '../hooks/dispatch'
import { buildCase } from '../hooks/model'
import { pipeline } from '../hooks/pipeline'
import type { Case, Verify } from '../types'
import { fixture, result, CARD_A, CARD_B, PROJECT_DIR } from './fixture'

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
const SELF_CHECK = '交出前自我檢查：每條驗收情境的測試，把對應改動拿掉要會紅'
const ADJACENT = '改到自動流程、狀態判斷或解析的，在暫存複本對照 main 跑相鄰路徑'
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

/** build-like-review AC-2：實作、回覆與修正的提示要求交出前自我檢查（突變檢查、對照 main 跑相鄰路徑、寫進歷程），有沒有清單都要。 */
test('test_writing_prompts_require_self_check_before_push', () => {
  const c = mk('依規格實作')
  for (const pitfalls of ['/h/pitfalls.md', '']) {
    for (const p of Object.values(writingPrompts(c, pitfalls))) {
      expect(p).toContain(SELF_CHECK)
      expect(p).toContain('把對應改動拿掉要會紅')
      expect(p).toContain(ADJACENT)
      expect(p).toContain('做了什麼寫進歷程')
    }
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
  ]
  for (const p of fixes) {
    expect(p.split('\n')[0]).toContain('修正')
    expect(p).toContain(WHOLE_CLASS)
    expect(p).toContain('每種都修並補測試，不只修審查舉的例子')
    expect(p).toContain('列了哪些情況寫進歷程')
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
