// plain-pm-wording：面板的「輪到你」、說明頁與卡片歷程都照白話範本寫，PM 看面板就懂現在發生什麼、下一步按什麼。
import { expect, test } from 'claude-code/testing'
import { buildPrompt, openPrRequest, prHowOf, pushRequest } from '../hooks/dispatch'
import { HISTORY_FORMAT, HISTORY_FORMAT_RULE, PUSH_RULE } from '../hooks/prompts/rules'
import { RUNNING_TEXT, TURN_TEXT, turnOf } from '../hooks/turn'
import { HELP, HELP_CREATE } from '../hooks/pane'
import { WORD } from '../hooks/theme'
import { specOkMarks } from '../hooks/touch'
import { CHECK_CHANGED_WHY, CHECK_UNAPPROVED_WHY } from '../hooks/chain'
import { buildCase } from '../hooks/model'
import { finalState, pipeline } from '../hooks/pipeline'
import type { Case, Verify } from '../types'

const card = (f: { next?: string; gate?: string }) =>
  `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：${f.next ?? '依規格實作'}\n- 關卡：${f.gate ?? '無'}\n<!-- /DESK -->`

/** 跟工作桌一樣：讀卡 → 疊上 git／PR／流程 → 算六段 → 決定是否完成。 */
function mk(f: Parameters<typeof card>[0], extra: Partial<Case> = {}, v?: Verify): Case {
  const base = { ...buildCase({ name: 'A', statusPath: '/w/order-export/.desk/CARD.md' }, card(f), 1, {}, v), git: { branch: 'feature/a', head: 'h1' }, ...extra }
  const piped = { ...base, pipeline: pipeline(base as Case, v) }
  return { ...piped, state: finalState(piped) } as Case
}
const passed: Verify = { command: 'npm test', at: 1, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h1' }

/** 括號外的字：補充都放在括號裡，括號外只剩鍵與動作。 */
const outside = (s: string) => s.replace(/（[^（）]*）/g, '')
const chars = (s: string) => [...s].length

/** 「輪到你」範本：一句話（沒有「；」）、補充只在句尾一個括號、括號外 30 字內。 */
function expectPlainTurn(name: string, text: string) {
  expect([name, text.includes('；')]).toEqual([name, false])
  expect([name, /^[^（）]+(?:（[^（）]+）)?$/.test(text)]).toEqual([name, true])
  expect([name, chars(outside(text)) <= 30]).toEqual([name, true])
}

/**
 * turn.ts 的每一句（TURN_TEXT），配上範例參數與改寫前那句的鍵（null：那句本來就沒有鍵）。
 * 鍵是改寫前句子裡叫你按的那顆（例如「按 g 派 Agent：…」是 g），改寫後要以同一顆鍵開頭。
 */
const TURN_CASES: [keyof typeof TURN_TEXT, unknown[], string | null][] = [
  ['demo', [], null], ['noCard', [], null], ['launching', [], null], ['agentQueued', [2], null],
  ['sentWaiting', [], null], ['sentUnwritten', [], 'o'], ['pickChoice', [], 'f'], ['reply', [], 'y'],
  ['verifying', [], null], ['verifyQueued', [], null], ['manual', [], null], ['shipped', [], null],
  ['agentStopped', [], 'g'], ['mediumFixNotSent', [], 'g'],
  ['checkApprove', [CHECK_CHANGED_WHY], 'v'], ['checkApprove', [CHECK_UNAPPROVED_WHY], 'v'],
  ['checkPaused', ['容器沒啟動'], 'v'], ['checkForeign', [CHECK_UNAPPROVED_WHY], 'g'], ['checkStageFailed', ['檢查中斷'], 'v'],
  ['fixPaused', ['自動修正兩輪用完'], 'g'], ['checkFailed', [], 'g'], ['unknownGate', ['待法務確認'], 'o'],
  ['specOk', ['/desk:card spec order-export ok'], 't'], ['specOkStacked', ['/desk:card spec order-export-medium ok', '訂單匯出'], 't'],
  ['stackWait', ['訂單匯出', true], null], ['stackWait', ['訂單匯出', false], null], ['specGap', ['/desk:card spec order-export'], null], ['missingCheck', [], 'o'],
  ['idle', [], null], ['continue', ['補上匯出測試'], 'g'],
  ['verify', ['自動驗收'], 'v'], ['verify', ['按 w 派驗收'], 'v'], ['reverify', ['自動重新驗收'], 'v'],
  ['verifyThenReview', ['按 w 派驗收'], 'v'], ['verifyIdle', ['流程接著過關、不重新驗收'], 'v'], ['verifyIdle', ['按 w 派驗收'], 'v'],
  ['verdict', [], null], ['autoReview', [], null], ['review', [false, '開 PR'], 'w'], ['review', [true, '合併 PR'], 'w'], ['nothing', [], null],
  ['publishPr', [], 'n'], ['publishPrRisky', [], 'n'], ['publishPush', [], 'n'], ['ciPending', [], null], ['ciFailed', [], 'p'], ['merge', [12], 'p'],
  ['releasing', ['打 tag'], null], ['releaseStopped', ['打 tag'], 'z'], ['release', [true], 'z'], ['release', [false], 'z'],
  ['shipConfirm', ['v1.2.0'], 'u'], ['taggedArchive', ['v1.2.0', '/desk:card archive order-export'], null],
  ['shipsWith', ['release/1.2', true], null], ['shipsWith', ['release/1.2', false], null], ['tagRelease', [true], null], ['tagRelease', [false], null],
  ['archive', ['/desk:card archive order-export'], 'q'], ['archiveCmd', ['/desk:card archive order-export'], null],
]

/** AC-2：「輪到你」每一句都是「<鍵> <動作>（<補充>）」，鍵跟改寫前相同。 */
test('every turn text follows plain format', () => {
  // 逐句列舉：TURN_TEXT 每一句都在清單上，新增一句要一起列進來。
  expect([...new Set(TURN_CASES.map(([name]) => name))].sort()).toEqual(Object.keys(TURN_TEXT).sort())
  for (const [name, args, key] of TURN_CASES) {
    const text = (TURN_TEXT[name] as (...a: unknown[]) => string)(...args)
    expectPlainTurn(name, text)
    if (key) expect([name, text.startsWith(`${key} `)]).toEqual([name, true])
    else expect([name, /^[a-z] /.test(text)]).toEqual([name, false])
  }
  for (const [kind, text] of Object.entries(RUNNING_TEXT)) expectPlainTurn(`running:${kind}`, text!)

  // 從面板算出來的那句（turnOf）就是範本句，鍵跟 Turn.key 相同。
  const build = turnOf(mk({ next: '補上匯出測試' }))
  expect(build).toEqual({ who: 'you', text: 'g 派 Agent 做下一步（補上匯出測試）', action: 'continue', key: 'g' })
  const spec = turnOf(mk({ gate: 'spec：待確認規格' }))
  expect(spec).toEqual({ who: 'you', text: 't 確認規格並派實作（先按 o 看過規格，或輸入 /desk:card spec order-export ok）', action: 'spec-ok', key: 't' })
  // 合併段驗收是自審：補充接進同一個括號，不另開第二個括號。
  const gate = 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
  const selfReviewed = turnOf(mk({ gate }, { pr: { id: 3, state: 'OPEN', ci: 'pass', url: 'https://github.com/acme/shop/pull/3' }, gitState: { ahead: 0, behind: 0, changed: 0, untracked: 0, upstream: true }, chain: { round: 0, passed: true, selfReview: true } }, passed))
  expect(selfReviewed.text).toBe('p 合併 PR #3（在瀏覽器開啟，合併後打 tag 發版，驗收是自審，可按 w 派獨立驗收）')
  expectPlainTurn('merge+selfReview', selfReviewed.text)
  for (const t of [build, spec, selfReviewed]) expect(t.text.startsWith(`${t.key} `)).toBe(true)
})

/** 說明頁改寫前的鍵，照原本的順序。 */
const HELP_KEYS = ['1–9', 'a b c d', 'f', 'g / w / s', 'y', 'k', 'l', 'v', 'u', 'n', 'z', 'q', 'm', 'o / e / p', 'r', '⇡ 更新', 'x', 'i', 'h', 't', '↑ ↓ 滾輪', 'Esc', '/desk close', '● ◉ ◆ ✕ ○ ·', '✓（綠）']

/** AC-3：說明頁每條是「做什麼（什麼時候用）」，不含「；」，每個鍵都還在、鍵名不變。 */
test('help entries follow plain format and keep every key', () => {
  expect(HELP.map(([key]) => key)).toEqual(HELP_KEYS)
  expect(HELP_CREATE[0]).toBe('n')
  for (const [key, text] of [...HELP, HELP_CREATE]) {
    expect([key, text.includes('；')]).toEqual([key, false])
    expect([key, /^[^（）]+（[^（）]+）$/.test(text)]).toEqual([key, true])
  }
  // 沒有任務時的空狀態跟說明頁同一個寫法。
  for (const line of WORD.empty.split('\n')) expect([line, /^[^（）；]+（[^（）；]+）$/.test(line)]).toEqual([line, true])
})

/** 歷程一筆的白話範本：「<誰>：<做了什麼> → <結果>」，代號最多一個、放句尾括號。 */
const HISTORY_LINE = /^[^：「」→]+：[^→（）]+ → [^→（）]+(?:（(?:commit|PR) [^（）]+）)?$/
/** 提示裡用「」框起來、含「→」的歷程範例。 */
const examples = (p: string) => [...p.matchAll(/「([^「」]*→[^「」]*)」/g)].map(m => m[1]!)

/** AC-1：每一種派工的提示都帶歷程範本那段（卡片模板同一段由 skills/card/tests 的 Python 測試比對）。 */
test('dispatch prompt and card template carry plain history format', () => {
  for (const words of ['<誰>：<做了什麼> → <結果>', '40 字內', '代號最多一個、放句尾括號', '不寫指令、檔名、Agent 啟動名', '.task/REPORT.md']) expect(HISTORY_FORMAT).toContain(words)
  const c = mk({ next: '補上匯出測試' })
  const merge = mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }, {}, passed)
  const prompts: Record<string, string> = {
    continue: buildPrompt(c, 'continue'),
    reply: buildPrompt(c, 'reply', '用 B'),
    fix: buildPrompt(c, 'continue', '', { from: 'review', round: 1 }),
    review: buildPrompt(c, 'review'),
    sync: buildPrompt(c, 'sync'),
    publish: buildPrompt(merge, 'publish', pushRequest('feature/a', 12)),
    catchup: buildPrompt(merge, 'catchup', 'origin/main'),
  }
  for (const [kind, p] of Object.entries(prompts)) expect([kind, p.includes(HISTORY_FORMAT_RULE)]).toEqual([kind, true])
  for (const e of examples(HISTORY_FORMAT)) expect([e, HISTORY_LINE.test(e)]).toEqual([e, true])
})

/**
 * card-rules-guard-legacy AC-5（派工提示那半；卡片模板那半由 skills/card/tests 的 Python 測試比對同一句）：
 * 歷程的時間句併進行格式那句，每一種派工的提示只講一次 date 取時間，不再另有一條時間規則。
 */
test('card template history line format is single consistent rule', () => {
  const date = "`date '+%Y-%m-%d %H:%M'`"
  expect(HISTORY_FORMAT.startsWith(`每筆寫成 \`- YYYY-MM-DD HH:MM：<誰>：<做了什麼> → <結果>\`，時間跑 ${date} 取得`)).toBe(true)
  const c = mk({ next: '補上匯出測試' })
  const merge = mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }, {}, passed)
  const prompts: Record<string, string> = {
    continue: buildPrompt(c, 'continue'),
    reply: buildPrompt(c, 'reply', '用 B'),
    fix: buildPrompt(c, 'continue', '', { from: 'review', round: 1 }),
    review: buildPrompt(c, 'review'),
    sync: buildPrompt(c, 'sync'),
    publish: buildPrompt(merge, 'publish', pushRequest('feature/a', 12)),
    catchup: buildPrompt(merge, 'catchup', 'origin/main'),
  }
  for (const [kind, p] of Object.entries(prompts)) {
    expect([kind, p.split(date).length - 1, p.includes('不用手寫時間'), p.includes('歷程時間一律')]).toEqual([kind, 1, false, false])
  }
})

/** AC-4：審查、修正、推送要求寫歷程的句子，給的是範本格式的範例。 */
test('review and publish history lines use plain format', () => {
  const c = mk({ next: '補上匯出測試' })
  const merge = mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }, {}, passed)
  const github = prHowOf({ host: 'github', repo: { owner: 'acme', repo: 'shop' } })
  const bitbucket = prHowOf({ host: 'bitbucket', repo: { workspace: 'acme', repo: 'shop' } })
  const wanted: [string, string, string][] = [
    ['審查記錄不修', buildPrompt(c, 'review'), '審查：MEDIUM n 條記錄不修 → 見審查檔'],
    ['依審查修正', buildPrompt(c, 'continue', '', { from: 'review', round: 1 }), 'Agent：依審查修好 <哪幾條> → 待測試（commit <頂端 commit 前 7 碼>）'],
    ['手動修審查', buildPrompt({ ...c, gate: 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；要修' }, 'continue', '', { from: 'review', round: 0 }), 'Agent：依審查修好 <哪幾條> → 待測試（commit <頂端 commit 前 7 碼>）'],
    ['開 PR（gh）', openPrRequest('feature/a', 'main', github), 'Agent：push 並開 PR → 等 CI（PR #<編號>）'],
    ['開 PR（Bitbucket）', openPrRequest('feature/a', 'main', bitbucket), 'Agent：push 並開 PR → 等 CI（PR #<編號>）'],
    ['開 PR（自訂指令）', openPrRequest('feature/a', 'main', prHowOf(null, 'glab mr create')), 'Agent：push 並開 PR → 等 CI（PR #<編號>）'],
    ['開 PR（其他）', openPrRequest('feature/a', ''), 'Agent：push 並開 PR → 等 CI（PR #<編號>）'],
    ['push', pushRequest('feature/a', 12), 'Agent：push 新 commit → 等 CI（commit <頂端 commit 前 7 碼>）'],
    ['推送規則', PUSH_RULE, 'Agent：push 並開 PR → 等 CI（PR #12）'],
    ['推送規則', PUSH_RULE, 'Agent：push 新 commit → 等 CI（commit abc1234）'],
    ['解衝突', buildPrompt(merge, 'catchup', 'origin/main'), 'Agent：合併 main 解衝突 → 待測試（commit <合併 commit 前 7 碼>）'],
  ]
  for (const [where, prompt, line] of wanted) {
    expect([where, prompt.includes(`「${line}」`)]).toEqual([where, true])
    for (const e of examples(prompt)) expect([where, e, HISTORY_LINE.test(e)]).toEqual([where, e, true])
  }
  // 舊的寫法（網址、分支頂端、列出哪幾條、摘要括號）不再出現。
  const all = wanted.map(([, p]) => p).join('\n')
  for (const old of ['PR 網址寫進歷程', '把分支頂端 commit', '列出依審查修了哪幾條', '記錄、不修（摘要）', '歷程記合併 commit 與檔名']) expect([old, all.includes(old)]).toEqual([old, false])
})

/** AC-5 的面板那端：spec-ok 偵測認得 card.py 的新寫法，舊卡的舊寫法照樣認得。 */
test('card script history lines follow plain format', () => {
  const at = (history: string) => specOkMarks(`<!-- DESK -->\n- 狀態：規格已確認（AC-1～AC-2），可派實作\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：依規格實作\n- 關卡：無\n<!-- /DESK -->\n\n## Decisions\n\n- D-02 2030-01-05 Alex：確認規格（AC-1～AC-2，共 2 條）與實作計畫（3 項）\n\n## History\n\n${history}\n`)
  expect(at('- 2030-01-05 12:00：Alex：確認規格 → 可派實作')).toEqual({ isSpec: false, history: 1, decisions: 1 })
  expect(at('- 2030-01-05 12:00：Alex Chen：確認規格 → 可派實作')!.history).toBe(1)
  expect(HISTORY_LINE.test('Alex：確認規格 → 可派實作')).toBe(true)
  // 舊寫法（換範本前開的卡）照樣認得。
  expect(at('- 2030-01-05 12:00：規格確認，關卡清為無，可派實作')!.history).toBe(1)
  expect(at('- 2030-01-05：規格確認，關卡清為無，可派實作')!.history).toBe(1)
  // 別的歷程不算。
  expect(at('- 2030-01-05 12:00：Alex：補上匯出測試 → 待測試（commit abc1234）')!.history).toBe(0)
})
