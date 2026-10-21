// 探測：git、tag、PR（Bitbucket／GitHub）、合併、風險、Agent 記錄、容器、版本、模型。都是讀，不寫卡片；
// 唯一的寫入是審查存底（archiveReview）。快取放在這個模組裡，重新載入就清空。
import type { PluginOptions } from 'claude-code'
import type { Case, PrInfo, Snapshot, Verify } from '../types'
import { expandHome } from './card'
import { lastMeaningful, plain } from './model'
import { REVIEW_FILE, SECURITY_FILE, modelFor, parseSettings } from './dispatch'
import type { DispatchSettings } from './dispatch'
import { READ_TOOL, ciOf, mcpJson, pickPr, prQuery, repoOf, statusQuery } from './bitbucket'
import type { Repo } from './bitbucket'
import { ghPrArgs, githubRepoOf, pickGhPr } from './github'
import type { GhRepo } from './github'
import { classify } from './risk'
import type { Risk } from './risk'
import { parseCompose, summarize } from './containers'
import type { ContainerSummary } from './containers'
import { logLines, parseGitStatus } from './extras'
import type { GitState } from './extras'
import { HANDOFFS, PROJECT_FILES, mergeSettingsText, projectOf } from './project'
import type { Project } from './project'

const PR_TTL_MS = 5 * 60_000
/** 讀 PR 失敗（gh 沒登入、斷網、MCP 斷線）後多久再試；舊結果最多沿用多久。 */
const PR_RETRY_MS = 60_000
const PR_STALE_MS = 60 * 60_000
/** git 判斷「還沒合併」後多久再問（按 r 重新整理會強制重問）。 */
const MERGE_MISS_MS = 2 * 60_000
const LOGS_TIMEOUT_MS = 15_000
let deskVersion: string | undefined
type Remote = { host: 'bitbucket'; repo: Repo } | { host: 'github'; repo: GhRepo } | null
const remotes = new Map<string, Remote>()
const tags = new Map<string, string>()
/** at＝最後一次嘗試、okAt＝最後一次讀成功；failed 時套 PR_RETRY_MS。 */
const prs = new Map<string, { at: number; okAt: number; branch: string; pr: PrInfo | null; failed?: boolean }>()
const risks = new Map<string, Risk>()
const merges = new Map<string, string>()
/** store 的鍵：根目錄 → 分支在哪個 HEAD 被 git 認定合併、併進哪裡。合併後分支再有 commit，HEAD 不在基準分支裡了，靠它認得。 */
export const GIT_MERGED_KEY = 'gitMerged'
type GitMerged = Record<string, { branch: string; head: string; into: string }>
/** 讀不到或寫不進 store 就當作沒有紀錄：不影響 git 本身的判斷。 */
async function gitMerged($: any): Promise<GitMerged> {
  try { return ((await $.store.get(GIT_MERGED_KEY)) as GitMerged | null) ?? {} } catch { return {} }
}
async function rememberMerged($: any, root: string, entry: GitMerged[string]) {
  try { await $.store.set(GIT_MERGED_KEY, { ...(await gitMerged($)), [root]: entry }) } catch { /* 下次合併段再問一次 git */ }
}
const mergeMisses = new Map<string, number>()
const projects = new Map<string, Project>()
/** 根目錄＋HEAD → 最近一次變更的時間；HEAD 不變它就不變。 */
const commitTimes = new Map<string, CommitTimes>()
/** 一次 commit 改到超過這麼多檔案就不逐一看修改時間，直接用 commit 時間。 */
const MAX_STAT_FILES = 50

export type CommitTimes = { at: number; changedAt: number }

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

/** 這個對話所在的專案（session 根目錄的 repo；`/cd` 換了就跟著換）。只快取找到的，之後才 git init 或 git 暫時失敗下一輪會再查。 */
export async function currentProject($: any): Promise<Project | null> {
  const root = String((await $.session.root().catch(() => '')) ?? '')
  if (!root) return null
  const cached = projects.get(root)
  if (cached) return cached
  const found = projectOf(await git($, root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), await home($))
  if (found) projects.set(root, found)
  return found
}

/**
 * 登錄表、設定、審查用檔的路徑。plugin 選項有填就照填的；沒填就用目前專案的資料夾。
 * 認不出專案時沒有登錄表（不退回別的專案的），常犯錯誤與審查存底退回 ~/.claude/handoffs。
 */
export type DeskPaths = { project: Project | null; registry: string | null; settings: string; projectSettings: string | null; pitfalls: string; reviews: string }
export async function deskPaths($: any, options: PluginOptions): Promise<DeskPaths> {
  const project = await currentProject($)
  const h = await home($)
  const pick = (key: string, file: string, fallback: string | null) =>
    String(options[key] ?? '').trim() ? expandHome(String(options[key]).trim(), h) : project ? `${project.dir}/${file}` : fallback === null ? null : expandHome(fallback, h)
  return {
    project,
    registry: pick('registryPath', PROJECT_FILES.registry, null),
    settings: await optionPath($, options, 'dispatchSettingsPath', `${HANDOFFS}/dispatch.json`),
    projectSettings: project ? `${project.dir}/${PROJECT_FILES.settings}` : null,
    pitfalls: pick('pitfallsPath', PROJECT_FILES.pitfalls, `${HANDOFFS}/review-pitfalls.md`)!,
    reviews: pick('reviewsDir', PROJECT_FILES.reviews, `${HANDOFFS}/reviews`)!,
  }
}

/** 分支、HEAD、包含 HEAD 的最舊 v* tag（依 HEAD 快取）。不是 git 資料夾就全空。 */
export async function gitProbe($: any, root: string): Promise<{ git?: { branch: string; head: string }; tag?: string }> {
  // --abbrev-ref 會套用到它後面每一個參數，所以 commit 要寫在它前面。
  const out = await git($, root, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'])
  if (!out) return {}
  const [head, branch] = out.split(/\r?\n/)
  if (!branch || !head) return {}
  // 只快取「找到 tag」：tag 打了不會消失；「還沒有 tag」每次重查，否則之後才打的 tag 永遠看不到。
  let tag = tags.get(head) ?? ''
  if (!tag) {
    tag = ((await git($, root, ['tag', '--contains', head, '--list', 'v*', '--sort=creatordate'])) ?? '').split(/\r?\n/).filter(Boolean)[0] ?? ''
    if (tag) tags.set(head, tag)
  }
  return { git: { branch, head }, ...(tag ? { tag } : {}) }
}

/**
 * 分支最近一次變更：commit 時間，以及那次 commit 改到的檔案最後被改的時間（不晚於 commit；讀不到檔案或檔案太多就用 commit 時間）。
 * 只改卡片的 commit 不算，commit 裡的卡片也不算：卡片 commit 進版控時檔案時間不會變，會被誤判成卡片過期。
 * 讀不到就 undefined（不提示）。依 HEAD 快取。
 */
export async function commitTime($: any, root: string, head: string): Promise<CommitTimes | undefined> {
  const key = `${root}\n${head}`
  const known = commitTimes.get(key)
  if (known) return known
  const out = await git($, root, ['log', '-1', '--format=%ct', '--name-only', 'HEAD', '--', '.', ':(exclude).desk', ':(exclude).console'])
  const [first = '', ...rest] = (out ?? '').split('\n')
  const sec = Number(first.trim())
  if (!out || !Number.isFinite(sec) || sec <= 0) return undefined
  const at = sec * 1000
  const files = rest.map(f => f.trim()).filter(Boolean)
  const stats = files.length && files.length <= MAX_STAT_FILES
    ? await Promise.all(files.map(f => ($.fs.stat(`${root}/${f}`) as Promise<{ mtimeMs?: number }>).catch(() => null)))
    : []
  const times = stats.map(s => s?.mtimeMs).filter((t): t is number => typeof t === 'number')
  const r = { at, changedAt: times.length ? Math.min(at, Math.max(...times)) : at }
  commitTimes.set(key, r)
  return r
}

/** origin 是哪一家：Bitbucket 走 MCP、GitHub 走 gh CLI；其他（GitLab、自架）不查 PR，合併交給 git 判斷。 */
function remoteOf(url: string): Remote {
  const bb = repoOf(url)
  if (bb) return { host: 'bitbucket', repo: bb }
  const gh = githubRepoOf(url)
  return gh ? { host: 'github', repo: gh } : null
}

/**
 * 這個分支的 PR 與 CI：Bitbucket 用 MCP 的 bb_get、GitHub 用 gh pr list，都是唯讀；發版線不查。
 * 5 分鐘快取，CI 跑中時每次更新都查；讀失敗後一分鐘內不再試，舊結果超過一小時就不顯示。
 */
export async function prProbe($: any, options: PluginOptions, root: string, branch: string, now: number, force = false): Promise<PrInfo | undefined> {
  if (/^release\//.test(branch) || branch === 'HEAD') return undefined
  // 只快取認得出來的 remote：之後才加 origin 或改網址，下一輪就會重讀。
  if (!remotes.get(root)) remotes.set(root, remoteOf((await git($, root, ['remote', 'get-url', 'origin'])) ?? ''))
  const remote = remotes.get(root)
  if (!remote) return undefined
  const own = prs.get(root)
  const cached = own?.branch === branch ? own : undefined
  const shown = (c: typeof cached) => c && now - c.okAt < PR_STALE_MS ? c.pr ?? undefined : undefined
  const live = !cached?.failed && cached?.pr?.state === 'OPEN' && cached.pr.ci === 'pending'
  if (cached && !force && !live && now - cached.at < (cached.failed ? PR_RETRY_MS : PR_TTL_MS)) return shown(cached)
  try {
    const pr = remote.host === 'github' ? await githubPr($, root, remote.repo, branch) : await bitbucketPr($, options, remote.repo, branch)
    prs.set(root, { at: now, okAt: now, branch, pr })
    return pr ?? undefined
  } catch {
    const kept = { at: now, okAt: cached?.okAt ?? 0, branch, pr: cached?.pr ?? null, failed: true }
    prs.set(root, kept)
    return shown(kept)
  }
}

async function bitbucketPr($: any, options: PluginOptions, repo: Repo, branch: string): Promise<PrInfo | null> {
  const server = String(options.bitbucketServer || 'bitbucket')
  const found = pickPr(mcpJson(await $.mcp.call(server, READ_TOOL, prQuery(repo, branch))))
  if (!found) return null
  const ci = found.state === 'OPEN' ? ciOf(mcpJson(await $.mcp.call(server, READ_TOOL, statusQuery(repo, found.id)))) : 'none'
  return { ...found, ci } as PrInfo
}

/** gh 沒裝、沒登入或沒網路：丟出去，由 prProbe 沿用上一次的結果。 */
async function githubPr($: any, root: string, repo: GhRepo, branch: string): Promise<PrInfo | null> {
  const r = await $.process.run(ghPrArgs(repo, branch), { cwd: root, timeoutMs: 15_000 })
  if (r.exitCode !== 0) throw new Error(String(r.stderr || 'gh pr list failed'))
  return pickGhPr(JSON.parse(String(r.stdout)), repo.owner)
}

/**
 * 這個分支要併進去的分支（候選，依序）：PR 目標 → 最新的 origin/release/* → dispatch.json 的 card.base → origin/HEAD。
 * 不含分支自己（主工作區在 main 上時不拿 origin/main 當基準）。
 */
export async function baseRefs($: any, c: Pick<Case, 'root' | 'git' | 'pr'>, cardBase = ''): Promise<string[]> {
  const release = (await git($, c.root, ['for-each-ref', '--sort=-committerdate', '--count=1', '--format=%(refname:short)', 'refs/remotes/origin/release/'])) ?? ''
  const originHead = (await git($, c.root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])) ?? ''
  const own = c.git?.branch ?? ''
  const list = [c.pr?.dest ? `origin/${c.pr.dest}` : '', release, cardBase.trim(), originHead].map(r => r.trim())
  // `-` 開頭的會被 git 當成選項（card.base 來自專案設定檔，不一定可信），一律不用。
  return [...new Set(list.filter(r => r && !r.startsWith('-') && r !== own && r !== `origin/${own}`))]
}

/** 分支相對第一個找得到 merge-base 的候選：基準分支與分叉點。都找不到就 null。 */
export async function diffBase($: any, c: Pick<Case, 'root' | 'git' | 'pr'>, cardBase = ''): Promise<{ target: string; base: string } | null> {
  for (const target of await baseRefs($, c, cardBase)) {
    const base = await git($, c.root, ['merge-base', 'HEAD', target])
    if (base) return { target, base }
  }
  return null
}

/**
 * git 判斷合併：分支 HEAD 是經由 merge commit 併進哪個候選分支——HEAD 在它裡面，但不在它的 first-parent 主線上。
 * 剛開的分支、停在 main 被 release 包含的主工作區，HEAD 都在主線上，不算；squash、rebase、fast-forward 合併也因此看不出來，
 * 那些靠 PR 狀態。只在合併段才問。找到就一直記住；沒找到兩分鐘內不重問（force 例外）。
 */
export async function mergedProbe($: any, c: Pick<Case, 'root' | 'git' | 'pr'>, cardBase = '', force = false): Promise<string | undefined> {
  const head = c.git?.head
  if (!head) return undefined
  const key = `${c.root}\n${head}`
  const hit = merges.get(key)
  if (hit) return hit
  const later = await mergedBefore($, c)
  if (later) { merges.set(key, later); return later }
  const now = await $.clock.now()
  const missed = mergeMisses.get(key)
  if (!force && missed !== undefined && now - missed < MERGE_MISS_MS) return undefined
  for (const ref of await baseRefs($, c, cardBase)) {
    if (await mergedThrough($, c.root, head, ref)) {
      merges.set(key, ref); mergeMisses.delete(key)
      await rememberMerged($, c.root, { branch: c.git!.branch, head, into: ref })
      return ref
    }
  }
  mergeMisses.set(key, now)
  return undefined
}

/**
 * 這個分支之前在某個 HEAD 被 git 認定合併過，那個 HEAD 還在現在 HEAD 的 first-parent 鏈上：仍算已合併，跟 PR 合併後再 commit 一樣。
 * 合併後在分支上補 commit、或把基準分支併回分支，沿第一個父往回走都會走到它；同名分支從已包含舊合併的基準分支重開，
 * 鏈走的是基準分支的主線，舊 HEAD 只是某個 merge commit 的第二個父，不算。
 * 有 PR 資訊（例如之後的 commit 開了新 PR）就照 PR 走；切到別的分支也不算。
 */
async function mergedBefore($: any, c: Pick<Case, 'root' | 'git' | 'pr'>): Promise<string | undefined> {
  if (c.pr || !c.git) return undefined
  const was = (await gitMerged($))[c.root]
  if (!was || was.branch !== c.git.branch || was.head === c.git.head) return undefined
  return (await onBranchLine($, c.root, was.head)) ? was.into : undefined
}

/**
 * 沿 to 的第一個父往回走，走到 from 之前的最後一步，回傳那一步的父；from 不是 to 的祖先（先問，便宜）或兩者相同就是 null。
 * 父就是 from：from 在 to 的 first-parent 鏈上；不是：from 是從旁邊（某個 merge commit 的第二個父）併進來的。
 */
async function firstParentLanding($: any, root: string, from: string, to: string): Promise<string | null> {
  if ((await git($, root, ['merge-base', '--is-ancestor', from, to])) === null) return null
  const line = ((await git($, root, ['rev-list', '--first-parent', `${from}..${to}`])) ?? '').split(/\r?\n/).filter(Boolean)
  const oldest = line[line.length - 1]
  return oldest ? git($, root, ['rev-parse', `${oldest}^`]) : null
}

/** commit 在 HEAD 的 first-parent 鏈上。 */
async function onBranchLine($: any, root: string, commit: string): Promise<boolean> {
  return (await firstParentLanding($, root, commit, 'HEAD')) === commit
}

/** HEAD 在 ref 裡、而且是從旁邊併進來的：沿 ref 的第一個父往回走，最後一步的父不是 HEAD。 */
async function mergedThrough($: any, root: string, head: string, ref: string): Promise<boolean> {
  const parent = await firstParentLanding($, root, 'HEAD', ref)
  return !!parent && parent !== head
}

/** 這個分支相對要併進去的分支（見 baseRefs）改了哪些檔，依 HEAD 快取。找不到基準就是空清單（算一般風險，不快取）。 */
export async function riskOf($: any, c: Case, extra: readonly [RegExp, string][] = [], cardBase = ''): Promise<Risk> {
  const head = c.git?.head
  if (!head) return classify([], extra)
  const cached = risks.get(`${c.root}\n${head}`)
  if (cached) return cached
  const found = await diffBase($, c, cardBase)
  const files = found ? ((await git($, c.root, ['diff', '--name-only', `${found.base}..HEAD`])) ?? '').split(/\r?\n/) : []
  const risk = classify(files, extra)
  // 找不到基準（例如還沒 fetch）不快取，下次找到了再判斷，免得高風險被當成一般記住。
  if (found) risks.set(`${c.root}\n${head}`, risk)
  return risk
}

/** 審查剛結束：把審查檔留一份到 reviews/，給之後的審查找「重複出現的問題」。只寫這個資料夾，不碰卡片。 */
export async function archiveReview($: any, options: PluginOptions, c: Case, security: boolean, at: number) {
  const text = await $.fs.read(`${c.root}/${security ? SECURITY_FILE : REVIEW_FILE}`).catch(() => null)
  if (!text) return
  const dir = (await deskPaths($, options)).reviews
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

/** 全域 dispatch.json 疊上目前專案的 dispatch.json；都讀不到就是預設值。 */
export async function loadSettings($: any, options: PluginOptions): Promise<DispatchSettings> {
  const paths = await deskPaths($, options)
  const read = (path: string | null) => path ? $.fs.read(path).catch(() => null) as Promise<string | null> : Promise.resolve(null)
  const [own, project] = await Promise.all([read(paths.settings), read(paths.projectSettings)])
  return parseSettings(mergeSettingsText(own, project))
}

/** 主工作區的容器：docker compose ps；Docker 沒開或讀不到就記錯誤，不擋其他東西。 */
export async function containers($: any, options: PluginOptions): Promise<ContainerSummary> {
  // dispatch.json 的 composeDir 優先（跟著專案），再來是 plugin 選項；都沒有就不看容器（面板不顯示容器列，檢查也不先確認容器）。
  const own = (await loadSettings($, options)).composeDir
  if (!own && !String(options.composeDir ?? '').trim()) return { total: 0, running: 0, down: [], unhealthy: [] }
  const dir = own ? expandHome(own, await home($)) : await optionPath($, options, 'composeDir', '')
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

/** Agent 最近幾行有意義的輸出。 */
export async function logTail($: any, id: string | undefined, n = 10): Promise<string[]> {
  if (!id) return []
  const r = await $.process.run(['claude', 'logs', id], { timeoutMs: LOGS_TIMEOUT_MS }).catch(() => null)
  return r && r.exitCode === 0 ? logLines(String(r.stdout), n) : []
}

/** 完成檢查最長跑多久。 */
export const VERIFY_TIMEOUT_MS = 600_000

/** 在任務根目錄跑卡片的完成檢查指令；跑不起來也記成一次未通過。 */
export async function verifyResult($: any, c: Case): Promise<Verify> {
  const head = (await gitProbe($, c.root)).git?.head
  try {
    const r = await $.process.run(['sh', '-c', c.verify], { cwd: c.root, timeoutMs: VERIFY_TIMEOUT_MS })
    const lines = `${r.stdout}\n${r.stderr}`.split(/[\r\n]+/).map((l: string) => plain(l).trimEnd()).filter(Boolean)
    return { command: c.verify, at: await $.clock.now(), ok: r.exitCode === 0, exitCode: r.exitCode, tail: lines.slice(-4), truncated: !!r.isStdoutTruncated, ...(head ? { head } : {}) }
  } catch (error) {
    return { command: c.verify, at: await $.clock.now(), ok: false, exitCode: -1, tail: [plain(error instanceof Error ? error.message : String(error))], truncated: false, ...(head ? { head } : {}) }
  }
}
