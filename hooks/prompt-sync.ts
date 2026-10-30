// 面板與對話同步：選取的任務附在每則提示、面板做過的操作附在下一則你打的提示、從面板送出的決策鎖到對話寫回卡片、對話動到卡片時提早重讀、
// 主對話確認規格（/desk:card spec … ok）的回合結束後自動派實作。
// 開關、登錄表路徑、教學模式與選項由 register 傳進來（PromptSyncDeps），重讀用 register 的 refreshAfterWrite；這裡只管附卡指紋、面板操作紀錄的附加與清除、送出的決策與兩個計時器。
import { atom, read, update } from 'claude-code'
import type { On, PluginOptions } from 'claude-code'
import type { PanelAction, SentRecord } from '../types'
import { decisionName, parseGate } from './card'
import { cardContext, cardKey, cardReminder, decisionContext, feedPush, panelActionsContext, tellPanel } from './desk-io'
import type { Timer } from './desk-io'
import { specOkCards, specOkMarks, specOkTarget, specOkVerdict, touchesDesk } from './touch'
import type { SpecOkMarks } from './touch'
import { sentState } from './turn'
import { refreshAfterWrite } from './register'
import { dispatchAfterSpec } from './card-actions'

const snapshot = atom({ plugin: 'desk', key: 'snapshot' } as const, null)
const selected = atom({ plugin: 'desk', key: 'selected' } as const, null)
const sentAtom = atom({ plugin: 'desk', key: 'sent' } as const, {})
const panelActionsAtom = atom({ plugin: 'desk', key: 'panelActions' } as const, [])

export type PromptSyncDeps = {
  /** 這個對話開著工作桌。 */
  isActive: () => boolean
  /** 教學模式：示範任務不認決策。 */
  isTutorial: () => boolean
  /** 登錄表與每張卡片的路徑（上一輪讀到的）：對話改到它們就馬上重讀。 */
  knownPaths: () => readonly string[]
  /** 外掛選項（重讀時要用）。 */
  options: PluginOptions
}

/** 上一次附在提示裡的卡片指紋：卡片沒變就只附一句提醒，不重複全文。 */
let lastAttached = ''
/** 對話改了卡片、跑了卡片腳本或 git 之後多久重讀：同一串工具呼叫只讀一次。 */
const TOUCH_DELAY_MS = 800
/** 稍後重讀（對話改了卡片之後）的計時器；/desk off 時取消。 */
let touchTimer: Timer
/** 回合進行中送出的決策：回合結束後這麼久都沒有新回合開始，就當作提示已經交給那個回合，直接判斷。 */
const QUEUED_GRACE_MS = 5_000
/** 等著判斷「回合中送出的決策」的計時器；/desk off 時取消。 */
let queuedTimer: Timer
/**
 * 只有人打的提示才附選取的卡、才認決策：composer（輸入框，直接送或排隊）與 bridge（Remote Control），而且不是 isMeta。
 * unclassified 包括隊友的訊息、引擎沒蓋章的通知與同使用者 socket 的輸入，都不算；排程、通知、其他 agent 送來的也不算。
 */
const TYPED_ORIGINS = new Set(['composer', 'bridge'])

/** 這個回合主對話用 card.py spec-ok 確認成功的卡片路徑（腳本印的那一行，或跑完比對卡片判定的）：回合結束、重讀後照面板按 t 的規則派實作。 */
let specOks: string[] = []
/** 要提示的對象：任務名；知道是哪張卡時帶卡片路徑。 */
type SpecOkWho = { name: string; statusPath?: string }
/** 這個回合主對話跑了 card.py spec-ok、卻判斷不了有沒有確認的（輸出沒有成功那一行、卡片又讀不到）：回合結束提示「規格可能已確認；要派時按 g」。 */
let specOkUnsure: SpecOkWho[] = []
/** 跑 card.py spec-ok 之前停在 spec 關卡的卡，與那時讀到的樣子（讀不到是 null）。 */
type SpecOkProbe = { name: string; statusPath: string; before: SpecOkMarks | null }

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/**
 * Bash 的輸出：正常結束看 result 的 stdout；整條指令回報錯誤（exit 不是 0，例如 spec-ok 成功、後面串的指令失敗）時
 * result 是錯誤文字、不是 { stdout }，模型讀到的在 text。實機（v2.1.312）的 text 依序是 `Exit code N`、stderr、stdout，
 * 超過約 1 萬字只留頭尾各 5,000 字、中間換成「… [n characters truncated] …」：stderr 與 stdout 都很長時 card.py 成功那一行會被截掉，
 * 所以找不到那一行時要再看卡片（noteSpecOks）。
 */
const bashOutput = (r: any): unknown => (r?.isError ? r.text : r?.result?.stdout)

/** 記一筆判斷不了的（同一張只記一次）。 */
const noteUnsure = (who: SpecOkWho) => { specOkUnsure = [...specOkUnsure.filter(u => u.name !== who.name || u.statusPath !== who.statusPath), who] }

/** 主對話要跑 card.py spec-ok：先讀一次工作桌上停在 spec 關卡的卡（不含示範任務）；讀不到的照面板上一輪的關卡算。 */
async function specOkProbes($: any): Promise<SpecOkProbe[]> {
  const s = await read($, snapshot).catch(() => null)
  if (!s) return []
  const all = await Promise.all(s.cases.filter(c => !c.demo).map(async c => {
    const text = await $.fs.read(c.statusPath).catch(() => null)
    const before = typeof text === 'string' ? specOkMarks(text) : null
    return { probe: { name: c.name, statusPath: c.statusPath, before }, isSpec: before ? before.isSpec : parseGate(c.gate)?.kind === 'spec' }
  }))
  return all.filter(x => x.isSpec).map(x => x.probe)
}

/**
 * 主對話跑完 card.py spec-ok：確認了哪幾張先看輸出裡腳本成功那一行；沒印出來的（錯誤文字截掉中間、輸出被導走）再讀卡，
 * 跟跑之前比（specOkVerdict）：確認了就記下回合結束派；腳本失敗、卡片沒變的不記也不提示；讀不到判斷不了的記下來提示。
 */
async function noteSpecOks($: any, call: any, result: unknown, probes: readonly SpecOkProbe[] | null, target: string) {
  const printed = specOkCards(call, bashOutput(result))
  const seen = new Set(printed.map(normPath))
  const confirmed = [...printed]
  if (!probes && !printed.length) noteUnsure({ name: target })
  for (const p of (probes ?? []).filter(x => !seen.has(normPath(x.statusPath)))) {
    const text = await $.fs.read(p.statusPath).catch(() => null)
    const verdict = specOkVerdict(p.before, typeof text === 'string' ? specOkMarks(text) : null)
    if (verdict === 'confirmed') confirmed.push(p.statusPath)
    else if (verdict === 'unsure') noteUnsure({ name: p.name, statusPath: p.statusPath })
  }
  if (confirmed.length) specOks = [...new Set([...specOks, ...confirmed])]
}

/**
 * 回合結束、重讀之後：這回合主對話確認了規格的那幾張，照面板按 t 的規則派實作；不在登錄表的路徑略過。一張意外出錯不擋其他張，各自說原因。
 * 判斷不了有沒有確認的，提示可能已確認、要派時按 g。
 */
async function dispatchSpecOks($: any, deps: PromptSyncDeps, paths: readonly string[], unsure: readonly SpecOkWho[]) {
  if (!deps.isActive()) return
  const s = await read($, snapshot)
  const want = new Set(paths.map(normPath))
  for (const c of (s?.cases ?? []).filter(x => !x.demo && want.has(normPath(x.statusPath)))) {
    try { await dispatchAfterSpec($, deps.options, c.statusPath) } catch (error) { await specOkDispatchFailed($, deps, error, c) }
  }
  for (const who of unsure) await specOkTell($, deps, '規格可能已確認，但讀不到卡片、判斷不了，沒有自動派實作：要派時按 g', 'warning', who)
}

/** 對話確認了規格、回合結束自動派實作時意外出錯：提示、動態（錯誤）、下一則提示告訴對話都說同一句，不默默吞掉。 */
async function specOkDispatchFailed($: any, deps: PromptSyncDeps, error: unknown, c?: SpecOkWho) {
  await specOkTell($, deps, `規格已確認；自動派實作失敗（${error instanceof Error ? error.message : String(error)}）：要派時按 g`, 'error', c)
}

/** 對話確認規格後，回合結束沒能自動派實作：提示、動態、下一則提示告訴對話都說同一句。 */
async function specOkTell($: any, deps: PromptSyncDeps, text: string, tone: 'error' | 'warning', c?: SpecOkWho) {
  const now = await $.clock.now()
  $.ui.toast(c ? `${c.name}：${text}` : text, { timeoutMs: 10_000 })
  await feedPush($, [{ at: now, text: c ? `${c.name} ${text}` : text, tone, ...(c?.statusPath ? { card: c.statusPath } : {}) }])
  await tellPanel($, now, text, { ...(c ? { name: c.name } : {}), skip: deps.isTutorial() })
}

/** 從面板送出、還在等對話寫回的決策（卡片路徑 → 紀錄）。 */
export async function readSent($: any): Promise<Record<string, SentRecord>> {
  return read($, sentAtom)
}

/** 新對話（含 /clear）：下一則重附卡片全文，之前送出的決策不帶著鎖進來。 */
export async function resetPromptSync($: any) {
  lastAttached = ''
  specOks = []
  specOkUnsure = []
  queuedTimer?.cancel(); queuedTimer = undefined
  await update($, sentAtom, () => ({}))
}

/** /desk off：取消稍後重讀與等著判斷決策的計時器。 */
export function cancelPromptSync() {
  specOks = []
  specOkUnsure = []
  touchTimer?.cancel(); touchTimer = undefined
  queuedTimer?.cancel(); queuedTimer = undefined
}

/** 對話改了卡片、跑了卡片腳本或 git：稍等一下再重讀，同一串工具呼叫只讀一次。 */
function touchSoon($: any, deps: PromptSyncDeps) {
  touchTimer?.cancel()
  touchTimer = $.clock.after(TOUCH_DELAY_MS, () => { touchTimer = undefined; void refreshAfterWrite($, deps.options) })
}

/**
 * 判斷送出的決策寫回了沒（面板重讀過之後）：卡片「等你」改了就清掉；沒改就標成「沒寫回」（不再鎖），讀到的是新的才提醒一次。
 * 只判斷 isDue 挑出來的那幾筆，其他照舊。重讀失敗時照樣解鎖，只是不提醒，免得一直鎖著。
 */
async function judgeSent($: any, endedAt: number, isDue: (r: SentRecord) => boolean) {
  const s = await read($, snapshot)
  if (!s) return
  const isFresh = !s.error && s.at >= endedAt
  let unwritten: string[] = []
  await update($, sentAtom, all => {
    unwritten = []
    const next: Record<string, SentRecord> = {}
    for (const [path, r] of Object.entries(all)) {
      const c = s.cases.find(x => x.statusPath === path)
      if (!c) { if (!isFresh) next[path] = r; continue }
      if (!sentState(all, c)) continue
      if (r.done || !isDue(r)) { next[path] = r; continue }
      next[path] = { ask: r.ask, done: true }
      if (isFresh) unwritten.push(c.name)
    }
    return next
  })
  for (const name of unwritten) $.ui.toast(`${name}：決策已送出，但卡片的「等你」沒有改；按 o 開卡片改掉，或請對話寫回`, { timeoutMs: 10_000 })
}

/**
 * 回合結束：判斷這個回合處理的決策。回合進行中才送出的那筆，提示可能排到下一個回合，也可能當輪就交給了模型：
 * 之後有新回合開始（turn.start 記在 by），留給那個回合；過一下都沒有，就當作這個回合處理過了，直接判斷。
 */
async function settleSent($: any, turnId: string | undefined, endedAt: number) {
  const isQueuedHere = (r: SentRecord) => !r.by && !!turnId && r.during === turnId
  await judgeSent($, endedAt, r => (r.by ? r.by === turnId : !isQueuedHere(r)))
  if (!Object.values(await read($, sentAtom)).some(r => !r.done && isQueuedHere(r))) return
  queuedTimer?.cancel()
  queuedTimer = $.clock.after(QUEUED_GRACE_MS, () => {
    queuedTimer = undefined
    void judgeSent($, endedAt, isQueuedHere).catch(async (error: unknown) => {
      await feedPush($, [{ at: endedAt, text: `決策狀態更新失敗：${error instanceof Error ? error.message : String(error)}`, tone: 'error' }])
    })
  })
}

/** 輸入框打的 ! 指令記進對話的那一列（<bash-input>／<bash-stdout>）。 */
const BANG_ROW = /<bash-(?:input|stdout|stderr)>/
/** 同一筆面板操作的識別：附過的那幾筆從清單拿掉時用。 */
const actionKey = (a: PanelAction) => `${a.at}\n${a.name ?? ''}\n${a.text}`
const rowText = (message: any) => typeof message?.content === 'string' ? message.content
  : Array.isArray(message?.content) ? message.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : ''


export function registerPromptSync(on: On, deps: PromptSyncDeps) {
  // 選取的任務是對話的主角：每次送出都附上它（卡片變了附全文，沒變附一句提醒），取消選取在「更多動作」裡。
  // 從面板填入的決策送出時記下來：面板鎖住那題，等對話寫回卡片。
  // 面板做過、對話還不知道的操作（歸檔、確認規格、檢查結果、派工…）整段附上，附過就清掉；有沒有選取任務都附。
  on('prompt.submit', async ($, e, next) => {
    if ((e.origin && !TYPED_ORIGINS.has(e.origin.kind)) || e.isMeta || !deps.isActive()) return next(e)
    // 斜線指令不附：有些指令不進模型，留給下一則你打的提示。
    const actions: PanelAction[] = e.command ? [] : await read($, panelActionsAtom).catch(() => [])
    const which = await read($, selected).catch(() => null)
    const s = await read($, snapshot).catch(() => null)
    const c = which && s ? s.cases.find(x => x.statusPath === which) ?? null : null
    const name = !deps.isTutorial() && s ? decisionName(String(e.text ?? '')) : null
    const decided = name && s ? s.cases.find(x => !x.demo && x.name === name && x.state === 'ask') ?? null : null
    if (!c && !decided && !actions.length) return next(e)
    const key = c ? cardKey(c) : ''
    // 決策的那件不是選取的主角：卡片內容跟著決策附上，但不把它設成主角。
    const extra = [...(actions.length ? [panelActionsContext(actions)] : []), ...(c ? [key === lastAttached ? cardReminder(c) : cardContext(c)] : []), ...(decided ? [decisionContext(decided, decided !== c)] : [])]
    if (decided) await update($, sentAtom, v => ({ ...v, [decided.statusPath]: { ask: decided.ask, ...(e.turnId ? { during: e.turnId } : {}) } }))
    const result = await next({ ...e, context: [...(e.context ?? []), ...extra] })
    if (result.drop) { if (decided) await update($, sentAtom, v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== decided.statusPath))) }
    // 斜線指令（skill 等）附了卡也不算附過：有些指令不進模型，下一則照樣附全文，最多重複一次。
    else {
      if (c && !e.command) lastAttached = key
      // 只拿掉這次附上的那幾筆：送出途中面板又做的，留給下一則。
      const sent = new Set(actions.map(actionKey))
      if (sent.size) await update($, panelActionsAtom, list => list.filter(a => !sent.has(actionKey(a))))
    }
    return result
  })

  // 回合結束：重讀（等進行中那輪讀完再讀，才看得到這個回合寫的卡），再看送出的決策寫回了沒；這回合確認了規格的派實作。
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && deps.isActive()) {
      const endedAt = await $.clock.now()
      const targets = specOks
      const confirmed = new Set(targets.map(normPath))
      // 同一回合另一次 spec-ok 已確定確認的那張，不再說「可能已確認」。
      const unsure = specOkUnsure.filter(u => !u.statusPath || !confirmed.has(normPath(u.statusPath)))
      specOks = []
      specOkUnsure = []
      const refreshed = refreshAfterWrite($, deps.options).catch(() => {})
      void refreshed.then(() => settleSent($, e.turnId, endedAt)).catch(async (error: unknown) => {
        await feedPush($, [{ at: endedAt, text: `決策狀態更新失敗：${error instanceof Error ? error.message : String(error)}`, tone: 'error' }])
      })
      // 派工自己會提示不能派的原因；意外的例外（每張卡的在 dispatchSpecOks 裡接住）也要說出來，不然卡片確認了卻什麼都沒發生。
      if (targets.length || unsure.length) void refreshed.then(() => dispatchSpecOks($, deps, targets, unsure)).catch(async (error: unknown) => { await specOkDispatchFailed($, deps, error) })
    }
    return next(e)
  })

  // 回合中送出的決策：之後開始的第一個回合就是處理它的那個（排隊的提示），記下來等它結束再判斷。
  on('turn.start', async ($, e, next) => {
    if (!e.agentId && deps.isActive()) {
      await update($, sentAtom, v => Object.fromEntries(Object.entries(v).map(([k, r]) => [k, r.during && !r.by && !r.done ? { ...r, by: e.turnId } : r]))).catch(() => {})
    }
    return next(e)
  })

  // /clear、壓縮之後模型看不到之前附的卡：下一則提示重新附全文。
  on('session.compact', async ($, e, next) => { if (!e.agentId) lastAttached = ''; return next(e) })
  on('session.end', async ($, e, next) => { lastAttached = ''; return next(e) })

  // 對話（或它派的 subagent）改了卡片、登錄表，跑了卡片腳本或會移動分支的 git：馬上重讀，不等回合結束。
  // 主對話（沒有 agentId）跑 card.py spec-ok 確認成功的，記下卡片路徑，回合結束再派：先看腳本印的那一行，輸出裡沒有就比對跑之前先讀的卡；
  // subagent 跑的、腳本失敗（卡片沒變）的不記。
  on('tool.call', async ($, e, next) => {
    const target = deps.isActive() && !e.agentId ? specOkTarget(e as any) : null
    const probes = target ? await specOkProbes($).catch(() => null) : null
    const result = await next(e)
    try { if (deps.isActive() && touchesDesk(e as any, deps.knownPaths())) touchSoon($, deps) } catch { /* 只是提早重讀，失敗就等定時更新 */ }
    // 判斷本身意外出錯：不知道有沒有確認，回合結束照「可能已確認」提示，不默默略過。
    if (target) await noteSpecOks($, e, result, probes, target).catch(() => noteUnsure({ name: target }))
    return result
  })

  // 輸入框的 ! 指令與斜線指令（例如 ! git commit、/desk:card）：結果記進對話後重讀。
  on('session.append', { door: 'command' }, async ($, e, next) => {
    const result = await next(e)
    if (deps.isActive() && !e.agentId) touchSoon($, deps)
    return result
  })
  // 實機（v2.1.302）的 ! 指令兩列都走 door command（上面那個就會重讀）；萬一改記成一般提示列，看內容認出來。
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const result = await next(e)
    try { if (deps.isActive() && !e.agentId && BANG_ROW.test(rowText(e.message))) touchSoon($, deps) } catch { /* 只是提早重讀 */ }
    return result
  })
}
