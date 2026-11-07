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
