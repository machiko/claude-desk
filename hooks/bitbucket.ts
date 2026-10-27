// Bitbucket：透過已連線的 MCP（bb_get，唯讀）查分支的 PR 與 CI。只組參數與解析，呼叫在 register.tsx。
import type { PrInfo } from '../types'

/** desk 只會呼叫這一個工具；寫入類（bb_post／bb_put／bb_patch／bb_delete）一律不用。 */
export const READ_TOOL = 'bb_get'

export type Repo = { workspace: string; repo: string }

export function repoOf(remote: string): Repo | null {
  const m = remote.trim().match(/bitbucket\.org[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  return m ? { workspace: m[1]!, repo: m[2]! } : null
}

export function prQuery(r: Repo, branch: string) {
  const safe = branch.replace(/["\\]/g, '')
  return {
    path: `/repositories/${r.workspace}/${r.repo}/pullrequests`,
    queryParams: { q: `source.branch.name="${safe}" AND (state="OPEN" OR state="MERGED" OR state="DECLINED")`, sort: '-updated_on', pagelen: '3' },
    jq: 'values[*].{id: id, state: state, dest: destination.branch.name, url: links.html.href, head: source.commit.hash}',
    outputFormat: 'json' as const,
  }
}

export function statusQuery(r: Repo, id: number) {
  return { path: `/repositories/${r.workspace}/${r.repo}/pullrequests/${id}/statuses`, queryParams: { pagelen: '20' }, jq: 'values[*].state', outputFormat: 'json' as const }
}

/** MCP 結果的文字區塊接起來當 JSON 讀；失敗或格式不對就 null。 */
export function mcpJson(result: { content?: { type?: string; text?: string }[]; isError?: boolean } | null | undefined): unknown {
  if (!result || result.isError) return null
  const text = (result.content ?? []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('')
  try { return JSON.parse(text) } catch { return null }
}

/** 最新那一個 PR；OPEN 優先於 MERGED／DECLINED。 */
export function pickPr(data: unknown): Omit<PrInfo, 'ci'> | null {
  const list = Array.isArray(data) ? data : []
  const prs = list.filter((x: any) => typeof x?.id === 'number' && typeof x?.state === 'string')
  const open = prs.find((x: any) => x.state === 'OPEN')
  const p: any = open ?? prs[0]
  return p ? { id: p.id, state: p.state, ...(typeof p.dest === 'string' ? { dest: p.dest } : {}), ...(typeof p.url === 'string' ? { url: p.url } : {}), ...(typeof p.head === 'string' && p.head ? { head: p.head } : {}) } : null
}

/** 建置狀態：有任何 FAILED／STOPPED 就紅；有 INPROGRESS 就跑中；全部 SUCCESSFUL 才綠；一筆都沒有算 none。 */
export function ciOf(data: unknown): PrInfo['ci'] {
  const states = (Array.isArray(data) ? data : []).map(s => String(s).toUpperCase())
  if (!states.length) return 'none'
  if (states.some(s => s === 'FAILED' || s === 'STOPPED')) return 'fail'
  if (states.some(s => s === 'INPROGRESS')) return 'pending'
  return 'pass'
}
