// 推送（publish）派工的提示詞：push 分支、開 PR。

/**
 * 推送只動遠端與卡片：審查結論（關卡）與完成檢查是之前判定的，改了六段會退回去。
 * 過關時「等你」可能還有題目（例如 MEDIUM 要不要修），自動開 PR 照樣派：原題目保留，要加的（開不了 PR 時的網址）接在後面。
 */
export const PUBLISH_CARD_RULE = '這次只推送：關卡與檢查欄保持原樣；狀態寫 PR 與 CI 的現況，下一步寫等 CI 與合併。等你 原有的題目保留，要加的用「；」接在後面，不覆寫。'
/** 「⇡ 開 PR」要推送 Agent 做的事；`target` 是基準分支（可帶 origin/），找不到就空白。開不了 PR 的平台寫進等你。 */
export const openPrRequest = (branch: string, target: string) =>
  `push ${branch} 並${target ? `對 ${target.replace(/^origin\//, '')} ` : ''}開 PR，PR 網址寫進歷程；沒有 gh 或平台開不了 PR（例如 Bitbucket）時，push 完把開 PR 的網址寫進 等你 後結束`
/** 「⇡ push」要推送 Agent 做的事：PR 已開，只 push、不開新 PR。 */
export const pushRequest = (branch: string, prId?: number) =>
  `只 push ${branch}（PR${prId ? ` #${prId}` : ''} 已開，不開新 PR），push 後把分支頂端 commit 寫進歷程`
/** 推送的提示頭；`text` 是 openPrRequest 或 pushRequest 組好的那句。 */
export const publishHead = (text: string) => `推送：${text || openPrRequest('這個分支', '')}。只推已 commit 的：不 commit、不改程式、不 rebase。`
