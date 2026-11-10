// 面板文字的字串目錄（zh-TW）：鍵用「檔名.用途」，參數寫成 {name}，由 t() 填入（hooks/i18n/index.ts）。
// 只放給人看的句子；卡片欄位名、解析用的句子與正規式、教學卡片本文、給 Agent 的提示不放這裡（docs/WORKFLOW.md「面板文字」）。
// 每個鍵都要有程式在用（scripts/tests/test_i18n_migrated.py 會檢查），英文版照同樣的鍵另寫一份。

export const zhTW = {
  // /desk 指令（hooks/register.tsx）
  'register.deskDescription': '工作桌：/desk 開啟面板並取得焦點（面板裡 Esc 回輸入框）；close 收起；refresh 重新整理；go|sync|review|reply <任務名> [回覆] 派工；verify|open <任務名> 執行測試／開啟卡片；bar 摘要列；update 把 desk 更新到 GitHub 最新版本；tutorial [end] 教學（含示範任務）；off 關閉',
  'register.deskArgumentHint': '[close|refresh|go|sync|review|reply|verify|open <任務名>|bar|update|tutorial [end]|off]',

  // 派工種類名稱（hooks/kind-label.ts）
  'kindLabel.continue': '繼續',
  'kindLabel.sync': '同步',
  'kindLabel.review': '驗收',
  'kindLabel.reply': '回覆',
  'kindLabel.publish': '推送',
  'kindLabel.catchup': '解衝突',

  // 疊放卡（hooks/stack.ts）
  'stack.waitWhy': '等原卡「{name}」合併',
  'stack.next': '原卡合併後才能派；要先做就開卡片（o）刪掉「疊放於」那行',
  'stack.autoNext': '原卡合併後自動接著做',

  // 格式警告（hooks/formats.ts）
  'formats.newerCardWhy': '這張卡是較新版 desk 的格式',
  'formats.updateDeskNext': '輸入 /desk update 更新 desk',
  'formats.newerCard': '「{name}」{why}（格式 {format}），請更新 desk；這張卡照常顯示但不派工',
  'formats.newerRegistry': '登錄表 {path} 是較新版 desk 的格式（格式 {format}），請更新 desk',

  // Claude Code 版本警告（hooks/engine-version.ts）
  'engineVersion.tooOld': 'Claude Code {version} 比 desk 需要的最低版本 {min} 舊，請更新 Claude Code（claude update）',
  'engineVersion.unknown': '讀不到 Claude Code 版本，desk 以 {min} 開發，太舊可能無法使用',

  // 更新檢查與 /desk update（hooks/update.ts、hooks/update-run.ts）
  'update.notice': '有新版本 {latest}',
  'update.updated': 'desk 已更新版本：{from} → {to}，自動重新載入（對話正在回覆就等回合結束）',
  'update.reloadFilled': 'desk 沒能自動重新載入：已填入 /reload-plugins，按 Esc 回到輸入框再按 Enter 執行，新版才會生效',
  'update.reloadType': 'desk 沒能自動重新載入：請輸入 /reload-plugins，新版才會生效',
  'update.upToDate': 'desk 已是最新版本（{version}）',
  'update.busy': 'desk 正在更新中，請稍候。',
  'update.offline': '連不到 GitHub：{err}',
  'update.noRemoteVersion': '讀不到 GitHub 上的版本：{err}',
  'update.noVersionField': '讀不到 GitHub 上的版本：plugin.json 沒有 version',
  'update.folderStatusFailed': '讀不到本機資料夾的狀態：{err}',
  'update.folderDirty': '本機資料夾 {dir} 有未提交的改動，請先 commit 或自行收好再更新',
  'update.folderOffBranch': '本機資料夾 {dir} 不在預設分支 {branch}（目前 {current}），請先切回 {branch} 再更新',
  'update.unknownBranch': '未知',
  'update.folderAhead': '本機資料夾 {dir} 有 {ahead} 個 GitHub 上沒有的 commit，請先 push 或自行整理再更新',
  'update.notInstalled': '找不到已安裝的 desk',
  'update.cantUpdate': 'desk 無法更新：{why}',
  'update.cantList': 'desk 無法更新：讀不到已安裝的 plugin（{err}）',
  'update.cantFind': 'desk 無法更新：找不到已安裝的 desk（例如用 --plugin-dir 載入的），請自行更新',
  'update.blocked': 'desk 無法更新，什麼都沒動：{reasons}',
  'update.reasonSep': '；',
  'update.noHead': 'desk 無法更新：讀不到本機資料夾 {dir} 目前的版本',
  'update.mergeFailed': 'desk 無法更新：更新本機資料夾失敗（{err}）',
  'update.rolledBack': 'desk 無法更新：{why}；本機資料夾已退回原本的版本',
  'update.rollbackFailed': 'desk 無法更新：{why}；本機資料夾已快轉但退回失敗（{err}），請在 {dir} 執行 git reset --keep {before}',
  'update.commandFailed': '更新指令失敗（{err}）',
  'update.stillOld': '更新指令跑完了，但已安裝的版本仍是 {version}',

  // desk 自己發版後自動更新（hooks/release-update.ts）
  'releaseUpdate.autoUpdate': '{name} 已發版 v{version}：自動更新 desk',
} as const
