// 推送（publish）派工的提示詞：push 分支、開 PR。開 PR 的做法依 origin 是哪一家而定。

/**
 * 推送只動遠端與卡片：審查結論（關卡）與完成檢查是之前判定的，改了六段會退回去。
 * 過關時「等你」可能還有題目（例如 MEDIUM 要不要修），自動開 PR 照樣派：原題目保留，要加的（開不了 PR 時的網址）接在後面。
 */
export const PUBLISH_CARD_RULE = '這次只推送：關卡與檢查欄保持原樣；狀態寫 PR 與 CI 的現況，下一步寫等 CI 與合併。等你 原有的題目保留，要加的用「；」接在後面，不覆寫。'

/**
 * 開 PR 要怎麼開：host 由 origin 網址判斷（GitHub 用 gh、Bitbucket 用 MCP 的 bb_post、其他只 push）；
 * repo 是 `owner/repo` 或 `workspace/repo`；open 是專案 `dispatch.json` 的 `pr.open` 覆寫指令（`{branch}`、`{target}` 會換成分支與目標），有填就不看 host。
 */
export type PrHow = { host: 'github' | 'bitbucket' | 'other'; repo?: string; open?: string }

/** origin 認出來的樣子（probes 的 Remote）；認不出來是 null。 */
export type OriginRemote = { host: 'bitbucket'; repo: { workspace: string; repo: string } } | { host: 'github'; repo: { owner: string; repo: string } } | null

/** 推送 Agent 開 PR 的做法：專案 `pr.open` 覆寫優先，否則依 origin；認不出來就 other（只 push、留網址）。 */
export function prHowOf(remote: OriginRemote, open = ''): PrHow {
  if (open.trim()) return { host: remote?.host ?? 'other', open: open.trim() }
  if (remote?.host === 'bitbucket') return { host: 'bitbucket', repo: `${remote.repo.workspace}/${remote.repo.repo}` }
  if (remote?.host === 'github') return { host: 'github', repo: `${remote.repo.owner}/${remote.repo.repo}` }
  return { host: 'other' }
}

/** 開不了 PR 時的收尾：push 完把網址留給人開。 */
const LEAVE_URL = 'push 完把開 PR 的網址寫進 等你 後結束'

/** 開 PR 那一段（不含 push）：依 host 給工具與查重複的指令；沒給 how 就是舊的通用寫法。 */
export function openPrSteps(branch: string, target: string, how?: PrHow): string {
  const fill = (s: string) => s.replace(/\{branch\}/g, branch).replace(/\{target\}/g, target)
  if (how?.open?.trim()) return `開 PR 用 \`${fill(how.open.trim())}\`，PR 網址寫進歷程；指令失敗時${LEAVE_URL}`
  if (how?.host === 'github') {
    return `開 PR 用 gh：先 \`gh pr list --head ${branch} --state open\` 確認沒有開著的 PR，再 \`gh pr create${target ? ` --base ${target}` : ''} --head ${branch}\`（標題用分支 commit 的主旨，內文寫改了什麼、怎麼測），PR 網址寫進歷程；沒有 gh 或 gh 沒登入時，${LEAVE_URL}`
  }
  if (how?.host === 'bitbucket') {
    const path = `/repositories/${how.repo || '<workspace>/<repo>'}/pullrequests`
    return `開 PR 用 Bitbucket MCP：先 \`bb_get ${path}\`（queryParams q=source.branch.name="${branch}" AND state="OPEN"）確認沒有開著的 PR，再 \`bb_post ${path}\`（body：title 用分支 commit 的主旨、source.branch.name=${branch}${target ? `、destination.branch.name=${target}` : ''}、description 寫改了什麼與怎麼測、close_source_branch=true），PR 網址寫進歷程；沒有 bb_post 工具時，${LEAVE_URL}`
  }
  return `開 PR，PR 網址寫進歷程；沒有 gh 或平台開不了 PR 時，${LEAVE_URL}`
}

/** 「⇡ 開 PR」要推送 Agent 做的事；`target` 是基準分支（可帶 origin/），找不到就空白。`how` 見 PrHow，沒給就通用寫法。 */
export const openPrRequest = (branch: string, target: string, how?: PrHow) => {
  const t = target.replace(/^origin\//, '')
  return `push ${branch} 並${t ? `對 ${t} ` : ''}${openPrSteps(branch, t, how)}`
}
/** 「⇡ push」要推送 Agent 做的事：PR 已開，只 push、不開新 PR。 */
export const pushRequest = (branch: string, prId?: number) =>
  `只 push ${branch}（PR${prId ? ` #${prId}` : ''} 已開，不開新 PR），push 後把分支頂端 commit 寫進歷程`
/** 推送的提示頭；`text` 是 openPrRequest 或 pushRequest 組好的那句。 */
export const publishHead = (text: string) => `推送：${text || openPrRequest('這個分支', '')}。只推已 commit 的：不 commit、不改程式、不 rebase。`
