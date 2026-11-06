import { expect, test } from 'claude-code/testing'
import { buildCase, stateOf, summary } from '../hooks/model'
import { UNREVIEWED_GATE, parseGate, unreviewedGate } from '../hooks/card'
import { finalState, pipeline } from '../hooks/pipeline'
import { AGENT_STOPPED } from '../hooks/chain'
import { buildPrompt, dispatchable, dispatchRefusal } from '../hooks/dispatch'
import { shipTurn, stageActions, turnOf } from '../hooks/turn'
import type { Case, Verify } from '../types'
import { fixture, CARD_B, PANE, REGISTRY, flat, text } from './fixture'

const card = (f: { check?: string; ask?: string; next?: string; gate?: string }) =>
  `<!-- DESK -->\n- 狀態：ok\n- 檢查：${f.check ?? '`npm test`'}\n- 等你：${f.ask ?? '無'}\n- 下一步：${f.next ?? '依規格實作'}\n- 關卡：${f.gate ?? '無'}\n<!-- /DESK -->`

/** 跟工作桌一樣：讀卡 → 疊上 git／PR／流程 → 算六段 → 決定是否完成。 */
function mk(f: Parameters<typeof card>[0], extra: Partial<Case> = {}, v?: Verify): Case {
  const base = { ...buildCase({ name: 'A', statusPath: '/w/age-group/.desk/CARD.md' }, card(f), 1, {}, v), git: { branch: 'feature/a', head: 'h1' }, ...extra }
  const piped = { ...base, pipeline: pipeline(base as Case, v) }
  return { ...piped, state: finalState(piped) } as Case
}
const passed: Verify = { command: '`npm test`'.slice(1, -1), at: 1, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h1' }
const ids = (c: Case, ctx = {}) => [...stageActions(c, ctx)].sort()

test('each stage says whose turn it is and what to press, in plain words', () => {
  expect(turnOf(mk({ check: '無' }))).toEqual({ who: 'you', text: 'o 開卡片填測試指令（卡片還沒有測試指令，在「檢查」欄填一條修之前會紅、修好會綠的指令）', action: 'open', key: 'o' })
  expect(turnOf(mk({ check: '`<完成檢查：修之前會紅、修好會綠的一條指令>`' }))).toEqual({ who: 'you', text: 'o 開卡片填測試指令（卡片還沒有測試指令，在「檢查」欄填一條修之前會紅、修好會綠的指令）', action: 'open', key: 'o' })
  expect(turnOf(mk({ gate: 'spec：待確認規格' }))).toEqual({ who: 'you', text: 't 確認規格並派實作（先按 o 看過規格，或輸入 /desk:card spec age-group ok）', action: 'spec-ok', key: 't' })
  expect(turnOf(mk({}))).toEqual({ who: 'you', text: 'g 派 Agent 做下一步（依規格實作）', action: 'continue', key: 'g' })
  expect(turnOf(mk({ ask: '要 push 嗎？A) 要 B) 等' }))).toMatchObject({ who: 'you', key: 'f' })
  expect(turnOf(mk({}), { verifying: true }).who).toBe('ai')
  expect(turnOf(mk({ gate: 'release：v0.2.0' }, { tag: 'v0.2.0' }))).toEqual({ who: 'you', text: 'u 確認上線（部署 v0.2.0 後按，確認後歸檔）', action: 'ship', key: 'u' })
  expect(turnOf(mk({ next: '可歸檔' }, { tag: 'v0.2.0' }))).toEqual({ who: 'you', text: 'q 歸檔（按兩次，或輸入 /desk:card archive age-group）', action: 'archive', key: 'q' })
  expect(turnOf(mk({}, { state: 'running', agent: { id: 'x', name: 'desk-1', state: 'working', status: 'busy' } })).who).toBe('ai')
})

test('only the actions that make sense now are listed: passed stages drop their keys', () => {
  // 規格段：只能開卡片（同步只在卡片落後時列）
  expect(ids(mk({ check: '無' }))).toEqual(['open'])
  // 實作段：繼續；還沒有檢查與審查
  expect(ids(mk({}))).toEqual(['continue', 'open'])
  // 審查過了（有結論、零擋）、還沒有 PR：沒有 v、沒有 w，多了開 PR（派推送 Agent）
  expect(ids(mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；過' }), {})).toEqual(['open', 'open-pr'])
  // 上線段：上線確認；合併過了不再同步
  expect(ids(mk({ gate: 'release：v0.2.0' }, { tag: 'v0.2.0' }))).toEqual(['open', 'ship'])
  // 完成：只剩歸檔（開卡片收進 m）
  expect(ids(mk({ next: '可歸檔' }, { tag: 'v0.2.0' }))).toEqual(['archive'])
  // 執行中：停止與輸出，不能再派
  expect(ids(mk({}, { state: 'running', agent: { id: 'x', name: 'desk-1', state: 'working', status: 'busy' } }))).toEqual(['logs', 'open', 'stop'])
  // 檢查未通過：可以讓 Agent 修，也可以重跑
  expect(ids(mk({}, {}, { ...passed, ok: false, exitCode: 1 }))).toEqual(['continue', 'open', 'verify'])
})

test('processing lines say who is doing what, without repeating that it is in progress', () => {
  const running = (kind?: any) => mk({}, { state: 'running', agent: { id: 'x', name: 'desk-1', state: 'working', status: 'busy', ...(kind ? { kind } : {}) }, ...(kind ? { chain: { round: 0, lastKind: kind } } : {}) })
  expect(turnOf(running()).text).toBe('Agent 在寫程式（l 看輸出）')
  expect(turnOf(running('fix')).text).toBe('Agent 在修正（l 看輸出）')
  expect(turnOf(running('sync')).text).toBe('Agent 在同步卡片（l 看輸出）')
  expect(turnOf(running('review')).text).toBe('Agent 在驗收（新對話）')
  expect(turnOf(mk({}), { verifying: true }).text).toBe('測試在跑')
  expect(turnOf(mk({}), { queued: true }).text).toBe('測試排隊中')
  expect(turnOf(mk({}), { launching: true }).text).toBe('派工中，等 Agent 啟動')
  expect(turnOf(mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }, { pr: { id: 1, state: 'OPEN', ci: 'pending' } })).text).toBe('PR 的 CI 在跑')
  expect(turnOf(mk({ gate: 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；要修' }, { chain: { round: 1 }, state: 'ready' }, passed)).text).toBe('驗收有結論，接著自動修正或過關')
  // 沒有任何一句還留著舊的「執行者」或「不用做事」
  for (const c of [running(), running('review')]) expect(turnOf(c).text).not.toMatch(/執行者|不用做事/)
})

/** AC-3：PR 開著、分支又領先遠端：輪到你說 push，不說合併；與遠端一致時照舊說合併 PR。 */
test('agent push: an open PR with new commits asks to push, not to merge', () => {
  const gate = 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
  const git = (ahead: number) => ({ ahead, behind: 0, changed: 0, untracked: 0, upstream: true })
  const pass = { id: 1, state: 'OPEN' as const, ci: 'pass' as const, url: 'https://github.com/acme/shop/pull/1' }

  const ahead = mk({ gate }, { pr: pass, gitState: git(1) })
  const pending = mk({ gate }, { pr: { ...pass, ci: 'pending' }, gitState: git(2) })
  const inSync = mk({ gate }, { pr: pass, gitState: git(0) })

  for (const c of [ahead, pending]) {
    expect(turnOf(c)).toEqual({ who: 'you', text: 'n 派 Agent push（PR 開著又有新 commit，按兩次，CI 過了再合併）', action: 'push', key: 'n' })
    expect(stageActions(c).has('push')).toBe(true)
  }
  expect(turnOf(inSync)).toEqual({ who: 'you', text: 'p 合併 PR #1（在瀏覽器開啟，合併後打 tag 發版）', action: 'pr', key: 'p' })
})

test('idle next: the now card asks for v instead of g', () => {
  // 沒有流程紀錄（主對話開發、/desk:card done 寫的下一步）：v 單跑只記結果，審查要自己按 w
  const c = mk({ next: '等自動檢查與審查；過了開 PR' })
  expect(turnOf(c)).toEqual({ who: 'you', text: 'v 執行測試（下一步只剩等測試，通過後按 w 派驗收，要改程式先把下一步寫成要做的事）', action: 'verify', key: 'v' })
  expect(ids(c)).toEqual(['open', 'verify'])
  // /desk:card done 寫的句子也認得
  expect(turnOf(mk({ next: '到面板按 v 執行完成檢查' }))).toEqual({ who: 'you', text: 'v 執行測試（下一步只剩等測試，通過後按 w 派驗收，要改程式先把下一步寫成要做的事）', action: 'verify', key: 'v' })
  expect(ids(mk({ next: '到面板按 v 執行完成檢查' }))).toEqual(['open', 'verify'])
  // 有流程紀錄（Agent 派工後）：檢查通過會自動接審查，照舊說
  const chained = mk({ next: '到面板按 v 執行完成檢查' }, { chain: { round: 0, lastKind: 'continue', autoReview: true } })
  expect(turnOf(chained)).toEqual({ who: 'you', text: 'v 執行測試（下一步只剩等測試，通過後流程接著驗收，要改程式先把下一步寫成要做的事）', action: 'verify', key: 'v' })
  expect(ids(chained)).toEqual(['open', 'verify'])
  // 有流程紀錄但不會自動接審查（別的對話開的、最後一次派的是同步、已停下）：照「通過後按 w」說
  const manual = 'v 執行測試（下一步只剩等測試，通過後按 w 派驗收，要改程式先把下一步寫成要做的事）'
  for (const chain of [{ round: 0, foreign: true, lastKind: 'continue' as const }, { round: 0, lastKind: 'sync' as const }, { round: 0, lastKind: 'continue' as const, autoReview: true, stopped: '修了 3 輪' }]) {
    expect(turnOf(mk({ next: '到面板按 v 執行完成檢查' }, { chain }))).toEqual({ who: 'you', text: manual, action: 'verify', key: 'v' })
  }
  // 審查過關後 /desk:card done 寫的句子也認得：叫你按 v，不叫你按 g
  const recheck = '等自動重新檢查與審查；沒動靜就到面板按 v'
  expect(turnOf(mk({ next: recheck }))).toEqual({ who: 'you', text: manual, action: 'verify', key: 'v' })
  expect(ids(mk({ next: recheck }))).toEqual(['open', 'verify'])
  expect(turnOf(mk({ next: recheck }, { chain: { round: 0, lastKind: 'continue', autoReview: true } }))).toEqual({ who: 'you', text: 'v 執行測試（下一步只剩等測試，通過後流程接著驗收，要改程式先把下一步寫成要做的事）', action: 'verify', key: 'v' })
  // 有實作的下一步照舊
  expect(turnOf(mk({ next: '等檢查；補 AC-3 的測試' }))).toEqual({ who: 'you', text: 'g 派 Agent 做下一步（等檢查；補 AC-3 的測試）', action: 'continue', key: 'g' })
  expect(ids(mk({ next: '等檢查；補 AC-3 的測試' }))).toEqual(['continue', 'open'])
})

/** AC-1、AC-2 */
test('a review next step at the build stage asks for v then w, not g', () => {
  for (const next of ['審查', '派審查：/desk review 更多動作自動收回', '派獨立審查（w）', '按 w 派審查', '重新審查']) {
    // 沒有流程紀錄：v 只記結果，審查要再按 w
    const c = mk({ next })
    const turn = turnOf(c)
    expect(turn).toEqual({ who: 'you', text: 'v 執行測試（下一步是驗收，通過後按 w 派驗收）', action: 'verify', key: 'v' })
    expect(turn.text).not.toContain('g 派 Agent')
    expect(ids(c)).toEqual(['open', 'verify'])
    // 流程會自動接審查（這個對話開的流程、剛做完實作）
    const chained = mk({ next }, { chain: { round: 0, lastKind: 'continue', autoReview: true } })
    expect(turnOf(chained)).toEqual({ who: 'you', text: 'v 執行測試（下一步是驗收，通過後自動驗收）', action: 'verify', key: 'v' })
    expect(ids(chained)).toEqual(['open', 'verify'])
  }
})

test('a review next step after a failed check still lets g fix it', () => {
  // 檢查失敗：「輪到你」叫你按 g 修正，g 就要派得出去，不能被「下一步是審查」擋掉
  for (const next of ['派審查：/desk review 更多動作自動收回', '按 w 派審查', '等審查']) {
    const c = mk({ next }, {}, { ...passed, ok: false, exitCode: 1 })
    expect(turnOf(c)).toEqual({ who: 'you', text: 'g 讓 Agent 修正（測試未通過，也可自己修好後按 v 重跑）', action: 'continue', key: 'g' })
    expect(ids(c)).toContain('continue')
    expect(dispatchable(c)).toContain('continue')
    expect(dispatchRefusal(c, 'continue')).toBe('')
    // 派出去的是修正，不是把等待句或派審查句原樣交出去
    const head = buildPrompt(c, 'continue').split('\n')[0]!
    expect(head).toBe('修正：完成檢查 `npm test` 未通過。先自己跑一次看失敗原因，修到完成檢查綠，commit 後寫回卡片。')
    expect(head).not.toContain('依卡片的下一步繼續')
  }
  // 流程停下（修了兩輪仍有 HIGH）與 Agent 被停掉：一樣派修正或接著做，不引用下一步
  const stopped = mk({ next: '派審查' }, { state: 'failed', chain: { round: 2, lastKind: 'fix', stopped: '修了 2 輪仍有 CRITICAL 0、HIGH 1' } })
  expect(dispatchable(stopped)).toContain('continue')
  expect(buildPrompt(stopped, 'continue').split('\n')[0]).toBe('修正：流程已暫停（修了 2 輪仍有 CRITICAL 0、HIGH 1）。看 .task/REVIEW.md（有的話）與完成檢查 `npm test`，修好 CRITICAL、HIGH 與沒標「不修」「等你決定」的 MEDIUM 並讓完成檢查綠（要改規格才能修的 MEDIUM 不要改：在審查檔那條結尾標「（等你決定）」、在卡片 等你 寫成「審查 MEDIUM n 條（摘要）怎麼處理：A) 不修，記錄原因 B) 另開卡修（推薦，這張先過關） C) 修掉（在這張卡修，多一輪修正） D) 改規格」，其他照修。），每條要修的發現，先把同一類情況全部列出（同一個寫法、同一種輸入、相鄰的路徑），每種都修並補測試，不只修審查舉的例子；列了哪些情況寫進 .task/REPORT.md。commit 後卡片 關卡 改回 無，狀態寫一句修了什麼。')
  const halted = mk({ next: '等審查' }, { state: 'failed', chain: { round: 0, lastKind: 'continue', stopped: AGENT_STOPPED } })
  expect(dispatchable(halted)).toContain('continue')
  expect(buildPrompt(halted, 'continue').split('\n')[0]).toBe('上一個 Agent 被停止，沒做完：先看 git status、git log 與卡片歷程，把那件事做完，commit 後寫回卡片。')
  // 下一步是真的工作：照舊交下一步
  expect(buildPrompt(mk({ next: '補 AC-3 的測試' }, {}, { ...passed, ok: false, exitCode: 1 }), 'continue').split('\n')[0]).toBe('依卡片的下一步繼續：補 AC-3 的測試')
})

test('a blocking review verdict without a chain sends a review fix, not a check fix', () => {
  // 審查不是工作桌派的（沒有流程紀錄）、關卡有 HIGH、檢查是過的：按 g 派的是依審查檔修，不說檢查未通過
  const gate = 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；不過'
  for (const next of ['等完成檢查與審查', '等審查', '派審查']) {
    const c = mk({ next, gate }, {}, passed)
    expect(c.state).toBe('failed')
    expect(dispatchable(c)).toContain('continue')
    const head = buildPrompt(c, 'continue').split('\n')[0]!
    expect(head).toBe('修正：依 .task/REVIEW.md 修正所有 CRITICAL、HIGH，與沒標「不修」「等你決定」的 MEDIUM（LOW 不用修）。每條要修的發現，先把同一類情況全部列出（同一個寫法、同一種輸入、相鄰的路徑），每種都修並補測試，不只修審查舉的例子；列了哪些情況寫進 .task/REPORT.md。要改規格才能修的 MEDIUM 不要改：在審查檔那條結尾標「（等你決定）」、在卡片 等你 寫成「審查 MEDIUM n 條（摘要）怎麼處理：A) 不修，記錄原因 B) 另開卡修（推薦，這張先過關） C) 修掉（在這張卡修，多一輪修正） D) 改規格」，其他照修。修完 commit，卡片 關卡 寫成「review：CRITICAL 0、HIGH 0、MEDIUM <沒修的條數>、LOW <原數>；已依審查修正、未複審（發版時整版審查）」，History 加一筆「Agent：依審查修好 <哪幾條> → 待測試（commit <頂端 commit 前 7 碼>）」，狀態寫一句修了什麼。')
    expect(head).not.toContain('未通過')
  }
})

test('a review next step with a failed PR CI still lets g fix it', () => {
  // PR 開著、CI 失敗：「輪到你」叫你按 g 修正，g 就要派得出去；推送 Agent 寫的「等 CI 與合併」也一樣
  const gate = 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
  const pr = { id: 12, state: 'OPEN', ci: 'fail', url: 'https://github.com/acme/shop/pull/12' } as any
  for (const next of ['派審查', '派獨立審查（w）', '等 CI 與合併']) {
    const c = mk({ next, gate }, { pr }, passed)
    expect(turnOf(c)).toEqual({ who: 'you', text: 'p 開 PR 看 CI 失敗原因（看完按 g 修正）', action: 'pr', key: 'p' })
    expect(ids(c)).toContain('continue')
    expect(dispatchable(c)).toContain('continue')
    expect(dispatchRefusal(c, 'continue')).toBe('')
    expect(buildPrompt(c, 'continue').split('\n')[0]).toBe('修正：PR #12 的 CI 失敗。先看失敗原因（gh pr checks 或平台頁面），修到 CI 會綠，commit 後寫回卡片。')
  }
})

test('at the review stage a review next step refuses g and points to w only', () => {
  const c = mk({ next: '派審查' }, {}, passed)
  expect(c.pipeline?.current).toBe('review')
  expect(dispatchRefusal(c, 'continue')).toBe('下一步是驗收，g 派的是繼續、不會驗收；按 w 派驗收')
})

/** AC-4 */
test('a next step that changes code and only mentions review still says press g', () => {
  for (const next of ['依 .task/REVIEW.md 的意見修正', '修正審查的 HIGH', '等審查通過後修 bug', '派審查（補完 AC-3 的測試後）', '審查（先修 HIGH）', '派審查: /desk review 後修正 HIGH']) {
    const c = mk({ next })
    expect(turnOf(c)).toEqual({ who: 'you', text: `g 派 Agent 做下一步（${next}）`, action: 'continue', key: 'g' })
    expect(ids(c)).toContain('continue')
    expect(dispatchable(c)).toContain('continue')
  }
})

/** AC-5 */
test('turn: merge stage asks to dispatch publish', () => {
  const passedGate = { gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }
  const noPr = mk(passedGate)
  const ahead = mk(passedGate, { pr: { id: 12, state: 'OPEN', ci: 'pass' } as any, gitState: { ahead: 1, behind: 0, changed: 0, untracked: 0, upstream: true } })
  const running = mk(passedGate, { state: 'running', agent: { id: 'x', name: 'desk-1', state: 'working', status: 'busy', kind: 'publish' } })

  expect(noPr.pipeline?.current).toBe('merge')
  // 沒有快捷鍵：按鈕是「⇡ 開 PR」「⇡ push」，句子說按哪一顆、誰去做
  expect(turnOf(noPr)).toEqual({ who: 'you', text: 'n 開 PR（按兩次，派 Agent push 並開 PR）', action: 'open-pr', key: 'n' })
  expect(stageActions(noPr).has('open-pr')).toBe(true)
  expect(turnOf(ahead)).toEqual({ who: 'you', text: 'n 派 Agent push（PR 開著又有新 commit，按兩次，CI 過了再合併）', action: 'push', key: 'n' })
  expect(stageActions(ahead).has('push')).toBe(true)
  // 推送 Agent 在跑：說它在做什麼，六段不退回實作
  expect(running.pipeline?.current).toBe('merge')
  expect(turnOf(running)).toEqual({ who: 'ai', text: 'Agent 在 push、開 PR（l 看輸出）' })
})

/** one-next-step AC-1：合併段之前輪到你的每一句，都寫出做完之後會怎樣。 */
test('each user turn before merging says what happens after it', () => {
  // 檢查段：沒有過期、也沒停下的檢查段（例如流程記錄清掉後）；流程會不會自動接審查決定後半句。
  const atCheck = (chain?: Case['chain']) => { const c = mk({}, chain ? { chain } : {}); return { ...c, state: 'ready', pipeline: { ...c.pipeline!, current: 'check' } } as Case }
  expect(turnOf(atCheck({ round: 0, lastKind: 'continue', autoReview: true }))).toEqual({ who: 'you', text: 'v 執行測試（通過後自動驗收）', action: 'verify', key: 'v' })
  expect(turnOf(atCheck())).toEqual({ who: 'you', text: 'v 執行測試（通過後按 w 派驗收）', action: 'verify', key: 'v' })
  // 審查後有新 commit：流程是這個對話的且已過關才會自動重新審查；別的對話開的、還沒過關的要自己按 w。
  expect(mk({}, { chain: { round: 0, stale: true, passed: true } }).pipeline?.current).toBe('check')
  expect(turnOf(mk({}, { chain: { round: 0, stale: true, passed: true } }))).toEqual({ who: 'you', text: 'v 重新執行測試（驗收後有新 commit，通過後自動重新驗收）', action: 'verify', key: 'v' })
  for (const chain of [{ round: 0, stale: true, passed: true, foreign: true }, { round: 0, stale: true }]) {
    expect(turnOf(mk({}, { chain }))).toEqual({ who: 'you', text: 'v 重新執行測試（驗收後有新 commit，通過後按 w 重新驗收）', action: 'verify', key: 'v' })
  }
  // 審查段：有開著的 PR 過關後合併，沒有就開 PR。
  const openPr = mk({}, { pr: { id: 12, state: 'OPEN', ci: 'pass' } }, passed)
  expect(openPr.pipeline?.current).toBe('review')
  expect(turnOf(openPr)).toEqual({ who: 'you', text: 'w 派驗收（新對話，有 CRITICAL／HIGH 會自動修正、影響行為的 MEDIUM 寫進等你，過關後合併 PR）', action: 'review', key: 'w' })
  expect(turnOf(mk({}, {}, passed))).toEqual({ who: 'you', text: 'w 派驗收（新對話，有 CRITICAL／HIGH 會自動修正、影響行為的 MEDIUM 寫進等你，過關後開 PR）', action: 'review', key: 'w' })
})

/** one-next-step D-04：審查後有新 commit，但流程會自己接手（自動排的重新檢查、修正輪剛做完）：新的一輪還沒過關，也照樣是自動重新審查 */
test('a stale check the chain will pick up by itself says the re-review is automatic', () => {
  const rechecked = { round: 0, stale: true, lastKind: 'continue' as const, autoReview: true }
  const fixed = { round: 1, stale: true, lastKind: 'fix' as const, autoReview: true }
  const stopped = { ...rechecked, stopped: '修了 2 輪仍有 CRITICAL 0、HIGH 1' }

  const auto = [rechecked, fixed].map(chain => turnOf(mk({}, { chain })))

  for (const t of auto) expect(t).toEqual({ who: 'you', text: 'v 重新執行測試（驗收後有新 commit，通過後自動重新驗收）', action: 'verify', key: 'v' })
  expect(turnOf(mk({}, { chain: stopped })).text).not.toContain('自動重新驗收')
  // 這條分支審查過（每張卡只審查一次）：流程接手時通過就過關，不說會重新驗收
  for (const chain of [rechecked, fixed]) expect(turnOf(mk({}, { chain: { ...chain, reviewed: true } })).text).toBe('v 重新執行測試（驗收後有新 commit，通過後自動過關、不重新驗收）')
  expect(turnOf(mk({}, { chain: { ...stopped, reviewed: true } })).text).not.toContain('自動過關')
  const fixing = { round: 1, lastKind: 'fix' as const, autoReview: true, reviewed: true }
  expect(turnOf(mk({ next: '等審查' }, { chain: fixing })).text).toBe('v 執行測試（下一步只剩等測試，通過後流程接著過關、不重新驗收，要改程式先把下一步寫成要做的事）')
  expect(turnOf(mk({ next: '派審查' }, { chain: fixing })).text).toBe('v 執行測試（下一步是驗收，通過後自動過關、不重新驗收）')
})

/** one-next-step AC-2：合併段與上線段也寫出下一步之後是什麼；部署步驟列「全部做完後：」接同一句。 */
test('merge and ship turns say what comes after', async ($, on) => {
  const gate = 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
  const merging = mk({ gate }, { pr: { id: 12, state: 'OPEN', ci: 'pass', url: 'https://github.com/acme/shop/pull/12' }, gitState: { ahead: 0, behind: 0, changed: 0, untracked: 0, upstream: true } })
  expect(merging.pipeline?.current).toBe('merge')
  expect(turnOf(merging)).toEqual({ who: 'you', text: 'p 合併 PR #12（在瀏覽器開啟，合併後打 tag 發版）', action: 'pr', key: 'p' })
  const merged = { pr: { id: 12, state: 'MERGED' as const, ci: 'pass' as const } }
  expect(mk({ gate }, merged).pipeline?.current).toBe('ship')
  expect(turnOf(mk({ gate: 'release：待打 tag' }, merged))).toEqual({ who: 'you', text: 'z 發版（按兩次，再按 Enter 送出，打了 tag 之後部署並按 u 確認上線）', action: 'release', key: 'z' })
  expect(turnOf(mk({ gate }, merged))).toEqual({ who: 'you', text: 'z 發版（按兩次，再按 Enter 送出，打了 tag 之後歸檔）', action: 'release', key: 'z' })
  expect(turnOf(mk({ gate: 'release：v1' }, { ...merged, tag: 'v1' }))).toEqual({ who: 'you', text: 'u 確認上線（部署 v1 後按，確認後歸檔）', action: 'ship', key: 'u' })

  // 面板上的部署步驟列：「全部做完後：」接的是「▶ 輪到你」同一句。
  const { data } = fixture(on)
  data.agents = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', '- 關卡：release：v1') + '\n## 部署步驟（合併後）\n1. php artisan migrate\n'
  data.git['/home/u/wt/beta'] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git', tag: 'v1' }
  data.gh = [{ number: 12, state: 'MERGED', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [] }]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  const shown = flat(text(await ui.drawn()))
  expect(shown).toContain('▶輪到你u確認上線（部署v1後按，確認後歸檔）')
  expect(shown).toContain('1.phpartisanmigrate全部做完後：u確認上線（部署v1後按，確認後歸檔）')
  await ui.unmount()
})

/** exited-agent-asks AC-4：上線段那一句看 tag：沒有 release 關卡、tag 已打就直接說歸檔，不再叫你打 tag。 */
test('ship turn says archive once the tag exists without a release gate', () => {
  const merged = { pr: { id: 12, state: 'MERGED' as const, ci: 'pass' as const } }
  const gate = 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
  // 另有一題「等你」：任務還沒算完成，上線段那一句照 tag 走
  const tagged = mk({ gate, ask: '要順便清 log 嗎？A) 要 B) 不要' }, { ...merged, tag: 'v0.29.0' })
  expect(tagged.state).not.toBe('done')

  expect(shipTurn(tagged)).toEqual({ who: 'you', text: '輸入指令歸檔（v0.29.0 已打，/desk:card archive age-group）' })
  expect(shipTurn(tagged).text).not.toContain('打 tag 發版')
  expect(shipTurn(mk({ gate }, merged))).toEqual({ who: 'you', text: 'z 發版（按兩次，再按 Enter 送出，打了 tag 之後歸檔）', action: 'release', key: 'z' })
  expect(shipTurn(mk({ gate: 'release：待打 tag' }, merged))).toEqual({ who: 'you', text: 'z 發版（按兩次，再按 Enter 送出，打了 tag 之後部署並按 u 確認上線）', action: 'release', key: 'z' })
  expect(shipTurn(mk({ gate: 'release：v0.29.0' }, { ...merged, tag: 'v0.29.0' }))).toEqual({ who: 'you', text: 'u 確認上線（部署 v0.29.0 後按，確認後歸檔）', action: 'ship', key: 'u' })
})

/** review-medium-record AC-3、AC-4：審查過關、MEDIUM 只剩記錄、不修的 → 直接開 PR 或合併；等你有 MEDIUM 那題時照舊要你選。 */
test('turn: a passed review with only recorded MEDIUM goes straight to open PR or merge', () => {
  const gate = 'review：CRITICAL 0、HIGH 0、MEDIUM 2、LOW 1；可合併'
  const noPr = mk({ gate })
  expect(noPr.pipeline?.current).toBe('merge')
  expect(noPr.pipeline?.note).toBe('可開 PR')
  expect(turnOf(noPr)).toEqual({ who: 'you', text: 'n 開 PR（按兩次，派 Agent push 並開 PR）', action: 'open-pr', key: 'n' })
  expect(ids(noPr)).toEqual(['open', 'open-pr'])
  expect(stageActions(noPr).has('fill')).toBe(false)

  const merging = mk({ gate }, { pr: { id: 12, state: 'OPEN', ci: 'pass', url: 'https://github.com/acme/shop/pull/12' }, gitState: { ahead: 0, behind: 0, changed: 0, untracked: 0, upstream: true } })
  expect(turnOf(merging)).toEqual({ who: 'you', text: 'p 合併 PR #12（在瀏覽器開啟，合併後打 tag 發版）', action: 'pr', key: 'p' })

  // 對照組：可能影響行為的 MEDIUM 照舊寫進等你，輪到你是選選項填入
  const asked = mk({ gate, ask: '審查 MEDIUM 2 條（漏處理空清單）怎麼處理：A) 不修，記錄原因 B) 另開卡修（推薦，這張先過關） C) 修掉（在這張卡修，多一輪修正） D) 改規格' })
  expect(turnOf(asked)).toMatchObject({ who: 'you', text: 'f 填入決策（先按選項字母，填入後按 Enter 送出）', key: 'f' })
  expect(stageActions(asked).has('fill')).toBe(true)
})

/** 跟 register 一樣：流程紀錄疊上去之後才算 state（stateOf 要看 chain），再算六段。 */
function mkRun(f: Parameters<typeof card>[0], extra: Partial<Case>, v?: Verify): Case {
  const read = { ...buildCase({ name: 'A', statusPath: '/w/age-group/.desk/CARD.md' }, card(f), 1, {}, v), git: { branch: 'feature/a', head: 'h2' }, ...extra }
  const base = { ...read, state: stateOf(read, v) }
  const piped = { ...base, pipeline: pipeline(base as Case, v) }
  return { ...piped, state: finalState(piped) } as Case
}

/**
 * 審查 HIGH（本卡）：依審查修完照提示寫的關卡「review：CRITICAL 0、HIGH 0、…；已依審查修正、未複審」不是審查結論，
 * 工作桌讀起來跟以前叫 Agent「改回 無」一模一樣：修正輪用完停下、Agent 被停止時照舊未通過、按 g 派修正；沒有判定 HEAD、檢查沒跑時不跳到合併段。
 */
test('a gate written after a review fix reads like none until the chain passes', () => {
  // 修正 Agent 照提示抄的結論：整句、少了括號那段、半形括號、「、」換「，」、中間插字，都只認「未複審」三個字
  const conclusions = [UNREVIEWED_GATE, '已依審查修正、未複審', '已依審查修正、未複審(發版時整版審查)', '已依審查修正，未複審（發版時整版審查）', '已依審查修正 HIGH 2 條、未複審（發版時整版審查）']
  const limit = '整張卡已自動修 2 輪仍未通過測試：開 PR、按 g 再修一輪，或改規格'
  const red = { ...passed, head: 'h2', ok: false, exitCode: 1 }
  const view = (c: Case) => ({ state: c.state, stage: c.pipeline?.current, summary: summary(c), turn: turnOf(c), ids: ids(c), prompt: buildPrompt(c, 'continue').split('\n')[0] })
  const cases: [Partial<Case>, Verify | undefined, string][] = [
    // 修正輪用完停下（測試沒過）：未通過，摘要寫停下原因，按 g 派修正提示
    [{ chain: { round: 2, fixTotal: 2, lastKind: 'fix', stopped: limit, reviewed: true } }, red, 'failed'],
    // 下一個 Agent 被停止
    [{ chain: { round: 1, fixTotal: 1, lastKind: 'fix', stopped: AGENT_STOPPED, reviewed: true } }, undefined, 'failed'],
    // 卡片上的審查結論不是工作桌派的（沒有流程紀錄、沒有判定 HEAD），按 g 修完、測試還沒跑
    [{}, undefined, 'ready'],
    // 同上，測試跑出紅的
    [{}, red, 'failed'],
  ]
  for (const written of conclusions.map(t => `review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；${t}`)) for (const next of ['等自動驗收', '補 AC-3 的測試']) {
    for (const [extra, v, state] of cases) {
      const now = mkRun({ next, gate: written }, extra, v)
      const none = mkRun({ next, gate: '無' }, extra, v)
      // 卡片的關卡照原文保留（主對話看到的卡片內容、面板的關卡列跟卡片檔一樣）
      expect(now.gate).toBe(written)
      expect(now.state).toBe(state)
      expect(now.pipeline?.current).not.toBe('merge')
      expect(summary(now)).not.toBe('驗收通過，可開 PR')
      expect(view(now)).toEqual(view(none))
    }
  }
  // 停下的那兩種：輪到你叫你按 g，派出去的是修正
  const written = `review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；${UNREVIEWED_GATE}`
  const halted = mkRun({ next: '等自動驗收', gate: written }, cases[0]![0], red)
  expect(summary(halted)).toBe(limit)
  expect(turnOf(halted).key).toBe('g')
  expect(dispatchRefusal(halted, 'continue')).toBe('')
  expect(buildPrompt(halted, 'continue').startsWith(`修正：流程已暫停（${limit}）`)).toBe(true)
  // 流程過關、未複審：照流程紀錄走到合併段
  const shipped = mkRun({ gate: written }, { chain: { round: 1, passed: true, unreviewed: true, reviewFix: true } }, { ...passed, head: 'h2' })
  expect(shipped.pipeline?.current).toBe('merge')
  expect(summary(shipped)).toBe('已修正・未重新驗收，可開 PR')
  // 審查寫的結論照舊讀得到（例如高風險複審覆寫成真的結論）
  const real = mkRun({ gate: 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核' }, {})
  expect(parseGate(real.gate)?.kind).toBe('review')
  expect(real.state).not.toBe(mkRun({ gate: '無' }, {}).state)
  // 顯示用：未複審的關卡另外讀得到原文；真的審查結論與其他關卡不算
  expect(unreviewedGate(written)).toEqual({ kind: 'review', detail: `CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；${UNREVIEWED_GATE}` })
  expect(parseGate(written)).toBeNull()
  expect(unreviewedGate(real.gate)).toBeNull()
  expect(unreviewedGate('spec：未複審')).toBeNull()
})
