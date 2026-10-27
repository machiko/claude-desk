// desk 更新的執行面：自動檢查新版本（只提示、不安裝）與手動更新（/desk update、面板按鈕）。
// 查到的結果存 $.store，提示掛在快照上；比版號、找安裝位置這些純邏輯在 update.ts。
import { atom, read, update } from 'claude-code'
import { feedPush } from './desk-io'
import { UPDATE_EVERY_MS, UPDATE_KEY, checkLatest, isNewer, noticeOf, noticeText, parseCheck, reloadFilledText, reloadTypeText, updateDesk } from './update'
import type { UpdateCheck } from './update'

const snapshot = atom({ plugin: 'desk', key: 'snapshot' } as const, null)
const loadsAtom = atom({ plugin: 'desk', key: 'loads' } as const, 0)

/** 這個模組是 desk 在這個 session 第幾次載入；/reload-plugins 載入新的模組時計數再加 1。 */
let loadNo = 0
/** session.start（新模組載入時也會跑）：把 $.state 的載入計數加 1，記下自己是第幾次。 */
export async function markLoaded($: any) {
  loadNo = (await read($, loadsAtom)) + 1
  await update($, loadsAtom, () => loadNo)
}

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
    // 等這個 hook 回完才重新載入：從 /desk update 的 command.run hook 裡直接跑會被宿主拒絕（會卡住它占著的回合）；
    // 也不等它跑完：重新載入排隊到對話閒下來才跑、會重跑 register，updating 旗標與回覆都不能卡在這裡。
    if (r.tone === 'success') $.clock.after(0, () => void reloadAfterUpdate($, now).catch(() => { /* 只剩寫「最近」失敗，更新本身已回報 */ }))
    return r.text
  } finally { updating = false }
}

/**
 * 更新成功後讓新版生效：像使用者輸入一樣執行 /reload-plugins。Claude Code 不讓 plugin 執行時，
 * 把 /reload-plugins 預填進輸入框；連預填也不行就請使用者自己輸入。兩種都記進「最近」並跳 toast。
 * 拒絕的錯誤沒有可辨識的型態，所以只在確定新版還沒載入時才預填：重新載入其實已經發生、舊模組這邊才收到拒絕，就什麼都不做。
 */
export async function reloadAfterUpdate($: any, now: number) {
  try {
    await $.command.run({ command: 'reload-plugins', args: '' })
    return
  } catch { /* 被拒絕；先確定新版真的還沒載入 */ }
  if (await newerLoaded($)) return
  const filled = await $.prompt.fill({ text: '/reload-plugins', mode: 'replace' }).catch(() => ({ isFilled: false }))
  const text = filled?.isFilled ? reloadFilledText : reloadTypeText
  await feedPush($, [{ at: now, text, tone: 'warning' }])
  $.ui.toast(text, { timeoutMs: 10_000 })
}

/**
 * 載入計數已不是這個模組的那一號（新版載入了），或讀不到（舊的 $ 已失效）。
 * 這個模組沒記過號（session.start 沒跑）就分不出來：當成沒載入，寧可多提示一次也不靜默。
 */
async function newerLoaded($: any): Promise<boolean> {
  if (!loadNo) return false
  try { return (await read($, loadsAtom)) !== loadNo } catch { return true }
}
