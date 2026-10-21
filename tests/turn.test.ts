import { expect, test } from 'claude-code/testing'
import { buildCase } from '../hooks/model'
import { finalState, pipeline } from '../hooks/pipeline'
import { stageActions, turnOf } from '../hooks/turn'
import type { Case, Verify } from '../types'

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
  expect(turnOf(mk({ check: '無' }))).toEqual({ who: 'you', text: '輸入 /desk:card spec age-group 寫規格與完成檢查' })
  expect(turnOf(mk({ gate: 'spec：待確認規格' }))).toEqual({ who: 'you', text: '看過規格（o 開卡片）後按 t 確認（或輸入 /desk:card spec age-group ok）', key: 't' })
  expect(turnOf(mk({}))).toEqual({ who: 'you', text: '按 g 派 Agent：依規格實作', key: 'g' })
  expect(turnOf(mk({ ask: '要 push 嗎？A) 要 B) 等' }))).toMatchObject({ who: 'you', key: 'f' })
  expect(turnOf(mk({}), { verifying: true }).who).toBe('ai')
  expect(turnOf(mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }))).toEqual({ who: 'you', text: 'push 分支並開 PR' })
  expect(turnOf(mk({ gate: 'release：v0.2.0' }, { tag: 'v0.2.0' }))).toEqual({ who: 'you', text: '部署 v0.2.0 後按 u 確認上線', key: 'u' })
  expect(turnOf(mk({ next: '可歸檔' }, { tag: 'v0.2.0' }))).toEqual({ who: 'you', text: '輸入 /desk:card archive age-group 歸檔' })
  expect(turnOf(mk({}, { state: 'running', agent: { id: 'x', name: 'desk-1', state: 'working', status: 'busy' } })).who).toBe('ai')
})

test('only the actions that make sense now are listed: passed stages drop their keys', () => {
  // 規格段：只能開卡片、同步
  expect(ids(mk({ check: '無' }))).toEqual(['open', 'sync'])
  // 實作段：繼續；還沒有檢查與審查
  expect(ids(mk({}))).toEqual(['continue', 'open', 'sync'])
  // 審查過了（有結論、零擋）、還沒有 PR：沒有 v、沒有 w，多了開 PR（只預填輸入框）
  expect(ids(mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；過' }), {})).toEqual(['open', 'open-pr', 'sync'])
  // 上線段：上線確認；合併過了不再同步
  expect(ids(mk({ gate: 'release：v0.2.0' }, { tag: 'v0.2.0' }))).toEqual(['open', 'ship'])
  // 完成：開卡片與歸檔
  expect(ids(mk({ next: '可歸檔' }, { tag: 'v0.2.0' }))).toEqual(['archive', 'open'])
  // 執行中：停止與輸出，不能再派
  expect(ids(mk({}, { state: 'running', agent: { id: 'x', name: 'desk-1', state: 'working', status: 'busy' } }))).toEqual(['logs', 'open', 'stop'])
  // 檢查未通過：可以讓 Agent 修，也可以重跑
  expect(ids(mk({}, {}, { ...passed, ok: false, exitCode: 1 }))).toEqual(['continue', 'open', 'sync', 'verify'])
})

test('processing lines say who is doing what, without repeating that it is in progress', () => {
  const running = (kind?: any) => mk({}, { state: 'running', agent: { id: 'x', name: 'desk-1', state: 'working', status: 'busy', ...(kind ? { kind } : {}) }, ...(kind ? { chain: { round: 0, lastKind: kind } } : {}) })
  expect(turnOf(running()).text).toBe('Agent 在寫程式（l 看輸出）')
  expect(turnOf(running('fix')).text).toBe('Agent 在修正（l 看輸出）')
  expect(turnOf(running('sync')).text).toBe('Agent 在同步卡片（l 看輸出）')
  expect(turnOf(running('review')).text).toBe('Agent 在審查 diff（新對話）')
  expect(turnOf(mk({}), { verifying: true }).text).toBe('完成檢查在跑')
  expect(turnOf(mk({}), { queued: true }).text).toBe('完成檢查排隊中')
  expect(turnOf(mk({}), { launching: true }).text).toBe('派工中，等 Agent 啟動')
  expect(turnOf(mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }, { pr: { id: 1, state: 'OPEN', ci: 'pending' } })).text).toBe('PR 的 CI 在跑')
  expect(turnOf(mk({ gate: 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；要修' }, { chain: { round: 1 }, state: 'ready' }, passed)).text).toBe('審查有結論，接著自動修正或過關')
  // 沒有任何一句還留著舊的「執行者」或「不用做事」
  for (const c of [running(), running('review')]) expect(turnOf(c).text).not.toMatch(/執行者|不用做事/)
})

test('idle next: the now card asks for v instead of g', () => {
  const c = mk({ next: '等自動檢查與審查；過了開 PR' })
  expect(turnOf(c)).toEqual({ who: 'you', text: '下一步只剩等檢查／審查：按 v 執行完成檢查，流程接著審查；要改程式先把下一步寫成要做的事', key: 'v' })
  expect(ids(c)).toEqual(['open', 'sync', 'verify'])
  // 有實作的下一步照舊
  expect(turnOf(mk({ next: '等檢查；補 AC-3 的測試' }))).toEqual({ who: 'you', text: '按 g 派 Agent：等檢查；補 AC-3 的測試', key: 'g' })
  expect(ids(mk({ next: '等檢查；補 AC-3 的測試' }))).toEqual(['continue', 'open', 'sync'])
})
