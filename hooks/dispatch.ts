// 派工：組 `claude --bg` 的參數與提示詞、解析啟動輸出、對回新 agent。純函式；I/O 在 register.tsx。
import type { Case } from '../types'
import { agentBusy, isReleaseLine, needsPr, needsPush } from './pipeline'
import { CARD_CMD, named, parseGate, saysNone } from './card'
import { agentWaits, slugOf } from './model'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHORT_ID = /^[0-9a-f]{8}$/i

/** publish：合併段派 Agent push 分支、開 PR（或 PR 已開時只 push）；不改程式、不在自動流程裡。 */
export type DispatchKind = 'continue' | 'sync' | 'review' | 'reply' | 'publish'
/** 審查用語；template 是審查契約檔（空白用 plugin 內附的 templates/review.md）。 */
export type ReviewWords = { high: string; security: string; categories: string; template: string }
export type DispatchSettings = {
  model: string; effort: string; sync: { model: string; effort: string; fresh: boolean }
  projects: Record<string, { model?: string; effort?: string; rules?: string[] }>
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
}

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
export type JobRecord = { launchName: string; nativeId: string; sessionId: string; kind: DispatchKind; startedAt: number; fresh: boolean; answered?: boolean; /** 自動流程已處理過這次的結果。 */ handled?: boolean; /** 修正第幾輪；0 或沒有是一般派工。 */ round?: number; owner?: string; /** 這次審查是資安審查。 */ security?: boolean; /** 審查通過後又有新 commit，流程自己排的「重新檢查、審查」，不是派工。 */ recheck?: boolean; /** 這次怎麼結束的（工作桌看到它不在跑時記下）：做完，或被 `claude stop` 停掉；沒有就是還沒看到它結束。 */ ended?: { how: 'finished' | 'stopped' } }
export type RootJobs = { sessionId?: string; last?: JobRecord; /** 最後一次會改程式的派工（繼續、回覆、修正）結束時 worktree 的未提交指紋（markOf）；派工前拿來分辨現在的改動是不是它留下的。 */ mark?: string }
export type RawAgent = { id?: string; name?: string; sessionId?: string; cwd?: string; kind?: string; state?: string; status?: string; waitingFor?: string; startedAt?: number; pid?: number | null }

export const KIND_LABEL: Record<DispatchKind, string> = { continue: '繼續', sync: '同步', review: '審查', reply: '回覆', publish: '推送' }

/** dispatch.json：全域 model／effort、每任務覆寫（鍵是根目錄）、同步模型、人名、專案規則、審查用語、風險路徑。讀不到就用預設。 */
export function parseSettings(text: string | null): DispatchSettings {
  const out: DispatchSettings = { model: '', effort: '', sync: { model: '', effort: '', fresh: false }, projects: {}, user: DEFAULT_USER, rules: [], review: { ...DEFAULT_REVIEW }, riskHigh: [], checkServices: {}, composeDir: '', cardBase: '', updateCheck: '' }
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
  } catch { /* 壞掉的設定檔當作沒有。 */ }
  return out
}

export const normalizeRoot = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')

/** 這件任務這種派工用的 model／effort：任務覆寫 > 全域；同步另有自己的模型。 */
export function modelFor(settings: DispatchSettings, root: string, kind: DispatchKind): { model: string; effort: string; fresh: boolean } {
  const own = settings.projects[normalizeRoot(root)] ?? {}
  const base = { model: own.model ?? settings.model, effort: own.effort ?? settings.effort }
  if (kind === 'sync') return { model: settings.sync.model || base.model, effort: settings.sync.effort || base.effort, fresh: settings.sync.fresh }
  // 推送只要分支與卡片，開新對話就夠了，不接任務那個越來越長的 session。
  return { ...base, fresh: kind === 'review' || kind === 'publish' }
}

export function launchName(now: number, seq: number): string {
  return `desk-${now.toString(36)}-${seq.toString(36)}`
}

/** 名字是不是 launchName() 取的（desk-<時間>-<序號>）：工作桌派出去的背景 agent。 */
export const isDeskLaunch = (name: string): boolean => /^desk-[0-9a-z]+-[0-9a-z]+$/.test(name)

export function launchArgs(prompt: string, opts: { model?: string; effort?: string; sessionId?: string; launchName: string }): string[] {
  return ['claude', '--bg', '--name', opts.launchName, ...(opts.sessionId ? ['--resume', opts.sessionId] : []), ...(opts.model ? ['--model', opts.model] : []), ...(opts.effort ? ['--effort', opts.effort] : []), prompt]
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

/**
 * 每次派工都附的規則；canPush（會改程式的派工與推送）可以 push 自己的分支、開 PR，其他的不寫遠端。
 * publishing（推送）不做實作，關卡與檢查留原樣。專案規則（dispatch.json 的 rules 與任務的 rules）接在最後。
 */
function cardRules(settings: DispatchSettings, root: string, canPush = false, publishing = false): string[] {
  return [
    '卡片要精簡：狀態一句話 60 字內、下一步 40 字內，多件事用「；」分開；commit、測試數字、檔案清單等細節寫在卡片下方的歷程，不要塞進這兩欄。',
    '卡片在 .desk/CARD.md（或 .console/STATUS.md）；結束這一輪前把五欄寫回，每欄一行。保留卡片既有的欄位名，不要改名：舊卡用「驗證」「等使用者」，新卡用「檢查」「等你」，工作桌兩種都讀得懂。',
    '寫入前重讀卡片；內容與你開始時讀到的不同就停止並回報衝突，不要覆寫。',
    '檢查欄只放一條可執行的完成檢查（反引號），exit 0 代表做完；發現寫在 狀態 或 .task/REPORT.md。',
    `要${named(settings.user)}決定的事寫進 等你（有選項寫成 問題：A) … B) …）後結束這一輪，不要提問等待。`,
    publishing ? PUBLISH_CARD_RULE : '做完實作：關卡留 無；完成檢查與審查由工作桌自動接手，你不用自己送審查。',
    '只在此任務根目錄作業；不碰正式環境、不啟動或重建容器、不改 port、不在主工作區切分支。',
    canPush ? PUSH_RULE : NO_PUSH_RULE,
    ...settings.rules,
    ...(settings.projects[normalizeRoot(root)]?.rules ?? []),
  ]
}

/** 會改程式的派工（繼續、回覆、修正）多這一條：照規格做，審查會逐條對照驗收情境。 */
const SPEC_RULE = '實作或修正前先讀卡片「## 規格」：非目標不要做；每條驗收情境（AC-n）都要做到，並有測試斷言到「則」那欄的結果，測試名稱照「對應測試」欄。規格做不到、互相矛盾或需要改，寫進 等你 後結束這一輪，不要自己改規格。有實作計畫時照「### 實作計畫」做，不用再停下來交計畫（規格確認時已一起確認）；實際改的檔跟計畫不同時在歷程寫明原因，要改範圍或做法寫進 等你。卡片沒有規格段就照下一步做。'

/** 推送只動遠端與卡片：審查結論（關卡）與完成檢查是之前判定的，改了六段會退回去。 */
const PUBLISH_CARD_RULE = '這次只推送：關卡與檢查欄保持原樣；狀態寫 PR 與 CI 的現況，下一步寫等 CI 與合併。'
/** 「⇡ 開 PR」要推送 Agent 做的事；`target` 是基準分支（可帶 origin/），找不到就空白。開不了 PR 的平台寫進等你。 */
export const openPrRequest = (branch: string, target: string) =>
  `push ${branch} 並${target ? `對 ${target.replace(/^origin\//, '')} ` : ''}開 PR，PR 網址寫進歷程；沒有 gh 或平台開不了 PR（例如 Bitbucket）時，push 完把開 PR 的網址寫進 等你 後結束`
/** 「⇡ push」要推送 Agent 做的事：PR 已開，只 push、不開新 PR。 */
export const pushRequest = (branch: string, prId?: number) =>
  `只 push ${branch}（PR${prId ? ` #${prId}` : ''} 已開，不開新 PR），push 後把分支頂端 commit 寫進歷程`
/** 推送的提示頭；`text` 是 openPrRequest 或 pushRequest 組好的那句。 */
const publishHead = (text: string) => `推送：${text || openPrRequest('這個分支', '')}。只推已 commit 的：不 commit、不改程式、不 rebase。`

/** 會改程式的派工（繼續、回覆、修正）與推送可以 push 自己的分支、開 PR；寫遠端的範圍只到這裡。 */
export const PUSH_RULE = '可以 push 這件任務自己的分支（git push -u origin \u003c分支\u003e）並對基準分支開 PR；不 force push、不 push 到其他分支（main、release/* 等）、不合併 PR、不打 tag。push 或開 PR 後把分支頂端 commit 與 PR 網址寫進歷程。'
/** 同步與審查只讀不寫遠端。 */
export const NO_PUSH_RULE = '不 push、不開 PR。'

/** 會改程式的派工再多一條：CHANGELOG 條目寫片段檔，不碰 CHANGELOG.md（發版時由 card.py changelog 合併，分支之間才不會搶「## 未發布」）。 */
const changelogRule = (c: Case) => `專案有 changelog.d/ 資料夾時，使用者看得到的改動寫成 CHANGELOG 條目放在 changelog.d/${slugOf(c)}.md（一行或多行「- 」開頭、動詞開頭：新增／修復／調整／移除，沒有標題與版本；沒有使用者看得到的改動就不建這個檔），不要改 CHANGELOG.md，發版時才合併。沒有這個資料夾就照專案原本的慣例。`

export const REVIEW_FILE = '.task/REVIEW.md'
export const SECURITY_FILE = '.task/SECURITY.md'

/** 審查的參數：第幾輪、複審只看哪個 commit 之後、是不是資安審查、常犯錯誤清單與過去審查紀錄在哪。 */
export type ReviewOpts = { round: number; base?: string; /** 第一次審查的 diff 基準分支（例如 origin/main）；不知道就請審查自己找。 */ target?: string; security?: boolean; /** 審查通過後又有新 commit 的重新審查：只看 base 之後的 diff。 */ recheck?: boolean; pitfalls: string; history: string; /** 審查契約檔；沒給就用設定檔的 review.template。 */ template?: string }

export type FixReason = { from: 'check' | 'review'; round: number; tail?: string[] }

/** `self`：這次派出去的啟動名；Agent 查同一個 worktree 有沒有別的 Agent 時，才不會把自己當成別人。 */
export function buildPrompt(c: Case, kind: DispatchKind, text = '', fix?: FixReason, review?: ReviewOpts, settings: DispatchSettings = parseSettings(null), self = ''): string {
  const head = fix ? (fix.from === 'check'
      ? `修正第 ${fix.round}／2 輪：完成檢查 \`${c.verify}\` 未通過。輸出最後幾行：\n${(fix.tail ?? []).join('\n')}\n修到完成檢查綠，commit 後寫回卡片。`
      : `修正第 ${fix.round}／2 輪：依 ${REVIEW_FILE} 修正所有 CRITICAL 與 HIGH（MEDIUM、LOW 不用修）。修完 commit，卡片 關卡 改回 無，狀態寫一句修了什麼。`)
    : kind === 'continue' ? `依卡片的下一步繼續：${c.next || '（下一步空白，先讀卡片與 git 狀態決定）'}`
    : kind === 'sync' ? '同步卡片：這是新的對話，沒有先前記憶。先讀卡片、git log -5 與 git status，只寫檔案與 git 看得到的事實；看不出結果的寫「待確認」，不要補做工作。只在狀態、下一步、檢查確實與事實不符時才改那一欄；歷程只在有新的事實（新 commit、新測試結果、新發現）時加一行，並寫出那個事實；什麼都沒變就一個字都不寫、直接結束。'
    : kind === 'review' ? reviewPrompt(c, settings.review, review)
    : kind === 'publish' ? publishHead(text)
    : `${named(settings.user).trimStart()}的回覆：${text}`
  const writes = !!fix || kind === 'continue' || kind === 'reply'
  const publishing = !fix && kind === 'publish'
  const base = cardRules(settings, c.root, writes || publishing, publishing)
  const rules = writes ? [SPEC_RULE, changelogRule(c), ...base] : base
  const who = self ? [`你的背景 Agent 名字是 ${self}；查同一個 worktree 有沒有別的 Agent 時，清單裡這個名字就是你自己。`] : []
  return [head, `任務：${c.name}`, `根目錄：${c.root}`, `卡片：${c.statusPath}`, ...who, ...rules].join('\n')
}

/** 下一步以 .task/review-… 開頭時，那個路徑。 */
export function reviewTask(c: Case): string {
  const m = c.next.match(/^\s*(\.task\/review-[^\s（(]+\.md)/)
  return m ? m[1]! : ''
}

const IDLE_WAIT = '(?:(?:自動|完成)?檢查(?:結果|通過)?|(?:程式碼|資安)?審查(?:結果|通過)?|審閱(?:結果|通過)?|合併|PR(?:\\s*#?\\d+)?(?:合併|通過)?|CI(?:\\s*通過)?|(?:你|使用者|[A-Za-z][\\w-]*)\\s*(?:確認|拍板|審閱|決定)?)'
/** `/desk:card done` 寫的下一步「到面板按 v 執行完成檢查」（與「按 v」的幾種寫法）：也是等檢查，不派 Agent。 */
const IDLE_PRESS_V = '(?:到面板\\s*)?按\\s*[vV](?:\\s*(?:執行|跑)?\\s*(?:完成)?檢查)?'
const IDLE_CLAUSE = new RegExp(`^(?:${IDLE_PRESS_V}|(?:過了|通過後?)\\s*開\\s*PR|開\\s*PR|(?:等|待)\\s*${IDLE_WAIT}(?:\\s*(?:與|和|、|及)\\s*${IDLE_WAIT})*)$`)

/** 下一步每一件都只是「等檢查／審查／合併／PR／CI／確認」或「開 PR」時，沒有要 Agent 做的事；回傳拒絕原因，否則空字串。 */
export function idleNext(next: string): string {
  if (saysNone(next)) return ''
  const parts = next.split(/[；;]/).map(s => s.trim()).filter(Boolean)
  return parts.length > 0 && parts.every(p => IDLE_CLAUSE.test(p))
    ? '下一步只剩等檢查／審查／開 PR，沒有要 Agent 做的事；要改程式先把下一步寫成要做的事'
    : ''
}

/** 現在可以派哪些：進行中一律不派；等回覆只給回覆；規格未確認或沒有完成檢查不能派實作；同步隨時可。 */
export function dispatchable(c: Case): DispatchKind[] {
  if (c.manual || c.state === 'running' || c.state === 'nocard') return []
  if (c.state === 'reply') return ['reply', 'sync']
  // 已上線：沒有要實作或審查的東西，只能同步。
  if (c.state === 'done') return ['sync']
  // 規格還沒確認（關卡 spec：…）：不派實作也不審查，只能同步。
  if (parseGate(c.gate)?.kind === 'spec') return ['sync']
  // 規格段還是範本、六段停在規格段：一樣只能同步（已經審查過、合併、打 tag 的不擋）。
  if (specBlocks(c)) return ['sync']
  const out: DispatchKind[] = []
  if (!reviewTask(c) && c.next && c.state !== 'idle' && c.verify && !idleNext(c.next)) out.push('continue')
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

/** 不能回覆的原因；空字串代表 Agent 停下來在等你、可以回覆（不管卡片關卡或「等你」是什麼）。 */
export function replyRefusal(c: Case): string {
  if (c.demo) return '示範任務只能看'
  if (c.manual) return MANUAL
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
  if (!c.verify) return '卡片尚缺完成檢查，規格未通過'
  return (kind === 'continue' ? idleNext(c.next) : '') || '卡片狀態不符'
}

function reviewPrompt(c: Case, words: ReviewWords, r: ReviewOpts | undefined): string {
  const file = r?.security ? SECURITY_FILE : REVIEW_FILE
  const scope = r?.base && r.recheck
    ? `這是審查通過後又有新 commit 的重新審查：只看 \`git diff ${r.base}..HEAD\`。先讀現有 ${file} 當上一次結論，只判斷這段新 diff 有沒有問題、有沒有處理到上一次列的項目；上一次已列過且沒被改到的 MEDIUM／LOW 不要再提。`
    : r?.base && r.round > 0
    ? `這是修正後的複審（第 ${r.round} 輪）：只看 \`git diff ${r.base}..HEAD\`。先讀現有 ${file} 當上一輪結論，只判斷上一輪的 CRITICAL／HIGH 有沒有修好、這段新 diff 有沒有新問題；上一輪已列過的 MEDIUM／LOW 與標「不修」的項目不要再提。`
    : r?.target ? `看這個分支相對 ${r.target} 的 diff（從 git merge-base 起算）。` : '看這個分支相對它要併進去的分支的 diff（從 git merge-base 起算；先看 PR 目標，沒有就看 origin/HEAD）。'
  return [
    `${r?.security ? '資安審查' : '程式碼審查'}：這是新的對話，不接續 Agent、不參考 Agent 的結論。`,
    `契約：${reviewTask(c) || r?.template || words.template || 'templates/review.md'}。自己重跑完成檢查 \`${c.verify}\`。`,
    scope,
    ...(r?.pitfalls ? [`先讀專案常犯錯誤清單 ${r.pitfalls}，逐條對照這次的改動。`] : []),
    ...(r?.security ? [`資安審查只看：${words.security}；其他交給程式碼審查。`] : []),
    `問題分 CRITICAL（資安、資料外洩、資料毀損）、HIGH（${words.high}）、MEDIUM（可維護性）、LOW（風格）四級。每條寫成「- [等級][類別] 檔案:行 — 說明」，類別用短詞（例如 ${words.categories}）。寫進 ${file}（整份覆寫）。`,
    '最後把卡片 關卡 寫成這個格式，四個數字都要有：review：CRITICAL <n>、HIGH <n>、MEDIUM <n>、LOW <n>；<一句結論>',
    ...(r?.pitfalls && r.history ? [`審完後看 ${r.history} 裡過去的審查紀錄：這次某條發現的類別若過去已出現過、而清單沒有，在 ${r.pitfalls} 檔尾追加一行「- 類別：怎麼避免」。這是唯一可以寫的根目錄外檔案；不要改既有條目。`] : []),
    '不改程式、不 commit。',
  ].join('\n')
}

// 工作桌與主對話撞同一個 worktree：派工前分辨未提交的改動是不是上一個 Agent 留下的。
/** worktree 未提交狀態的指紋：`files` 有幾個檔在 git status 裡，`hash` 是狀態與 diff 的雜湊（乾淨是空字串）。 */
export type WorktreeMark = { files: number; hash: string }

/** 32 位元 FNV-1a，八個十六進位字元；只拿來比「一不一樣」，不需要加密強度（執行環境沒有 node:crypto）。 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

/** `git status --porcelain=v2` 與 `git diff HEAD` 的輸出做成指紋；`#` 開頭的分支標頭不算。 */
export function markOf(status: string, diff: string): WorktreeMark {
  const lines = String(status ?? '').split(/\r?\n/).map(l => l.trimEnd()).filter(l => l && !l.startsWith('#'))
  return lines.length ? { files: lines.length, hash: fnv1a(`${lines.join('\n')}\n${String(diff ?? '')}`) } : { files: 0, hash: '' }
}

const CODE_KINDS: ReadonlySet<DispatchKind> = new Set(['continue', 'reply'])

/**
 * 派繼續／回覆／審查前的拒絕原因；空字串代表可以派。乾淨一律可以；上一個會改程式的 Agent 還在（例如停在提問）時改動是它的；
 * 它結束時留下的指紋（`own.mark`）跟現在一樣也可以。從沒派過工、或指紋不同：有別的對話在改，拒絕。同步不經過這裡。
 */
export function markRefusal(now: WorktreeMark, own: RootJobs | undefined): string {
  if (!now.files) return ''
  const last = own?.last
  if (last && CODE_KINDS.has(last.kind) && !last.ended) return ''
  if (own?.mark !== undefined && own.mark === now.hash) return ''
  return `worktree 有未提交的改動（${now.files} 個檔），不是上一個 Agent 留下的；可能有別的對話在改，commit 或還原後再派`
}
