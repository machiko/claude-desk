import { expect, test } from 'claude-code/testing'
import * as dispatch from '../hooks/dispatch'
import * as rules from '../hooks/prompts/rules'
import * as publish from '../hooks/prompts/publish'
import * as review from '../hooks/prompts/review'
import * as fix from '../hooks/prompts/fix'

// 提示詞搬到 hooks/prompts/ 之後，呼叫端照舊從 hooks/dispatch 匯入，拿到的是同一個值。
test('prompt files: dispatch re-exports moved names unchanged', () => {
  expect(dispatch.PUSH_RULE).toBe(rules.PUSH_RULE)
  expect(dispatch.NO_PUSH_RULE).toBe(rules.NO_PUSH_RULE)
  expect(dispatch.openPrRequest).toBe(publish.openPrRequest)
  expect(dispatch.pushRequest).toBe(publish.pushRequest)
  expect(dispatch.REVIEW_FILE).toBe(review.REVIEW_FILE)
  expect(dispatch.SECURITY_FILE).toBe(review.SECURITY_FILE)
  expect(dispatch.reviewTask).toBe(review.reviewTask)
  // 留在 dispatch.ts 的組裝與判斷照樣匯得到。
  for (const f of [dispatch.buildPrompt, dispatch.ciFailed, dispatch.fixByG]) expect(typeof f).toBe('function')
  expect(typeof fix.manualFixHead).toBe('function')
})
