// 派工：組 `claude --bg` 的參數與提示詞、解析啟動輸出、對回新 agent。純函式；I/O 在 register.tsx。
import type { Case } from '../types'
import { agentBusy, isMerged, isReleaseLine, needsPr, needsPush } from './pipeline'
import { CARD_CMD, PLAN_STEP, isPlaceholder, named, parseGate, saysNone } from './card'
import type { ChainRun } from './chain'
import { agentWaits, approvalWait, slugOf } from './model'
import { DONE_RULE, SPEC_RULE, cardRules, changelogRule, testRule } from './prompts/rules'
import { CATCHUP_CARD_RULE, catchupHead } from './prompts/catchup'
import { PUBLISH_CARD_RULE, publishHead } from './prompts/publish'
import { reviewPrompt, reviewTask } from './prompts/review'
import type { ReviewOpts } from './prompts/review'
import { fixHead, manualFixHead } from './prompts/fix'
import { REVIEW_NEXT_AT_REVIEW, idleNext, reviewNext } from './next-words'

// 各派工的提示詞在 prompts/<種類>.ts；呼叫端照舊從這裡匯入。
export { NO_PUSH_RULE, PUSH_RULE } from './prompts/rules'
export { openPrRequest, pushRequest } from './prompts/publish'
export { REVIEW_FILE, SECURITY_FILE, reviewTask } from './prompts/review'
export type { ReviewOpts } from './prompts/review'
export { REVIEW_NEXT, idleNext, reviewNext } from './next-words'
export { markOf, markRefusal } from './worktree-mark'
export type { WorktreeMark } from './worktree-mark'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHORT_ID = /^[0-9a-f]{8}$/i

/**
 * publish：合併段派 Agent push 分支、開 PR（或 PR 已開時只 push）；不改程式、不在自動流程裡。
 * catchup：合併段跟基準分支有衝突時自動派 Agent 把基準分支合併進來、解衝突；不 push、沒有按鍵。
 */
export type DispatchKind = 'continue' | 'sync' | 'review' | 'reply' | 'publish' | 'catchup'
/** dispatch.json 的 kinds 可以各設模型的派工種類；同步另用 sync.claude，解衝突用 continue 的。 */
export const MODEL_KINDS = ['continue', 'reply', 'review', 'publish'] as const
export type ModelKind = typeof MODEL_KINDS[number]
/** 審查用語；template 是審查契約檔（空白用 plugin 內附的 templates/review.md）。 */
export type ReviewWords = { high: string; security: string; categories: string; template: string }
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
  /** updateCheck："off" 不自動檢查 desk 新版本；沒設＝每 24 小時查一次。 */
  updateCheck: '' | 'off'
  /** 同時在跑的工作桌背景 Agent 上限（整台機器一起算）；超過的派工排隊。0＝不限。 */
  maxAgents: number
  /** 審查過關（含免審查過關）後自動派推送 Agent push 並開 PR（PR 已開只 push）；只認 JSON 的 true，建議寫在專案的 dispatch.json。 */
  autoPr: boolean
  /** 背景 Agent 要不要載入 MCP server。預設不載（`--strict-mcp-config`）：每個 MCP 都是一支常駐程序，派工一多就吃掉記憶體；要用再在 dispatch.json 設 `mcp: true`。 */
  mcp: boolean
  /** 做完的背景 Agent 由工作桌在下一次重新整理時 `claude stop` 收掉：不停的話每支各佔幾百 MB，閒置到 daemon 回收。預設開，只有 JSON 的 false 關掉。 */
  stopDone: boolean
}

export const DEFAULT_MAX_AGENTS = 3

export const DEFAULT_USER = '使用者'
export const DEFAULT_REVIEW: ReviewWords = {
  high: '實際的 bug、漏做授權或資料範圍檢查、測試沒測到需求',
  security: '授權與資料範圍、輸入驗證、SQL 與 XSS、個人資料外洩（log、匯出、版控）、機密與金鑰、檔案路徑、外部呼叫',
  categories: '授權、個資、測試、命名',
  template: '',
}

const str = (v: unknown) => typeof v === 'string' ? v.trim() : ''
const strList = (v: unknown) => Array.isArray(v) ? v.map(str).filter(Boolean) : []
/** 一次派工留下的紀錄，按任務根目錄存在 $.store。 */
export type JobRecord = { launchName: string; nativeId: string; sessionId: string; kind: DispatchKind; startedAt: number; fresh: boolean; answered?: boolean; /** 這次停在提問時，工作桌看過卡片「等你」有內容（題目寫進卡片了）；之後「等你」清成「無」就算在對話處理過。 */ cardAsked?: boolean; /** 自動流程已處理過這次的結果。 */ handled?: boolean; /** 修正第幾輪；0 或沒有是一般派工。 */ round?: number; owner?: string; /** 這次審查是資安審查。 */ security?: boolean; /** 審查通過後又有新 commit，流程自己排的「重新檢查、審查」，不是派工。 */ recheck?: boolean; /** 這次怎麼結束的（工作桌看到它不在跑時記下）：做完，或被 `claude stop` 停掉；沒有就是還沒看到它結束。 */ ended?: { how: 'finished' | 'stopped' } }
export type RootJobs = { sessionId?: string; last?: JobRecord; /** 最後一次會改程式的派工（繼續、回覆、修正）結束時 worktree 的未提交指紋（markOf）；派工前拿來分辨現在的改動是不是它留下的。 */ mark?: string }
export type RawAgent = { id?: string; name?: string; sessionId?: string; cwd?: string; kind?: string; state?: string; status?: string; waitingFor?: string; startedAt?: number; pid?: number | null }

export const KIND_LABEL: Record<DispatchKind, string> = { continue: '繼續', sync: '同步', review: '驗收', reply: '回覆', publish: '推送', catchup: '解衝突' }

/** dispatch.json：全域 model／effort、每任務覆寫（鍵是根目錄）、同步模型、人名、專案規則、審查用語、風險路徑。讀不到就用預設。 */
export function parseSettings(text: string | null): DispatchSettings {
  const out: DispatchSettings = { model: '', effort: '', sync: { model: '', effort: '', fresh: false }, projects: {}, kinds: {}, user: DEFAULT_USER, rules: [], review: { ...DEFAULT_REVIEW }, riskHigh: [], checkServices: {}, composeDir: '', cardBase: '', updateCheck: '', maxAgents: DEFAULT_MAX_AGENTS, autoPr: false, mcp: false, stopDone: true }
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
    out.review = { high: str(d?.review?.high) || DEFAULT_REVIEW.high, security: str(d?.review?.security) || DEFAULT_REVIEW.security, categories: str(d?.review?.categories) || DEFAULT_REVIEW.categories, template: str(d?.review?.template) }
    if (Array.isArray(d?.risk?.high)) for (const r of d.risk.high) {
      // 寫錯的正規式略過，不讓整份設定失效。
      try { if (str(r?.pattern) && str(r?.label)) out.riskHigh.push([new RegExp(str(r.pattern)), str(r.label)]) } catch { /* 略過 */ }
    }
    if (d?.checkServices && typeof d.checkServices === 'object') for (const [cmd, v] of Object.entries<unknown>(d.checkServices)) {
      if (str(cmd) && strList(v).length) out.checkServices[str(cmd)] = strList(v)
    }
    out.composeDir = str(d?.composeDir)
    out.cardBase = str(d?.card?.base)
    out.updateCheck = d?.updateCheck === false || str(d?.updateCheck).toLowerCase() === 'off' ? 'off' : ''
    // 非負整數照用（0＝不限）；負數、小數、字串都當沒寫。
    out.maxAgents = Number.isInteger(d?.maxAgents) && d.maxAgents >= 0 ? d.maxAgents : DEFAULT_MAX_AGENTS
    // 字串 "true"、數字 1 都算沒開：自動推送會寫遠端，只認明確的 true。
    out.autoPr = d?.autoPr === true
    // 同 autoPr：只認明確的 true。
    out.mcp = d?.mcp === true
    // 反過來：預設開，只認明確的 false 關掉。
    out.stopDone = d?.stopDone !== false
  } catch { /* 壞掉的設定檔當作沒有。 */ }
  return out
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

/** 這件任務這種派工用的 model／effort：種類（kinds）> 任務覆寫 > 全域；同步另有自己的模型，解衝突照 continue（接任務的 session）。 */
export function modelFor(settings: DispatchSettings, root: string, kind: DispatchKind): { model: string; effort: string; fresh: boolean } {
  const own = settings.projects[normalizeRoot(root)] ?? {}
  const base = { model: own.model ?? settings.model, effort: own.effort ?? settings.effort }
  if (kind === 'sync') return { model: settings.sync.model || base.model, effort: settings.sync.effort || base.effort, fresh: settings.sync.fresh }
  const byKind = settings.kinds[kind === 'catchup' ? 'continue' : kind] ?? {}
  // 推送只要分支與卡片，開新對話就夠了，不接任務那個越來越長的 session。
  return { model: byKind.model ?? base.model, effort: byKind.effort ?? base.effort, fresh: kind === 'review' || kind === 'publish' }
}

export function launchName(now: number, seq: number): string {
  return `desk-${now.toString(36)}-${seq.toString(36)}`
}

/** 名字是不是 launchName() 取的（desk-<時間>-<序號>）：工作桌派出去的背景 agent。 */
export const isDeskLaunch = (name: string): boolean => /^desk-[0-9a-z]+-[0-9a-z]+$/.test(name)

/**
 * 在跑的工作桌 Agent 有幾個：背景、名字是 launchName() 取的、status busy；不看根目錄（別的專案、別的對話派的也算）。
 * 停在提問或等權限批准（waiting）、idle、blocked、stopped 都不算。
 */
export function runningDeskAgents(list: readonly RawAgent[]): number {
  return list.filter(a => a.kind === 'background' && isDeskLaunch(String(a.name ?? '')) && String(a.status ?? '').toLowerCase() === 'busy').length
}

/** 組 `claude --bg` 的參數；提示詞一定是最後一個。沒開 `mcp` 就加 `--strict-mcp-config`，背景 Agent 不拉任何 MCP 程序。 */
export function launchArgs(prompt: string, opts: { model?: string; effort?: string; sessionId?: string; launchName: string; mcp?: boolean }): string[] {
  return ['claude', '--bg', '--name', opts.launchName, ...(opts.sessionId ? ['--resume', opts.sessionId] : []), ...(opts.model ? ['--model', opts.model] : []), ...(opts.effort ? ['--effort', opts.effort] : []), ...(opts.mcp ? [] : ['--strict-mcp-config']), prompt]
}

/** `claude --bg` 印出的短 id 或完整 session id；一行文字、JSON 或夾在句子裡都行；找到兩個不同的就不猜。 */
export function parseLaunchToken(stdout: string): string | null {
  const text = stdout.replace(/\u001b\[[0-9;]*m/g, '').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() ?? ''
  if (SHORT_ID.test(text) || UUID.test(text)) return text
  try {
    const v = JSON.parse(text)
    const c = typeof v?.id === 'string' ? v.id.trim() : typeof v?.sessionId === 'string' ? v.sessionId.trim() : ''
    return SHORT_ID.test(c) || UUID.test(c) ? c : null
  } catch { /* 一般文字輸出 */ }
  const found = new Set<string>()
  for (const m of stdout.matchAll(/(?<![0-9a-f])(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{8})(?![0-9a-f])/gi)) found.add(m[0])
  return found.size === 1 ? [...found][0]! : null
}

/** 啟動後清單裡唯一一個叫這個名字、對得上 token、且啟動前不存在的背景 agent。 */
export function confirmLaunch(before: RawAgent[], after: RawAgent[], name: string, token: string): RawAgent | null {
  const seen = new Set(before.map(a => `${a.id ?? ''}|${a.sessionId ?? ''}`))
  const hits = after.filter(a => a.kind === 'background' && a.name === name && (a.id === token || a.sessionId === token) && !seen.has(`${a.id ?? ''}|${a.sessionId ?? ''}`) && typeof a.sessionId === 'string' && UUID.test(a.sessionId))
  return hits.length === 1 ? hits[0]! : null
}

export type FixReason = { from: 'check' | 'review'; round: number; tail?: string[]; /** 審查修正接在資安審查之後：依 SECURITY.md 修，不是 REVIEW.md。 */ security?: boolean }

/** `self`：這次派出去的啟動名；Agent 查同一個 worktree 有沒有別的 Agent 時，才不會把自己當成別人。 */
export function buildPrompt(c: Case, kind: DispatchKind, text = '', fix?: FixReason, review?: ReviewOpts, settings: DispatchSettings = parseSettings(null), self = ''): string {
  const head = fix ? fixHead(c, fix)
    // 下一步還是範本佔位（舊卡沒跑 spec-ok）：不把佔位文字原樣交給 Agent。
    : kind === 'continue' ? (isPlaceholder(c.next) ? PLAN_STEP : (fixByG(c) && idleNext(c.next) ? manualFixHead(c, ciFailed(c)) : '') || `依卡片的下一步繼續：${c.next || '（下一步空白，先讀卡片與 git 狀態決定）'}`)
    : kind === 'sync' ? '同步卡片：這是新的對話，沒有先前記憶。先讀卡片、git log -5 與 git status，只寫檔案與 git 看得到的事實；看不出結果的寫「待確認」，不要補做工作。只在狀態、下一步、檢查確實與事實不符時才改那一欄；歷程只在有新的事實（新 commit、新測試結果、新發現）時加一行，並寫出那個事實；什麼都沒變就一個字都不寫、直接結束。'
    : kind === 'review' ? reviewPrompt(c, settings.review, review)
    : kind === 'publish' ? publishHead(text)
    : kind === 'catchup' ? catchupHead(text)
    : `${named(settings.user).trimStart()}的回覆：${text}`
  const writes = !!fix || kind === 'continue' || kind === 'reply'
  const publishing = !fix && kind === 'publish'
  const catchup = !fix && kind === 'catchup'
  // 解衝突改程式但不 push：合併 commit 由流程重新檢查、審查後，照合併段的 ⇡ push 推上去。
  const base = cardRules(settings.user, [...settings.rules, ...(settings.projects[normalizeRoot(c.root)]?.rules ?? [])], writes || publishing, publishing ? PUBLISH_CARD_RULE : catchup ? CATCHUP_CARD_RULE : DONE_RULE)
  const rules = writes ? [SPEC_RULE, changelogRule(c), testRule(c), ...base] : catchup ? [testRule(c), ...base] : base
  const who = self ? [`你的背景 Agent 名字是 ${self}；查同一個 worktree 有沒有別的 Agent 時，清單裡這個名字就是你自己。`] : []
  return [head, `任務：${c.name}`, `根目錄：${c.root}`, `卡片：${c.statusPath}`, ...who, ...rules].join('\n')
}

/** PR 開著、CI 失敗、本機沒有待 push 的 commit：「輪到你」叫你按 g 修正。 */
export const ciFailed = (c: Case): boolean => c.pipeline?.current === 'merge' && c.pr?.state === 'OPEN' && c.pr.ci === 'fail' && !needsPush(c)
/** 「輪到你」叫你按 g 修的時候（檢查失敗、流程停下、Agent 被停掉、PR 的 CI 失敗）：下一步寫什麼，g 都要派得出去。 */
export const fixByG = (c: Case): boolean => c.state === 'failed' || ciFailed(c)

/** 現在可以派哪些：進行中一律不派；等回覆只給回覆；規格未確認或沒有完成檢查不能派實作；同步隨時可。 */
export function dispatchable(c: Case): DispatchKind[] {
  if (c.manual || c.state === 'running' || c.state === 'nocard') return []
  if (c.state === 'reply') return ['reply', 'sync']
  // 等權限批准：回覆放行不了工具，只能同步。
  if (c.state === 'approve') return ['sync']
  // 已上線：沒有要實作或審查的東西，只能同步。
  if (c.state === 'done') return ['sync']
  // 規格還沒確認（關卡 spec：…）：不派實作也不審查，只能同步。
  if (parseGate(c.gate)?.kind === 'spec') return ['sync']
  // 規格段還是範本、六段停在規格段：一樣只能同步（已經審查過、合併、打 tag 的不擋）。
  if (specBlocks(c)) return ['sync']
  const out: DispatchKind[] = []
  // 「輪到你」叫你按 g 修（檢查失敗、CI 失敗）：下一步只剩等待或派審查也照樣能派，不然 g 是死路。
  if (!reviewTask(c) && c.next && c.state !== 'idle' && c.verify && (fixByG(c) || !idleNext(c.next))) out.push('continue')
  if ((reviewTask(c) || c.verify) && !isReleaseLine(c)) out.push('review')
  // 推送只在合併段、還要 push 或開 PR 時；高風險改動也能派，面板上第一次按只提醒先看審查檔。
  if (needsPr(c) || needsPush(c)) out.push('publish')
  out.push('sync')
  return out
}

/** 規格段認不到填好的 AC，而且六段停在規格段（沒算過六段的當作停在規格段；六段走完時 current 是 null，不算）。 */
export const specBlocks = (c: Case) => !!c.specGap && (c.pipeline ? c.pipeline.current === 'spec' : true)
/** specBlocks 時不能派工的原因：手動派工的拒絕與自動流程停下都用這句。 */
export const specGapReason = (c: Case) => `規格沒有驗收情境：先輸入 ${CARD_CMD} spec ${slugOf(c)}`

const MANUAL = '登錄表設為 manual，只追蹤不派工'
export const PUBLISH_ONLY_AT_MERGE = '只有合併段還要 push 或開 PR 時才能推送'
const BUSY = 'Agent 仍在執行'
const APPROVAL_WAIT = 'Agent 在等權限批准'

/** 不能回覆的原因；空字串代表 Agent 停下來在等你、可以回覆（不管卡片關卡或「等你」是什麼）。 */
export function replyRefusal(c: Case): string {
  if (c.demo) return '示範任務只能看'
  if (c.manual) return MANUAL
  // 權限提示要到 claude agents 批准；回覆會被當成一則新訊息，不會放行那個工具。
  if (c.state === 'approve' || approvalWait(c.agent)) return `${APPROVAL_WAIT}，不是提問`
  if (c.state === 'reply' || agentWaits(c.agent)) return ''
  return c.state === 'running' || c.agent?.status === 'busy' ? BUSY : 'Agent 沒有在等你回覆'
}

/** 手動派工不能派的原因；空字串代表可以派。回覆看 Agent 是否在等你，其他看 dispatchable。 */
export function dispatchRefusal(c: Case, kind: DispatchKind): string {
  if (kind === 'reply') return replyRefusal(c)
  if (dispatchable(c).includes(kind)) return ''
  if (c.manual) return MANUAL
  if (c.state === 'running' || (kind === 'publish' && agentBusy(c))) return BUSY
  if (kind === 'publish') return PUBLISH_ONLY_AT_MERGE
  if (specBlocks(c)) return specGapReason(c)
  if (parseGate(c.gate)?.kind === 'spec') return '規格還沒確認'
  if (!c.verify) return '卡片尚缺完成檢查，規格未通過'
  // 審查段（檢查已通過）：「輪到你」已經是按 w，不再叫你先按 v。
  if (kind === 'continue' && reviewNext(c.next) && c.pipeline?.current === 'review') return REVIEW_NEXT_AT_REVIEW
  return (kind === 'continue' ? idleNext(c.next) : '') || '卡片狀態不符'
}

/**
 * 確認規格後自動派實作不能派的原因；空字串代表可以派。按 g 在「等你」有事時照樣能派，自動派不行：要你決定的事還沒決定。
 * 其他照手動派繼續（manual、Agent 在跑、規格還擋著、沒有完成檢查、下一步只剩等待）。
 */
export function afterSpecRefusal(c: Case): string {
  if (!saysNone(c.ask)) return '卡片「等你」還有要你決定的事'
  return dispatchRefusal(c, 'continue')
}

/** 排隊等派的一筆：手動（g、w、s、y、⇡）或自動流程排的；opts 照原本派工的參數。 */
export type QueueOpts = { text?: string; fix?: FixReason; auto?: boolean; security?: boolean }
export type QueueEntry = { statusPath: string; kind: DispatchKind; opts: QueueOpts; at: number }

export const NO_PUSH_NEEDED = '已不需要推送（PR 已開且分支已是最新，或不在合併段）'

/**
 * 排隊的這筆現在不能派的原因；空字串代表可以派。手動排的照手動派工重新判斷；自動排的要流程還在（這個對話的、沒停下）、
 * 規格沒擋、還沒合併。兩種都要那件沒有 Agent 在跑：自動排的只看真的 Agent（跟 autoChain 跳過的條件同一條），
 * 不看 state——審查有 CRITICAL／HIGH、流程還在時 stateOf 回 running，看 state 會把排隊的修正當成執行中丟掉。
 * 停在權限提示的 Agent 也算（同一個 worktree 不多開一個），原因寫在等權限批准，你才知道要去批准。
 * 自動排的推送（審查過關後）不看流程：過關後流程不再動，只看還要不要推。
 */
export function queueRefusal(c: Case, entry: Pick<QueueEntry, 'kind' | 'opts'>, run: ChainRun | undefined, mine: string): string {
  if (!entry.opts.auto) return dispatchRefusal(c, entry.kind)
  if (c.agent && !c.agent.asks) return approvalWait(c.agent) ? APPROVAL_WAIT : BUSY
  if (entry.kind === 'publish') return isMerged(c) ? '已經合併' : !needsPr(c) && !needsPush(c) ? NO_PUSH_NEEDED : ''
  if (!run || run.owner !== mine) return '流程已不是這個對話的'
  if (run.stopped) return `流程已暫停（${run.stopped}）`
  if (specBlocks(c)) return specGapReason(c)
  if (isMerged(c)) return '已經合併'
  return ''
}
