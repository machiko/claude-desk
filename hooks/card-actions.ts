// 現在卡上的動作：回覆 Agent、派 Agent 開 PR／push、預填決策、預填發版請求、開卡片、確認上線、歸檔、確認規格、停止 Agent；
// 以及新專案還沒有任務時的建立空登錄表。會改變任務狀態的操作，結果另外記下來，下一則你打的提示告訴對話（desk-io 的 tellPanel）。
// 從 register.tsx 搬出來；派工、重新整理仍在 register.tsx，比照 tutorial-run.tsx 從那裡匯入。
// 跨檔傳 $ 的函式一律用 function 宣告；atom 位址同 register.tsx，各自宣告。
import { atom, read } from 'claude-code'
import type { PluginOptions } from 'claude-code'
import type { Case, Snapshot } from '../types'
import { parseDecisions, decisionAnswer, decisionPrompt, releasePrompt, allPicked, confirmShip, isPlaceholder, parseGate, ARCHIVE_WORD, CARD_CMD, PLAN_STEP, REGISTRY_TEMPLATE } from './card'
import { WORD } from './theme'
import { errorLine, reasonLine, slugOf } from './model'
import { baseRefs, deskPaths, lastLine, loadSettings } from './probes'
import { afterSpecRefusal, normalizeRoot, openPrRequest, pushRequest, replyRefusal } from './dispatch'
import { archivesOnShip, canRelease, isReleaseLine } from './pipeline'
import { AGENT_STOPPED, paused } from './chain'
import { picksKey } from './pane'
import { tutorial, cancelSim, tutorialDecision } from './tutorial-run'
import type { AutoPrPlan } from './auto-pr'
import { feedPush, loadJobs, missingRegistry, openWith, saveChain, tellPanel } from './desk-io'
import { sentState } from './turn'
import { readSent } from './prompt-sync'
import { approveCheck } from './approve-check'
import { dispatch, refresh, refreshAfterWrite, optionsRef } from './register'

export const DEMO_ONLY = '示範任務只能看；請照教學那件的指示操作'
const picksAtom = atom({ plugin: 'desk', key: 'picks' } as const, {})
const snapshotAtom = atom({ plugin: 'desk', key: 'snapshot' } as const, null)

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

/** 開 PR 要推送 Agent 做的那句：對基準分支（baseRefs 第一個）開 PR。 */
async function openPrText($: any, options: PluginOptions, c: Case): Promise<string> {
  const [target] = await baseRefs($, c, (await loadSettings($, options)).cardBase ?? '')
  return openPrRequest(c.git?.branch ?? '分支', target ?? '')
}

/** 合併段的「⇡ 開 PR」（按兩次確認後）：派推送 Agent push 分支並對基準分支開 PR；desk 自己不跑 git push、gh。 */
export async function publishPr($: any, options: PluginOptions, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  if (tutorial) { $.ui.toast(`${c.name}：${TUTORIAL_PUBLISH}`); return }
  await dispatch($, options, c, 'publish', { text: await openPrText($, options, c) })
}

/**
 * 審查過關後自動派推送（專案設了 autoPr）：open 開 PR、push 只推到已開的 PR；跟按鈕一樣派推送 Agent，desk 自己不跑 git push、gh。
 * 自動派的不經手動派工的合併段判斷（過關當下六段還在審查段）；名額滿了照樣排進派工隊伍。
 */
export async function autoPublish($: any, options: PluginOptions, c: Case, plan: AutoPrPlan) {
  if (plan.kind === 'skip') return
  const text = plan.kind === 'open' ? await openPrText($, options, c) : pushRequest(c.git?.branch ?? '分支', plan.pr)
  await dispatch($, options, { ...c, state: 'ready' }, 'publish', { text, auto: true })
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

/**
 * 「⚑ 發版」：把列出所有已合併待發版卡的發版請求填進輸入框，你按 Enter 送給對話；版號由對話提、你確認後照文件的步驟發版。
 * 面板不打 tag、不 push、不派工、不跑任何指令，也不自動送出。
 */
export async function fillRelease($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const cases = ((await read($, snapshotAtom)) as Snapshot | null)?.cases.filter(canRelease) ?? []
  const text = releasePrompt(cases.length ? cases : [c])
  const filled = await $.prompt.fill({ text, mode: 'replace' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) { $.ui.toast(`輸入框無法預填，請直接輸入：${text}`, { timeoutMs: 10_000 }); return }
  $.ui.toast('發版請求已填入，按 Esc 回到輸入框再按 Enter 送出', { timeoutMs: 6000 })
}

export async function openCard($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  if (!(await openWith($, c.statusPath))) $.ui.toast(`${c.name}：無法開啟 ${c.statusPath}`)
}

/** 上線確認：重讀卡片，關卡還是 release 才清成「無」並記 History；desk 只在這裡寫卡。 */
export async function confirmShipped($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const text = await $.fs.read(c.statusPath).catch(() => null)
  const now = await $.clock.now()
  const d = new Date(now)
  const two = (n: number) => String(n).padStart(2, '0')
  const next = typeof text === 'string' ? confirmShip(text, `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, `${two(d.getHours())}:${two(d.getMinutes())}`, c.tag ?? '', isReleaseLine(c) ? '等下一版開發' : `${ARCHIVE_WORD}：${CARD_CMD} archive ${slugOf(c)}`, (await loadSettings($, optionsRef!)).user) : null
  if (!next) {
    $.ui.toast(`${c.name}：卡片關卡已不是 release，沒有改動`)
    await tellPanel($, now, '確認上線沒有改動：卡片關卡已不是 release', { name: c.name, skip: tutorial })
    void refresh($, optionsRef!); return
  }
  const ok = await $.fs.write(c.statusPath, next).then(() => true).catch(() => false)
  if (!ok) { $.ui.toast(`${c.name}：寫入卡片失敗`); await tellPanel($, now, '確認上線失敗：寫入卡片失敗', { name: c.name, skip: tutorial }); return }
  const shipped = `已確認上線${c.tag ? `（${c.tag}）` : ''}`
  await feedPush($, [{ at: now, text: `${c.name} ${shipped}`, tone: 'success', card: c.statusPath }])
  await tellPanel($, now, shipped, { name: c.name, skip: tutorial })
  // 一般的卡確認上線後接著歸檔（同 ⌫ 歸檔，不刪 worktree 與分支）；發版線與教學那件照舊只清關卡。
  if (archivesOnShip(c, !!tutorial)) { await archiveCase($, optionsRef!, c); return }
  $.ui.toast(`${c.name}：已確認上線，release 關卡已清除`)
  void refresh($, optionsRef!)
}

/** 在任務的 worktree 裡跑 /desk:card 用的那支腳本（cwd 讓它認得出同一個專案與登錄表）。 */
async function runCardScript($: any, options: PluginOptions, c: Case, cmd: 'spec-ok' | 'archive') {
  const env = { DESK_SETTINGS: (await deskPaths($, options)).settings }
  return $.process.run(['python3', `${$.plugin.root}/skills/card/scripts/card.py`, cmd, slugOf(c)], { cwd: c.root, timeoutMs: 30_000, env })
    .catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String(e) }))
}

export const deployReminder = (n: number) => `部署步驟 ${n} 項：確認已搬到發版線卡片或 ## 提醒`

/**
 * 真實模式的歸檔：執行 /desk:card archive <slug> 用的同一支腳本；卡片與審查檔由腳本複製、登錄表由腳本改。
 * 不刪 worktree 與分支，只把腳本印出的刪除指令放進提示；卡片有部署步驟時提示一併提醒搬走。失敗就提示錯誤原因（腳本印的第一行），任務留著。
 */
export async function archiveCase($: any, options: PluginOptions, c: Case) {
  const r = await runCardScript($, options, c, 'archive')
  const now = await $.clock.now()
  if (r.exitCode !== 0) {
    const why = reasonLine(r)
    $.ui.toast(`${c.name}：歸檔失敗：${why}`, { timeoutMs: 10_000 })
    await feedPush($, [{ at: now, text: `${c.name} 歸檔失敗：${why}`, tone: 'error', card: c.statusPath }])
    await tellPanel($, now, `歸檔失敗：${why}`, { name: c.name, skip: tutorial })
    void refreshAfterWrite($, options)
    return
  }
  const removeCmd = String(r.stdout ?? '').split(/\r?\n/).map((l: string) => l.trim()).find((l: string) => /\bworktree remove\b/.test(l))
  // 部署步驟跟著卡片歸檔：隨發版線發版的卡，步驟要搬到發版線卡片或登錄表才不會漏做（只提醒，不自動搬）。
  const steps = c.deploySteps?.length ? `；${deployReminder(c.deploySteps.length)}` : ''
  $.ui.toast(`${c.name}：已歸檔${steps}${removeCmd ? `；worktree 與分支確認後再自己刪：${removeCmd}` : ''}`, { timeoutMs: 15_000 })
  // 歸檔後這件離開工作桌：這筆不掛在它的卡上，換到哪件都看得到。
  await feedPush($, [{ at: now, text: `${c.name} 已歸檔（worktree 與分支保留）`, tone: 'success' }])
  await tellPanel($, now, '已歸檔（worktree 與分支保留）', { name: c.name, skip: tutorial })
  void refreshAfterWrite($, options)
}

/**
 * 真實模式的確認規格：執行 /desk:card spec <slug> ok 用的同一支腳本（在任務的 worktree 裡跑，認得出同一個專案），
 * 卡片由腳本改；確認後重讀，照按 g 的規則自動派實作（dispatchAfterSpec）。腳本失敗（卡片已被改過、找不到卡）就提示錯誤原因（腳本印的第一行），關卡留著、不派。
 */
export async function confirmSpec($: any, options: PluginOptions, c: Case) {
  const r = await runCardScript($, options, c, 'spec-ok')
  const now = await $.clock.now()
  if (r.exitCode !== 0) {
    const why = reasonLine(r)
    $.ui.toast(`${c.name}：確認規格失敗：${why}`, { timeoutMs: 10_000 })
    await feedPush($, [{ at: now, text: `${c.name} 確認規格失敗：${why}`, tone: 'error', card: c.statusPath }])
    await tellPanel($, now, `確認規格失敗：${why}`, { name: c.name, skip: tutorial })
    void refreshAfterWrite($, options)
    return
  }
  await feedPush($, [{ at: now, text: `${c.name} 規格已確認，可以派實作`, tone: 'success', card: c.statusPath }])
  await tellPanel($, now, '規格已確認，可以派實作', { name: c.name, skip: tutorial })
  await refreshAfterWrite($, options)
  await dispatchAfterSpec($, options, c.statusPath)
}

/**
 * 規格剛確認（面板 t、教學的 t、對話跑的 spec-ok）：用重讀後的卡照按 g 派實作。
 * 「等你」還有事或手動派也不能派的，只說原因；完成檢查沒核准過先問（同一個對話框），不核准就不派；
 * 核准了就當手動派工交給 dispatch：worktree 有別人的改動、啟動中、已在隊伍、Agent 已滿排隊都照按 g 處理。
 */
export async function dispatchAfterSpec($: any, options: PluginOptions, statusPath: string): Promise<boolean> {
  const c = ((await read($, snapshotAtom)) as Snapshot | null)?.cases.find(x => x.statusPath === statusPath)
  // 重讀到的關卡還是 spec（腳本失敗、重讀失敗）：沒有確認，不派也不出聲。
  if (!c || c.demo || parseGate(c.gate)?.kind === 'spec') return false
  const why = afterSpecRefusal(c)
  if (why) { await notDispatched($, c, `規格已確認；沒有自動派實作（${why}）`); return false }
  if (!(await approveCheck($, c))) { await notDispatched($, c, '規格已確認；沒有核准完成檢查，沒有派實作：要派時按 g'); return false }
  return dispatch($, options, c, 'continue')
}

/** 確認規格後沒有派實作：提示、動態、下一則提示告訴對話都說同一句。 */
async function notDispatched($: any, c: Case, text: string) {
  const now = await $.clock.now()
  $.ui.toast(`${c.name}：${text}`, { timeoutMs: 10_000 })
  await feedPush($, [{ at: now, text: `${c.name} ${text}`, tone: 'suggestion', card: c.statusPath }])
  await tellPanel($, now, text, { name: c.name, skip: tutorial })
}

/** 停止 desk 自己派出去、正在跑的那個背景 agent（名字要對得上這件任務最後一次派工），流程一併暫停。 */
export async function stopAgent($: any, c: Case) {
  const last = (await loadJobs($))[normalizeRoot(c.root)]?.last
  if (!c.agent?.id || !last || c.agent.name !== last.launchName) { $.ui.toast(`${c.name}：只能停止 desk 派出去的 Agent`); return }
  if (tutorial) cancelSim()
  const r = tutorial ? { exitCode: 0, stderr: '' } : await $.process.run(['claude', 'stop', c.agent.id], { timeoutMs: 30_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) {
    const why = errorLine(r, 'claude stop 失敗')
    $.ui.toast(`${c.name}：無法停止（${why}）`)
    await tellPanel($, await $.clock.now(), `停止 Agent 失敗：${why}`, { name: c.name, skip: tutorial })
    return
  }
  await saveChain($, normalizeRoot(c.root), run => run ? paused(run, AGENT_STOPPED) : run)
  const now = await $.clock.now()
  await feedPush($, [{ at: now, text: `${c.name} ${AGENT_STOPPED}（對話保留）`, tone: 'warning', card: c.statusPath }])
  await tellPanel($, now, `${AGENT_STOPPED}（對話保留）`, { name: c.name, skip: tutorial })
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
  if (!ok) { $.ui.toast(`無法建立登錄表 ${path}`); await tellPanel($, await $.clock.now(), `無法建立登錄表 ${path}`, { skip: tutorial }); return }
  const now = await $.clock.now()
  await feedPush($, [{ at: now, text: `已${WORD.createRegistry}`, tone: 'success' }])
  await tellPanel($, now, `已${WORD.createRegistry}`, { skip: tutorial })
  $.ui.toast(`已${WORD.createRegistry}；用 ${CARD_CMD} new <分支> <任務名> 開第一張卡`, { timeoutMs: 8000 })
  void refreshAfterWrite($, options)
}
