// desk 自我更新：`/desk update` 與面板的「更新版本」按鈕把 desk 更新到 GitHub 上的最新版本；自動檢查每 24 小時查一次、只提示不安裝。
// 只更新 desk 自己，不碰專案與任務。版號讀 plugin.json，提示只講版號。無法乾淨更新時什麼都不動（不 stash、不切換、不合併），說明原因。
// 跨檔傳 $ 的函式一律用 function 宣告（箭頭函式會被引擎掃描拒絕載入）。

export const UPDATE_KEY = 'updateCheck'
export const UPDATE_EVERY_MS = 24 * 60 * 60_000
const FETCH_TIMEOUT_MS = 60_000
const UPDATE_TIMEOUT_MS = 180_000
const LIST_TIMEOUT_MS = 30_000
const MANIFEST = '.claude-plugin/plugin.json'
const MARKETPLACE = '.claude-plugin/marketplace.json'

/** desk 裝在哪：GitHub marketplace（clone 在 installLocation）或本機資料夾（directory marketplace）。 */
export type Install = { id: string; marketplace: string; scope?: string; version: string; kind: 'github' | 'folder'; dir: string }
/** 上次自動或手動查到的結果，存在 $.store（跨重開有效）；notified＝已經提示過的版號。 */
export type UpdateCheck = { at: number; latest: string; current: string; notified?: string }
export type UpdateResult = { tone: 'success' | 'subtle' | 'warning' | 'error'; text: string; check?: UpdateCheck }

type RawPlugin = { id?: string; version?: string; scope?: string; enabled?: boolean; installPath?: string; readFromFolder?: string }
type RawMarket = { name?: string; source?: string; path?: string; installLocation?: string }

/** 版號比大小：逐段比數字，`-` 後的預發布標記不看。 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/, '').split('-')[0]!.split('.').map(n => Number.parseInt(n, 10) || 0)
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}
export const isNewer = (latest: string, current: string) => !!latest && !!current && compareVersions(latest, current) > 0

export const firstLine = (text: string) => String(text ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? ''

export const noticeText = (latest: string) => `有新版本 ${latest}`
export const updatedText = (from: string, to: string) => `desk 已更新版本：${from} → ${to}，重新啟動 Claude Code 後生效`
export const upToDateText = (version: string) => `desk 已是最新版本（${version}）`

/**
 * 面板與摘要列要不要顯示「有新版本」：查到的比已安裝的新才顯示。已安裝的取「上次查的時候」與「現在載入中的」較新的那個，
 * 在工作桌以外更新過（claude plugin update、別的專案 /desk update）再重開，就不會拿過時的版號比。
 */
export function noticeOf(check: UpdateCheck | null, loaded = ''): { latest: string } | undefined {
  if (!check) return undefined
  const current = isNewer(loaded, check.current) ? loaded : check.current
  return isNewer(check.latest, current) ? { latest: check.latest } : undefined
}

export function parseCheck(v: unknown): UpdateCheck | null {
  const c = v as UpdateCheck | null
  return c && typeof c === 'object' && typeof c.at === 'number' && typeof c.latest === 'string' && typeof c.current === 'string' ? c : null
}

/** `claude plugin list --json` 與 `marketplace list --json` 對出 desk 的安裝；同名多筆時以載入中的這份（root）為準。 */
export function pickInstall(plugins: RawPlugin[], markets: RawMarket[], name: string, root: string): Install | null {
  const mine = plugins.filter(p => typeof p.id === 'string' && p.id.startsWith(`${name}@`))
  const at = (p: RawPlugin) => p.installPath === root || p.readFromFolder === root
  const p = mine.find(at) ?? mine.find(x => x.enabled !== false) ?? mine[0]
  if (!p?.id || !p.version) return null
  const marketplace = p.id.slice(name.length + 1)
  const m = markets.find(x => x.name === marketplace)
  const folder = p.readFromFolder || (m?.source === 'directory' ? m.path || m.installLocation : '')
  const dir = folder || m?.installLocation || ''
  if (!dir) return null
  return { id: p.id, marketplace, ...(p.scope ? { scope: p.scope } : {}), version: p.version, kind: folder ? 'folder' : 'github', dir }
}

/** marketplace.json 裡 desk 的 source（例如 `./`）→ plugin.json 在 repo 裡的路徑。 */
export function manifestPath(marketplaceJson: string | null, name: string): string {
  try {
    const source = JSON.parse(marketplaceJson ?? '').plugins?.find((p: any) => p?.name === name)?.source
    if (typeof source === 'string') {
      const dir = source.replace(/^\.\//, '').replace(/^\.$/, '').replace(/\/+$/, '')
      if (!dir.split('/').includes('..')) return dir ? `${dir}/${MANIFEST}` : MANIFEST
    }
  } catch { /* 讀不到就當作在 repo 根目錄 */ }
  return MANIFEST
}

type Run = { ok: boolean; out: string; err: string }
async function run($: any, argv: string[], timeoutMs: number): Promise<Run> {
  const r = await $.process.run(argv, { timeoutMs }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))
  return { ok: r.exitCode === 0, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') || String(r.stdout ?? '') || `exit ${r.exitCode}` }
}
async function git($: any, dir: string, args: string[], timeoutMs = LIST_TIMEOUT_MS): Promise<Run> {
  return run($, ['git', '-C', dir, ...args], timeoutMs)
}
function parseList<T>(text: string): T[] {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : [] } catch { return [] }
}

/** 已安裝的 desk；找不到（例如用 --plugin-dir 載入）就 null。 */
export async function findInstall($: any): Promise<Install | null> {
  const [plugins, markets] = await Promise.all([
    run($, ['claude', 'plugin', 'list', '--json'], LIST_TIMEOUT_MS),
    run($, ['claude', 'plugin', 'marketplace', 'list', '--json'], LIST_TIMEOUT_MS),
  ])
  if (!plugins.ok || !markets.ok) throw new Error(firstLine(plugins.ok ? markets.err : plugins.err))
  return pickInstall(parseList<RawPlugin>(plugins.out), parseList<RawMarket>(markets.out), String($.plugin.name || 'desk'), String($.plugin.root || ''))
}

/** GitHub 上預設分支的 desk 版號：先 fetch（只更新遠端追蹤分支），再讀那個分支的 plugin.json。失敗就丟出錯誤訊息第一行。 */
export async function latestOf($: any, inst: Install): Promise<{ version: string; ref: string; branch: string }> {
  const fetched = await git($, inst.dir, ['fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS)
  if (!fetched.ok) throw new Error(`連不到 GitHub：${firstLine(fetched.err)}`)
  const head = await git($, inst.dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const ref = head.ok && firstLine(head.out).startsWith('origin/') ? firstLine(head.out) : 'origin/main'
  const name = String($.plugin.name || 'desk')
  const market = await git($, inst.dir, ['show', `${ref}:${MARKETPLACE}`])
  const manifest = await git($, inst.dir, ['show', `${ref}:${manifestPath(market.ok ? market.out : null, name)}`])
  if (!manifest.ok) throw new Error(`讀不到 GitHub 上的版本：${firstLine(manifest.err)}`)
  let version = ''
  try { version = String(JSON.parse(manifest.out).version ?? '').trim() } catch { /* 下面處理 */ }
  if (!version) throw new Error('讀不到 GitHub 上的版本：plugin.json 沒有 version')
  return { version, ref, branch: ref.slice('origin/'.length) }
}

/** 本機資料夾能不能乾淨地快轉到 GitHub 的版本：未提交改動、不在預設分支、有 GitHub 上沒有的 commit，各自說明怎麼處理。 */
export async function folderBlockers($: any, dir: string, ref: string, branch: string): Promise<string[]> {
  const reasons: string[] = []
  const status = await git($, dir, ['status', '--porcelain', '--untracked-files=no'])
  if (!status.ok) throw new Error(`讀不到本機資料夾的狀態：${firstLine(status.err)}`)
  if (status.out.trim()) reasons.push(`本機資料夾 ${dir} 有未提交的改動，請先 commit 或自行收好再更新`)
  const current = firstLine((await git($, dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out)
  if (current !== branch) reasons.push(`本機資料夾 ${dir} 不在預設分支 ${branch}（目前 ${current || '未知'}），請先切回 ${branch} 再更新`)
  const ahead = Number.parseInt(firstLine((await git($, dir, ['rev-list', '--count', `${ref}..HEAD`])).out), 10) || 0
  if (ahead > 0) reasons.push(`本機資料夾 ${dir} 有 ${ahead} 個 GitHub 上沒有的 commit，請先 push 或自行整理再更新`)
  return reasons
}

/** 自動檢查：查已安裝的與 GitHub 上最新的版號；失敗丟出去，由呼叫端不出聲。 */
export async function checkLatest($: any, now: number): Promise<UpdateCheck> {
  const inst = await findInstall($)
  if (!inst) throw new Error('找不到已安裝的 desk')
  const latest = await latestOf($, inst)
  return { at: now, latest: latest.version, current: inst.version }
}

/**
 * 手動更新（`/desk update`、面板按鈕）：已是最新就不動；GitHub 安裝更新 marketplace 再更新 plugin；
 * 本機資料夾先確認能乾淨快轉（不行就什麼都不動），記下原本的 HEAD 再快轉預設分支、更新 plugin；
 * 更新指令失敗就把資料夾退回原本的 HEAD，維持原狀。結果帶回這次查到的版號給自動檢查沿用。
 */
export async function updateDesk($: any, now: number): Promise<UpdateResult> {
  let inst: Install | null
  try { inst = await findInstall($) } catch (error) { return { tone: 'error', text: `desk 無法更新：讀不到已安裝的 plugin（${message(error)}）` } }
  if (!inst) return { tone: 'warning', text: 'desk 無法更新：找不到已安裝的 desk（例如用 --plugin-dir 載入的），請自行更新' }
  let latest: { version: string; ref: string; branch: string }
  try { latest = await latestOf($, inst) } catch (error) { return { tone: 'error', text: `desk 無法更新：${message(error)}` } }
  const from = inst.version
  if (!isNewer(latest.version, from)) return { tone: 'subtle', text: upToDateText(from), check: { at: now, latest: latest.version, current: from } }
  if (inst.kind === 'github') {
    const market = await run($, ['claude', 'plugin', 'marketplace', 'update', inst.marketplace], UPDATE_TIMEOUT_MS)
    if (!market.ok) return { tone: 'error', text: `desk 無法更新：更新指令失敗（${firstLine(market.err)}）` }
    const done = await installLatest($, inst, latest.version)
    return 'failed' in done ? { tone: 'error', text: `desk 無法更新：${done.failed}` } : updated(from, done.version, now)
  }
  let reasons: string[]
  try { reasons = await folderBlockers($, inst.dir, latest.ref, latest.branch) } catch (error) { return { tone: 'error', text: `desk 無法更新：${message(error)}` } }
  if (reasons.length) return { tone: 'warning', text: `desk 無法更新，什麼都沒動：${reasons.join('；')}` }
  const before = firstLine((await git($, inst.dir, ['rev-parse', 'HEAD'])).out)
  if (!before) return { tone: 'error', text: `desk 無法更新：讀不到本機資料夾 ${inst.dir} 目前的版本` }
  const merged = await git($, inst.dir, ['merge', '--ff-only', '--quiet', latest.ref], UPDATE_TIMEOUT_MS)
  if (!merged.ok) return { tone: 'error', text: `desk 無法更新：更新本機資料夾失敗（${firstLine(merged.err)}）` }
  // 讓 Claude Code 重讀資料夾的 marketplace 目錄；資料夾來源不一定需要，失敗不算數，版本以 plugin update 之後重讀的為準。
  await run($, ['claude', 'plugin', 'marketplace', 'update', inst.marketplace], UPDATE_TIMEOUT_MS)
  const done = await installLatest($, inst, latest.version)
  if (!('failed' in done)) return updated(from, done.version, now)
  const back = await git($, inst.dir, ['reset', '--keep', '--quiet', before], UPDATE_TIMEOUT_MS)
  await run($, ['claude', 'plugin', 'marketplace', 'update', inst.marketplace], UPDATE_TIMEOUT_MS)
  return back.ok
    ? { tone: 'error', text: `desk 無法更新：${done.failed}；本機資料夾已退回原本的版本` }
    : { tone: 'error', text: `desk 無法更新：${done.failed}；本機資料夾已快轉但退回失敗（${firstLine(back.err)}），請在 ${inst.dir} 執行 git reset --keep ${before}` }
}

/** `claude plugin update`，再重讀已安裝的版號確認真的變新了（讀不到就當作是 GitHub 上的那版）。 */
async function installLatest($: any, inst: Install, expected: string): Promise<{ version: string } | { failed: string }> {
  const r = await run($, ['claude', 'plugin', 'update', inst.id, ...(inst.scope ? ['--scope', inst.scope] : [])], UPDATE_TIMEOUT_MS)
  if (!r.ok) return { failed: `更新指令失敗（${firstLine(r.err)}）` }
  const version = (await findInstall($).catch(() => null))?.version ?? expected
  return isNewer(version, inst.version) ? { version } : { failed: `更新指令跑完了，但已安裝的版本仍是 ${inst.version}` }
}

const updated = (from: string, to: string, now: number): UpdateResult =>
  ({ tone: 'success', text: updatedText(from, to), check: { at: now, latest: to, current: to } })

const message = (error: unknown) => firstLine(error instanceof Error ? error.message : String(error))
