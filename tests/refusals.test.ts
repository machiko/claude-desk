import { expect, test } from 'claude-code/testing'
import { buildCase } from '../hooks/model'
import { finalState, pipeline } from '../hooks/pipeline'
import { refusalOf } from '../hooks/dispatch'
import type { DispatchKind, Refusal } from '../hooks/dispatch'
import { shipTurn, stageActions } from '../hooks/turn'
import type { ActionId } from '../hooks/turn'
import type { AgentInfo, Case, Verify } from '../types'

// 派工被拒時，原因之後一定接一句此刻做得到的下一步（refusal-next-step AC-3）。

const ROOT = '/w/age-group'
const TEMPLATE_SPEC = '\n## 規格\n\n### 驗收情境\n\n| # | 給定 | 當 | 則 | 對應測試 |\n| --- | --- | --- | --- | --- |\n| AC-1 | <前提> | <操作> | <看得到的結果> | `<測試名稱>` |\n'
const card = (f: { check?: string; next?: string; gate?: string }, extra = '') =>
  `<!-- DESK -->\n- 狀態：ok\n- 檢查：${f.check ?? '`npm test`'}\n- 等你：無\n- 下一步：${f.next ?? '依規格實作'}\n- 關卡：${f.gate ?? '無'}\n<!-- /DESK -->${extra}`

type Opts = { extra?: Partial<Case>; v?: Verify; agent?: AgentInfo; spec?: string }

/** 跟工作桌一樣：讀卡（含 Agent）→ 疊上 git／PR → 算六段 → 決定狀態。 */
function mk(f: Parameters<typeof card>[0], o: Opts = {}): Case {
  const agents = o.agent ? { [ROOT]: o.agent } : {}
  const base = { ...buildCase({ name: 'A', statusPath: `${ROOT}/.desk/CARD.md` }, card(f, o.spec), 1, agents as any, o.v), git: { branch: 'feature/a', head: 'h1' }, ...o.extra }
  const piped = { ...base, pipeline: pipeline(base as Case, o.v) }
  return { ...piped, state: finalState(piped) } as Case
}

const passed: Verify = { command: 'npm test', at: 1, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h1' }
const BUSY: AgentInfo = { id: 'a1b2c3d4', name: 'desk-1', state: 'working', status: 'busy' }
const ASKS: AgentInfo = { id: 'a1b2c3d4', name: 'desk-1', state: 'blocked', status: 'idle', asks: true }
const PERMISSION: AgentInfo = { id: 'a1b2c3d4', name: 'desk-1', state: 'blocked', status: 'idle', waitsFor: 'permission' }

/** 面板按鍵：動作 → 鍵（對照 pane-card.tsx 的 hotkey；只在這支測試用）。 */
const KEY_OF: Record<ActionId, string> = {
  continue: 'g', review: 'w', sync: 's', reply: 'y', verify: 'v', ship: 'u', 'spec-ok': 't', stop: 'k', unqueue: 'k',
  logs: 'l', 'review-file': 'e', pr: 'p', fill: 'f', 'open-pr': 'n', push: 'n', archive: 'q', release: 'z', open: 'o', tutorial: 't',
}
/** 全域鍵：開卡片、更多、展開、說明、重新整理。 */
const GLOBAL_KEYS = ['o', 'm', 'x', 'i', 'r']
const FOLLOW_TURN = '照「輪到你」做'

/** 下一步裡提到的鍵：「按 X」與「（X）」。 */
const keysIn = (next: string): string[] => [...next.matchAll(/按\s*([a-z])(?![a-z])|（([a-z])）/g)].map(m => (m[1] ?? m[2])!)

/** 派工被拒的 19 種，每種一件停在它典型階段的任務。 */
const CASES: [string, Case, DispatchKind][] = [
  ['登錄表設為 manual', mk({}, { extra: { manual: true } }), 'continue'],
  ['Agent 處理中', mk({}, { agent: BUSY }), 'continue'],
  ['已合併還沒上線', mk({}, { extra: { pr: { id: 12, state: 'MERGED', ci: 'none' } } }), 'continue'],
  ['不在合併段卻要推送', mk({}), 'publish'],
  ['規格沒有驗收情境', mk({}, { spec: TEMPLATE_SPEC }), 'continue'],
  ['規格還沒確認', mk({ gate: 'spec：待確認規格' }), 'continue'],
  ['沒有測試指令', mk({ check: '無' }), 'continue'],
  // 驗收後有新 commit：六段退回測試段
  ['下一步是驗收（測試段）', mk({ next: '派審查' }, { extra: { chain: { round: 0, stale: true } as Case['chain'] } }), 'continue'],
  ['下一步是驗收（驗收段）', mk({ next: '派審查' }, { v: passed }), 'continue'],
  ['下一步只剩等待', mk({ next: '等審查' }), 'continue'],
  ['下一步空白', mk({ next: '' }), 'continue'],
  ['卡片閒置', mk({ next: '無' }), 'continue'],
  ['Agent 停著在等你回覆', mk({}, { agent: ASKS }), 'continue'],
  ['Agent 在等權限批准', mk({}, { agent: PERMISSION }), 'continue'],
  ['已上線', mk({ next: '可歸檔' }, { extra: { tag: 'v0.2.0' } }), 'continue'],
  ['驗收任務卡按 g', mk({ next: '.task/review-a.md 依這份驗收' }), 'continue'],
  ['發版線按 w', mk({}, { extra: { git: { branch: 'release/v1.4', head: 'h1' } } }), 'review'],
  ['Agent 沒有在等你卻按回覆', mk({}), 'reply'],
  ['其他（手動派解衝突）', mk({}), 'catchup'],
]

/** 被拒、有原因與下一步，下一步提到的鍵此刻面板都列著；沒提鍵就要是指令或照「輪到你」做。回傳拒絕。 */
function expectOfferedNext(label: string, c: Case, kind: DispatchKind): Refusal {
  const r = refusalOf(c, kind)
  expect([label, r === null]).toEqual([label, false])
  expect([label, r!.why.length > 0, (r!.next ?? '').length > 0]).toEqual([label, true, true])
  const next = r!.next!
  const offered = new Set([...[...stageActions(c)].map(id => KEY_OF[id]), ...GLOBAL_KEYS])
  const keys = keysIn(next)
  for (const k of keys) expect([label, k, offered.has(k)]).toEqual([label, k, true])
  if (keys.length === 0) {
    const ok = next.includes('/desk') || next.includes('claude ') || next === FOLLOW_TURN || next === shipTurn(c).text
    expect([label, next, ok]).toEqual([label, next, true])
  }
  return r!
}

/** AC-3 */
test('every dispatch refusal has a next step the panel offers', () => {
  expect(CASES).toHaveLength(19)
  const whys = new Set<string>()
  for (const [label, c, kind] of CASES) whys.add(expectOfferedNext(label, c, kind).why)
  // 每一種都有自己的原因，沒有被併成同一句通稱
  expect(whys.size).toBe(CASES.length - 1)
})

/** AC-3：典型階段要真的是那一段，不然上面的鍵是在別的階段比對的。 */
test('refusal cases sit at their typical stage', () => {
  const at = (label: string) => CASES.find(([l]) => l === label)![1]
  expect(at('已合併還沒上線').pipeline?.current).toBe('ship')
  expect(at('規格沒有驗收情境').pipeline?.current).toBe('spec')
  expect(at('規格還沒確認').pipeline?.current).toBe('spec')
  expect(at('下一步是驗收（測試段）').pipeline?.current).toBe('check')
  expect(at('下一步是驗收（驗收段）').pipeline?.current).toBe('review')
  expect(at('Agent 處理中').state).toBe('running')
  expect(at('Agent 停著在等你回覆').state).toBe('reply')
  expect(at('Agent 在等權限批准').state).toBe('approve')
  expect(at('已上線').state).toBe('done')
  expect(at('卡片閒置').state).toBe('idle')
})

/** AC-3：下一步只剩等待的卡停在各段、或卡片狀態先擋下時，被拒的下一步只叫你按那一刻列著的鍵。 */
test('waiting next steps are refused with keys the stage lists', () => {
  const waitingAtReview = mk({ next: '等審查' }, { v: passed })
  const openPrAtMerge = mk({ next: '開 PR' }, { extra: { chain: { round: 0, passed: true } as Case['chain'] } })
  const approveWaiting = mk({ next: '等審查' }, { agent: PERMISSION })
  const replyWaiting = mk({ next: '等審查' }, { agent: ASKS })
  expect(waitingAtReview.pipeline?.current).toBe('review')
  expect(openPrAtMerge.pipeline?.current).toBe('merge')
  expect(approveWaiting.state).toBe('approve')
  expect(replyWaiting.state).toBe('reply')

  expect(expectOfferedNext('驗收段等審查', waitingAtReview, 'continue')).toEqual({ why: '下一步只剩等待，沒有要 Agent 做的事', next: FOLLOW_TURN })
  expect(expectOfferedNext('合併段開 PR', openPrAtMerge, 'continue')).toEqual({ why: '下一步只剩等待，沒有要 Agent 做的事', next: FOLLOW_TURN })
  // 卡片狀態先講：等批准、等回覆時下一步寫什麼都不是該按的鍵
  expect(expectOfferedNext('等批准', approveWaiting, 'continue').next).toBe('到終端機跑 claude agents 批准它')
  expect(expectOfferedNext('等回覆', replyWaiting, 'continue')).toEqual({ why: 'Agent 停著在等你回覆', next: '按 y 回覆它' })
})

/** AC-3：發版線上線後不歸檔，被拒時不叫你輸入歸檔指令。 */
test('a shipped release line is not told to archive', () => {
  const shipped = mk({ next: '等下一版' }, { extra: { git: { branch: 'release/v1.4', head: 'h1' }, tag: 'v1.4.0' } })
  expect(shipped.state).toBe('done')
  expect(expectOfferedNext('發版線已上線', shipped, 'continue')).toEqual({ why: '已上線', next: FOLLOW_TURN })
})
