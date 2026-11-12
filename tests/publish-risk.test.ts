import { expect, test } from 'claude-code/testing'
import { buildPrompt, openPrRequest, pushRequest } from '../hooks/dispatch'
import { buildCase } from '../hooks/model'
import { pipeline } from '../hooks/pipeline'
import type { Case, Verify } from '../types'

// 審查測試反模式與 PR 合併風險：推送 Agent 自己寫 PR 說明時（GitHub 內文、Bitbucket description），加「合併風險」段，
// 看 PR 的人一眼知道合併後能不能直接退回（單向門／雙向門）、會影響到哪裡；不由 Agent 寫 PR 說明的情況不加。

/** 停在合併段：審查過關、沒有 MEDIUM（合併風險段不看有沒有 MEDIUM）。 */
function passedReview(): Case {
  const text = '<!-- DESK -->\n- 狀態：ok\n- 檢查：`npm test`\n- 等你：無\n- 下一步：可開 PR：push 後開 PR\n- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；可合併\n<!-- /DESK -->'
  const v: Verify = { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h' }
  const c: Case = { ...buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, text, 1, {}, v), git: { branch: 'feature/a', head: 'h' } }
  return { ...c, pipeline: pipeline(c, v) }
}

const HISTORY = '，歷程記一筆「Agent：push 並開 PR → 等 CI（PR #<編號>）」'

/** 合併風險段要講的三件事：單向門（附例子）、雙向門、影響範圍。 */
function expectRiskParts(p: string) {
  expect(p).toContain('單向門（合併後很難直接退回，例如資料遷移、對外格式、刪除）')
  expect(p).toContain('還是雙向門')
  expect(p).toContain('影響範圍（哪些使用者或流程會受影響）')
}

/** AC-1：GitHub 開 PR 的推送提示要求在 PR 內文加「合併風險」段，寫明單向門或雙向門與影響範圍。 */
test('test_publish_prompt_asks_merge_risk_in_github_pr_body', () => {
  const p = buildPrompt(passedReview(), 'publish', openPrRequest('feature/a', 'origin/main', { host: 'github', repo: 'acme/shop' }))

  expect(p).toContain('`gh pr create --base main --head feature/a`')
  // 寫在 PR 內文，接在記歷程之前
  expect(p).toMatch(/內文加「合併風險」段：[^，]*單向門[^\n]*影響範圍[^\n]*，歷程記一筆/)
  expectRiskParts(p)
  expect(p).toContain(`照 diff 自己判斷${HISTORY}`)
})

/** AC-2：Bitbucket 開 PR 的推送提示要求在 PR description 加同樣的「合併風險」段。 */
test('test_publish_prompt_asks_merge_risk_in_bitbucket_pr_description', () => {
  const p = buildPrompt(passedReview(), 'publish', openPrRequest('feature/a', 'origin/main', { host: 'bitbucket', repo: 'acme/shop' }))

  expect(p).toContain('`bb_post /repositories/acme/shop/pullrequests`')
  expect(p).toMatch(/description 加「合併風險」段：[^，]*單向門[^\n]*影響範圍[^\n]*，歷程記一筆/)
  expectRiskParts(p)
  expect(p).toContain(`照 diff 自己判斷${HISTORY}`)
})

/** AC-3：PR 已開只 push、專案自訂開 PR 指令、平台認不出來時，不由 Agent 寫 PR 說明，提示裡沒有「合併風險」段。 */
test('test_publish_prompt_has_no_merge_risk_when_agent_does_not_write_pr_body', () => {
  const c = passedReview()
  // 對照組：同一張卡在 GitHub 由 Agent 開 PR 時有這段，下面沒有是因為情況不同，不是這張卡本來就沒有
  expect(buildPrompt(c, 'publish', openPrRequest('feature/a', 'origin/main', { host: 'github', repo: 'acme/shop' }))).toContain('合併風險')

  const pushOnly = buildPrompt(c, 'publish', pushRequest('feature/a', 12))
  const custom = buildPrompt(c, 'publish', openPrRequest('feature/a', 'origin/main', { host: 'github', open: 'glab mr create --source-branch {branch} --target-branch {target}' }))
  const other = buildPrompt(c, 'publish', openPrRequest('feature/a', 'origin/main', { host: 'other' }))

  expect(pushOnly).toContain('只 push feature/a（PR #12 已開，不開新 PR）')
  expect(custom).toContain('`glab mr create --source-branch feature/a --target-branch main`')
  expect(other).toContain('沒有 gh 或平台開不了 PR 時')
  for (const p of [pushOnly, custom, other]) {
    expect(p).not.toContain('合併風險')
    expect(p).not.toContain('單向門')
  }
})
