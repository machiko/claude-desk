// 工作桌與主對話撞同一個 worktree：派工前分辨未提交的改動是不是上一個 Agent 留下的。
import type { DispatchKind, RootJobs } from './dispatch'

/** worktree 未提交狀態的指紋：`files` 有幾個檔在 git status 裡，`hash` 是狀態與 diff 的雜湊（乾淨是空字串）。 */
export type WorktreeMark = { files: number; hash: string }

/** 32 位元 FNV-1a，八個十六進位字元；只拿來比「一不一樣」，不需要加密強度（執行環境沒有 node:crypto）。 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

/** `git status --porcelain=v2` 與 `git diff HEAD` 的輸出做成指紋；`#` 開頭的分支標頭不算。 */
export function markOf(status: string, diff: string): WorktreeMark {
  const lines = String(status ?? '').split(/\r?\n/).map(l => l.trimEnd()).filter(l => l && !l.startsWith('#'))
  return lines.length ? { files: lines.length, hash: fnv1a(`${lines.join('\n')}\n${String(diff ?? '')}`) } : { files: 0, hash: '' }
}

const CODE_KINDS: ReadonlySet<DispatchKind> = new Set(['continue', 'reply', 'catchup'])

/**
 * 派繼續／回覆／審查前的拒絕原因；空字串代表可以派。乾淨一律可以；上一個會改程式的 Agent 還在（例如停在提問）時改動是它的；
 * 它結束時留下的指紋（`own.mark`）跟現在一樣也可以。從沒派過工、或指紋不同：有別的對話在改，拒絕。同步不經過這裡。
 */
export function markRefusal(now: WorktreeMark, own: RootJobs | undefined): string {
  if (!now.files) return ''
  const last = own?.last
  if (last && CODE_KINDS.has(last.kind) && !last.ended) return ''
  if (own?.mark !== undefined && own.mark === now.hash) return ''
  return `worktree 有未提交的改動（${now.files} 個檔），不是上一個 Agent 留下的；可能有別的對話在改，commit 或還原後再派`
}
