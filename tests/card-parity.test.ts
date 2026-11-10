import { expect, test } from 'claude-code/testing'
import { isPlaceholder, parseCard } from '../hooks/card'
import { deploySteps } from '../hooks/extras'
import { cardFormat } from '../hooks/formats'
import CARD_CASES from './card-cases.mjs'

type CardCase = {
  name: string
  card: string
  fields: Record<string, string> | null
  placeholder: Record<string, boolean>
  deploySteps: string[]
  format?: number
}

// card-parity AC-3：skills/card/tests/test_card.py 的 test_card_fields_match_shared_cases 拿同一份範例斷言 card.py。
test('card fields match shared cases', () => {
  const cases = CARD_CASES as CardCase[]
  expect(cases.length > 0).toBe(true)
  for (const c of cases) {
    const fields = parseCard(c.card)
    expect({ name: c.name, fields }).toEqual({ name: c.name, fields: c.fields })
    const placeholder = Object.fromEntries(Object.keys(c.placeholder).map(k => [k, isPlaceholder(fields?.[k] ?? '')]))
    expect({ name: c.name, placeholder }).toEqual({ name: c.name, placeholder: c.placeholder })
    expect({ name: c.name, steps: deploySteps(c.card) }).toEqual({ name: c.name, steps: c.deploySteps })
    // 格式版號（格式版本標記 AC-1、AC-7）：沒寫 format 的範例沒有標記，當格式 1
    expect({ name: c.name, format: cardFormat(c.card) }).toEqual({ name: c.name, format: c.format ?? 1 })
  }
})
