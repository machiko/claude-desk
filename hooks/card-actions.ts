// 現在卡上的動作：回覆 Agent、派 Agent 開 PR／push、預填決策、開卡片、確認上線、歸檔、確認規格、停止 Agent；
// 以及新專案還沒有任務時的建立空登錄表。
// 從 register.tsx 搬出來（只搬不改）；派工、重新整理仍在 register.tsx，比照 tutorial-run.tsx 從那裡匯入。
// 跨檔傳 $ 的函式一律用 function 宣告；atom 位址同 register.tsx，各自宣告。
import { atom, read } from 'claude-code'
import type { PluginOptions } from 'claude-code'
import type { Case } from '../types'
import { parseDecisions, decisionAnswer, decisionPrompt, allPicked, confirmShip, isPlaceholder, ARCHIVE_WORD, CARD_CMD, PLAN_STEP, REGISTRY_TEMPLATE } from './card'
import { WORD } from './theme'
import { errorLine, reasonLine, slugOf } from './model'
import { baseRefs, deskPaths, lastLine, loadSettings } from './probes'
import { normalizeRoot, openPrRequest, pushRequest, replyRefusal } from './dispatch'
import { isReleaseLine } from './pipeline'
import { AGENT_STOPPED, paused } from './chain'
import { picksKey } from './pane'
import { tutorial, cancelSim, tutorialDecision } from './tutorial-run'
import { feedPush, loadJobs, missingRegistry, openWith, saveChain } from './desk-io'
import { sentState } from './turn'
import { readSent } from './prompt-sync'
import { dispatch, refresh, refreshAfterWrite, optionsRef } from './register'

export const DEMO_ONLY = '示範任務只能看；請照教學那件的指示操作'
const picksAtom = atom({ plugin: 'desk', key: 'picks' } as const, {})

/** 回覆停下來問的 Agent：先問要回什麼（可打自己的字），再 resume 那個 session。 */
export async function reply($: any, options: PluginOptions, c: Case, text?: string) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const why = replyRefusal(c)
  if (why) { $.ui.toast(`${c.name}：目前無法回覆（${why}）`); return }
  let answer = text?.trim() ?? ''
  if (!answer) {
    // 停在提問（status waiting）的 Agent 重新整理時不讀輸出：回覆這時才讀它最後一句。
    const asked = c.agent?.last || (tutorial ? '' : await lastLine($, c.agent?.id))
    const picked = await $.ui.ask(`${asked ? `Agent 提問：${asked}` : '讀不到 Agent 的提問，按 l 看輸出'}\n要回覆什麼？請選「照卡片的下一步繼續」，或在「其他」輸入回覆。`, { header: `${c.name} 回覆`, options: ['照卡片的下一步繼續', '取消'] }).catch(() => '')
    if (!picked || picked === '取消') return
    // 下一步還是範本佔位（舊卡沒跑 spec-ok）：與派工同一條規則，不把佔位文字原樣送給 Agent。
    answer = picked !== '照卡片的下一步繼續' ? picked : isPlaceholder(c.next) ? PLAN_STEP : `照卡片的下一步繼續：${c.next || '依卡片'}`
  }
  // 不先把上一次派工標成已回覆：派出成功時 dispatch 會換上新的那筆；派工失敗時要留著，Agent 才仍算在等你、可以再回覆。
  await dispatch($, options, c, 'reply', { text: answer })
}

/** 教學不派真的 Agent：合併照教學說的按 t。 */
const TUTORIAL_PUBLISH = '教學不會真的 push：照教學的指示按 t 合併'

/** 合併段的「⇡ 開 PR」（按兩次確認後）：派推送 Agent push 分支並對基準分支開 PR；desk 自己不跑 git push、gh。 */
export async function publishPr($: any, options: PluginOptions, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  if (tutorial) { $.ui.toast(`${c.name}：${TUTORIAL_PUBLISH}`); return }
  const [target] = await baseRefs($, c, (await loadSettings($, options)).cardBase ?? '')
  await dispatch($, options, c, 'publish', { text: openPrRequest(c.git?.branch ?? '分支', target ?? '') })
}

/** 合併段 PR 已開後的「⇡ push」（按兩次確認後）：派推送 Agent 只 push、不開新 PR。派出去了、又有未提交的檔案時提醒只會推已 commit 的。 */
export async function publishPush($: any, options: PluginOptions, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  if (tutorial) { $.ui.toast(`${c.name}：${TUTORIAL_PUBLISH}`); return }
  const sent = await dispatch($, options, c, 'publish', { text: pushRequest(c.git?.branch ?? '分支', c.pr?.id) })
  if (sent && c.gitState?.changed) $.ui.toast(`${c.name}：有 ${c.gitState.changed} 檔未提交，只會 push 已 commit 的`)
}

export async function fillDecision($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const decisions = parseDecisions(c.ask)
  const picks = (await read($, picksAtom))[picksKey(c)] ?? {}
  if (!allPicked(decisions, picks)) { $.ui.toast(`${c.name}：請先完成每個決策的選擇（點選項或按數字鍵）`); return }
  if (sentState(await readSent($), c) === 'waiting') { $.ui.toast(`${c.name}：決策已送出，等對話寫回卡片`); return }
  const answer = decisionAnswer(decisions, picks)
  if (tutorial) { await tutorialDecision($, c, answer); return }
  const text = decisionPrompt(c.name, answer)
  const filled = await $.prompt.fill({ text, mode: 'replace' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) { $.ui.toast(`${c.name}：輸入框無法預填，請直接輸入${text}`); return }
  $.ui.toast(`${c.name}：決策已填入，按 Esc 回到輸入框再按 Enter 送出；此任務的卡片會一併附上`, { timeoutMs: 6000 })
}

export async function openCard($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  if (!(await openWith($, c.statusPath))) $.ui.toast(`${c.name}：無法開啟 ${c.statusPath}`)
}

/** 上線確認：重讀卡片，關卡還是 release 才清成「無」並記 History；desk 只在這裡寫卡。 */
export async function confirmShipped($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const text = await $.fs.read(c.statusPath).catch(() => null)
  const d = new Date(await $.clock.now())
  const two = (n: number) => String(n).padStart(2, '0')
  const next = typeof text === 'string' ? confirmShip(text, `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, `${two(d.getHours())}:${two(d.getMinutes())}`, c.tag ?? '', isReleaseLine(c) ? '等下一版開發' : `${ARCHIVE_WORD}：${CARD_CMD} archive ${slugOf(c)}`, (await loadSettings($, optionsRef!)).user) : null
  if (!next) { $.ui.toast(`${c.name}：卡片關卡已不是 release，沒有改動`); void refresh($, optionsRef!); return }
  const ok = await $.fs.write(c.statusPath, next).then(() => true).catch(() => false)
  if (!ok) { $.ui.toast(`${c.name}：寫入卡片失敗`); return }
  await feedPush($, [{ at: await $.clock.now(), text: `${c.name} 已確認上線${c.tag ? `（${c.tag}）` : ''}`, tone: 'success', card: c.statusPath }])
  $.ui.toast(`${c.name}：已確認上線，release 關卡已清除`)
  void refresh($, optionsRef!)
}

/** 在任務的 worktree 裡跑 /desk:card 用的那支腳本（cwd 讓它認得出同一個專案與登錄表）。 */
async function runCardScript($: any, options: PluginOptions, c: Case, cmd: 'spec-ok' | 'archive') {
  const env = { DESK_SETTINGS: (await deskPaths($, options)).settings }
  return $.process.run(['python3', `${$.plugin.root}/skills/card/scripts/card.py`, cmd, slugOf(c)], { cwd: c.root, timeoutMs: 30_000, env })
    .catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String(e) }))
}

/**
 * 真實模式的歸檔：執行 /desk:card archive <slug> 用的同一支腳本；卡片與審查檔由腳本複製、登錄表由腳本改。
 * 不刪 worktree 與分支，只把腳本印出的刪除指令放進提示。失敗就提示錯誤原因（腳本印的第一行），任務留著。
 */
export async function archiveCase($: any, options: PluginOptions, c: Case) {
  const r = await runCardScript($, options, c, 'archive')
  const now = await $.clock.now()
  if (r.exitCode !== 0) {
    const why = reasonLine(r)
    $.ui.toast(`${c.name}：歸檔失敗：${why}`, { timeoutMs: 10_000 })
    await feedPush($, [{ at: now, text: `${c.name} 歸檔失敗：${why}`, tone: 'error', card: c.statusPath }])
    void refreshAfterWrite($, options)
    return
  }
  const removeCmd = String(r.stdout ?? '').split(/\r?\n/).map((l: string) => l.trim()).find((l: string) => /\bworktree remove\b/.test(l))
  $.ui.toast(`${c.name}：已歸檔${removeCmd ? `；worktree 與分支確認後再自己刪：${removeCmd}` : ''}`, { timeoutMs: 15_000 })
  // 歸檔後這件離開工作桌：這筆不掛在它的卡上，換到哪件都看得到。
  await feedPush($, [{ at: now, text: `${c.name} 已歸檔（worktree 與分支保留）`, tone: 'success' }])
  void refreshAfterWrite($, options)
}

/**
 * 真實模式的確認規格：執行 /desk:card spec <slug> ok 用的同一支腳本（在任務的 worktree 裡跑，認得出同一個專案），
 * 卡片由腳本改；只確認、不派工。腳本失敗（卡片已被改過、找不到卡）就提示錯誤原因（腳本印的第一行），關卡留著。
 */
export async function confirmSpec($: any, options: PluginOptions, c: Case) {
  const r = await runCardScript($, options, c, 'spec-ok')
  const now = await $.clock.now()
  if (r.exitCode !== 0) {
    const why = reasonLine(r)
    $.ui.toast(`${c.name}：確認規格失敗：${why}`, { timeoutMs: 10_000 })
    await feedPush($, [{ at: now, text: `${c.name} 確認規格失敗：${why}`, tone: 'error', card: c.statusPath }])
    void refreshAfterWrite($, options)
    return
  }
  await feedPush($, [{ at: now, text: `${c.name} 規格已確認，可以派實作`, tone: 'success', card: c.statusPath }])
  void refreshAfterWrite($, options)
}

/** 停止 desk 自己派出去、正在跑的那個背景 agent（名字要對得上這件任務最後一次派工），流程一併暫停。 */
export async function stopAgent($: any, c: Case) {
  const last = (await loadJobs($))[normalizeRoot(c.root)]?.last
  if (!c.agent?.id || !last || c.agent.name !== last.launchName) { $.ui.toast(`${c.name}：只能停止 desk 派出去的 Agent`); return }
  if (tutorial) cancelSim()
  const r = tutorial ? { exitCode: 0, stderr: '' } : await $.process.run(['claude', 'stop', c.agent.id], { timeoutMs: 30_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) { $.ui.toast(`${c.name}：無法停止（${errorLine(r, 'claude stop 失敗')}）`); return }
  await saveChain($, normalizeRoot(c.root), run => run ? paused(run, AGENT_STOPPED) : run)
  await feedPush($, [{ at: await $.clock.now(), text: `${c.name} ${AGENT_STOPPED}（對話保留）`, tone: 'warning', card: c.statusPath }])
  $.ui.toast(`${c.name}：已停止 Agent`)
  void refresh($, optionsRef!)
}

/**
 * 新專案的「＋ 建立空的登錄表」：在專案資料夾寫一份只有表頭的登錄表（$.fs.write 會建資料夾）。
 * 按下時重算一次要建的路徑：上次讀取後已經有了（對話或 /desk:card new 建的）、對話換了 repo、確認不了在不在，都不寫，提示後重讀。
 */
export async function createRegistry($: any, options: PluginOptions, path: string) {
  if ((await missingRegistry($, await deskPaths($, options))) !== path) {
    const exists = await $.fs.exists(path).catch(() => null)
    $.ui.toast(exists ? '已經有登錄表，沒有覆寫，重新讀取' : '專案或登錄表已經變了，沒有建立，重新讀取')
    void refreshAfterWrite($, options)
    return
  }
  const ok = await $.fs.write(path, REGISTRY_TEMPLATE).then(() => true).catch(() => false)
  if (!ok) { $.ui.toast(`無法建立登錄表 ${path}`); return }
  await feedPush($, [{ at: await $.clock.now(), text: `已${WORD.createRegistry}`, tone: 'success' }])
  $.ui.toast(`已${WORD.createRegistry}；用 ${CARD_CMD} new <分支> <任務名> 開第一張卡`, { timeoutMs: 8000 })
  void refreshAfterWrite($, options)
}
