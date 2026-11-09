// 探測：git、tag、PR（Bitbucket／GitHub）、合併、風險、Agent 記錄、容器、版本、模型。都是讀，不寫卡片；
// 唯一的寫入是審查存底（archiveReview）。快取放在這個模組裡，重新載入就清空。
import type { PluginOptions } from 'claude-code'
import type { AgentInfo, Case, PrInfo, Snapshot, Verify } from '../types'
import { expandHome } from './card'
import { beaconAgentInfo, beaconRootOf, isBeaconId, parseBeaconJson } from './agents'
import { lastMeaningful, parseOsc7501, plain } from './text'
import { summarizeCheck } from './verify-summary'
import { MODEL_KINDS, modelFor, normalizeRoot, parseSettings, settingsProblems } from './settings'
import { REVIEW_FILE, SECURITY_FILE } from './prompts/review'
import { markOf } from './worktree-mark'
import type { DispatchSettings, ModelKind, SettingsReport } from './settings'
import type { WorktreeMark } from './worktree-mark'
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
import { parseMergeTree } from './catchup'
import type { Project } from './project'

const PR_TTL_MS = 5 * 60_000
/** 讀 PR 失敗（gh 沒登入、斷網、MCP 斷線）後多久再試；舊結果最多沿用多久。 */
const PR_RETRY_MS = 60_000
/** PR 開著、CI 還在跑時多久再查一次（按 r 重新整理會強制重查）。 */
const PR_PENDING_MS = 60_000
const PR_STALE_MS = 60 * 60_000
/** git 判斷「還沒合併」後多久再問（按 r 重新整理會強制重問）。 */
const MERGE_MISS_MS = 2 * 60_000
const LOGS_TIMEOUT_MS = 15_000
let deskVersion: string | undefined
export type Remote = { host: 'bitbucket'; repo: Repo } | { host: 'github'; repo: GhRepo } | null
const remotes = new Map<string, Remote>()
const tags = new Map<string, string>()
/** 根目錄 → git common dir（worktree 共用的那個 .git）；只快取問得到的。 */
const commonDirs = new Map<string, string>()
/** common dir＋HEAD → 上次 tag --contains 沒找到時的 tag 簽章；簽章沒變（沒打新 tag）就不重問。 */
const tagMisses = new Map<string, string>()
/** 根目錄＋分支 → 上次照 origin 同名分支算領先落後時的 HEAD＋簽章與結果；都沒變就沿用。 */
const originCounts = new Map<string, { stamp: string; counts: Partial<GitState> }>()
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
let rememberChain: Promise<void> = Promise.resolve()
async function rememberMerged($: any, root: string, entry: GitMerged[string]) {
  const next = rememberChain.then(async () => {
    try { await $.store.set(GIT_MERGED_KEY, { ...(await gitMerged($)), [root]: entry }) } catch { /* 下次合併段再問一次 git */ }
  })
  rememberChain = next.catch(() => {})
  await next
}
const mergeMisses = new Map<string, number>()
const projects = new Map<string, Project>()
/** 根目錄＋HEAD → 最近一次變更的時間；HEAD 不變它就不變。 */
const commitTimes = new Map<string, CommitTimes>()
/** 一次 commit 改到超過這麼多檔案就不逐一看修改時間，直接用 commit 時間。 */
const MAX_STAT_FILES = 50

export type CommitTimes = { at: number; changedAt: number }

let cachedHome: string | undefined

export function clearProbeCaches() {
  remotes.clear()
  tags.clear()
  commonDirs.clear()
  tagMisses.clear()
  originCounts.clear()
  prs.clear()
  risks.clear()
  merges.clear()
  mergeMisses.clear()
  projects.clear()
  commitTimes.clear()
  cachedHome = undefined
}

export async function home($: any): Promise<string> {
  if (cachedHome !== undefined) return cachedHome
  const h = (await $.env.get('HOME').catch(() => null)) || (await $.env.get('USERPROFILE').catch(() => null)) || ''
  cachedHome = String(h).replace(/\\/g, '/')
  return cachedHome
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

/** 這個根目錄的 git common dir（worktree 的 ref 都放在那裡）；問不到是 null，下次再問。 */
async function commonDir($: any, root: string): Promise<string | null> {
  const known = commonDirs.get(root)
  if (known) return known
  const dir = await git($, root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (dir) commonDirs.set(root, dir)
  return dir
}

/** packed-refs 讀不到時在簽章裡的值：git init 起家、沒 gc／pack-refs 過的 repo 本來就沒有這個檔；之後被建立，時間取代它，簽章就變了。 */
const NO_PACKED_REFS = '-'

/**
 * ref 檔的修改時間串成的簽章：git 打 tag、push、fetch 都會換掉 ref 檔（或在 refs/tags 新增檔、改寫 packed-refs），時間跟著變。
 * required（refs/tags、origin 同名分支的 ref 檔）任何一個讀不到（不是一般的 git 資料夾、reftable、只在 packed-refs 裡）就是 null：
 * 不快取，照舊問 git。packed-refs 讀不到是常態，記成 NO_PACKED_REFS 照樣給簽章。
 */
async function refStamp($: any, common: string, required: readonly string[]): Promise<string | null> {
  const mtime = async (p: string) => ((await ($.fs.stat(p) as Promise<{ mtimeMs?: number }>).catch(() => null))?.mtimeMs)
  const [packed, ...times] = await Promise.all([`${common}/packed-refs`, ...required].map(mtime))
  return times.every(t => typeof t === 'number') ? [...times, typeof packed === 'number' ? packed : NO_PACKED_REFS].join('\n') : null
}

/**
 * 分支、HEAD、包含 HEAD 的最舊 v* tag。找到的 tag 依 HEAD 快取（tag 打了不會消失）；
 * 沒找到時記下當時 refs/tags 與 packed-refs 的修改時間（沒有 packed-refs 也算一種），沒打新 tag（時間沒變）就不重問，讀不到 refs/tags 的時間就每次重問。不是 git 資料夾就全空。
 */
export async function gitProbe($: any, root: string): Promise<{ git?: { branch: string; head: string }; tag?: string }> {
  // --abbrev-ref 會套用到它後面每一個參數，所以 commit 要寫在它前面。
  const out = await git($, root, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'])
  if (!out) return {}
  const [head, branch] = out.split(/\r?\n/)
  if (!branch || !head) return {}
  const tag = tags.get(head) ?? await tagMiss($, root, head)
  return { git: { branch, head }, ...(tag ? { tag } : {}) }
}

/** 快取沒有這個 HEAD 的 tag：簽章跟上次沒找到時一樣就直接回空；否則問 git（先讀簽章再問，問完才打的 tag 下一輪看得到）。 */
async function tagMiss($: any, root: string, head: string): Promise<string> {
  const common = await commonDir($, root)
  const stamp = common ? await refStamp($, common, [`${common}/refs/tags`]) : null
  const key = `${common}\n${head}`
  if (stamp !== null && tagMisses.get(key) === stamp) return ''
  const tag = ((await git($, root, ['tag', '--contains', head, '--list', 'v*', '--sort=creatordate'])) ?? '').split(/\r?\n/).filter(Boolean)[0] ?? ''
  if (tag) { tags.set(head, tag); tagMisses.delete(key) } else if (stamp !== null) tagMisses.set(key, stamp)
  return tag
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

/** 這個 worktree 的 origin 是哪一家（讀 PR 與推送 Agent 開 PR 都看它）。只快取認得出來的 remote：之後才加 origin 或改網址，下一輪就會重讀。 */
export async function originRemote($: any, root: string): Promise<Remote> {
  if (!remotes.get(root)) remotes.set(root, remoteOf((await git($, root, ['remote', 'get-url', 'origin'])) ?? ''))
  return remotes.get(root) ?? null
}

/**
 * 這個分支的 PR 與 CI：Bitbucket 用 MCP 的 bb_get、GitHub 用 gh pr list，都是唯讀；發版線不查。
 * 5 分鐘快取，CI 跑中時每 60 秒查一次；讀失敗後一分鐘內不再試，舊結果超過一小時就不顯示。force（按 r、推送 Agent 剛結束）一定重查。
 */
export async function prProbe($: any, options: PluginOptions, root: string, branch: string, now: number, force = false): Promise<PrInfo | undefined> {
  if (/^release\//.test(branch) || branch === 'HEAD') return undefined
  const remote = await originRemote($, root)
  if (!remote) return undefined
  const own = prs.get(root)
  const cached = own?.branch === branch ? own : undefined
  const shown = (c: typeof cached) => c && now - c.okAt < PR_STALE_MS ? c.pr ?? undefined : undefined
  const live = !cached?.failed && cached?.pr?.state === 'OPEN' && cached.pr.ci === 'pending'
  if (cached && !force && now - cached.at < (cached.failed ? PR_RETRY_MS : live ? PR_PENDING_MS : PR_TTL_MS)) return shown(cached)
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

/** 選基準分支用得到的欄位：任務根目錄、git、PR（目標），與卡片的「基準」欄。 */
export type BaseInput = Pick<Case, 'root' | 'git' | 'pr' | 'base'>

/**
 * 這個分支要併進去的分支（候選，依序）：PR 目標 → 卡片「基準」欄 → 最新的 origin/release/* → dispatch.json 的 card.base → origin/HEAD。
 * 卡片記了基準（開卡時的分支）就不猜最新的 release 線：同時有好幾條 release 線時，最新的那條不一定是這張卡要併的。
 * 基準欄的分支已經不在（合併後刪掉、拼錯）就當沒有這欄，照舊順序找，免得開 PR 對到不存在的分支。
 * 不含分支自己（主工作區在 main 上時不拿 origin/main 當基準）。
 */
export async function baseRefs($: any, c: BaseInput, cardBase = ''): Promise<string[]> {
  const recorded = await recordedBase($, c)
  const release = recorded ? '' : (await git($, c.root, ['for-each-ref', '--sort=-committerdate', '--count=1', '--format=%(refname:short)', 'refs/remotes/origin/release/'])) ?? ''
  const originHead = (await git($, c.root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])) ?? ''
  const branch = c.git?.branch ?? ''
  const list = [c.pr?.dest ? `origin/${c.pr.dest}` : '', recorded, release, cardBase.trim(), originHead].map(r => r.trim())
  // `-` 開頭的會被 git 當成選項（card.base 來自專案設定檔、基準欄來自卡片，不一定可信），一律不用。
  return [...new Set(list.filter(r => r && !r.startsWith('-') && r !== branch && r !== `origin/${branch}`))]
}

/** 卡片基準欄的分支，git 找得到才算；沒有這欄、`-` 開頭（會被當成選項）或分支不在都是空字串。 */
async function recordedBase($: any, c: BaseInput): Promise<string> {
  const ref = c.base?.trim() ?? ''
  if (!ref || ref.startsWith('-')) return ''
  return (await git($, c.root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) ? ref : ''
}

/** 分支相對第一個找得到 merge-base 的候選：基準分支與分叉點。都找不到就 null。 */
export async function diffBase($: any, c: BaseInput, cardBase = ''): Promise<{ target: string; base: string } | null> {
  for (const target of await baseRefs($, c, cardBase)) {
    const base = await git($, c.root, ['merge-base', 'HEAD', target])
    if (base) return { target, base }
  }
  return null
}

/**
 * git 判斷合併，三條規則：1) 分支 HEAD 經由 merge commit 併進某個候選分支——HEAD 在它裡面，但不在它的 first-parent 主線上；
 * 2) 之前在某個 HEAD 認定過合併，之後分支又有 commit 或 fast-forward 到基準分支（mergedBefore）；
 * 3) HEAD 還不在基準分支裡，但工作桌曾在這條分支看過的 HEAD（`seen`：審查時的 HEAD）就是分叉點，且它經由 merge commit 併進（mergedCommit 第二段）。
 * 剛開的分支、停在 main 被 release 包含的主工作區，HEAD 都在主線上，不算；squash、rebase、fast-forward 合併也因此看不出來，
 * 那些靠 PR 狀態。只在合併段才問。找到就一直記住；沒找到兩分鐘內不重問（force 例外）。
 */
export async function mergedProbe($: any, c: BaseInput, cardBase = '', force = false, seen: readonly string[] = []): Promise<string | undefined> {
  const head = c.git?.head
  if (!head) return undefined
  const key = `${c.root}\n${head}`
  const hit = merges.get(key)
  if (hit) return hit
  const now = await $.clock.now()
  const missed = mergeMisses.get(key)
  if (!force && missed !== undefined && now - missed < MERGE_MISS_MS) return undefined
  const was = (await gitMerged($))[c.root]
  const later = await mergedBefore($, c, was)
  if (later) { merges.set(key, later); return later }
  for (const ref of await baseRefs($, c, cardBase)) {
    const mergedHead = await mergedCommit($, c, head, ref, was, seen)
    if (mergedHead) {
      merges.set(key, ref); mergeMisses.delete(key)
      await rememberMerged($, c.root, { branch: c.git!.branch, head: mergedHead, into: ref })
      return ref
    }
  }
  mergeMisses.set(key, now)
  return undefined
}

/**
 * 這個分支之前在某個 HEAD 被 git 認定合併過，那個 HEAD 還在現在 HEAD 的 first-parent 鏈上，或分支直接 fast-forward 到基準分支裡：
 * 仍算已合併，跟 PR 合併後再 commit 一樣。合併後在分支上補 commit、或把基準分支併回分支（無論有無 fast-forward）都算；
 * 同名分支從已包含舊合併的基準分支重開並有新 commit 時，新 HEAD 不在基準分支裡、舊 HEAD 也只是某個 merge commit 的第二個父，不算。
 * 有 PR 資訊（例如之後的 commit 開了新 PR）就照 PR 走；切到別的分支也不算。
 */
async function mergedBefore($: any, c: BaseInput, was?: GitMerged[string]): Promise<string | undefined> {
  if (c.pr || !c.git || !was || was.branch !== c.git.branch || was.head === c.git.head) return undefined
  const landing = await firstParentLanding($, c.root, was.head, 'HEAD')
  if (!landing) return undefined
  if (landing === was.head) return was.into
  return (await git($, c.root, ['merge-base', '--is-ancestor', 'HEAD', was.into])) !== null ? was.into : undefined
}

async function landingParent($: any, root: string, from: string, to: string): Promise<string | null> {
  const line = ((await git($, root, ['rev-list', '--first-parent', `${from}..${to}`])) ?? '').split(/\r?\n/).filter(Boolean)
  const oldest = line[line.length - 1]
  return oldest ? git($, root, ['rev-parse', `${oldest}^`]) : null
}

/**
 * 沿 to 的第一個父往回走，走到 from 之前的最後一步，回傳那一步的父；from 不是 to 的祖先（先問，便宜）或兩者相同就是 null。
 * 父就是 from：from 在 to 的 first-parent 鏈上；不是：from 是從旁邊（某個 merge commit 的第二個父）併進來的。
 */
async function firstParentLanding($: any, root: string, from: string, to: string): Promise<string | null> {
  if ((await git($, root, ['merge-base', '--is-ancestor', from, to])) === null) return null
  return landingParent($, root, from, to)
}

/**
 * 找出這個分支經由 merge commit 併進 ref 的那個 commit：HEAD 已在 ref 裡就看 HEAD；HEAD 不在 ref 裡（例如合併後兩分鐘內又補了 commit，
 * 工作桌還沒在合併當下的 HEAD 問過 git）就看分支與 ref 的 merge-base 是否在 HEAD 的 first-parent 鏈上且經由 merge commit 併進 ref。
 * 第二段只接受工作桌曾在這條分支看過的 HEAD（`seen`）當分叉點：從別條已合併分支的 commit 開出來、還沒合併的分支（疊分支、
 * 從已併回 main 的 release 分支切出的 fix）分叉點也符合「經由 merge commit 併進」，但那個 commit 從來不是這條分支的 HEAD，不算。
 */
async function mergedCommit($: any, c: BaseInput, head: string, ref: string, was: GitMerged[string] | undefined, seen: readonly string[]): Promise<string | null> {
  if ((await git($, c.root, ['merge-base', '--is-ancestor', 'HEAD', ref])) !== null) {
    const parent = await landingParent($, c.root, 'HEAD', ref)
    return parent && parent !== head ? head : null
  }
  if (c.pr) return null
  const fork = await git($, c.root, ['merge-base', 'HEAD', ref])
  if (!fork || fork === head || !seen.includes(fork) || (was && was.head === fork && was.branch !== c.git!.branch)) return null
  if ((await landingParent($, c.root, fork, 'HEAD')) !== fork) return null
  const intoParent = await landingParent($, c.root, fork, ref)
  return intoParent && intoParent !== fork ? fork : null
}

/** 合併段 fetch 基準分支的間隔（每個根目錄）；按 r 重新整理例外。 */
const FETCH_TTL_MS = 5 * 60_000
const GIT_NET_TIMEOUT_MS = 30_000
/** 根目錄 → 最後一次 fetch 基準分支的時間。 */
const fetches = new Map<string, number>()
/** 根目錄＋HEAD＋基準分支的 commit → 衝突的檔（空清單＝沒衝突）。 */
const conflicts = new Map<string, string[]>()
type Tried = { ref: string; into: string; files: string[] }
/** 根目錄＋HEAD＋PR 目標 → 最近一次試合併的結果（null＝不知道）與時間；下一次 fetch 之前直接沿用，重新整理不必每輪都問 git。 */
const recent = new Map<string, { at: number; tried: Tried | null }>()

/**
 * 合併段：分支跟基準分支（diffBase 的 target，跟風險、審查同一個）試合併有沒有衝突。基準是 origin/… 時先 fetch 那一個分支
 * （只更新遠端追蹤分支；每個根目錄最多 5 分鐘一次，force 例外；失敗就用本機現有的），再用 `git merge-tree` 試合併，不動工作區與 HEAD。
 * desk 自己只跑 fetch、rev-parse、merge-tree 與讀取，不 merge、commit、push、checkout。依「根目錄＋HEAD＋基準的 commit」快取；
 * 同一個 HEAD 在下一次 fetch 之前沿用上次的結果；有衝突時再數未提交的檔。沒衝突或不知道（git 太舊、失敗）是 undefined。
 */
export async function conflictProbe($: any, c: BaseInput, cardBase: string, now: number, force = false): Promise<Case['conflict']> {
  const head = c.git?.head
  if (!head) return undefined
  const key = `${c.root}\n${head}\n${c.pr?.dest ?? ''}\n${c.base ?? ''}`
  const last = recent.get(key)
  const again = !last || force || now - last.at >= FETCH_TTL_MS
  const tried = again ? await tryMerge($, c, head, cardBase, now, force) : last.tried
  if (tried === undefined) return undefined
  if (again) recent.set(key, { at: now, tried })
  if (!tried?.files.length) return undefined
  return { ...tried, dirty: (await worktreeMark($, c.root)).files }
}

/**
 * 背景 fetch 不能停下來問帳密（沒人在看，只會卡到逾時）：關掉 git 的帳密提示；ssh 加 BatchMode，
 * 沿用你設的 ssh 指令（GIT_SSH_COMMAND 或 core.sshCommand）。設了舊式 GIT_SSH 的不蓋掉它。env 疊在原本的環境上，ssh-agent 照用。
 */
async function quietFetchEnv($: any, root: string): Promise<Record<string, string>> {
  if (envText(await $.env.get('GIT_SSH').catch(() => ''))) return { GIT_TERMINAL_PROMPT: '0' }
  const ssh = envText(await $.env.get('GIT_SSH_COMMAND').catch(() => '')) || await git($, root, ['config', '--get', 'core.sshCommand']) || 'ssh'
  return { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes` }
}

/** 環境變數的值；沒設是空字串。 */
const envText = (value: unknown) => String(value ?? '').trim()

/** fetch（需要的話）後試合併；undefined＝找不到基準分支（不記），null＝git 回答不了。 */
async function tryMerge($: any, c: BaseInput, head: string, cardBase: string, now: number, force: boolean): Promise<Tried | null | undefined> {
  const found = await diffBase($, c, cardBase)
  if (!found) return undefined
  const ref = found.target
  const remote = ref.match(/^origin\/(.+)$/)?.[1]
  const fetchedAt = fetches.get(c.root)
  if (remote && (force || fetchedAt === undefined || now - fetchedAt >= FETCH_TTL_MS)) {
    fetches.set(c.root, now)
    await $.process.run(['git', '-C', c.root, 'fetch', '--quiet', '--no-tags', 'origin', remote], { timeoutMs: GIT_NET_TIMEOUT_MS, env: await quietFetchEnv($, c.root) }).catch(() => null)
  }
  const target = await git($, c.root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (!target) return null
  const key = `${c.root}\n${head}\n${target}`
  let files = conflicts.get(key)
  if (!files) {
    // 要分 exit 0／1，不能用回 null 的 git()。
    const r = await $.process.run(['git', '-C', c.root, 'merge-tree', '--write-tree', '--name-only', '--no-messages', ref, 'HEAD'], { timeoutMs: GIT_NET_TIMEOUT_MS }).catch(() => null)
    const parsed = r ? parseMergeTree(r.exitCode, String(r.stdout ?? '')) : null
    if (!parsed) return null
    files = parsed
    conflicts.set(key, files)
  }
  return { into: remote ?? ref, ref, files }
}

/** 分支相對基準分支（見 diffBase）改了哪些檔；找不到基準就 null。 */
export async function diffFiles($: any, c: BaseInput, cardBase = ''): Promise<{ target: string; files: string[] } | null> {
  const found = await diffBase($, c, cardBase)
  if (!found) return null
  const files = ((await git($, c.root, ['diff', '--name-only', `${found.base}..HEAD`])) ?? '').split(/\r?\n/).filter(Boolean)
  return { target: found.target, files }
}

/**
 * 這個分支相對要併進去的分支（見 baseRefs）改了哪些檔，依 HEAD 與選基準用的輸入（PR 目標、卡片基準欄、card.base）快取：
 * 沒帶 PR 算的不會蓋掉帶 PR 的（重新整理與自動流程要給同一個 c，見 register.tsx 與 auto-chain.ts）。找不到基準就是空清單（算一般風險，不快取）。
 */
export async function riskOf($: any, c: BaseInput, extra: readonly [RegExp, string][] = [], cardBase = ''): Promise<Risk> {
  const head = c.git?.head
  if (!head) return classify([], extra)
  const key = [c.root, head, c.pr?.dest ?? '', c.base ?? '', cardBase.trim()].join('\n')
  const cached = risks.get(key)
  if (cached) return cached
  const found = await diffFiles($, c, cardBase)
  const risk = classify(found?.files ?? [], extra)
  // 找不到基準（例如還沒 fetch）不快取，下次找到了再判斷，免得高風險被當成一般記住。
  if (found) risks.set(key, risk)
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

export const BEACON_FILE = '.task/agent-state.json'
export const AGENT_OUT_FILE = '.task/AGENT-OUT.md'

/** Agent 的整份輸出（`claude logs` 或外部 Agent 的 `.task/AGENT-OUT.md`）；沒有 id 或讀不到是 null。最後一句與最後幾行都從它取，同一輪只讀一次。 */
export async function agentLog($: any, id: string | undefined): Promise<string | null> {
  if (!id) return null
  if (isBeaconId(id)) {
    const root = beaconRootOf(id)
    if (!root) return null
    const text = await $.fs.read(`${root}/${AGENT_OUT_FILE}`).catch(() => null)
    return typeof text === 'string' ? text : null
  }
  const r = await $.process.run(['claude', 'logs', id], { timeoutMs: LOGS_TIMEOUT_MS }).catch(() => null)
  return r && r.exitCode === 0 ? String(r.stdout) : null
}

/** 檢查外部 Agent 信標記錄的 PID 是否還活著（`kill -0 <pid>`）。 */
export async function pidAlive($: any, pid: number | undefined): Promise<boolean> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true
  const r = await $.process.run(['kill', '-0', String(pid)], { timeoutMs: 2_000 }).catch(() => null)
  return !!r && r.exitCode === 0
}

/** 探測 worktree 裡的外部 Agent 信標（`.task/agent-state.json`）與即時輸出（`.task/AGENT-OUT.md`）。 */
export async function beaconProbe($: any, root: string): Promise<{ agent?: AgentInfo; log: string | null }> {
  const [rawBeacon, rawOut] = await Promise.all([
    $.fs.read(`${root}/${BEACON_FILE}`).catch(() => null) as Promise<string | null>,
    $.fs.read(`${root}/${AGENT_OUT_FILE}`).catch(() => null) as Promise<string | null>,
  ])
  const beacon = parseBeaconJson(rawBeacon)
  const osc = rawOut ? parseOsc7501(rawOut) : null
  if (!beacon && !osc) return { log: rawOut }
  const alive = beacon?.pid !== undefined ? await pidAlive($, beacon.pid) : true
  const agent = beaconAgentInfo(root, beacon, osc, lastLineOf(rawOut), alive)
  return { ...(agent ? { agent } : {}), log: rawOut }
}

/** 整份輸出的最後一句話；讀不到是空字串。 */
export const lastLineOf = (log: string | null): string => log === null ? '' : lastMeaningful(log)

/** 整份輸出最近幾行有意義的；讀不到是空清單。 */
export const logTailOf = (log: string | null, n = 10): string[] => log === null ? [] : logLines(log, n)

/** 進行中或停下來問的 agent，最後一句話（`claude logs`）。 */
export async function lastLine($: any, id: string | undefined): Promise<string> {
  return lastLineOf(await agentLog($, id))
}

/** 全域 dispatch.json 疊上目前專案的 dispatch.json；都讀不到就是預設值。 */
export async function loadSettings($: any, options: PluginOptions, preloaded?: DispatchSettings): Promise<DispatchSettings> {
  if (preloaded) return preloaded
  const paths = await deskPaths($, options)
  const read = (path: string | null) => path ? $.fs.read(path).catch(() => null) as Promise<string | null> : Promise.resolve(null)
  const [own, project] = await Promise.all([read(paths.settings), read(paths.projectSettings)])
  return parseSettings(mergeSettingsText(own, project))
}

/** 全域與目前專案的 dispatch.json（路徑同 loadSettings）各自檢查；不疊加，問題才知道是哪一份的。 */
export async function settingsReport($: any, options: PluginOptions): Promise<SettingsReport[]> {
  const paths = await deskPaths($, options)
  const files = [...new Set([paths.settings, ...(paths.projectSettings ? [paths.projectSettings] : [])])]
  return Promise.all(files.map(async path => {
    const text = await ($.fs.read(path) as Promise<string>).catch(() => null)
    return { path, text, problems: text === null ? [] : settingsProblems(text) }
  }))
}

/** 主工作區的容器：docker compose ps；Docker 沒開或讀不到就記錯誤，不擋其他東西。 */
export async function containers($: any, options: PluginOptions, preloadedSettings?: DispatchSettings): Promise<ContainerSummary> {
  // dispatch.json 的 composeDir 優先（跟著專案），再來是 plugin 選項；都沒有就不看容器（面板不顯示容器列，檢查也不先確認容器）。
  const settings = preloadedSettings ?? await loadSettings($, options)
  const own = settings.composeDir
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

/**
 * 這個對話的模型（/model 顯示的那個）與最近一次請求的 effort；派工與同步用的模型與 effort；kinds 只列跟派工不同的種類。
 * 有 projects 覆寫的任務另外列在 byRoot（每種派工實際會用的），確認字照它寫；都用 modelFor 算，跟實際派工同一套規則。
 */
export async function models($: any, options: PluginOptions, turnModel: { model?: string; effort?: string }, roots: readonly string[] = [], preloadedSettings?: DispatchSettings): Promise<Snapshot['models']> {
  const session = turnModel.model || String((await $.session.model().catch(() => '')) ?? '')
  const settings = preloadedSettings ?? await loadSettings($, options)
  const sync = modelFor(settings, '', 'sync')
  const pick = (root: string, kind: ModelKind) => { const m = modelFor(settings, root, kind); return { model: m.model, effort: m.effort } }
  const kinds = MODEL_KINDS.map(kind => ({ kind, ...pick('', kind) })).filter(k => k.model !== settings.model || k.effort !== settings.effort)
  const overridden = [...new Set(roots.map(normalizeRoot))].filter(r => settings.projects[r]?.model !== undefined || settings.projects[r]?.effort !== undefined)
  const byRoot = Object.fromEntries(overridden.map(r => [r, Object.fromEntries(MODEL_KINDS.map(kind => [kind, pick(r, kind)]))]))
  return {
    ...(session ? { session } : {}), ...(turnModel.effort ? { effort: turnModel.effort } : {}),
    dispatch: { model: settings.model, effort: settings.effort },
    ...(kinds.length ? { kinds } : {}),
    ...(overridden.length ? { byRoot } : {}),
    sync: { model: settings.sync.model, effort: settings.sync.effort || (settings.sync.model ? '' : settings.effort), fresh: sync.fresh },
  }
}

/** 指紋不看的路徑：卡片（.desk、.console）與審查、計畫、回報檔（.task）是 Agent、審查、你都會寫的，不算誰留下的改動。 */
const MARK_EXCLUDES = [':(exclude).desk', ':(exclude).console', ':(exclude).task']

/** worktree 未提交狀態的指紋：git status 與對 HEAD 的 diff 做雜湊；不是 git 資料夾或 git 失敗就當乾淨。 */
export async function worktreeMark($: any, root: string): Promise<WorktreeMark> {
  const status = await git($, root, ['status', '--porcelain=v2', '--untracked-files=all', '--', '.', ...MARK_EXCLUDES])
  if (status === null) return markOf('', '')
  const diff = await git($, root, ['diff', 'HEAD', '--', '.', ...MARK_EXCLUDES])
  return markOf(status, diff ?? '')
}

/** git status --porcelain=v2 --branch 的摘要；不是 git 資料夾就 undefined。 */
export async function gitStatus($: any, root: string): Promise<GitState | undefined> {
  const out = await git($, root, ['status', '--porcelain=v2', '--branch'])
  if (out === null) return undefined
  const st = parseGitStatus(out)
  return st.upstream ? st : { ...st, ...(await originBranch($, root, out)) }
}

/**
 * 沒設追蹤分支（card.py new 會取消追蹤；用 git push origin <分支> 推過也不會設）：照 origin 上的同名分支算領先、落後。
 * 算到的數字依「HEAD＋origin 同名分支 ref 檔與 packed-refs 的修改時間」快取：HEAD 沒動、遠端分支沒被 push／fetch 更新就沿用；
 * 沒有 packed-refs 照樣快取；讀不到遠端分支 ref 檔的時間或沒算到數字就不快取，每次照舊問 git。
 */
async function originBranch($: any, root: string, status: string): Promise<Partial<GitState>> {
  const branch = status.match(/^# branch\.head (.+)$/m)?.[1]
  if (!branch || branch === '(detached)') return {}
  const head = status.match(/^# branch\.oid (\S+)$/m)?.[1]
  const common = head ? await commonDir($, root) : null
  const refs = common ? await refStamp($, common, [`${common}/refs/remotes/origin/${branch}`]) : null
  const stamp = refs === null ? null : `${head}\n${refs}`
  const key = `${root}\n${branch}`
  const known = originCounts.get(key)
  if (stamp !== null && known?.stamp === stamp) return known.counts
  const found = (await git($, root, ['rev-list', '--left-right', '--count', `refs/remotes/origin/${branch}...HEAD`]))?.trim().match(/^(\d+)\s+(\d+)$/)
  if (!found) return {}
  const counts = { upstream: true, behind: Number(found[1]), ahead: Number(found[2]) }
  if (stamp !== null) originCounts.set(key, { stamp, counts })
  return counts
}

/** Agent 最近幾行有意義的輸出。 */
export async function logTail($: any, id: string | undefined, n = 10): Promise<string[]> {
  return logTailOf(await agentLog($, id), n)
}

/** 完成檢查最長跑多久。 */
export const VERIFY_TIMEOUT_MS = 600_000

/** 在任務根目錄跑卡片的完成檢查指令；跑不起來也記成一次未通過。沒過時從整份輸出整理失敗摘要給面板看，tail 留給修正提示。 */
export async function verifyResult($: any, c: Case): Promise<Verify> {
  const head = (await gitProbe($, c.root)).git?.head
  try {
    const r = await $.process.run(['sh', '-c', c.verify], { cwd: c.root, timeoutMs: VERIFY_TIMEOUT_MS })
    const lines = `${r.stdout}\n${r.stderr}`.split(/[\r\n]+/).map((l: string) => plain(l).trimEnd()).filter(Boolean)
    const ok = r.exitCode === 0
    return { command: c.verify, at: await $.clock.now(), ok, exitCode: r.exitCode, tail: lines.slice(-4), truncated: !!r.isStdoutTruncated, ...(head ? { head } : {}), ...(ok ? {} : { summary: summarizeCheck(lines) }) }
  } catch (error) {
    const tail = [plain(error instanceof Error ? error.message : String(error))]
    return { command: c.verify, at: await $.clock.now(), ok: false, exitCode: -1, tail, truncated: false, ...(head ? { head } : {}), summary: summarizeCheck(tail) }
  }
}
