import { expect, test } from 'claude-code/testing'
import { buildCase } from '../hooks/model'
import { finalState, pipeline } from '../hooks/pipeline'
import { stageActions, turnOf } from '../hooks/turn'
import type { Case, Verify } from '../types'

const card = (f: { check?: string; ask?: string; next?: string; gate?: string }) =>
  `<!-- DESK -->\n- 狀態：ok\n- 檢查：${f.check ?? '`npm test`'}\n- 等你：${f.ask ?? '無'}\n- 下一步：${f.next ?? '依規格實作'}\n- 關卡：${f.gate ?? '無'}\n<!-- /DESK -->`

/** 跟工作桌一樣：讀卡 → 疊上 git／PR／接力 → 算六段 → 決定是否完成。 */
function mk(f: Parameters<typeof card>[0], extra: Partial<Case> = {}, v?: Verify): Case {
  const base = { ...buildCase({ name: 'A', statusPath: '/w/age-group/.desk/CARD.md' }, card(f), 1, {}, v), git: { branch: 'feature/a', head: 'h1' }, ...extra }
  const piped = { ...base, pipeline: pipeline(base as Case, v) }
  return { ...piped, state: finalState(piped) } as Case
}
const passed: Verify = { command: '`npm test`'.slice(1, -1), at: 1, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h1' }
const ids = (c: Case, ctx = {}) => [...stageActions(c, ctx)].sort()

test('each stage says whose turn it is and what to press, in plain words', () => {
  expect(turnOf(mk({ check: '無' }))).toEqual({ who: 'you', text: '輸入 /desk:card spec age-group 寫規格與完成檢查' })
  expect(turnOf(mk({ gate: 'spec：待確認規格' })).text).toBe('看過規格後輸入 /desk:card spec age-group ok')
  expect(turnOf(mk({}))).toEqual({ who: 'you', text: '按 g 派執行者：依規格實作', key: 'g' })
  expect(turnOf(mk({ ask: '要 push 嗎？A) 要 B) 等' }))).toMatchObject({ who: 'you', key: 'f' })
  expect(turnOf(mk({}), { verifying: true }).who).toBe('ai')
  expect(turnOf(mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }))).toEqual({ who: 'you', text: 'push 分支並開 PR 到 release 線' })
  expect(turnOf(mk({ gate: 'release：v0.2.0' }, { tag: 'v0.2.0' }))).toEqual({ who: 'you', text: '部署 v0.2.0 後按 u 確認上線', key: 'u' })
  expect(turnOf(mk({ next: '可歸檔' }, { tag: 'v0.2.0' }))).toEqual({ who: 'you', text: '輸入 /desk:card archive age-group 歸檔' })
  expect(turnOf(mk({}, { state: 'running', agent: { id: 'x', name: 'desk-1', state: 'working', status: 'busy' } })).who).toBe('ai')
})

test('only the actions that make sense now are listed: passed stages drop their keys', () => {
  // 規格段：只能開卡片、同步
  expect(ids(mk({ check: '無' }))).toEqual(['open', 'sync'])
  // 實作段：繼續；還沒有檢查與審查
  expect(ids(mk({}))).toEqual(['continue', 'open', 'sync'])
  // 審查過了（有結論、零擋）：沒有 v、沒有 w，只剩開卡片與同步
  expect(ids(mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；過' }), {})).toEqual(['open', 'sync'])
  // 上線段：上線確認
  expect(ids(mk({ gate: 'release：v0.2.0' }, { tag: 'v0.2.0' }))).toEqual(['open', 'ship', 'sync'])
  // 完成：只剩開卡片
  expect(ids(mk({ next: '可歸檔' }, { tag: 'v0.2.0' }))).toEqual(['open'])
  // 執行中：停止與輸出，不能再派
  expect(ids(mk({}, { state: 'running', agent: { id: 'x', name: 'desk-1', state: 'working', status: 'busy' } }))).toEqual(['logs', 'open', 'stop'])
  // 檢查未通過：可以讓執行者修，也可以重跑
  expect(ids(mk({}, {}, { ...passed, ok: false, exitCode: 1 }))).toEqual(['continue', 'open', 'sync', 'verify'])
})
