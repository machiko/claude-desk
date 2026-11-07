// Agent 清單解析：`claude agents --json` 的每一筆對回任務、判斷在跑／停下等人／做完，以及工作桌派工的啟動名。
// 純函式；model.ts、dispatch.ts 與派工 I/O 都從這裡拿。
import type { AgentInfo, Case } from '../types'
import type { JobRecord } from './dispatch'
import { saysNone } from './card'
import { plain } from './text'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function rawAgents(json: string): any[] {
  try { const v = JSON.parse(json.replace(/^\uFEFF/, '')); return Array.isArray(v) ? v : Array.isArray(v?.agents) ? v.agents : [] } catch { return [] }
}

/**
 * `claude agents --json --all`：每個根目錄留一個「真的在動」的背景 agent（status busy，或 waiting 停在權限提示）。
 * 一個轉完回合的 agent 會 status idle 而 state 還是 working／blocked，那不算在跑，也不算停下來等你：
 * blocked 是做完一輪的正常結束狀態，Agent 要問人寫進卡片「等你」；只有 status waiting 才是停下來等。
 */
export const parseAgents = (json: string): Record<string, AgentInfo> => agentsByRoot(rawAgents(json))

const cwdOf = (a: any): string => typeof a?.cwd === 'string' ? a.cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''

/** 同 parseAgents，從已經解析好的清單（例如拿掉被取代的之後）挑。 */
export function agentsByRoot(list: readonly any[]): Record<string, AgentInfo> {
  const out: Record<string, AgentInfo> = {}
  for (const a of list) {
    const cwd = cwdOf(a)
    if (!cwd || a.kind !== 'background') continue
    const status = String(a.status ?? '').toLowerCase()
    if (status !== 'busy' && status !== 'waiting') continue
    const info = agentInfo(a)
    const prev = out[cwd]
    if (!prev || (info.startedAt ?? 0) > (prev.startedAt ?? 0)) out[cwd] = info
  }
  return out
}

/** 一個根目錄最後一次派工的名字與派出時間（$.store 的 jobs）。 */
export type LastLaunch = { launchName: string; startedAt: number }
/** 被後來的派工取代、還停在提問的工作桌 Agent。 */
export type Superseded = { root: string; id: string; name: string; startedAt: number }

const isSuperseded = (a: any, last: Readonly<Record<string, LastLaunch>>): boolean => {
  const l = last[cwdOf(a)]
  const name = String(a?.name ?? '')
  return !!l && a.kind === 'background' && String(a.status ?? '').toLowerCase() === 'waiting'
    && isDeskLaunch(name) && name !== l.launchName && typeof a.startedAt === 'number' && a.startedAt < l.startedAt
}

/**
 * 挑出被取代的 Agent：工作桌派的（desk- 開頭）、停在提問（status waiting）、比這個根目錄最後一次派工早啟動、不是最後那一次。
 * 它們不再代表任務（狀態照卡片走）；回傳拿掉它們之後的清單，與被取代的那幾個（給工作桌停掉）。
 */
export function supersede(list: readonly any[], last: Readonly<Record<string, LastLaunch>>): { list: any[]; superseded: Superseded[] } {
  // 一次分流，每個 Agent 只判斷一次。
  return list.reduce<{ list: any[]; superseded: Superseded[] }>((acc, a) => isSuperseded(a, last)
    ? { list: acc.list, superseded: [...acc.superseded, { root: cwdOf(a), id: typeof a.id === 'string' ? a.id : '', name: plain(String(a.name)), startedAt: a.startedAt as number }] }
    : { list: [...acc.list, a], superseded: acc.superseded }, { list: [], superseded: [] })
}

/** 做完（done／failed，或做完一輪的 blocked）但程序還活著的工作桌 Agent。 */
export type EndedAlive = { root: string; id: string; name: string; startedAt: number | null }

/**
 * 挑出做完、程序還活著的 Agent：工作桌派的（desk- 開頭）、state done／failed／blocked、不在跑（status 不是 busy／waiting）、
 * JSON 有數字的 pid（程序早已退出的沒有 pid）、有 id。不看根目錄在不在工作桌上（歸檔後留下的也算）。
 * blocked 是做完一輪的正常結束狀態（要問人寫進卡片「等你」）；真的停下來等的（status waiting、或還停在權限提示）不會被挑到。
 */
export function endedAlive(list: readonly any[]): EndedAlive[] {
  return list.flatMap(a => {
    const status = String(a?.status ?? '').toLowerCase()
    const state = String(a?.state ?? '').toLowerCase()
    const alive = a?.kind === 'background' && isDeskLaunch(String(a?.name ?? '')) && (state === 'done' || state === 'failed' || blockedDone(a))
      && status !== 'busy' && status !== 'waiting' && typeof a.pid === 'number' && typeof a.id === 'string' && !!a.id
    return alive ? [{ root: cwdOf(a), id: a.id as string, name: plain(String(a.name)), startedAt: typeof a.startedAt === 'number' ? a.startedAt : null }] : []
  })
}

export function agentInfo(a: any): AgentInfo {
  const waitsFor = waitsOf(a)
  return { ...(typeof a.id === 'string' ? { id: a.id } : {}), name: plain(String(a.name ?? a.id ?? '')), ...(typeof a.sessionId === 'string' ? { sessionId: a.sessionId } : {}), state: String(a.state ?? ''), status: String(a.status ?? ''), ...(a.waitingFor ? { waitingFor: plain(String(a.waitingFor)) } : {}), ...(waitsFor ? { waitsFor } : {}), ...(typeof a.startedAt === 'number' ? { startedAt: a.startedAt } : {}) }
}

/**
 * 停下來的 Agent 在等什麼：waitingFor 提到 permission 是權限提示；其他 status waiting 的當成提問。
 * state blocked 本身不算：那是做完一輪的正常結束狀態，Agent 要問人寫進卡片「等你」。
 */
function waitsOf(a: any): AgentInfo['waitsFor'] {
  if (/permission/i.test(String(a?.waitingFor ?? ''))) return 'permission'
  return String(a?.status ?? '').toLowerCase() === 'waiting' ? 'question' : undefined
}

/** Agent 停在權限提示：要到終端機的 claude agents 批准，面板代替不了。 */
export const approvalWait = (a: AgentInfo | undefined) => a?.waitsFor === 'permission'

/** 等權限批准時給人看的那句：現在卡最上方、摘要列與列表都用它。 */
export const approveText = (c: Pick<Case, 'agent'>) => `Agent 在等權限批准：到終端機跑 claude agents 選 ${c.agent?.name || 'Agent'} 批准；批准後面板會自動更新`

const isBlocked = (a: any): boolean => String(a?.state ?? '').toLowerCase() === 'blocked'

/** 做完一輪的 blocked：不在跑（status 不是 busy／waiting），也不是停在權限提示（那個還在等批准，見 asksFor）。 */
const blockedDone = (a: any): boolean => {
  const status = String(a?.status ?? '').toLowerCase()
  return isBlocked(a) && status !== 'busy' && status !== 'waiting' && waitsOf(a) !== 'permission'
}

const launchOf = (list: readonly any[], launchName: string | undefined): any =>
  launchName ? list.find(x => x?.name === launchName && x?.kind === 'background') : undefined

/**
 * 工作桌派出去的那一次（按啟動名）不在跑（不是 busy／waiting）、卻還停在權限提示（state blocked、waitingFor 提到 permission）：
 * 補成停下來的 Agent，面板才說等權限批准。其他 blocked 是做完一輪的正常結束狀態（要問人寫進卡片「等你」），回 null、不補 Agent；
 * status waiting 的已經在 agentsByRoot 挑到，也回 null。
 */
export function asksFor(list: readonly any[], launchName: string | undefined): AgentInfo | null {
  const a = launchOf(list, launchName)
  if (!a) return null
  const status = String(a.status ?? '').toLowerCase()
  if (status === 'busy' || status === 'waiting') return null
  return isBlocked(a) && waitsOf(a) === 'permission' ? { ...agentInfo(a), asks: true } : null
}

/**
 * 工作桌派出去的那一次（按啟動名）停在提問：status waiting 但不是等權限批准。
 * state blocked 本身不算：那是做完一輪的正常結束狀態，Agent 要問人寫進卡片「等你」。
 */
export function asksQuestion(list: readonly any[], launchName: string | undefined): boolean {
  const a = launchOf(list, launchName)
  return !!a && String(a.status ?? '').toLowerCase() === 'waiting' && waitsOf(a) === 'question'
}

/**
 * 最後一次派工停在提問時題目寫進了卡片「等你」，之後在對話處理掉：「等你」清成「無」，或已記成處理過（answered）。
 * 面板、自動流程與「最近」那筆都用這一條判斷：不再等那個 Agent，也不替那次派工接著做。
 */
export const askClearedOnCard = (last: Pick<JobRecord, 'cardAsked' | 'answered'> | undefined, ask: string): boolean =>
  !!last?.cardAsked && (!!last.answered || saysNone(ask))

/**
 * 會改程式的派工（繼續、修正、回覆）做完一輪：Agent 要問人只能寫進卡片「等你」，所以它結束時「等你」有內容就是在等你決定。
 * 驗收通過後有新 commit、流程自己排的重新測試與驗收（recheck）是合成紀錄、不是 Agent 做完：「等你」裡留著的是審查寫的題目，流程照舊。
 */
export const codeJobEnded = (last: Pick<JobRecord, 'kind' | 'ended' | 'recheck'> | undefined): boolean =>
  !!last && !last.recheck && (last.kind === 'continue' || last.kind === 'reply') && last.ended?.how === 'finished'

/**
 * 做完一輪時把要你決定的事寫進了「等你」、還沒處理：自動流程停著等，不替它跑測試、派驗收或修正。
 * 流程已接手的（chained：開跑自動檢查、停在檢查段後你重開）不算，那之後「等你」的題目不是它寫的。
 */
export const askedOnCardAtEnd = (last: Pick<JobRecord, 'kind' | 'ended' | 'recheck' | 'chained'> | undefined, ask: string): boolean =>
  codeJobEnded(last) && !last?.chained && !saysNone(ask)

/**
 * 工作桌派出去的那一次（按啟動名）結束了沒、怎麼結束的：還在跑或停下來等（busy／waiting）、清單裡找不到都是 null；
 * `claude stop` 停掉的是 stopped（清單裡 state 是 stopped、沒有 status），其他算 finished。找不到不算結束：剛派出去的那次可能還沒出現在這份清單。
 * blocked（status 不是 busy／waiting）算 finished：那是做完一輪的正常結束狀態，要問人寫進卡片「等你」；還停在權限提示的不算（null）。
 */
export function endedHow(list: readonly any[], launchName: string | undefined): 'finished' | 'stopped' | null {
  const a = launchOf(list, launchName)
  if (!a) return null
  const status = String(a.status ?? '').toLowerCase()
  if (status === 'busy' || status === 'waiting') return null
  if (isBlocked(a) && !blockedDone(a)) return null
  return String(a.state ?? '').toLowerCase() === 'stopped' ? 'stopped' : 'finished'
}

/**
 * 工作桌派出去的那一次（按啟動名）還沒結束時的樣子：busy 在跑；停在提問、權限提示或還沒做完的 blocked 是 waiting（等人，不算時間）；
 * 不在清單裡（還在啟動）是 null。已經結束的由 endedHow 判斷，這裡不管。
 */
export function runSeen(list: readonly any[], launchName: string | undefined): 'busy' | 'waiting' | null {
  const a = launchOf(list, launchName)
  if (!a) return null
  return String(a.status ?? '').toLowerCase() === 'busy' && !a.waitingFor ? 'busy' : 'waiting'
}

/** 停下來等人的 agent：權限提示，或工作桌派出去的那次停在提問。 */
export const agentWaits = (a: AgentInfo | undefined) => !!a && (!!a.waitingFor || a.status === 'waiting' || !!a.asks)

export type RawAgent = { id?: string; name?: string; sessionId?: string; cwd?: string; kind?: string; state?: string; status?: string; waitingFor?: string; startedAt?: number; pid?: number | null }

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

/** 啟動後清單裡唯一一個叫這個名字、對得上 token、且啟動前不存在的背景 agent。 */
export function confirmLaunch(before: RawAgent[], after: RawAgent[], name: string, token: string): RawAgent | null {
  const seen = new Set(before.map(a => `${a.id ?? ''}|${a.sessionId ?? ''}`))
  const hits = after.filter(a => a.kind === 'background' && a.name === name && (a.id === token || a.sessionId === token) && !seen.has(`${a.id ?? ''}|${a.sessionId ?? ''}`) && typeof a.sessionId === 'string' && UUID.test(a.sessionId))
  return hits.length === 1 ? hits[0]! : null
}
