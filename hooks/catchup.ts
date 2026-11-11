// 合併段的衝突：分支跟基準分支試合併有衝突時，自動派 Agent 把基準分支合併進來、解衝突；不自動派時說原因。
// 純函式：試合併輸出的解析、不自動派的原因、面板文字。偵測（fetch＋merge-tree）在 probes.ts，派工在 register.tsx。
import type { Case } from '../types'
import { quotaLowOf } from './quota-words'
import { t } from './i18n'

/**
 * `git merge-tree --write-tree --name-only --no-messages <基準> HEAD` 的結果：exit 0 沒衝突（空清單），
 * exit 1 有衝突（第一行是 tree，之後每行一個衝突檔），其他（git 太舊不支援、失敗）是 null＝不知道。
 */
export function parseMergeTree(exitCode: number | null | undefined, stdout: string): string[] | null {
  if (exitCode === 0) return []
  if (exitCode !== 1) return null
  const [, ...files] = String(stdout ?? '').split(/\r?\n/).map(l => l.trim())
  const list = [...new Set(files.filter(Boolean))]
  // exit 1 卻沒列出任何檔：不是我們認得的輸出，當作不知道。
  return list.length ? list : null
}

/**
 * 有衝突時不自動派解衝突 Agent 的原因；空字串＝可以自動派。依序：手動任務、沒有自動流程、流程是別的對話開的、
 * 流程已暫停、高風險改動、worktree 有未提交的改動、這個 HEAD 已經自動試過一次。
 */
export function catchupHold(c: Pick<Case, 'manual' | 'chain' | 'conflict'>): string {
  if (c.manual) return t('catchup.manual')
  const chain = c.chain
  if (!chain) return t('catchup.noChain')
  if (chain.foreign) return t('catchup.foreign')
  // 額度煞車擋下的：合併段沒有 g 可按，括號只寫額度原因。
  if (chain.stopped) return quotaLowOf(chain) || t('catchup.paused')
  // 沒有流程紀錄、只是卡片上有審查結論（自審）的，或流程還沒過關的：不是自動流程走到合併段的。
  if (!chain.passed) return t('catchup.noChain')
  if (chain.needsHuman) return t('catchup.highRisk')
  if (c.conflict?.dirty) return t('catchup.dirty', { n: c.conflict.dirty })
  if (chain.catchupTried) return t('catchup.tried')
  return ''
}

/** 合併段的註記：有衝突。 */
export const conflictNote = (into: string): string => t('catchup.conflict', { into })
/** 合併段的註記：解衝突 Agent 在跑。 */
export const CATCHUP_ACTIVE = t('catchup.active')
/** 解衝突 Agent 在跑時「輪到你」那句。 */
export const CATCHUP_RUNNING = t('catchup.running')
/** 有衝突、會自動派。 */
export const catchupAutoTurn = (into: string): string => t('catchup.autoTurn', { into })
/** 有衝突、不自動派：在對話處理，括號寫原因。 */
export const catchupHandTurn = (into: string, why: string): string => t('catchup.handTurn', { into, why })
/** 自動派解衝突時的動態。 */
export const catchupFeed = (name: string, into: string, files: number): string => t('catchup.feed', { name, into, files })
