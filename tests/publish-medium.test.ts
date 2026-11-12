import { expect, test } from 'claude-code/testing'
import { buildPrompt, openPrRequest, pushRequest } from '../hooks/dispatch'
import { buildCase } from '../hooks/model'
import { pipeline } from '../hooks/pipeline'
import type { Case, Verify } from '../types'

// 驗收 MEDIUM 記錄後繼續：審查的 MEDIUM 只記錄、不在「等你」問，推送 Agent 開 PR 時把它們列進 PR 說明，看 PR 的人看得到。

/** 停在合併段：審查過關、只剩記錄的 MEDIUM。 */
function passedWithMedium(): Case {
  const text = '<!-- DESK -->\n- 狀態：ok\n- 檢查：`npm test`\n- 等你：無\n- 下一步：可開 PR：push 後開 PR\n- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 2、LOW 0；可合併\n<!-- /DESK -->'
  const v: Verify = { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h' }
  const c: Case = { ...buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, text, 1, {}, v), git: { branch: 'feature/a', head: 'h' } }
  return { ...c, pipeline: pipeline(c, v) }
}

const READ = '另讀 .task/REVIEW.md，有 .task/SECURITY.md 也讀，把裡面的 MEDIUM 逐條列在「驗收記錄的 MEDIUM」段，兩份都沒有 MEDIUM 就不加這段'
/** review-pr-risk：合併風險段接在 MEDIUM 段之後、記歷程之前（MEDIUM 段本身不變）。 */
const RISK = '加「合併風險」段：寫明這次是單向門（合併後很難直接退回，例如資料遷移、對外格式、刪除）還是雙向門，以及影響範圍（哪些使用者或流程會受影響），照 diff 自己判斷'

/** 驗收 MEDIUM 記錄後繼續 AC-3：GitHub 與 Bitbucket 開 PR 的推送提示都要 Agent 讀審查檔（有資安審查檔也讀），把 MEDIUM 逐條列進 PR 說明；沒有就不加這段。 */
test('test_publish_prompt_lists_recorded_medium_in_pr_body', () => {
  const c = passedWithMedium()
  const github = buildPrompt(c, 'publish', openPrRequest('feature/a', 'origin/main', { host: 'github', repo: 'acme/shop' }))
  const bitbucket = buildPrompt(c, 'publish', openPrRequest('feature/a', 'origin/main', { host: 'bitbucket', repo: 'acme/shop' }))

  // GitHub：寫在 PR 內文，接在開 PR 指令之後、合併風險段與記歷程之前
  expect(github).toContain(`內文寫改了什麼、怎麼測），內文${READ}，內文${RISK}，歷程記一筆「Agent：push 並開 PR → 等 CI（PR #<編號>）」`)
  // Bitbucket：寫在 description
  expect(bitbucket).toContain(`close_source_branch=true），description ${READ}，description ${RISK}，歷程記一筆「Agent：push 並開 PR → 等 CI（PR #<編號>）」`)
  for (const p of [github, bitbucket]) {
    expect(p.startsWith('推送：push feature/a 並對 main 開 PR')).toBe(true)
    // MEDIUM 不在等你問：推送照舊不改關卡、不覆寫等你
    expect(p).toContain('關卡與檢查欄保持原樣')
    expect(p).not.toContain('A) 不修，記錄原因')
  }

  // PR 已開、只 push：不開新 PR，也就沒有 PR 說明要寫
  expect(buildPrompt(c, 'publish', pushRequest('feature/a', 12))).not.toContain('驗收記錄的 MEDIUM')
})
