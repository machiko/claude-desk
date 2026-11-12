// 卡片統計：派工或完成檢查跑完時，把這條分支的總執行與整張卡的修正輪數寫進 worktree 的 .task/stats.json，歸檔時 card.py 讀它組統計行。
// 有逐段紀錄（各段的種類、開始與結束、在跑的時間、排隊多久）也一起寫，card.py 拿來算各段分鐘與段間空等。
// $ 只傳給 function 宣告（外掛載入的限制）。
import { fixTotalOf } from './chain'
import { loadChains, loadJobs } from './desk-io'
import type { StageRun } from './dispatch'
import { normalizeRoot } from './settings'

/** 統計檔在 worktree 裡的位置（.task 不算進 worktree 指紋，見 probes 的 MARK_EXCLUDES）。 */
export const STATS_FILE = '.task/stats.json'

/** stats.json 的內容：runMs 是 branch 這條分支的累計執行毫秒，fixRounds 是整張卡的修正輪數，runs 是這條分支已結束的各段（沒有就不寫）。 */
export type CardStats = { branch?: string; runMs: number; fixRounds: number; runs?: StageRun[] }

/** 從派工紀錄與流程紀錄組統計；總執行與修正輪數都是 0（沒派過工、沒修過）回傳 null，呼叫端就不寫，不把舊的統計蓋成空的。 */
export function statsOf(runMs: number | undefined, runBranch: string | undefined, fixRounds: number, runs?: readonly StageRun[]): CardStats | null {
  const ms = Math.max(0, runMs ?? 0)
  if (!ms && !fixRounds) return null
  return { ...(runBranch ? { branch: runBranch } : {}), runMs: ms, fixRounds, ...(runs?.length ? { runs: [...runs] } : {}) }
}

/**
 * 把這個根目錄的統計寫進 `<root>/.task/stats.json`：讀現在存著的總執行（runMs／runBranch）、逐段紀錄（runs）與流程的修正輪數。
 * 只是照存著的數字寫一份，同一次派工重寫幾次結果都一樣，不會重複加。寫失敗吞掉，只少一筆統計，不擋流程。
 */
export async function writeStats($: any, root: string) {
  const key = normalizeRoot(root)
  const jobs = (await loadJobs($))[key]
  const stats = statsOf(jobs?.runMs, jobs?.runBranch, fixTotalOf((await loadChains($))[key]), jobs?.runs)
  if (!stats) return
  await $.fs.write(`${key}/${STATS_FILE}`, `${JSON.stringify(stats, null, 2)}\n`).catch(() => {})
}
