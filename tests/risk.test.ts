import { expect, test } from 'claude-code/testing'
import { classify } from '../hooks/risk'
import { baseRefs, diffFiles, riskOf } from '../hooks/probes'

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

/** 只回答 git 的假 $（同 merge-sources.test.tsx）：基準相關的探測只會呼叫 git，問了什麼記在 asked。 */
const gitOnly = (answers: Record<string, string>) => {
  const asked: string[] = []
  const $ = { process: { run: async (argv: string[]) => {
    const key = argv.slice(3).join(' ')
    asked.push(key)
    const out = answers[key]
    return out === undefined ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: out, stderr: '' }
  } } }
  return { $, asked }
}
const NEWEST_RELEASE = 'for-each-ref --sort=-committerdate --count=1 --format=%(refname:short) refs/remotes/origin/release/'
const LINES = { [NEWEST_RELEASE]: 'origin/release/v26.3.0\n', 'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n' }

/** card-base-and-fast-path AC-2 */
test('card base field wins over newest release line', async () => {
  const { $, asked } = gitOnly({
    ...LINES,
    'merge-base HEAD origin/release/v26.2.8': 'fork828\n',
    'merge-base HEAD origin/release/v26.3.0': 'fork830\n',
    'diff --name-only fork828..HEAD': 'src/Auth/Fido.php\n',
    'diff --name-only fork830..HEAD': 'src/Auth/Fido.php\ndocs/v26.3.0.md\nsrc/Report/Other.php\n',
  })
  const c = { root: '/w/fido', git: { branch: 'feat/fido', head: 'h1' }, base: 'origin/release/v26.2.8' } as any
  expect(await baseRefs($ as any, c, 'origin/develop')).toEqual(['origin/release/v26.2.8', 'origin/develop', 'origin/main'])
  // 有基準欄就不猜最新的 release 線
  expect(asked).not.toContain(NEWEST_RELEASE)
  expect(await diffFiles($ as any, c)).toEqual({ target: 'origin/release/v26.2.8', files: ['src/Auth/Fido.php'] })
  expect(await riskOf($ as any, c)).toEqual({ level: 'high', reasons: ['認證／中介層'] })
  // PR 目標照舊排第一
  expect((await baseRefs($ as any, { ...c, pr: { id: 1, state: 'OPEN', ci: 'none', dest: 'release/v26.2.9' } }))[0]).toBe('origin/release/v26.2.9')
})

/** card-base-and-fast-path AC-6 */
test('card without base keeps legacy order', async () => {
  const { $ } = gitOnly(LINES)
  const c = { root: '/w/old', git: { branch: 'feat/old', head: 'h2' } } as any
  expect(await baseRefs($ as any, c, 'origin/develop')).toEqual(['origin/release/v26.3.0', 'origin/develop', 'origin/main'])
  expect(await baseRefs($ as any, { ...c, pr: { id: 1, state: 'OPEN', ci: 'none', dest: 'release/v2' } }, 'origin/develop')).toEqual(['origin/release/v2', 'origin/release/v26.3.0', 'origin/develop', 'origin/main'])
})
