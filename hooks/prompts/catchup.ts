// 解衝突（catchup）派工的提示詞。

/** 解衝突的那條：關卡與檢查是之前判定的，合併 commit 之後由流程自動重新檢查與審查。 */
export const CATCHUP_CARD_RULE = '這次只合併基準分支、解衝突：關卡與檢查欄保持原樣；合併 commit 之後的完成檢查與審查由工作桌自動接手，你不用自己送審查。'

/**
 * 解衝突的提示頭；`target` 是基準分支（例如 origin/main），空白當 origin/main。照順序：確認還有衝突 → merge → 解衝突 → 跑檢查、commit；
 * 要業務判斷就 abort、寫進等你。不 rebase、不 reset、不 push。
 */
export function catchupHead(target: string): string {
  const ref = target.trim() || 'origin/main'
  const name = ref.replace(/^origin\//, '')
  const fetch = ref === name ? '' : `git fetch origin ${name}，再`
  return [
    `合併基準分支、解衝突：這個分支跟 ${name} 有衝突，把 ${ref} merge 進來、解衝突。照順序：`,
    `1) ${fetch}用 \`git merge-tree --write-tree --name-only ${ref} HEAD\` 確認還有衝突；沒有衝突就不合併，在歷程記一筆後結束。`,
    `2) \`git merge --no-ff --no-edit ${ref}\`，逐檔解衝突：兩邊的改動都保留，只動衝突的地方。`,
    '3) 只跑跟衝突有關的測試，解完跑一次完成檢查；git add 解好的檔、git commit --no-edit。只修因合併才壞的地方，修不綠也照樣 commit，狀態寫哪裡沒過（流程會接著自動修正）。',
    '4) 要業務判斷（兩邊改了同一段邏輯、不確定留哪邊）時 git merge --abort，把問題寫進 等你 後結束。',
    `5) 不 rebase、不 reset、不 force push、不 push、不開 PR。狀態寫合併了 ${name}、解了幾個檔，下一步寫「等自動重新檢查與審查」，歷程記合併 commit 與檔名。`,
  ].join('\n')
}
