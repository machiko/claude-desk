// GitHub：用 gh CLI（gh pr list，唯讀）查分支的 PR 與 CI。只組參數與解析，呼叫在 probes.ts。
import type { PrInfo } from '../types'

/** desk 只會執行 `gh pr list`；建立、合併、留言等寫入類子指令一律不用。 */
export const GH_READ = ['pr', 'list'] as const

export type GhRepo = { owner: string; repo: string }

/** 主機要剛好是 github.com（開頭、`//` 或 `@` 之後），notgithub.com 之類不算。 */
export function githubRepoOf(remote: string): GhRepo | null {
  const m = remote.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  return m ? { owner: m[1]!, repo: m[2]! } : null
}

export function ghPrArgs(r: GhRepo, branch: string): string[] {
  return ['gh', ...GH_READ, '--repo', `${r.owner}/${r.repo}`, '--head', branch, '--state', 'all', '--limit', '5', '--json', 'number,state,baseRefName,url,headRepositoryOwner,statusCheckRollup']
}

const FAIL = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'])

/** statusCheckRollup：check run 看 conclusion／status，status context 看 state。有失敗就紅、還有跑中就跑中、其餘綠；一筆都沒有算 none。 */
export function ghCiOf(rollup: unknown): PrInfo['ci'] {
  const items: any[] = Array.isArray(rollup) ? rollup : []
  if (!items.length) return 'none'
  const word = (x: any) => String(x?.conclusion || x?.state || '').toUpperCase()
  const status = (x: any) => String(x?.status ?? '').toUpperCase()
  if (items.some(x => FAIL.has(word(x)))) return 'fail'
  if (items.some(x => PENDING.has(word(x)) || (status(x) !== '' && status(x) !== 'COMPLETED'))) return 'pending'
  return 'pass'
}

/**
 * 最新那一個 PR；OPEN 優先，其餘取 gh 回傳的第一筆（gh 依建立時間新到舊排）。GitHub 的 CLOSED（沒合併就關掉）對應 DECLINED。
 * CI 只看開著的。給了 owner 就只認從這個 owner 的 repo 開的 PR（fork 裡同名分支的不算）。
 */
export function pickGhPr(data: unknown, owner = ''): PrInfo | null {
  const ours = (x: any) => !owner || !x?.headRepositoryOwner?.login || String(x.headRepositoryOwner.login).toLowerCase() === owner.toLowerCase()
  const list = (Array.isArray(data) ? data : []).filter((x: any) => typeof x?.number === 'number' && typeof x?.state === 'string' && ours(x))
  const p: any = list.find((x: any) => x.state === 'OPEN') ?? list[0]
  if (!p) return null
  const state: PrInfo['state'] = p.state === 'OPEN' ? 'OPEN' : p.state === 'MERGED' ? 'MERGED' : 'DECLINED'
  return {
    id: p.number, state, ci: state === 'OPEN' ? ghCiOf(p.statusCheckRollup) : 'none',
    ...(typeof p.baseRefName === 'string' ? { dest: p.baseRefName } : {}), ...(typeof p.url === 'string' ? { url: p.url } : {}),
  }
}
