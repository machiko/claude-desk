// 教學模式（/desk tutorial）的執行：沙盒、模擬的 Agent 與審查、t 鍵的下一步。教學的進度狀態也住在這裡，
// register.tsx 只讀（ES module 的 live binding），要改一律呼叫 setTutorial／cancelSim。
import { atom, update } from 'claude-code'
import type { PluginOptions } from 'claude-code'
import type { AgentInfo, Case } from '../types'
import { home, loadSettings } from './probes'
import { errorLine } from './model'
import { REVIEW_FILE, normalizeRoot } from './dispatch'
import type { DispatchKind, FixReason } from './dispatch'
import { CODE_V1, CODE_V2, CODE_V3, REVIEW_1, REVIEW_2, REVIEW_3, SIM_MS, TEST_V1, TEST_V2, TUTORIAL_BRANCH, TUTORIAL_CHECK, TUTORIAL_INTRO, TUTORIAL_RELEASE, TUTORIAL_SLUG, TUTORIAL_TAG, cardAfter, cardAfterDecision, cardAfterTag, cardText, gitCommit, isTutorialDir, registryText, settingsText, setupScript, tutorialPaths, tutorialStep } from './tutorial'
import type { SimWork, TutorialState } from './tutorial'
import { CHAIN_KEY, JOBS_KEY, TRUST_KEY, VERIFIES_KEY, feedPush, loadChains, loadJobs } from './desk-io'
import type { Timer } from './desk-io'
import { refreshing, refresh, openPane, optionsRef } from './register'

// 引擎規定：read／update 的 atom 必須在同一個檔案用 const 宣告（同 plugin、同 key 就是同一份狀態）。
const selected = atom({ plugin: 'desk', key: 'selected' } as const, null)
const verifiesAtom = atom({ plugin: 'desk', key: 'verifies' } as const, {})
const feedAtom = atom({ plugin: 'desk', key: 'feed' } as const, [])
const picksAtom = atom({ plugin: 'desk', key: 'picks' } as const, {})
const contentOffset = atom({ plugin: 'desk', key: 'contentOffset' } as const, 0)

/** 教學模式（/desk tutorial）：沙盒資料夾與進度；null 是一般模式。存在 $.store，重新載入後接著教。 */
export let tutorial: TutorialState | null = null
/** 教學裡正在「工作」的模擬 Agent 或審查。 */
export let sim: { root: string; statusPath: string; name: string; startedAt: number; work: SimWork; timer: Timer; token: number; finishing?: boolean } | null = null
let simSeq = 0
export const TUTORIAL_KEY = 'tutorial'

export function setTutorial(next: TutorialState | null) { tutorial = next }
/** 停掉正在「工作」的模擬 Agent（離開教學、手動停止、換對話時）。 */
export function cancelSim() { sim?.timer?.cancel(); sim = null }

const SIM_SESSION = '00000000-0000-4000-8000-00000000d35c'
const SIM_SAYS: Record<SimWork, string> = { build: '寫 discount() 與測試…', fix: '依審查補上負數檢查…', 'review-1': '審查 diff、對照規格…', 'review-2': '複審新的 diff…', 'review-3': '重新審查新的 commit…', sync: '讀卡片與 git…' }
const GIT_TUTOR = ['-c', 'user.name=desk tutorial', '-c', 'user.email=tutorial@example.invalid']

/** 教學裡「正在工作」的那一個，給 refresh 當作 agents 清單。 */
export function simAgents(): Record<string, AgentInfo> {
  if (!sim) return {}
  return { [normalizeRoot(sim.root)]: { id: 'tutorial', name: sim.name, state: 'working', status: 'busy', startedAt: sim.startedAt, last: SIM_SAYS[sim.work] } }
}

export async function saveTutorial($: any) {
  await $.store.set(TUTORIAL_KEY, tutorial).catch(() => {})
}

/** 教學的派工：不啟動 claude，由腳本在 SIM_MS 後「做完」。回傳的樣子跟真的派工一樣，流程照常記錄。 */
export function startSim($: any, options: PluginOptions, c: Case, kind: DispatchKind, name: string, now: number, opts: { fix?: FixReason }) {
  const reviews = tutorial?.reviews ?? 0
  const work: SimWork = kind === 'review' ? (reviews === 0 ? 'review-1' : reviews === 1 ? 'review-2' : 'review-3') : kind === 'sync' ? 'sync' : opts.fix || reviews > 0 ? 'fix' : 'build'
  sim?.timer?.cancel()
  sim = { root: c.root, statusPath: c.statusPath, name, startedAt: now, work, token: ++simSeq, timer: $.clock.after(SIM_MS, () => void finishSim($, options)) }
  return { id: 'tutorial', name, sessionId: SIM_SESSION, kind: 'background', cwd: c.root, state: 'working', status: 'busy', startedAt: now }
}

/**
 * 模擬的 Agent 或審查做完：改程式並 commit、寫審查檔、寫回卡片，然後重讀讓流程往下走。
 * 收尾期間模擬仍算「工作中」（refresh 不會以為它結束了）；每一步之後確認這一輪還有效（教學沒有結束、沒有被新的一輪取代）。
 */
export async function finishSim($: any, options: PluginOptions) {
  const job = sim
  if (!job || !tutorial || job.finishing) return
  sim = { ...job, finishing: true }
  const live = () => !!tutorial && sim?.token === job.token
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  try {
    const card = await $.fs.read(job.statusPath).catch(() => null)
    if (job.work === 'build' || job.work === 'fix') {
      if (!live()) return
      await $.fs.write(`${job.root}/discount.py`, job.work === 'build' ? CODE_V1 : CODE_V2)
      await $.fs.write(`${job.root}/test_discount.py`, job.work === 'build' ? TEST_V1 : TEST_V2)
      if (!live()) return
      await $.process.run(['git', '-C', job.root, 'add', 'discount.py', 'test_discount.py'], { timeoutMs: 30_000 })
      const r = await $.process.run(gitCommit(job.root, job.work === 'build' ? 'feat: 新增會員折扣' : 'fix: 金額為負數時丟出 ValueError'), { timeoutMs: 30_000 })
      // 重新載入後補做同一輪時，內容已經 commit 過：沒有東西可以 commit 不算失敗。
      if (r.exitCode !== 0 && !/nothing to commit|nothing added/i.test(`${r.stdout}${r.stderr}`)) throw new Error(String(r.stderr || r.stdout).trim() || 'git commit 失敗')
    }
    if (job.work === 'review-1' || job.work === 'review-2' || job.work === 'review-3') {
      if (!live()) return
      await $.fs.write(`${job.root}/${REVIEW_FILE}`, job.work === 'review-1' ? REVIEW_1 : job.work === 'review-2' ? REVIEW_2 : REVIEW_3)
      if (!live() || !tutorial) return
      tutorial = { ...tutorial, reviews: tutorial.reviews + 1 }
      await saveTutorial($)
    }
    if (!live()) return
    if (typeof card === 'string') await $.fs.write(job.statusPath, cardAfter(card, job.work, day))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (live()) await feedPush($, [{ at: await $.clock.now(), text: `教學 Agent 失敗：${message}`, tone: 'error', card: job.statusPath }])
  } finally {
    if (sim?.token === job.token) sim = null
  }
  if (!tutorial) return
  // 正在跑的那一次 refresh 是寫檔前讀的；等它結束再讀一次，流程才看得到新的卡片。
  if (refreshing) await refreshing
  await refresh($, options)
}

/**
 * 重新載入後接著教：沙盒被刪了就結束教學；上一輪模擬還沒做完（派工紀錄未處理、沒有在跑的模擬）就重新排上，
 * 不然流程會以為 Agent 做完了，拿舊的程式跑檢查。
 */
export async function resumeTutorial($: any, options: PluginOptions) {
  if (!tutorial) return
  const p = tutorialPaths(await home($))
  if (!(await $.fs.exists(p.marker).catch(() => false))) { tutorial = null; await $.store.set(TUTORIAL_KEY, null).catch(() => {}); return }
  const last = (await loadJobs($))[normalizeRoot(p.wt)]?.last
  if (sim || !last || last.handled || last.recheck) return
  const fix: FixReason | undefined = last.round ? { from: 'review', round: last.round } : undefined
  startSim($, options, { root: p.wt, statusPath: p.card } as Case, last.kind, last.launchName, await $.clock.now(), fix ? { fix } : {})
}

/** 教學的決策：直接寫回卡片，不送到主對話；選 C（現在改）就扮演主對話改程式並 commit，流程會看到新 commit 而重新檢查、審查。 */
export async function tutorialDecision($: any, c: Case, answer: string) {
  const text = await $.fs.read(c.statusPath).catch(() => null)
  if (typeof text !== 'string') { $.ui.toast('教學卡片讀不到；輸入 /desk tutorial end 後重新開始'); return }
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  if (answer === 'C') {
    await $.fs.write(`${c.root}/discount.py`, CODE_V3)
    await $.process.run(['git', '-C', c.root, 'add', 'discount.py'], { timeoutMs: 30_000 }).catch(() => null)
    const r = await $.process.run(gitCommit(c.root, 'refactor: 金卡折扣率改成常數 GOLD_RATE'), { timeoutMs: 30_000 }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String(e) }))
    if (r.exitCode !== 0 && !/nothing to commit|nothing added/i.test(`${r.stdout}${r.stderr}`)) { $.ui.toast(`教學改程式失敗：${String(r.stderr || r.stdout).trim() || 'git commit 失敗'}`, { timeoutMs: 10_000 }); return }
  }
  await $.fs.write(c.statusPath, cardAfterDecision(text, answer, day, (await loadSettings($, optionsRef!)).user))
  $.ui.toast(answer === 'C'
    ? '已改程式並 commit（實際使用時由主對話照你的決定改）。審查後有新 commit，流程會自動重新檢查、審查。'
    : `已寫回卡片：${answer}。實際使用時這一步會填入輸入框，按 Enter 送給主對話。`, { timeoutMs: 8000 })
  await refresh($, optionsRef!)
}

/** 教學按鈕 t：確認規格（真的執行 /desk:card 的腳本）、本機合併、打 tag。 */
export async function tutorialAct($: any, options: PluginOptions, c: Case) {
  if (!tutorial || c.demo) return
  const step = tutorialStep(c)
  const p = tutorialPaths(await home($))
  const now = await $.clock.now()
  const day = new Date(now).toISOString().slice(0, 10)
  const failed = (what: string, r: any) => $.ui.toast(`${what}失敗：${errorLine(r)}`, { timeoutMs: 10_000 })
  const run = (argv: string[], env?: Record<string, string>) => $.process.run(argv, { timeoutMs: 30_000, ...(env ? { env } : {}) }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String(e) }))
  if (step === 'spec-ok') {
    // DESK_PROJECT_DIR 留空：card.py 不依 cwd 認專案，否則會疊上真實專案的 card 設定、讀到它的登錄表
    const r = await run(['python3', `${$.plugin.root}/skills/card/scripts/card.py`, 'spec-ok', TUTORIAL_SLUG], { DESK_SETTINGS: p.settings, DESK_PROJECT_DIR: '' })
    if (r.exitCode !== 0) return failed('確認規格', r)
    await feedPush($, [{ at: now, text: `${c.name} 規格已確認，可以派實作`, tone: 'success', card: c.statusPath }])
  } else if (step === 'merge') {
    const r = await run(['git', '-C', p.main, ...GIT_TUTOR, 'merge', '--no-ff', '--quiet', '-m', `Merge ${TUTORIAL_BRANCH}`, TUTORIAL_BRANCH])
    if (r.exitCode !== 0) return failed('合併', r)
    tutorial = { ...tutorial, merged: true }
    await saveTutorial($)
    await feedPush($, [{ at: now, text: `${c.name} 已合併到 ${TUTORIAL_RELEASE}`, tone: 'success', card: c.statusPath }])
  } else if (step === 'tag') {
    const r = await run(['git', '-C', p.main, 'tag', TUTORIAL_TAG])
    if (r.exitCode !== 0) return failed('打 tag', r)
    const text = await $.fs.read(c.statusPath).catch(() => null)
    if (typeof text === 'string') await $.fs.write(c.statusPath, cardAfterTag(text, day))
    await feedPush($, [{ at: now, text: `${c.name} 已打 ${TUTORIAL_TAG}`, tone: 'success', card: c.statusPath }])
  } else return
  await refresh($, options)
}

/** 開始教學：建沙盒（git repo＋worktree＋卡片＋登錄表），完成檢查先授權，面板切到教學。 */
export async function tutorialStart($: any, options: PluginOptions): Promise<string> {
  const p = tutorialPaths(await home($))
  // 教學已經在跑：選回教學那件、打開面板。
  if (tutorial) { await update($, selected, () => p.card); await refresh($, options); await openPane($); return TUTORIAL_INTRO }
  if (await $.fs.exists(p.dir).catch(() => false)) return `${p.dir} 已經存在（上一次的教學沒有清掉）。先輸入 /desk tutorial end 清除，再輸入 /desk tutorial 重新開始。`
  const r = await $.process.run(['sh', '-c', setupScript(p.main, p.wt)], { timeoutMs: 60_000 }).catch((e: unknown) => ({ exitCode: 1, stderr: String(e), stdout: '' }))
  if (r.exitCode !== 0) return `建立教學沙盒失敗：${errorLine(r)}（需要 git）`
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  await $.fs.write(p.card, cardText(day))
  await $.fs.write(p.registry, registryText(p.card))
  await $.fs.write(p.settings, settingsText(p.registry, p.main, (await loadSettings($, options)).user))
  await forgetRoot($, p.wt, p.card)
  const trusted = ((await $.store.get(TRUST_KEY).catch(() => null)) as Record<string, string> | null) ?? {}
  await $.store.set(TRUST_KEY, { ...trusted, [p.card]: TUTORIAL_CHECK })
  await $.fs.write(p.marker, '這個資料夾由 desk 的 /desk tutorial 建立；/desk tutorial end 會整個刪除。\n')
  tutorial = { dir: p.dir, reviews: 0, merged: false }
  await saveTutorial($)
  await clearView($, p.card)
  await refresh($, options)
  await openPane($)
  return TUTORIAL_INTRO
}

/** 教學開始與結束時，畫面上上一輪留下的東西（最近動態、決策選項、捲動位置）清掉；選取改成 pick（開始時是教學那件）。 */
async function clearView($: any, pick: string | null) {
  await update($, selected, () => pick)
  await update($, feedAtom, () => [])
  await update($, picksAtom, () => ({}))
  await update($, contentOffset, () => 0)
}

/** 結束教學：停掉模擬、刪沙盒（只刪 ~/.claude/desk-tutorial）、清掉它留下的流程紀錄，面板切回你的任務。 */
export async function tutorialEnd($: any, options: PluginOptions): Promise<string> {
  sim?.timer?.cancel(); sim = null
  const p = tutorialPaths(await home($))
  const existed = !!tutorial || (await $.fs.exists(p.dir).catch(() => false))
  tutorial = null
  await $.store.set(TUTORIAL_KEY, null).catch(() => {})
  await forgetRoot($, p.wt, p.card)
  const trusted = ((await $.store.get(TRUST_KEY).catch(() => null)) as Record<string, string> | null) ?? {}
  if (p.card in trusted) await $.store.set(TRUST_KEY, Object.fromEntries(Object.entries(trusted).filter(([k]) => k !== p.card)))
  if (existed && !(await $.fs.exists(p.marker).catch(() => false))) {
    await refresh($, options)
    return `${p.dir} 裡沒有 desk 的標記檔，不是 /desk tutorial 建的，沒有刪除；確認不需要後請自己刪除。`
  }
  let removed = true
  if (existed && isTutorialDir(p.dir)) {
    const r = await $.process.run(['rm', '-rf', p.dir], { timeoutMs: 60_000 }).catch(() => null)
    removed = !!r && r.exitCode === 0
  }
  await clearView($, null)
  await refresh($, options)
  if (!existed) return '目前沒有教學沙盒。'
  return removed ? '教學已結束，沙盒已刪除；面板回到你的任務。' : `教學已結束，但沙盒刪不掉，請自己刪除 ${p.dir}`
}

/** 一件任務在 desk 自己 store 裡的紀錄（派工、流程、檢查結果）全部清掉。 */
export async function forgetRoot($: any, root: string, statusPath: string) {
  const key = normalizeRoot(root)
  const jobs = await loadJobs($)
  if (key in jobs) await $.store.set(JOBS_KEY, Object.fromEntries(Object.entries(jobs).filter(([k]) => k !== key)))
  const chains = await loadChains($)
  if (key in chains) await $.store.set(CHAIN_KEY, Object.fromEntries(Object.entries(chains).filter(([k]) => k !== key)))
  const verifies = await update($, verifiesAtom, v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== statusPath)))
  await $.store.set(VERIFIES_KEY, verifies).catch(() => {})
}

