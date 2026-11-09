// 派工設定：dispatch.json 解析成 DispatchSettings、各種派工用的模型與 effort、常犯錯誤清單路徑。純函式。
import type { DispatchKind } from './dispatch'
import { expandHome } from './card'

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

export const DEFAULT_USER = '使用者'
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

/** 檢查一個值；認不得的鍵記進 unknown（完整路徑），寫錯的值記進 bad（含改用的值）。 */
type Found = { unknown: string[]; bad: string[] }
type Check = (v: unknown, path: string, found: Found) => void

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** `$schema` 與 `_` 開頭的鍵是註解，不算認不得。 */
const isNoteKey = (k: string) => k === '$schema' || k.startsWith('_')
/** null 跟沒寫一樣：解析時都落到預設值，不報。 */
const unset = (v: unknown) => v === undefined || v === null

const aString = (instead: string): Check => (v, path, found) => {
  if (!unset(v) && typeof v !== 'string') found.bad.push(`${path} 不是字串，${instead}`)
}
const textList: Check = (v, path, found) => {
  if (unset(v)) return
  if (!Array.isArray(v)) found.bad.push(`${path} 不是字串陣列，視為沒設`)
  else if (v.some(x => typeof x !== 'string')) found.bad.push(`${path} 有不是字串的項目，那幾項略過`)
}
const onlyTrue: Check = (v, path, found) => {
  if (!unset(v) && typeof v !== 'boolean') found.bad.push(`${path} 只認 JSON 的 true，視為關`)
}
const onlyFalse: Check = (v, path, found) => {
  if (!unset(v) && typeof v !== 'boolean') found.bad.push(`${path} 只認 JSON 的 false，視為開`)
}
const intAtLeast = (min: number, words: string, used: number): Check => (v, path, found) => {
  if (!unset(v) && !(Number.isInteger(v) && (v as number) >= min)) found.bad.push(`${path} 不是${words}，改用 ${used}`)
}
const shape = (fields: Record<string, Check>): Check => (v, path, found) => {
  if (unset(v)) return
  if (!isPlainObject(v)) { found.bad.push(`${path} 不是物件，整段略過`); return }
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
  if (!isPlainObject(v)) { found.bad.push(`${path} 不是物件，整段略過`); return }
  for (const [k, x] of Object.entries(v)) if (!isNoteKey(k)) each(x, `${path}.${k}`, found)
}

const modelEffort = { model: aString('視為沒設'), effort: aString('視為沒設') }

const riskHigh: Check = (v, path, found) => {
  if (unset(v)) return
  if (!Array.isArray(v)) { found.bad.push(`${path} 不是陣列，整段略過`); return }
  v.forEach((r, i) => {
    const at = `${path}[${i}]`
    if (!isPlainObject(r)) { found.bad.push(`${at} 不是物件，這條略過`); return }
    shape({ pattern: () => {}, label: () => {} })(r, at, found)
    if (!str(r.pattern) || !str(r.label)) { found.bad.push(`${at} 少了 pattern 或 label，這條略過`); return }
    try { new RegExp(str(r.pattern)) } catch (e) { found.bad.push(`${at} 的正規式寫錯（${e instanceof Error ? e.message : String(e)}），這條略過`) }
  })
}

const syncSession: Check = (v, path, found) => {
  if (!unset(v) && v !== 'fresh') found.bad.push(`${path} 只認 "fresh"，視為接著任務原本的對話`)
}
const updateCheck: Check = (v, path, found) => {
  if (unset(v) || typeof v === 'boolean' || (typeof v === 'string' && v.trim().toLowerCase() === 'off')) return
  found.bad.push(`${path} 只認 "off"，照常檢查新版本`)
}
const chainQuotaStop: Check = (v, path, found) => {
  const off = v === false || (typeof v === 'string' && v.trim().toLowerCase() === 'off')
  if (unset(v) || off || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100)) return
  found.bad.push(`${path} 要是 1–100 的整數或 "off"，改用 ${DEFAULT_CHAIN_QUOTA_STOP}`)
}
const changelogFormat: Check = (v, path, found) => {
  if (unset(v)) return
  if (typeof v !== 'string') found.bad.push(`${path} 不是字串，照原本的格式`)
  else if (v.trim() && v.trim() !== CHANGELOG_FORMAT) found.bad.push(`${path} 只能是 "${CHANGELOG_FORMAT}"，合併 changelog 時會停下報錯`)
}

/** dispatch.json 認得的鍵：parseSettings 讀的，加上 card.py 讀的 card.*（README 與 card.py 說明列的那些）。 */
const SETTINGS_SHAPE = shape({
  ...modelEffort,
  sync: shape({ claude: shape(modelEffort), session: syncSession }),
  kinds: shape(Object.fromEntries(MODEL_KINDS.map(k => [k, shape(modelEffort)]))),
  projects: mapOf(shape({ ...modelEffort, rules: textList })),
  user: aString(`改用「${DEFAULT_USER}」`),
  rules: textList,
  review: shape({
    high: aString('改用預設'), security: aString('改用預設'), categories: aString('改用預設'),
    template: aString('改用內附的'), preflight: aString('視為沒設'), pitfalls: aString('視為沒設'),
    preflightMinFiles: intAtLeast(0, '非負整數', 0), combineSecurity: onlyTrue,
  }),
  risk: shape({ high: riskHigh }),
  checkServices: mapOf(textList),
  composeDir: aString('視為沒設'),
  card: shape({
    main: aString('視為沒設'), worktrees: aString('改用預設'), base: aString('視為沒設'), check: aString('視為沒設'),
    registry: aString('改用預設'), template: aString('改用內附的'), archive: aString('改用預設'),
    specRules: textList, specPreflight: aString('視為沒設'),
    specPreflightMinFiles: intAtLeast(1, '正整數', CARD_SPEC_PREFLIGHT_MIN_FILES),
    retro: aString('視為沒設'), changelog: shape({ format: changelogFormat }),
  }),
  pr: shape({ open: aString('視為沒設') }),
  updateCheck,
  maxAgents: intAtLeast(0, '非負整數', DEFAULT_MAX_AGENTS),
  autoPr: onlyTrue,
  mcp: onlyTrue,
  stopDone: onlyFalse,
  chainQuotaStop,
})

/**
 * 一份 dispatch.json 的問題，每條一句：JSON 語法錯、最外層不是物件（整份沒套用）、認不得的鍵（完整路徑，已略過）、
 * 型別或範圍錯的值（寫出實際改用的值）、risk.high 寫錯的正規式。空檔與只有空白跟沒有這份一樣，不報。
 * 只報告：解析照 parseSettings、疊加照 mergeSettingsText，結果不因這裡改變。
 */
export function settingsProblems(text: string): string[] {
  const body = text.replace(/^\uFEFF/, '')
  if (!body.trim()) return []
  let d: unknown
  try { d = JSON.parse(body) } catch { return ['JSON 格式錯誤，這份設定沒有套用'] }
  if (!isPlainObject(d)) return ['最外層不是物件，這份設定沒有套用']
  const found: Found = { unknown: [], bad: [] }
  SETTINGS_SHAPE(d, '', found)
  return [...(found.unknown.length ? [`認不得的鍵，已略過：${found.unknown.join('、')}`] : []), ...found.bad]
}

/** 最多列幾條問題，其餘寫「等 n 條」。 */
export const SETTINGS_PROBLEMS_SHOWN = 3

/** 動態的一句：哪份檔、前幾條問題。 */
export function settingsFeedText(path: string, problems: readonly string[]): string {
  const shown = problems.slice(0, SETTINGS_PROBLEMS_SHOWN).join('；')
  const more = problems.length > SETTINGS_PROBLEMS_SHOWN ? ` 等 ${problems.length} 條` : ''
  return `設定檔 ${path} 有問題：${shown}${more}`
}
