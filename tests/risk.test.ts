import { expect, test } from 'claude-code/testing'
import { classify } from '../hooks/risk'

test('docs only is low; sensitive paths are high with reasons; anything else normal', () => {
  expect(classify(['CHANGELOG.md', 'docs/PLAN_X.md'])).toEqual({ level: 'low', reasons: ['只動文件'] })
  expect(classify(['app/Http/Middleware/Admin.php', 'CHANGELOG.md']).level).toBe('high')
  expect(classify(['database/migrations/2026_10_17_x.php', 'bitbucket-pipelines.yml']).reasons).toEqual(['migration', 'CI'])
  expect(classify(['db/migration/V2__orders.sql', '.github/workflows/ci.yml']).reasons).toEqual(['migration', 'CI'])
  expect(classify(['src/Auth/Login.ts']).reasons).toEqual(['認證／中介層'])
  expect(classify(['composer.lock']).reasons).toEqual(['相依套件'])
  expect(classify(['pnpm-lock.yaml']).reasons).toEqual(['相依套件'])
  expect(classify(['docker/php/Dockerfile.prod']).reasons).toEqual(['容器'])
  expect(classify(['compose.yaml']).reasons).toEqual(['容器'])
  expect(classify(['.env.example']).reasons).toEqual(['環境設定'])
  expect(classify(['app/Http/Controllers/OrderController.php', 'tests/Feature/X.php'])).toEqual({ level: 'normal', reasons: [] })
  expect(classify([])).toEqual({ level: 'normal', reasons: [] })
})

test('project paths from settings come first and add their own reasons', () => {
  const extra: [RegExp, string][] = [[/(^|\/)Billing\//, '金流'], [/(^|\/)[^/]*Export[^/]*\.php$/, '報表與匯出']]
  expect(classify(['app/Billing/Refund.php'], extra)).toEqual({ level: 'high', reasons: ['金流'] })
  expect(classify(['app/Exports/OrderExport.php', 'composer.lock'], extra).reasons).toEqual(['報表與匯出', '相依套件'])
  expect(classify(['app/Billing/Refund.php']).level).toBe('normal')
})
