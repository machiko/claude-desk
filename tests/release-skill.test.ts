import { expect, test } from 'claude-code/testing'
import SAMPLE from './release-sample.mjs'
import { parseDecisions } from '../hooks/card'

/**
 * AC-4：skills/release/SKILL.md 的確認題範本填上樣本後，面板只看到一題、選項恰好 A、B、C（「PR #13）」不是選項）。
 * 測試環境不能讀 .md 檔：範本照樣本填出來等於 SAMPLE.question、規則字句都在 SKILL.md，由 skills/card/tests/test_release_skill.py 的同名測試斷言。
 */
test('test_release_skill_keeps_every_rule_and_parses_as_one_abc_question', () => {
  const question: string = SAMPLE.question
  expect(question).toContain('PR #13）')
  expect(question).not.toContain('；')
  const decisions = parseDecisions(question)
  expect(decisions).toHaveLength(1)
  expect(decisions[0]!.title).toBe(question.slice(0, question.indexOf('：A) ')))
  expect(decisions[0]!.options).toEqual([
    { key: 'A', text: '照做 v0.38.0（推薦）' },
    { key: 'B', text: '改用 v0.37.1 照做' },
    { key: 'C', text: '先不發' },
  ])
})
