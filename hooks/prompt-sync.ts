// 面板與對話同步：選取的任務附在每則提示、從面板送出的決策鎖到對話寫回卡片、對話動到卡片時提早重讀。
// 開關、登錄表路徑、教學模式與選項由 register 傳進來（PromptSyncDeps），重讀用 register 的 refreshAfterWrite；這裡只管附卡指紋、送出的決策與兩個計時器。
import { atom, read, update } from 'claude-code'
import type { On, PluginOptions } from 'claude-code'
import type { SentRecord } from '../types'
import { decisionName } from './card'
import { cardContext, cardKey, cardReminder, decisionContext, feedPush } from './desk-io'
import type { Timer } from './desk-io'
import { touchesDesk } from './touch'
import { sentState } from './turn'
import { refreshAfterWrite } from './register'

const snapshot = atom({ plugin: 'desk', key: 'snapshot' } as const, null)
const selected = atom({ plugin: 'desk', key: 'selected' } as const, null)
const sentAtom = atom({ plugin: 'desk', key: 'sent' } as const, {})

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

/** 從面板送出、還在等對話寫回的決策（卡片路徑 → 紀錄）。 */
export async function readSent($: any): Promise<Record<string, SentRecord>> {
  return read($, sentAtom)
}

/** 新對話（含 /clear）：下一則重附卡片全文，之前送出的決策不帶著鎖進來。 */
export async function resetPromptSync($: any) {
  lastAttached = ''
  queuedTimer?.cancel(); queuedTimer = undefined
  await update($, sentAtom, () => ({}))
}

/** /desk off：取消稍後重讀與等著判斷決策的計時器。 */
export function cancelPromptSync() {
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
const rowText = (message: any) => typeof message?.content === 'string' ? message.content
  : Array.isArray(message?.content) ? message.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : ''


export function registerPromptSync(on: On, deps: PromptSyncDeps) {
  // 選取的任務是對話的主角：每次送出都附上它（卡片變了附全文，沒變附一句提醒），再點任務名才取消。
  // 從面板填入的決策送出時記下來：面板鎖住那題，等對話寫回卡片。
  on('prompt.submit', async ($, e, next) => {
    if ((e.origin && !TYPED_ORIGINS.has(e.origin.kind)) || e.isMeta || !deps.isActive()) return next(e)
    const which = await read($, selected).catch(() => null)
    const s = await read($, snapshot).catch(() => null)
    const c = which && s ? s.cases.find(x => x.statusPath === which) ?? null : null
    const name = !deps.isTutorial() && s ? decisionName(String(e.text ?? '')) : null
    const decided = name && s ? s.cases.find(x => !x.demo && x.name === name && x.state === 'ask') ?? null : null
    if (!c && !decided) return next(e)
    const key = c ? cardKey(c) : ''
    // 決策的那件不是選取的主角：卡片內容跟著決策附上，但不把它設成主角。
    const extra = [...(c ? [key === lastAttached ? cardReminder(c) : cardContext(c)] : []), ...(decided ? [decisionContext(decided, decided !== c)] : [])]
    if (decided) await update($, sentAtom, v => ({ ...v, [decided.statusPath]: { ask: decided.ask, ...(e.turnId ? { during: e.turnId } : {}) } }))
    const result = await next({ ...e, context: [...(e.context ?? []), ...extra] })
    if (result.drop) { if (decided) await update($, sentAtom, v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== decided.statusPath))) }
    // 斜線指令（skill 等）附了卡也不算附過：有些指令不進模型，下一則照樣附全文，最多重複一次。
    else if (c && !e.command) lastAttached = key
    return result
  })

  // 回合結束：重讀（等進行中那輪讀完再讀，才看得到這個回合寫的卡），再看送出的決策寫回了沒。
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && deps.isActive()) {
      const endedAt = await $.clock.now()
      void refreshAfterWrite($, deps.options).catch(() => {}).then(() => settleSent($, e.turnId, endedAt)).catch(async (error: unknown) => {
        await feedPush($, [{ at: endedAt, text: `決策狀態更新失敗：${error instanceof Error ? error.message : String(error)}`, tone: 'error' }])
      })
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
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    try { if (deps.isActive() && touchesDesk(e as any, deps.knownPaths())) touchSoon($, deps) } catch { /* 只是提早重讀，失敗就等定時更新 */ }
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
