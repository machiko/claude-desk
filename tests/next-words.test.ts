import { expect, test } from 'claude-code/testing'
import { buildCase } from '../hooks/model'
import { finalState, pipeline } from '../hooks/pipeline'
import { refusalOf, refusalText } from '../hooks/dispatch'
import { IDLE_WHY, REVIEW_WHY, idleNext, reviewNext } from '../hooks/next-words'
import type { Case } from '../types'

// blocked-reply-loop AC-4：下一步寫「等自動驗收」「…，通過後按 w 派驗收」時，按 g 不派 Agent。

const ROOT = '/w/beta'
const card = (next: string) =>
  `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：${next}\n- 關卡：無\n<!-- /DESK -->`

/** 跟工作桌一樣：讀卡 → 疊上 git → 算六段 → 決定狀態；沒有 Agent、沒有測試結果，停在實作段。 */
function atImplement(next: string): Case {
  const base = { ...buildCase({ name: 'Beta', statusPath: `${ROOT}/.desk/CARD.md` }, card(next), 1, {}, undefined), git: { branch: 'feature/b', head: 'h1' } }
  const piped = { ...base, pipeline: pipeline(base as Case, undefined) }
  return { ...piped, state: finalState(piped) } as Case
}

const AUTO_REVIEW = '等自動驗收；沒動靜就到面板按 v'
const PASS_THEN_W = '到面板按 v 執行測試，通過後按 w 派驗收'
const REAL_WORK = '修正 X，等審查'

test('test_idle_next_recognizes_auto_review_and_pass_then_w', () => {
  // 下一步的寫法判斷
  expect(idleNext(AUTO_REVIEW)).toBe(IDLE_WHY)
  expect(reviewNext(AUTO_REVIEW)).toBe(false)
  expect(idleNext(PASS_THEN_W)).toBe(REVIEW_WHY)
  expect(reviewNext(PASS_THEN_W)).toBe(true)
  expect(idleNext(REAL_WORK)).toBe('')
  expect(reviewNext(REAL_WORK)).toBe(false)

  // 實作段的卡按兩次 g：前兩種被拒、跳拒絕句，第三種照常派出
  const auto = atImplement(AUTO_REVIEW)
  const passThenW = atImplement(PASS_THEN_W)
  const work = atImplement(REAL_WORK)
  for (const c of [auto, passThenW, work]) expect(c.pipeline?.current).toBe('build')

  const autoRefusal = refusalOf(auto, 'continue')
  expect(autoRefusal?.why).toBe(IDLE_WHY)
  expect(refusalText('Beta', '繼續', autoRefusal!)).toContain('下一步只剩等待')

  const wRefusal = refusalOf(passThenW, 'continue')
  expect(wRefusal?.why).toBe(REVIEW_WHY)
  expect(refusalText('Beta', '繼續', wRefusal!)).toContain('下一步是驗收')

  expect(refusalOf(work, 'continue')).toBeNull()
})
