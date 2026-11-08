// 派工：組 `claude --bg` 的參數與提示詞、解析啟動輸出、對回新 agent。純函式；I/O 在 register.tsx。
import type { Case } from '../types'
import { agentBusy, isMerged, isReleaseLine, needsPr, needsPush } from './pipeline'
import { CARD_CMD, PLAN_STEP, isPlaceholder, named, parseGate, saysNone } from './card'
import { AGENT_STOPPED, MEDIUM_FIX_NOT_SENT, shownStopped } from './chain'
import type { ChainRun } from './chain'
import { UUID, agentWaits, approvalWait } from './agents'
import { slugOf } from './text'
import { normalizeRoot, parseSettings } from './settings'
import type { DispatchSettings } from './settings'
import { DONE_RULE, NO_PUSH_RULE, PUSH_RULE, PUSH_SCOPE_RULE, SELF_CHECK_RULE, SPEC_RULE, cardRules, changelogRule, pitfallsRule, testRule } from './prompts/rules'
import { CATCHUP_CARD_RULE, catchupHead } from './prompts/catchup'
import { PUBLISH_CARD_RULE, publishHead } from './prompts/publish'
import { externalReviewPrompt, reviewPrompt, reviewTask } from './prompts/review'
import type { ReviewOpts } from './prompts/review'
import { fixHead, manualFix } from './prompts/fix'
import type { ManualFix } from './prompts/fix'
import { MISSING_CHECK_NEXT, MISSING_CHECK_WHY, REVIEW_WHY, idleNext } from './next-words'
import { shipTurn, stageActions } from './turn'
import { KIND_LABEL } from './kind-label'

// 各派工的提示詞在 prompts/<種類>.ts；呼叫端照舊從這裡匯入。
export { NO_PUSH_RULE, PUSH_RULE } from './prompts/rules'
export { openPrRequest, openPrSteps, prHowOf, pushRequest } from './prompts/publish'
export type { PrHow } from './prompts/publish'
export { EXTERNAL_VERDICT_LINE, REVIEW_FILE, SECURITY_FILE, parseExternalVerdict, reviewTask } from './prompts/review'
export type { ReviewOpts } from './prompts/review'
export { IDLE_WHY, MISSING_CHECK_NEXT, MISSING_CHECK_WHY, REVIEW_WHY, idleNext, reviewNext } from './next-words'
export { markOf, markRefusal } from './worktree-mark'
export type { WorktreeMark } from './worktree-mark'
// 設定解析搬到 settings.ts、執行時間計算搬到 run-time.ts、啟動名與 Agent 清單比對搬到 agents.ts；呼叫端與測試照舊從這裡匯入也行。
export { DEFAULT_CHAIN_QUOTA_STOP, DEFAULT_MAX_AGENTS, DEFAULT_REVIEW, DEFAULT_USER, MODEL_KINDS, modelFor, normalizeRoot, parseSettings, pitfallsFor } from './settings'
export type { DispatchSettings, ModelKind, ReviewWords } from './settings'
export { RUN_SEEN_STEP_MS, RUN_WARN_MS, addRunTime, dispatchRunMs, observeRun, runMsOn, runOf, spanMs } from './run-time'
export type { RunShown } from './run-time'
export { UUID, confirmLaunch, isDeskLaunch, launchName, runningDeskAgents } from './agents'
export type { RawAgent } from './agents'

const SHORT_ID = /^[0-9a-f]{8}$/i

/**
 * publish：合併段派 Agent push 分支、開 PR（或 PR 已開時只 push）；不改程式、不在自動流程裡。
 * catchup：合併段跟基準分支有衝突時自動派 Agent 把基準分支合併進來、解衝突；不 push、沒有按鍵。
 */
export type DispatchKind = 'continue' | 'sync' | 'review' | 'reply' | 'publish' | 'catchup'
/**
 * 外部 Agent 跑的驗收怎麼結束（工作桌從 `.task/agent-state.json` 看到的）：done 回報完成、blocked 回報失敗、
 * gone 行程已不在卻沒回報完成（或派工後信標一直沒更新）。
 */
export type ExternalEnd = 'done' | 'blocked' | 'gone'
/**
 * 外部 Agent（review.agent）跑的這次驗收：agent 是執行器名稱（信標與動態用），pid 是 card.py send 的背景行程；
 * beaconAt 是這次寫的信標的 startedAt（card.py send 開工的時間；派出時讀信標記下，讀不到就在看到它結束時補記）：
 * 之後你另外派給外部 Agent 的工作會覆寫同一份信標，靠它分辨信標是不是這次的。
 * end 是看到它結束時記下的；settled 是結論已寫回卡片關卡（之後照 Claude 驗收的結論往下走）。
 */
export type ExternalRun = { agent: string; pid?: number; beaconAt?: number; end?: ExternalEnd; settled?: true }
/** 一次派工留下的紀錄，按任務根目錄存在 $.store。 */
export type JobRecord = { launchName: string; nativeId: string; sessionId: string; kind: DispatchKind; startedAt: number; fresh: boolean; answered?: boolean; /** 這次停在提問時，工作桌看過卡片「等你」有內容（題目寫進卡片了）；之後「等你」清成「無」就算在對話處理過。 */ cardAsked?: boolean; /** 自動流程已處理過這次的結果。 */ handled?: boolean; /** 自動流程已接手這次（開跑自動檢查，或停在檢查段後你重開）：之後「等你」出現的題目不是它做完時寫的。 */ chained?: boolean; /** 修正第幾輪；0 或沒有是一般派工。 */ round?: number; owner?: string; /** 這次審查是資安審查。 */ security?: boolean; /** 這次驗收派給外部 Agent（不是 claude --bg）。 */ external?: ExternalRun; /** 審查通過後又有新 commit，流程自己排的「重新檢查、審查」，不是派工。 */ recheck?: boolean; /** 這次怎麼結束的（工作桌看到它不在跑時記下）：做完，或被 `claude stop` 停掉；沒有就是還沒看到它結束。 */ ended?: { how: 'finished' | 'stopped' }; /** 之前幾段在跑的時間加起來（停下來等人時收進來）。 */ busyMs?: number; /** 現在這段開始在跑的時間；沒有就是派出的時間。 */ runAt?: number; /** 這段最後一次看到它在跑（最多每 RUN_SEEN_STEP_MS 記一次）。 */ seenAt?: number; /** 停下來等人（提問、權限提示）：現在這段不算，再看到它在跑才重新起算。 */ paused?: true }
export type RootJobs = { sessionId?: string; last?: JobRecord; /** 最後一次會改程式的派工（繼續、回覆、修正）結束時 worktree 的未提交指紋（markOf）；派工前拿來分辨現在的改動是不是它留下的。 */ mark?: string; /** 這條分支已結束的派工與自動檢查總共跑了幾毫秒（不含正在跑的）。 */ runMs?: number; /** runMs 算的是哪條分支；同一個資料夾換了分支就從 0 起算。 */ runBranch?: string }

export { KIND_LABEL }

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

/**
 * `claude --bg` 因為 repo 還沒信任而開不了：不分大小寫、整字比對 not trusted／not yet trusted／untrusted，出現在任何一行都算。
 * 待確認實際字樣；目前依 docs/WORKFLOW.md 的 workspace not trusted 寬鬆比對（distrusted、單獨的 trusted 不算）。
 */
const UNTRUSTED_RE = /\b(?:not\s+(?:yet\s+)?trusted|untrusted)\b/i

/** 啟動失敗的整段輸出（stderr＋stdout）是不是「還沒信任」。 */
export function isUntrustedLaunch(text: string): boolean {
  return UNTRUSTED_RE.test(text)
}

/** 啟動失敗：訊息是輸出的最後一行；untrusted 是整段輸出看得出 repo 還沒信任。 */
export class LaunchError extends Error {
  readonly untrusted: boolean
  /** 已經啟動、只是 agents 清單還沒列出來：Agent 可能正在跑，不能當成沒派出去重派。 */
  readonly unconfirmed: boolean
  constructor(message: string, untrusted: boolean, unconfirmed = false) {
    super(message)
    this.name = 'LaunchError'
    this.untrusted = untrusted
    this.unconfirmed = unconfirmed
  }
}

/**
 * 面板記著的「還沒信任」（每件一筆）：派的是哪一種、是不是自動流程派的，「輪到你」才說得出要按哪個鍵。
 * 派工開頭、成功派出，以及重新整理看到之後又有 Agent 開過時清掉。
 */
export type UntrustedHold = { kind: 'untrusted'; root: string; at: number; dispatch: DispatchKind; auto: boolean }

/** 給人照抄到終端機的路徑：有空白或 shell 特殊字元時用單引號包起來，一般路徑照原樣。 */
export function shellPath(path: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

/**
 * 還沒信任時的三步（不含任務名）：「輪到你」直接用，toast 與動態在前面接「<任務名>：」。
 * key 是回面板要再按的鍵；不知道（自動流程派的、解衝突）就說重新派工。
 */
export function untrustedSteps(root: string, key?: string): string {
  const again = key ? `回面板再按 ${key}` : '回面板再重新派工'
  return `Agent 開不了，這個 repo 還沒信任。①另開終端機分頁：cd ${shellPath(root)} && claude ②信任提示選 Yes ③輸入 /exit ${again}（不要用 ! 跑）`
}

/**
 * 重新整理時留下還成立的「還沒信任」：失敗之後這件又有 Agent 開過（別的對話派的、或信任後派出的），repo 顯然已經信任，拿掉那筆。
 * 都還成立就回原本那份（不觸發重畫）。
 */
export function liveHolds(holds: Readonly<Record<string, UntrustedHold>>, cases: readonly Pick<Case, 'statusPath' | 'agent'>[]): Readonly<Record<string, UntrustedHold>> {
  const startedAfter = (path: string, at: number) => cases.some(c => c.statusPath === path && (c.agent?.startedAt ?? 0) > at)
  const kept = Object.entries(holds).filter(([path, h]) => !startedAfter(path, h.at))
  return kept.length === Object.keys(holds).length ? holds : Object.fromEntries(kept)
}

export type FixReason = { /** medium：你在「等你」對審查 MEDIUM 題選了修掉。 */ from: 'check' | 'review' | 'medium'; round: number; tail?: string[]; /** 審查修正接在資安審查之後：依 SECURITY.md 修，不是 REVIEW.md。你選修掉 MEDIUM（from medium）時是這次流程跑過資安審查：兩份都看。 */ security?: boolean }

/** 會改程式的派工（繼續、回覆、修正）：多帶規格、CHANGELOG、測試與自我檢查的規則。 */
export const writesCode = (kind: DispatchKind, fix?: FixReason): boolean => !!fix || kind === 'continue' || kind === 'reply'

/** 按 g 派、開頭走 manualFix 的那份（fixByG 且下一步只剩等待或派審查，或選了修掉 MEDIUM 沒派出）；其他派工是 undefined。 */
function manualFixOf(c: Case, kind: DispatchKind, fix?: FixReason): ManualFix | undefined {
  if (fix || kind !== 'continue' || isPlaceholder(c.next) || !fixByG(c)) return undefined
  return idleNext(c.next) || c.chain?.stopped === MEDIUM_FIX_NOT_SENT ? manualFix(c, ciFailed(c)) : undefined
}

/**
 * 會改程式的派工裡要讀常犯錯誤清單的：實作與回覆。修正不讀（修審查檔或檢查指出的具體問題，另有「同一類全部列出」）：
 * 自動流程的修正輪（帶 fix），與按 g 派的修正——跟 fixesByG 算修正輪數用同一組條件（Agent 被停止後重開、停在檢查段不算修正），
 * 開頭走 manualFix 時再扣掉沒東西要修的（額度煞車擋在派驗收前）。派工端決定要不要查清單檔也用這一份。
 */
export function readsPitfalls(c: Case, kind: DispatchKind, fix?: FixReason): boolean {
  if (fix || !writesCode(kind)) return false
  if (kind !== 'continue' || !fixesByG(c)) return true
  return manualFixOf(c, kind)?.repairs === false
}

/**
 * `self`：這次派出去的啟動名；Agent 查同一個 worktree 有沒有別的 Agent 時，才不會把自己當成別人。
 * `pitfalls`：常犯錯誤清單路徑（呼叫端確認檔案存在才給）；只有實作與回覆用得到（修正給了也不帶，見 readsPitfalls），審查的清單照舊放在 `review`。
 */
export function buildPrompt(c: Case, kind: DispatchKind, text = '', fix?: FixReason, review?: ReviewOpts, settings: DispatchSettings = parseSettings(null), self = '', pitfalls = ''): string {
  const head = fix ? fixHead(c, fix)
    // 下一步還是範本佔位（舊卡沒跑 spec-ok）：不把佔位文字原樣交給 Agent。
    : kind === 'continue' ? (isPlaceholder(c.next) ? PLAN_STEP : manualFixOf(c, kind)?.head || `依卡片的下一步繼續：${c.next || '（下一步空白，先讀卡片與 git 狀態決定）'}`)
    : kind === 'sync' ? '同步卡片：這是新的對話，沒有先前記憶。先讀卡片、git log -5 與 git status，只寫檔案與 git 看得到的事實；看不出結果的寫「待確認」，不要補做工作。只在狀態、下一步、檢查確實與事實不符時才改那一欄；歷程只在有新的事實（新 commit、新測試結果、新發現）時加一行，並寫出那個事實；什麼都沒變就一個字都不寫、直接結束。'
    : kind === 'review' ? reviewPrompt(c, settings.review, review)
    : kind === 'publish' ? publishHead(text)
    : kind === 'catchup' ? catchupHead(text, c.verify)
    : `${named(settings.user).trimStart()}的回覆：${text}`
  const writes = writesCode(kind, fix)
  const publishing = !fix && kind === 'publish'
  const catchup = !fix && kind === 'catchup'
  // 解衝突改程式但不 push：合併 commit 由流程重新檢查、審查後，照合併段的 ⇡ push 推上去。
  // 推送的歷程範例已寫在推送步驟（openPrRequest／pushRequest），範圍規則不再附一次。
  const pushRule = writes ? PUSH_RULE : publishing ? PUSH_SCOPE_RULE : NO_PUSH_RULE
  const base = cardRules(settings.user, [...settings.rules, ...(settings.projects[normalizeRoot(c.root)]?.rules ?? [])], pushRule, publishing ? PUBLISH_CARD_RULE : catchup ? CATCHUP_CARD_RULE : DONE_RULE)
  // 交出前先做審查會做的檢查：自我檢查給會改程式的派工，清單（有設、檔案在才有）只給實作與回覆、修正不帶（readsPitfalls）；解衝突、同步、審查、推送不帶。
  // 解衝突不附 testRule：catchupHead 第 3 步已寫「解完跑一次完成檢查」，testRule 叫它不跑，兩句相反。
  const selfCheck = [...(pitfalls && readsPitfalls(c, kind, fix) ? [pitfallsRule(pitfalls)] : []), SELF_CHECK_RULE]
  const rules = writes ? [SPEC_RULE, ...selfCheck, changelogRule(c), testRule(c), ...base] : base
  const who = self ? [`你的背景 Agent 名字是 ${self}；查同一個 worktree 有沒有別的 Agent 時，清單裡這個名字就是你自己。`] : []
  return [head, `任務：${c.name}`, `根目錄：${c.root}`, `卡片：${c.statusPath}`, ...who, ...rules].join('\n')
}

/**
 * 這次驗收改派外部 Agent：專案設了 review.agent，而且不是資安審查、也不是高風險分支併做資安的驗收（那兩種照舊用 Claude）。
 * 外部驗收沒有結果、改派的 Claude 驗收（fallback）也不改派。
 */
export function usesExternalReview(settings: DispatchSettings, review: Pick<ReviewOpts, 'security' | 'securityFocus'>, fallback = false): boolean {
  return !!settings.review.agent && !review.security && !review.securityFocus && !fallback
}

/** 外部驗收的整份提示：審查本身（不碰卡片）加上任務、根目錄；不附卡片規則，外部 Agent 不改卡片。 */
export function buildExternalPrompt(c: Case, review: ReviewOpts, settings: DispatchSettings): string {
  return [externalReviewPrompt(c, settings.review, review), `任務：${c.name}`, `根目錄：${c.root}`].join('\n')
}

/** PR 開著、CI 失敗、本機沒有待 push 的 commit：「輪到你」叫你按 g 修正。 */
export const ciFailed = (c: Case): boolean => c.pipeline?.current === 'merge' && c.pr?.state === 'OPEN' && c.pr.ci === 'fail' && !needsPush(c)
/** 「輪到你」叫你按 g 修的時候（檢查失敗、流程停下、Agent 被停掉、PR 的 CI 失敗）：下一步寫什麼，g 都要派得出去。 */
export const fixByG = (c: Case): boolean => c.state === 'failed' || ciFailed(c)
/**
 * 按 g 派出去的真的是修正（算進整張卡的修正輪數，不受上限擋）：fixByG 裡扣掉不是修東西的兩種——
 * Agent 被停掉後重開（接著把那件事做完）、停在檢查段（測試沒跑成，不是沒過）。
 */
export const fixesByG = (c: Case): boolean => fixByG(c) && c.chain?.stopped !== AGENT_STOPPED && !c.chain?.heldAtCheck

/** 已合併、停在上線段（還沒上線）：分支已進基準分支，不派實作、審查，也不跑檢查。發版線沒有合併段，不算。 */
export const mergedUnshipped = (c: Case): boolean => c.pipeline?.current === 'ship' && isMerged(c)

/** 現在可以派哪些：進行中一律不派；等回覆只給回覆；規格未確認或沒有完成檢查不能派實作；同步隨時可。 */
export function dispatchable(c: Case): DispatchKind[] {
  if (c.manual || c.state === 'running' || c.state === 'nocard') return []
  if (c.state === 'reply') return ['reply', 'sync']
  // 等權限批准：回覆放行不了工具，只能同步。
  if (c.state === 'approve') return ['sync']
  // 已上線，或已合併還沒上線（分支已進基準分支）：沒有要實作或審查的東西，只能同步。
  if (c.state === 'done' || mergedUnshipped(c)) return ['sync']
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
const BUSY = 'Agent 處理中'
const APPROVAL_WAIT = 'Agent 在等權限批准'
const FOLLOW_TURN = '照「輪到你」做'
const OPEN_NEXT = '開卡片（o）看下一步'
const APPROVE_NEXT = '到終端機跑 claude agents 批准它'
const BUSY_NEXT = '等 Agent 做完再按一次；要中途停掉按 k'

/** 不能派（或回覆）的原因與下一步；next 是面板上此刻按得到的鍵、要輸入的指令，或「照「輪到你」做」。示範任務沒有下一步。 */
export type Refusal = { why: string; next?: string }

/** 不能回覆的原因；null 代表 Agent 停下來在等你、可以回覆（不管卡片關卡或「等你」是什麼）。 */
function replyRefusalOf(c: Case): Refusal | null {
  if (c.demo) return { why: '示範任務只能看' }
  if (c.manual) return { why: MANUAL, next: `在這個對話自己做；${OPEN_NEXT}` }
  // 權限提示要到 claude agents 批准；回覆會被當成一則新訊息，不會放行那個工具。
  if (c.state === 'approve' || approvalWait(c.agent)) return { why: `${APPROVAL_WAIT}，不是提問`, next: APPROVE_NEXT }
  if (c.state === 'reply' || agentWaits(c.agent)) return null
  if (c.state === 'running' || c.agent?.status === 'busy') return { why: BUSY, next: BUSY_NEXT }
  return { why: 'Agent 沒有在等你回覆', next: '要交代新的事，開卡片（o）改下一步' }
}

/** 不能回覆的原因（一行）；空字串代表可以回覆。 */
export function replyRefusal(c: Case): string {
  return refusalLine(replyRefusalOf(c))
}

/** 卡片狀態擋下的原因：照 dispatchable 擋下的順序分句（條件不新增）。 */
function stageRefusal(c: Case, kind: DispatchKind): Refusal {
  if (c.state === 'reply') return { why: 'Agent 停著在等你回覆', next: '按 y 回覆它' }
  if (c.state === 'approve') return { why: APPROVAL_WAIT, next: APPROVE_NEXT }
  // 發版線不歸檔（canArchive 排除它），照「輪到你」等下一版。
  if (c.state === 'done') return { why: '已上線', next: isReleaseLine(c) ? FOLLOW_TURN : `輸入 ${CARD_CMD} archive ${slugOf(c)} 歸檔` }
  if (reviewTask(c) && kind === 'continue') return { why: '這張是驗收任務卡，只派驗收、不派實作', next: FOLLOW_TURN }
  if (isReleaseLine(c) && kind === 'review') return { why: '發版線不派驗收，只跑測試', next: FOLLOW_TURN }
  if (kind === 'continue' && !c.next) return { why: '下一步空白', next: '開卡片（o）寫下一步' }
  if (c.state === 'idle') return { why: '卡片閒置（下一步寫「無」）', next: '開卡片（o）寫狀態與下一步' }
  return { why: `這個階段不能${KIND_LABEL[kind]}`, next: FOLLOW_TURN }
}

const STATE_FIRST = new Set<Case['state']>(['reply', 'approve', 'done'])

/**
 * 下一步只剩等待時，g 被拒的下一步：只叫你按這一刻面板列著的鍵（stageActions），沒列的就照「輪到你」做。
 * 還沒過測試時，通過後流程可能自動驗收，w 也要那時才列，所以只叫你先按 v。
 */
function idleRefusalNext(c: Case, idle: string): string {
  const actions = stageActions(c)
  if (idle === REVIEW_WHY && actions.has('review')) return '按 w 派驗收'
  if (!actions.has('verify')) return FOLLOW_TURN
  return idle === REVIEW_WHY
    ? '先按 v 執行測試，通過後照「輪到你」派驗收'
    : '按 v 執行測試；要改程式先開卡片（o）把下一步寫成要做的事'
}

/** 手動派工不能派的原因與下一步；null 代表可以派。回覆看 Agent 是否在等你，其他看 dispatchable。 */
export function refusalOf(c: Case, kind: DispatchKind): Refusal | null {
  if (kind === 'reply') return replyRefusalOf(c)
  if (dispatchable(c).includes(kind)) return null
  if (c.manual) return { why: MANUAL, next: `在這個對話自己做；${OPEN_NEXT}` }
  if (c.state === 'running' || (kind === 'publish' && agentBusy(c))) return { why: BUSY, next: BUSY_NEXT }
  // 排隊等名額時 PR 被合併、或按了還沒重新整理的舊鍵：跟自動排的一樣說已經合併，不叫你按已經不列的 v、w。
  if (mergedUnshipped(c)) return { why: '分支已合併，不再派實作或驗收', next: shipTurn(c).text }
  if (kind === 'publish') return { why: PUBLISH_ONLY_AT_MERGE, next: FOLLOW_TURN }
  if (specBlocks(c)) return { why: '規格沒有驗收情境', next: `輸入 ${CARD_CMD} spec ${slugOf(c)}` }
  if (parseGate(c.gate)?.kind === 'spec') return { why: '規格還沒確認', next: `看過規格（o）後按 t 確認，或輸入 ${CARD_CMD} spec ${slugOf(c)} ok` }
  // 走到這裡規格已過：只差檢查欄。
  if (!c.verify) return { why: MISSING_CHECK_WHY, next: MISSING_CHECK_NEXT }
  // 等回覆、等批准、已上線先講卡片狀態：下一步寫什麼都不是這時該按的鍵。
  if (kind === 'continue' && !STATE_FIRST.has(c.state)) {
    const idle = idleNext(c.next)
    if (idle) return { why: idle, next: idleRefusalNext(c, idle) }
  }
  return stageRefusal(c, kind)
}

/** 一行「原因；下一步」（沒有下一步只回原因）；null 回空字串。給動態與 /desk 指令這類只要一句的地方。 */
export const refusalLine = (r: Refusal | null): string => !r ? '' : r.next ? `${r.why}；${r.next}` : r.why

/** toast 與對話回覆的拒絕句：「<任務>：無法<動作>（<原因>）；<下一步>」。 */
export const refusalText = (name: string, action: string, r: Refusal): string =>
  `${name}：無法${action}（${r.why}）${r.next ? `；${r.next}` : ''}`

/** 手動派工不能派的原因（一行「原因；下一步」）；空字串代表可以派。排隊的動態用這句。 */
export function dispatchRefusal(c: Case, kind: DispatchKind): string {
  return refusalLine(refusalOf(c, kind))
}

/**
 * 確認規格後自動派實作不能派的原因；null 代表可以派。按 g 在「等你」有事時照樣能派，自動派不行：要你決定的事還沒決定。
 * 其他照手動派繼續（manual、Agent 在跑、規格還擋著、沒有完成檢查、下一步只剩等待）。
 */
export function afterSpecRefusal(c: Case): Refusal | null {
  if (!saysNone(c.ask)) return { why: '卡片「等你」還有要你決定的事', next: '開卡片（o）處理「等你」的決定' }
  return refusalOf(c, 'continue')
}

/** 排隊等派的一筆：手動（g、w、s、y、⇡）或自動流程排的；opts 照原本派工的參數。 */
export type QueueOpts = { text?: string; fix?: FixReason; auto?: boolean; security?: boolean; /** 外部驗收沒有結果、改派的 Claude 驗收：設了 review.agent 也不再派給外部 Agent。 */ fallback?: boolean; /** 你按 g（或 /desk go）接續被額度煞車擋下的那步：照自動流程接續原本那輪，但算你手動派的，排隊時不看額度。 */ resumed?: boolean }
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
  if (run.stopped) return `流程已暫停（${shownStopped(run.stopped)}）`
  if (specBlocks(c)) return specGapReason(c)
  if (isMerged(c)) return '已經合併'
  return ''
}
