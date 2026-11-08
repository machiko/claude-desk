import { expect, test } from 'claude-code/testing'
import * as dispatch from '../hooks/dispatch'
import * as rules from '../hooks/prompts/rules'
import * as publish from '../hooks/prompts/publish'
import * as review from '../hooks/prompts/review'
import * as fix from '../hooks/prompts/fix'
import { buildCase } from '../hooks/model'
import { fixture, CARD_B, PROJECT_DIR } from './fixture'

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

const BETA = '/home/u/wt/beta'
const lastPrompt = (data: any) => { const argv = data.launches[data.launches.length - 1].argv; return String(argv[argv.length - 1]) }

/** 按 w 派 Beta 的程式碼審查：工作桌的完成檢查在 verifiedAt（沒給＝沒跑過）通過，分支 HEAD 在 head。 */
async function reviewBeta($: any, on: any, opts: { head: string; verifiedAt?: string; command?: string; settings?: object; files?: string[] }) {
  const { data, clock } = fixture(on)
  data.agents = []
  if (opts.settings) data.files[`${PROJECT_DIR}/dispatch.json`] = JSON.stringify(opts.settings)
  data.git[BETA] = { branch: 'feature/b', head: opts.head, releases: '', originHead: 'origin/main', files: opts.files ?? ['src/a.ts'] }
  if (opts.verifiedAt) data.store.verifies = { [CARD_B]: { command: opts.command ?? 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: opts.verifiedAt } }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'review Beta' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  return lastPrompt(data)
}

/** card-base-and-fast-path AC-3 */
test('review skips full check when verified at same head', async ($, on) => {
  const p = await reviewBeta($, on, { head: 'c7', verifiedAt: 'c7' })
  expect(p).toContain('完成檢查 `npm test` 已在 HEAD c7 通過（工作桌跑的）：HEAD 沒變就不重跑整套，只跑跟改動有關的測試')
  expect(p).not.toContain('自己重跑完成檢查 `npm test`。')
})

/** card-base-and-fast-path AC-3：HEAD 已移動，照舊要審查自己重跑。 */
test('review reruns check when head moved', async ($, on) => {
  const p = await reviewBeta($, on, { head: 'c8', verifiedAt: 'c7' })
  expect(p).toContain('自己重跑完成檢查 `npm test`。')
  expect(p).not.toContain('已在 HEAD')
})

/** card-base-and-fast-path AC-3：沒有工作桌的通過紀錄，照舊自己重跑。 */
test('review reruns check when desk never ran it', async ($, on) => {
  expect(await reviewBeta($, on, { head: 'c8' })).toContain('自己重跑完成檢查 `npm test`。')
})

/** card-base-and-fast-path AC-3：通過的是別的指令（卡片的檢查改過），照舊自己重跑。 */
test('review reruns check when the passed command is not the card check', async ($, on) => {
  const p = await reviewBeta($, on, { head: 'c8', verifiedAt: 'c8', command: 'npm run old' })
  expect(p).toContain('自己重跑完成檢查 `npm test`。')
  expect(p).not.toContain('已在 HEAD')
})

const PREFLIGHT = { review: { preflight: 'agy-review --base {base}', preflightMinFiles: 6 } }
const FOUR = ['a.ts', 'b.ts', 'c.ts', 'd.ts']

/** card-base-and-fast-path AC-4：設了門檻 6，diff 只有 4 檔不帶前審。 */
test('review preflight skipped below min files', async ($, on) => {
  expect(await reviewBeta($, on, { head: 'c1', settings: PREFLIGHT, files: FOUR })).not.toContain('審查前置')
})

/** card-base-and-fast-path AC-4：diff 達到門檻（6 檔）照舊帶前審。 */
test('review preflight kept at min files', async ($, on) => {
  expect(await reviewBeta($, on, { head: 'c2', settings: PREFLIGHT, files: [...FOUR, 'e.ts', 'f.ts'] })).toContain('審查前置：先執行 `agy-review --base origin/main`')
})

/** card-base-and-fast-path AC-7：沒設門檻，4 檔也帶前審。 */
test('review preflight kept for small diffs without min files', async ($, on) => {
  expect(await reviewBeta($, on, { head: 'c3', settings: { review: { preflight: 'agy-review --base {base}' } }, files: FOUR })).toContain('審查前置')
})

/** card-base-and-fast-path AC-4：設了門檻時，修正後的複審與重新審查一律不帶前審（檔數再多也一樣）；沒設門檻照舊帶（AC-7）。 */
test('review preflight skipped on recheck', () => {
  const c = buildCase({ name: 'A', statusPath: '/w/x/.desk/CARD.md' }, '<!-- DESK -->\n- 狀態：x\n- 檢查：`true`\n- 等你：無\n- 下一步：寫測試\n- 關卡：無\n<!-- /DESK -->', 1, {}, undefined)
  const gated = dispatch.parseSettings(JSON.stringify(PREFLIGHT))
  const always = dispatch.parseSettings(JSON.stringify({ review: { preflight: 'agy-review --base {base}' } }))
  const rereview = { round: 1, base: 'abc123', files: 40, pitfalls: '' }
  const recheck = { round: 0, base: 'abc123', recheck: true, files: 40, pitfalls: '' }
  for (const r of [rereview, recheck]) {
    expect(dispatch.buildPrompt(c, 'review', '', undefined, r, gated)).not.toContain('審查前置')
    expect(dispatch.buildPrompt(c, 'review', '', undefined, r, always)).toContain('審查前置：先執行 `agy-review --base abc123`')
  }
})

const FOCUS = '這是高風險分支，這次審查同時做資安審查（過關後不另派）'

/** card-base-and-fast-path AC-5：設了 combineSecurity、分支動到 Auth/（高風險）：第一次程式碼審查就帶資安重點清單。 */
test('code review includes security focus when combined', async ($, on) => {
  const p = await reviewBeta($, on, { head: 'c1', settings: { review: { combineSecurity: true, security: '金流與退款' } }, files: ['src/Auth/Fido.php'] })
  expect(p).toContain(`${FOCUS}：另外逐項看 金流與退款`)
  expect(p.startsWith('程式碼審查：')).toBe(true)
})

/** card-base-and-fast-path AC-7：沒設 combineSecurity，高風險的程式碼審查照舊不帶資安重點（過關後另派資安審查）。 */
test('code review has no security focus when not combined', async ($, on) => {
  expect(await reviewBeta($, on, { head: 'c2', files: ['src/Auth/Fido.php'] })).not.toContain(FOCUS)
})

/** card-base-and-fast-path AC-5：設了 combineSecurity，但不是高風險：不帶。 */
test('code review has no security focus on a normal-risk branch', async ($, on) => {
  expect(await reviewBeta($, on, { head: 'c3', settings: { review: { combineSecurity: true } }, files: ['src/a.ts'] })).not.toContain(FOCUS)
})
