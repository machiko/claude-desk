// 探測：git、tag、Bitbucket PR、風險、執行者記錄、容器、版本、模型。都是讀，不寫卡片；
// 唯一的寫入是審查存底（archiveReview）。快取放在這個模組裡，重新載入就清空。
import type { PluginOptions } from 'claude-code'
import type { Case, PrInfo, Snapshot } from '../types'
import { expandHome } from './card'
import { lastMeaningful } from './model'
import { REVIEW_FILE, SECURITY_FILE, modelFor, parseSettings } from './dispatch'
import type { DispatchSettings } from './dispatch'
import { READ_TOOL, ciOf, mcpJson, pickPr, prQuery, repoOf, statusQuery } from './bitbucket'
import type { Repo } from './bitbucket'
import { classify } from './risk'
import type { Risk } from './risk'
import { parseCompose, summarize } from './containers'
import type { ContainerSummary } from './containers'
import { logLines, parseGitStatus } from './extras'
import type { GitState } from './extras'

const PR_TTL_MS = 5 * 60_000
const LOGS_TIMEOUT_MS = 15_000
let deskVersion: string | undefined
const remotes = new Map<string, Repo | null>()
const tags = new Map<string, string>()
const prs = new Map<string, { at: number; branch: string; pr: PrInfo | null }>()
const risks = new Map<string, Risk>()

export async function home($: any): Promise<string> {
  const h = (await $.env.get('HOME').catch(() => null)) || (await $.env.get('USERPROFILE').catch(() => null)) || ''
  return String(h).replace(/\\/g, '/')
}

export async function optionPath($: any, options: PluginOptions, key: string, fallback: string): Promise<string> {
  return expandHome(String(options[key] || fallback), await home($))
}

export async function git($: any, root: string, args: string[]): Promise<string | null> {
  const r = await $.process.run(['git', '-C', root, ...args], { timeoutMs: 10_000 }).catch(() => null)
  return r && r.exitCode === 0 ? String(r.stdout).trim() : null
}

/** 分支、HEAD、包含 HEAD 的最舊 v* tag（依 HEAD 快取）。不是 git 資料夾就全空。 */
export async function gitProbe($: any, root: string): Promise<{ git?: { branch: string; head: string }; tag?: string }> {
  const out = await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD', 'HEAD'])
  if (!out) return {}
  const [branch, head] = out.split(/\r?\n/)
  if (!branch || !head) return {}
  // 只快取「找到 tag」：tag 打了不會消失；「還沒有 tag」每次重查，否則之後才打的 tag 永遠看不到。
  let tag = tags.get(head) ?? ''
  if (!tag) {
    tag = ((await git($, root, ['tag', '--contains', head, '--list', 'v*', '--sort=creatordate'])) ?? '').split(/\r?\n/).filter(Boolean)[0] ?? ''
    if (tag) tags.set(head, tag)
  }
  return { git: { branch, head }, ...(tag ? { tag } : {}) }
}

/** Bitbucket 上這個分支的 PR 與 CI，透過 MCP 的 bb_get（唯讀）；發版線不查；5 分鐘快取，CI 跑中時每次更新都查。 */
export async function prProbe($: any, options: PluginOptions, root: string, branch: string, now: number, force = false): Promise<PrInfo | undefined> {
  if (/^release\//.test(branch) || branch === 'HEAD') return undefined
  if (!remotes.has(root)) remotes.set(root, repoOf((await git($, root, ['remote', 'get-url', 'origin'])) ?? ''))
  const repo = remotes.get(root)
  if (!repo) return undefined
  const cached = prs.get(root)
  const live = cached?.pr?.state === 'OPEN' && cached.pr.ci === 'pending'
  if (cached && cached.branch === branch && !force && !live && now - cached.at < PR_TTL_MS) return cached.pr ?? undefined
  const server = String(options.bitbucketServer || 'bitbucket')
  try {
    const found = pickPr(mcpJson(await $.mcp.call(server, READ_TOOL, prQuery(repo, branch))))
    let pr: PrInfo | null = null
    if (found) {
      const ci = found.state === 'OPEN' ? ciOf(mcpJson(await $.mcp.call(server, READ_TOOL, statusQuery(repo, found.id)))) : 'none'
      pr = { ...found, ci } as PrInfo
    }
    prs.set(root, { at: now, branch, pr })
    return pr ?? undefined
  } catch {
    return cached?.branch === branch ? cached.pr ?? undefined : undefined
  }
}

/** 這個分支相對 release 線（PR 的目標，沒有 PR 就是最新的 origin/release/*）改了哪些檔，依 HEAD 快取。 */
export async function riskOf($: any, c: Case, extra: readonly [RegExp, string][] = []): Promise<Risk> {
  const head = c.git?.head
  if (!head) return classify([], extra)
  const cached = risks.get(`${c.root}\n${head}`)
  if (cached) return cached
  const target = c.pr?.dest ? `origin/${c.pr.dest}` : ((await git($, c.root, ['for-each-ref', '--sort=-committerdate', '--count=1', '--format=%(refname:short)', 'refs/remotes/origin/release/'])) ?? '')
  const base = target ? await git($, c.root, ['merge-base', 'HEAD', target]) : null
  const files = base ? ((await git($, c.root, ['diff', '--name-only', `${base}..HEAD`])) ?? '').split(/\r?\n/) : []
  const risk = classify(files, extra)
  risks.set(`${c.root}\n${head}`, risk)
  return risk
}

/** 審查剛結束：把審查檔留一份到 reviews/，給之後的審查找「重複出現的問題」。只寫這個資料夾，不碰卡片。 */
export async function archiveReview($: any, options: PluginOptions, c: Case, security: boolean, at: number) {
  const text = await $.fs.read(`${c.root}/${security ? SECURITY_FILE : REVIEW_FILE}`).catch(() => null)
  if (!text) return
  const dir = await optionPath($, options, 'reviewsDir', '~/.claude/handoffs/reviews')
  const slug = c.root.split('/').filter(Boolean).pop() ?? 'case'
  const d = new Date(at)
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
  await $.fs.write(`${dir}/${slug}-${stamp}-${security ? 'security' : 'code'}.md`, text).catch(() => {})
}

/** 進行中或停下來問的 agent，最後一句話（`claude logs`）。 */
export async function lastLine($: any, id: string | undefined): Promise<string> {
  if (!id) return ''
  const r = await $.process.run(['claude', 'logs', id], { timeoutMs: LOGS_TIMEOUT_MS }).catch(() => null)
  if (!r || r.exitCode !== 0) return ''
  return lastMeaningful(String(r.stdout))
}

/** dispatch.json；讀不到就是預設值。 */
export async function loadSettings($: any, options: PluginOptions): Promise<DispatchSettings> {
  return parseSettings(await $.fs.read(await optionPath($, options, 'dispatchSettingsPath', '~/.claude/handoffs/dispatch.json')).catch(() => null))
}

/** 主工作區的容器：docker compose ps；Docker 沒開或讀不到就記錯誤，不擋其他東西。 */
export async function containers($: any, options: PluginOptions): Promise<ContainerSummary> {
  // 沒設定 composeDir 就不看容器（面板不顯示容器列，檢查也不先確認容器）。
  if (!String(options.composeDir ?? '').trim()) return { total: 0, running: 0, down: [], unhealthy: [] }
  const dir = await optionPath($, options, 'composeDir', '')
  const r = await $.process.run(['docker', 'compose', 'ps', '-a', '--format', 'json'], { cwd: dir, timeoutMs: 10_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return { total: 0, running: 0, down: [], unhealthy: [], error: '無法讀取（Docker 未啟動？）' }
  return summarize(parseCompose(String(r.stdout)))
}

/** desk 自己的版本（plugin.json）；產品線上版＝發版線所在 repo 最新的 v* tag，開發中＝release/* 分支名。 */
export async function versions($: any, cases: Case[]): Promise<Snapshot['versions']> {
  if (deskVersion === undefined) {
    const manifest = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => null)
    try { deskVersion = String(JSON.parse(manifest ?? '{}').version ?? '') } catch { deskVersion = '' }
  }
  const line = cases.find(c => c.git && /^release\//.test(c.git.branch)) ?? cases.find(c => c.git)
  const live = line ? ((await git($, line.root, ['tag', '--list', 'v*', '--sort=-creatordate'])) ?? '').split(/\r?\n/).filter(Boolean)[0] : undefined
  const dev = line?.git && /^release\//.test(line.git.branch) ? line.git.branch.replace(/^release\//, '') : undefined
  return { ...(deskVersion ? { desk: deskVersion } : {}), ...(live ? { live } : {}), ...(dev ? { dev } : {}) }
}

/** 這個對話的模型（/model 顯示的那個）與最近一次請求的 effort；派工與同步用的模型與 effort。 */
export async function models($: any, options: PluginOptions, turnModel: { model?: string; effort?: string }): Promise<Snapshot['models']> {
  const session = turnModel.model || String((await $.session.model().catch(() => '')) ?? '')
  const settings = await loadSettings($, options)
  const sync = modelFor(settings, '', 'sync')
  return {
    ...(session ? { session } : {}), ...(turnModel.effort ? { effort: turnModel.effort } : {}),
    dispatch: { model: settings.model, effort: settings.effort },
    sync: { model: settings.sync.model, effort: settings.sync.effort || (settings.sync.model ? '' : settings.effort), fresh: sync.fresh },
  }
}

/** git status --porcelain=v2 --branch 的摘要；不是 git 資料夾就 undefined。 */
export async function gitStatus($: any, root: string): Promise<GitState | undefined> {
  const out = await git($, root, ['status', '--porcelain=v2', '--branch'])
  return out === null ? undefined : parseGitStatus(out)
}

/** 執行者最近幾行有意義的輸出。 */
export async function logTail($: any, id: string | undefined, n = 10): Promise<string[]> {
  if (!id) return []
  const r = await $.process.run(['claude', 'logs', id], { timeoutMs: LOGS_TIMEOUT_MS }).catch(() => null)
  return r && r.exitCode === 0 ? logLines(String(r.stdout), n) : []
}
