// desk 更新的執行面：自動檢查新版本（只提示、不安裝）與手動更新（/desk update、面板按鈕）。
// 查到的結果存 $.store，提示掛在快照上；比版號、找安裝位置這些純邏輯在 update.ts。
import { atom, update } from 'claude-code'
import { feedPush } from './desk-io'
import { UPDATE_EVERY_MS, UPDATE_KEY, checkLatest, isNewer, noticeOf, noticeText, parseCheck, updateDesk } from './update'
import type { UpdateCheck } from './update'

const snapshot = atom({ plugin: 'desk', key: 'snapshot' } as const, null)

export async function loadUpdateCheck($: any): Promise<UpdateCheck | null> {
  return parseCheck(await $.store.get(UPDATE_KEY).catch(() => null))
}

let checkingUpdate = false
/**
 * desk 新版本的自動檢查（教學模式由呼叫的地方擋掉）：距離上次查到結果超過 24 小時才查（時間存 $.store，重開也算）。只提示、不安裝；
 * 同一個版號只在「最近」記一筆、跳一次 toast。查失敗不出聲、不記時間，下一輪再查。
 */
export async function autoUpdateCheck($: any, now: number) {
  if (checkingUpdate) return
  const prev = await loadUpdateCheck($)
  if (prev && now - prev.at < UPDATE_EVERY_MS) return
  checkingUpdate = true
  try {
    const found = await checkLatest($, now)
    const fresh = isNewer(found.latest, found.current) && prev?.notified !== found.latest
    const next: UpdateCheck = { ...found, ...(fresh ? { notified: found.latest } : prev?.notified ? { notified: prev.notified } : {}) }
    await $.store.set(UPDATE_KEY, next)
    await showNotice($, next)
    if (fresh) {
      await feedPush($, [{ at: now, text: `desk ${noticeText(found.latest)}`, tone: 'suggestion' }])
      $.ui.toast(`desk ${noticeText(found.latest)}`, { timeoutMs: 8000 })
    }
  } catch { /* 查失敗不提示，下一輪再查 */ } finally { checkingUpdate = false }
}

async function showNotice($: any, check: UpdateCheck) {
  await update($, snapshot, s => {
    if (!s) return s
    const notice = noticeOf(check, s.versions?.desk)
    const { update: _old, ...rest } = s
    return notice ? { ...rest, update: notice } : rest
  })
}

let updating = false
/** 手動更新（/desk update、面板按鈕）：結果記進「最近」並跳 toast；查到的版號給自動檢查沿用。 */
export async function runUpdate($: any): Promise<string> {
  if (updating) return 'desk 正在更新中，請稍候。'
  updating = true
  try {
    const now = await $.clock.now()
    const r = await updateDesk($, now)
    if (r.check) {
      const prev = await loadUpdateCheck($)
      const check: UpdateCheck = { ...r.check, ...(prev?.notified ? { notified: prev.notified } : {}) }
      await $.store.set(UPDATE_KEY, check)
      await showNotice($, check)
    }
    await feedPush($, [{ at: now, text: r.text, tone: r.tone }])
    $.ui.toast(r.text, { timeoutMs: r.tone === 'success' ? 10_000 : 8000 })
    return r.text
  } finally { updating = false }
}
