// 派工設定：dispatch.json 解析成 DispatchSettings、各種派工用的模型與 effort、常犯錯誤清單路徑。純函式。
import type { DispatchKind } from './dispatch'
import { expandHome } from './card'
import type { FeedEvent, SettingsChecked } from '../types'
import { SETTINGS_FORMAT } from './formats'
import { t } from './i18n'

/** dispatch.json 的 kinds 可以各設模型的派工種類；同步另用 sync.claude，解衝突用 continue 的。 */
export const MODEL_KINDS = ['continue', 'reply', 'review', 'publish'] as const
export type ModelKind = typeof MODEL_KINDS[number]
/**
 * 審查用語；template 是審查契約檔（空白用 plugin 內附的 templates/review.md）。
 * preflight 是審查前置指令（`{root}`、`{base}` 佔位），審查先跑、輸出當候選逐條驗證；空白不加前置句。
 * pitfalls 是專案自己的常犯錯誤清單路徑（可用 `~`），優先於 plugin 選項與專案資料夾預設。
 * preflightMinFiles：diff 少於這麼多檔的審查與複審（修正後、重新審查）不加前置句；0（預設）＝都加。
 * combineSecurity：高風險分支的資安重點併進程式碼審查，過關後不另派資安審查；只認 JSON 的 true。
 */
export type ReviewWords = { high: string; security: string; categories: string; template: string; preflight?: string; pitfalls?: string; preflightMinFiles?: number; combineSecurity?: boolean }
export type DispatchSettings = {
  model: string; effort: string; sync: { model: string; effort: string; fresh: boolean }
  projects: Record<string, { model?: string; effort?: string; rules?: string[] }>
  /** 依派工種類的模型與 effort，優先於任務覆寫與全域。 */
  kinds: Partial<Record<ModelKind, { model?: string; effort?: string }>>
  /** 寫進提示詞與卡片的人名（「要 <user> 決定的事」「<user> 在工作桌確認」）。 */
  user: string
  /** 每次派工都附上的專案規則（例如測試只能怎麼跑）；任務的 rules 接在後面。 */
  rules: string[]
  review: ReviewWords
  /** 額外的高風險路徑（正規式, 理由），排在內建的前面。 */
  riskHigh: [RegExp, string][]
  /** 完成檢查裡出現這個指令名就需要哪些容器服務（例如包好的測試腳本 → mysql）。 */
  checkServices: Record<string, string[]>
  /** docker-compose.yml 所在資料夾（寫在專案的 dispatch.json，容器列就跟著專案）；空白用 plugin 選項。 */
  composeDir: string
  /** card.base：分支預設要併進去的分支（例如 origin/main）；沒有 PR 與 release 線時當 diff 與合併判斷的基準。 */
  cardBase: string
  /** card.template：DESK 卡模板（可用 `~`）；空白用 plugin 內附的 templates/DESK-template.md。寫入卡片後的卡片規則段守門跟 card.py 用同一份。 */
  cardTemplate: string
  /** updateCheck："off" 不自動檢查 desk 新版本；沒設＝每 24 小時查一次。 */
  updateCheck: '' | 'off'
  /** 同時在跑的工作桌背景 Agent 上限（整台機器一起算）；超過的派工排隊。0＝不限。 */
  maxAgents: number
  /** 審查過關（含免審查過關）後自動派推送 Agent push 並開 PR（PR 已開只 push）；只認 JSON 的 true，建議寫在專案的 dispatch.json。 */
  autoPr: boolean
  /** 專案 `pr.open`：推送 Agent 開 PR 的覆寫指令（`{branch}`、`{target}` 會換掉），給 GitLab、自架等 desk 認不出的平台；空白＝依 origin（GitHub 用 gh、Bitbucket 用 MCP、其他只 push）。 */
  prOpen: string
  /** 背景 Agent 要不要載入 MCP server。預設不載（`--strict-mcp-config`）：每個 MCP 都是一支常駐程序，派工一多就吃掉記憶體；要用再在 dispatch.json 設 `mcp: true`。 */
  mcp: boolean
  /** 做完的背景 Agent 由工作桌在下一次重新整理時 `claude stop` 收掉：不停的話每支各佔幾百 MB，閒置到 daemon 回收。預設開，只有 JSON 的 false 關掉。 */
  stopDone: boolean
  /** 自動流程的額度煞車：5 小時額度剩餘百分比低於這個值時，自動流程不派下一個 Agent、暫停寫原因。0＝關（`"off"`／`false`）；不合法用預設。 */
  chainQuotaStop: number
}

export const DEFAULT_MAX_AGENTS = 3
export const DEFAULT_CHAIN_QUOTA_STOP = 30

export const DEFAULT_USER = t('settings.defaultUser')
export const DEFAULT_REVIEW: ReviewWords = {
  high: '實際的 bug、漏做授權或資料範圍檢查、測試沒測到需求',
  security: '授權與資料範圍、輸入驗證、SQL 與 XSS、個人資料外洩（log、匯出、版控）、機密與金鑰、檔案路徑、外部呼叫',
  categories: '授權、個資、測試、命名',
  template: '',
  preflight: '',
  pitfalls: '',
  preflightMinFiles: 0,
  combineSecurity: false,
}

const str = (v: unknown) => typeof v === 'string' ? v.trim() : ''
const strList = (v: unknown) => Array.isArray(v) ? v.map(str).filter(Boolean) : []

/** dispatch.json：全域 model／effort、每任務覆寫（鍵是根目錄）、同步模型、人名、專案規則、審查用語、風險路徑。讀不到就用預設。 */
export function parseSettings(text: string | null): DispatchSettings {
  const out: DispatchSettings = { model: '', effort: '', sync: { model: '', effort: '', fresh: false }, projects: {}, kinds: {}, user: DEFAULT_USER, rules: [], review: { ...DEFAULT_REVIEW }, riskHigh: [], checkServices: {}, composeDir: '', cardBase: '', cardTemplate: '', updateCheck: '', maxAgents: DEFAULT_MAX_AGENTS, autoPr: false, prOpen: '', mcp: false, stopDone: true, chainQuotaStop: DEFAULT_CHAIN_QUOTA_STOP }
  if (!text) return out
  try {
    const d = JSON.parse(text.replace(/^﻿/, ''))
    out.model = typeof d?.model === 'string' ? d.model.trim() : ''
    out.effort = typeof d?.effort === 'string' ? d.effort.trim() : ''
    const sync = d?.sync?.claude
    out.sync = { model: typeof sync?.model === 'string' ? sync.model.trim() : '', effort: typeof sync?.effort === 'string' ? sync.effort.trim() : '', fresh: d?.sync?.session === 'fresh' || (d?.sync?.session === undefined && !!(typeof sync?.model === 'string' && sync.model.trim())) }
    if (d?.projects && typeof d.projects === 'object') for (const [root, v] of Object.entries<any>(d.projects)) {
      out.projects[normalizeRoot(root)] = { ...(typeof v?.model === 'string' ? { model: v.model.trim() } : {}), ...(typeof v?.effort === 'string' ? { effort: v.effort.trim() } : {}), ...(strList(v?.rules).length ? { rules: strList(v.rules) } : {}) }
    }
    out.kinds = parseKinds(d?.kinds)
    out.user = str(d?.user) || DEFAULT_USER
    out.rules = strList(d?.rules)
    out.review = { high: str(d?.review?.high) || DEFAULT_REVIEW.high, security: str(d?.review?.security) || DEFAULT_REVIEW.security, categories: str(d?.review?.categories) || DEFAULT_REVIEW.categories, template: str(d?.review?.template), preflight: str(d?.review?.preflight), pitfalls: str(d?.review?.pitfalls), preflightMinFiles: Number.isInteger(d?.review?.preflightMinFiles) && d.review.preflightMinFiles > 0 ? d.review.preflightMinFiles : 0, combineSecurity: d?.review?.combineSecurity === true }
    if (Array.isArray(d?.risk?.high)) for (const r of d.risk.high) {
      // 寫錯的正規式略過，不讓整份設定失效。
      try { if (str(r?.pattern) && str(r?.label)) out.riskHigh.push([new RegExp(str(r.pattern)), str(r.label)]) } catch { /* 略過 */ }
    }
    if (d?.checkServices && typeof d.checkServices === 'object') for (const [cmd, v] of Object.entries<unknown>(d.checkServices)) {
      if (str(cmd) && strList(v).length) out.checkServices[str(cmd)] = strList(v)
    }
    out.composeDir = str(d?.composeDir)
    out.cardBase = str(d?.card?.base)
    out.cardTemplate = str(d?.card?.template)
    out.prOpen = str(d?.pr?.open)
    out.updateCheck = d?.updateCheck === false || str(d?.updateCheck).toLowerCase() === 'off' ? 'off' : ''
    // 非負整數照用（0＝不限）；負數、小數、字串都當沒寫。
    out.maxAgents = Number.isInteger(d?.maxAgents) && d.maxAgents >= 0 ? d.maxAgents : DEFAULT_MAX_AGENTS
    // 字串 "true"、數字 1 都算沒開：自動推送會寫遠端，只認明確的 true。
    out.autoPr = d?.autoPr === true
    // 同 autoPr：只認明確的 true。
    out.mcp = d?.mcp === true
    // 反過來：預設開，只認明確的 false 關掉。
    out.stopDone = d?.stopDone !== false
    out.chainQuotaStop = parseQuotaStop(d?.chainQuotaStop)
  } catch { /* 壞掉的設定檔當作沒有。 */ }
  return out
}

/** chainQuotaStop：整數 1–100 照用；`"off"`（不分大小寫）或 false 關掉（0）；其他（沒寫、非數字、小數、超出範圍）用預設。 */
function parseQuotaStop(v: unknown): number {
  if (v === false || (typeof v === 'string' && v.trim().toLowerCase() === 'off')) return 0
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100 ? v as number : DEFAULT_CHAIN_QUOTA_STOP
}

/** kinds 只收 MODEL_KINDS 的鍵、值是物件的；欄位不是字串或是空白就當沒寫。其他的（sync、不認得的鍵、型別錯的值）略過。 */
function parseKinds(v: unknown): DispatchSettings['kinds'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: DispatchSettings['kinds'] = {}
  for (const k of MODEL_KINDS) {
    const e = (v as Record<string, unknown>)[k]
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue
    const { model, effort } = e as Record<string, unknown>
    const pick = { ...(str(model) ? { model: str(model) } : {}), ...(str(effort) ? { effort: str(effort) } : {}) }
    if (pick.model || pick.effort) out[k] = pick
  }
  return out
}

export const normalizeRoot = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')

/** 審查與會改程式的派工要讀的常犯錯誤清單：專案 dispatch.json 的 review.pitfalls（展開 ~）優先；空白用 fallback（plugin 選項 → 專案資料夾 review-pitfalls.md）。 */
export function pitfallsFor(settings: DispatchSettings, fallback: string, home: string): string {
  const own = settings.review.pitfalls ?? ''
  return own ? expandHome(own, home) : fallback
}

/** 這件任務這種派工用的 model／effort：種類（kinds）> 任務覆寫 > 全域；同步另有自己的模型，解衝突照 continue（接任務的 session）。 */
export function modelFor(settings: DispatchSettings, root: string, kind: DispatchKind): { model: string; effort: string; fresh: boolean } {
  const own = settings.projects[normalizeRoot(root)] ?? {}
  const base = { model: own.model ?? settings.model, effort: own.effort ?? settings.effort }
  if (kind === 'sync') return { model: settings.sync.model || base.model, effort: settings.sync.effort || base.effort, fresh: settings.sync.fresh }
  const byKind = settings.kinds[kind === 'catchup' ? 'continue' : kind] ?? {}
  // 推送只要分支與卡片，開新對話就夠了，不接任務那個越來越長的 session。
  return { model: byKind.model ?? base.model, effort: byKind.effort ?? base.effort, fresh: kind === 'review' || kind === 'publish' }
}

// ── 設定檔驗證：指出 dispatch.json 哪裡寫錯、改用了什麼。只報告，不改 parseSettings 的解析結果。──

/** card.py 的 DEFAULT_SPEC_PREFLIGHT_MIN_FILES：card.specPreflightMinFiles 不合法時 card.py 改用的值，兩邊要一致。 */
const CARD_SPEC_PREFLIGHT_MIN_FILES = 3
/** card.py 的 KAC：card.changelog.format 唯一認得的值。 */
const CHANGELOG_FORMAT = 'keepachangelog'

/** 檢查一個值；認不得的鍵記進 unknown（完整路徑），寫錯的值記進 bad（含改用的值），格式比這版新記進 newer（排在最前面）。 */
type Found = { unknown: string[]; bad: string[]; newer?: string }
type Check = (v: unknown, path: string, found: Found) => void

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** `$schema` 與 `_` 開頭的鍵是註解，不算認不得。 */
const isNoteKey = (k: string) => k === '$schema' || k.startsWith('_')
/** null 跟沒寫一樣：解析時都落到預設值，不報。 */
const unset = (v: unknown) => v === undefined || v === null

const aString = (instead: string): Check => (v, path, found) => {
  if (!unset(v) && typeof v !== 'string') found.bad.push(t('settings.notString', { path, instead }))
}
const textList: Check = (v, path, found) => {
  if (unset(v)) return
  if (!Array.isArray(v)) found.bad.push(t('settings.notStringList', { path }))
  else if (v.some(x => typeof x !== 'string')) found.bad.push(t('settings.nonStringItems', { path }))
}
const onlyTrue: Check = (v, path, found) => {
  if (!unset(v) && typeof v !== 'boolean') found.bad.push(t('settings.onlyTrue', { path }))
}
const onlyFalse: Check = (v, path, found) => {
  if (!unset(v) && typeof v !== 'boolean') found.bad.push(t('settings.onlyFalse', { path }))
}
const intAtLeast = (min: number, words: string, used: number): Check => (v, path, found) => {
  if (!unset(v) && !(Number.isInteger(v) && (v as number) >= min)) found.bad.push(t('settings.notInt', { path, words, used }))
}
const shape = (fields: Record<string, Check>): Check => (v, path, found) => {
  if (unset(v)) return
  if (!isPlainObject(v)) { found.bad.push(t('settings.notObject', { path })); return }
  for (const [k, x] of Object.entries(v)) {
    if (isNoteKey(k)) continue
    const at = path ? `${path}.${k}` : k
    const check = Object.prototype.hasOwnProperty.call(fields, k) ? fields[k] : undefined
    if (check) check(x, at, found)
    else found.unknown.push(at)
  }
}
/** 鍵由使用者自訂（根目錄、指令名）的物件：每個值照 each 檢查。 */
const mapOf = (each: Check): Check => (v, path, found) => {
  if (unset(v)) return
  if (!isPlainObject(v)) { found.bad.push(t('settings.notObject', { path })); return }
  for (const [k, x] of Object.entries(v)) if (!isNoteKey(k)) each(x, `${path}.${k}`, found)
}

const modelEffort = { model: aString(t('settings.unset')), effort: aString(t('settings.unset')) }

const riskHigh: Check = (v, path, found) => {
  if (unset(v)) return
  if (!Array.isArray(v)) { found.bad.push(t('settings.notArray', { path })); return }
  v.forEach((r, i) => {
    const at = `${path}[${i}]`
    if (!isPlainObject(r)) { found.bad.push(t('settings.ruleNotObject', { path: at })); return }
    shape({ pattern: () => {}, label: () => {} })(r, at, found)
    if (!str(r.pattern) || !str(r.label)) { found.bad.push(t('settings.ruleMissing', { path: at })); return }
    try { new RegExp(str(r.pattern)) } catch (e) { found.bad.push(t('settings.badRegex', { path: at, error: e instanceof Error ? e.message : String(e) })) }
  })
}

const syncSession: Check = (v, path, found) => {
  if (!unset(v) && v !== 'fresh') found.bad.push(t('settings.onlyFresh', { path }))
}
const updateCheck: Check = (v, path, found) => {
  if (unset(v) || typeof v === 'boolean' || (typeof v === 'string' && v.trim().toLowerCase() === 'off')) return
  found.bad.push(t('settings.onlyOff', { path }))
}
const chainQuotaStop: Check = (v, path, found) => {
  const off = v === false || (typeof v === 'string' && v.trim().toLowerCase() === 'off')
  if (unset(v) || off || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100)) return
  found.bad.push(t('settings.quotaRange', { path, used: DEFAULT_CHAIN_QUOTA_STOP }))
}
/** 頂層 format：整數 SETTINGS_FORMAT 或沒寫不報；更大的是較新版 desk 寫的設定，認得的鍵照常套用（新版多的鍵另列在認不得的鍵）。 */
const settingsFormat: Check = (v, path, found) => {
  if (unset(v) || v === SETTINGS_FORMAT) return
  if (Number.isInteger(v) && (v as number) > SETTINGS_FORMAT) found.newer = t('settings.newer', { path, value: String(v) })
  else found.bad.push(t('settings.formatInt', { path, format: SETTINGS_FORMAT }))
}
const changelogFormat: Check = (v, path, found) => {
  if (unset(v)) return
  if (typeof v !== 'string') found.bad.push(t('settings.changelogNotString', { path }))
  else if (v.trim() && v.trim() !== CHANGELOG_FORMAT) found.bad.push(t('settings.changelogOnly', { path, format: CHANGELOG_FORMAT }))
}

/** dispatch.json 認得的鍵：parseSettings 讀的，加上 card.py 讀的 card.*（docs/REFERENCE.md 與 card.py 說明列的那些），以及格式版號 format（docs/FORMATS.md）。 */
const SETTINGS_SHAPE = shape({
  format: settingsFormat,
  ...modelEffort,
  sync: shape({ claude: shape(modelEffort), session: syncSession }),
  kinds: shape(Object.fromEntries(MODEL_KINDS.map(k => [k, shape(modelEffort)]))),
  projects: mapOf(shape({ ...modelEffort, rules: textList })),
  user: aString(t('settings.useUser', { user: DEFAULT_USER })),
  rules: textList,
  review: shape({
    high: aString(t('settings.useDefault')), security: aString(t('settings.useDefault')), categories: aString(t('settings.useDefault')),
    template: aString(t('settings.useBundled')), preflight: aString(t('settings.unset')), pitfalls: aString(t('settings.unset')),
    preflightMinFiles: intAtLeast(0, t('settings.nonNegInt'), 0), combineSecurity: onlyTrue,
  }),
  risk: shape({ high: riskHigh }),
  checkServices: mapOf(textList),
  composeDir: aString(t('settings.unset')),
  card: shape({
    main: aString(t('settings.unset')), worktrees: aString(t('settings.useDefault')), base: aString(t('settings.unset')), check: aString(t('settings.unset')),
    registry: aString(t('settings.useDefault')), template: aString(t('settings.useBundled')), archive: aString(t('settings.useDefault')),
    specRules: textList, specPreflight: aString(t('settings.unset')),
    specPreflightMinFiles: intAtLeast(1, t('settings.posInt'), CARD_SPEC_PREFLIGHT_MIN_FILES),
    retro: aString(t('settings.unset')), changelog: shape({ format: changelogFormat }),
  }),
  pr: shape({ open: aString(t('settings.unset')) }),
  updateCheck,
  maxAgents: intAtLeast(0, t('settings.nonNegInt'), DEFAULT_MAX_AGENTS),
  autoPr: onlyTrue,
  mcp: onlyTrue,
  stopDone: onlyFalse,
  chainQuotaStop,
})

/**
 * 一份 dispatch.json 的問題，每條一句：JSON 語法錯、最外層不是物件（整份沒套用）、format 比這版新（排第一條）、認不得的鍵（完整路徑，已略過）、
 * 型別或範圍錯的值（寫出實際改用的值）、risk.high 寫錯的正規式。空檔與只有空白跟沒有這份一樣，不報。
 * 只報告：解析照 parseSettings、疊加照 mergeSettingsText，結果不因這裡改變。
 */
export function settingsProblems(text: string): string[] {
  const body = text.replace(/^\uFEFF/, '')
  if (!body.trim()) return []
  let d: unknown
  try { d = JSON.parse(body) } catch { return [t('settings.badJson')] }
  if (!isPlainObject(d)) return [t('settings.notTopObject')]
  const found: Found = { unknown: [], bad: [] }
  SETTINGS_SHAPE(d, '', found)
  return [...(found.newer ? [found.newer] : []), ...(found.unknown.length ? [t('settings.unknownKeys', { keys: found.unknown.join(t('word.listSep')) })] : []), ...found.bad]
}

/** 最多列幾條問題，其餘寫「等 n 條」。 */
export const SETTINGS_PROBLEMS_SHOWN = 3

/** 動態的一句：哪份檔、前幾條問題。 */
export function settingsFeedText(path: string, problems: readonly string[]): string {
  const shown = problems.slice(0, SETTINGS_PROBLEMS_SHOWN).join(t('update.reasonSep'))
  const more = problems.length > SETTINGS_PROBLEMS_SHOWN ? t('settings.more', { n: problems.length }) : ''
  return t('settings.feed', { path, shown, more })
}

/** 一份 dispatch.json 這一輪讀到的內容與問題；讀不到（不存在）時 text 是 null。 */
export type SettingsReport = { path: string; text: string | null; problems: string[] }

/**
 * 這一輪的設定檔動態與要記下的檢查結果（純函式）：
 * - 內容跟上次檢查過的一樣：不報。
 * - 新內容有問題：報一筆錯誤（排在最前面，問題列顯示它）。
 * - 上次有問題、這次沒了（改正、檔案刪掉、不再屬於目前專案）：報一筆說明，問題列才不會一直掛著舊錯誤；
 *   另一份之前報過、還沒改正時，那份的問題接在後面、照樣是錯誤。
 */
export function settingsNotices(reports: readonly SettingsReport[], before: SettingsChecked, at: number): { checked: SettingsChecked; events: FeedEvent[] } {
  const checked: SettingsChecked = {}
  const broken: FeedEvent[] = []
  const gone: string[] = []
  for (const r of reports) {
    const was = before[r.path]
    if (r.text === null) { if (was?.problems.length) gone.push(t('settings.removed', { path: r.path })); continue }
    checked[r.path] = { text: r.text, problems: r.problems }
    if (was?.text === r.text) continue
    if (r.problems.length) broken.push({ at, text: settingsFeedText(r.path, r.problems), tone: 'error' })
    else if (was?.problems.length) gone.push(t('settings.fixed', { path: r.path }))
  }
  for (const [path, was] of Object.entries(before)) {
    if (!reports.some(r => r.path === path) && was.problems.length) gone.push(t('settings.notProject', { path }))
  }
  const reportedNow = new Set(reports.filter(r => r.text !== null && r.text !== before[r.path]?.text).map(r => r.path))
  const still = Object.entries(checked).filter(([path, v]) => v.problems.length && !reportedNow.has(path)).map(([path, v]) => settingsFeedText(path, v.problems))
  const cleared = gone.map((text): FeedEvent => still.length ? { at, text: [text, ...still].join(t('update.reasonSep')), tone: 'error' } : { at, text, tone: 'success' })
  return { checked, events: [...broken, ...cleared] }
}
