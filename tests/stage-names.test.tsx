import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, PANE, BAND, CARD_A, CARD_B, CARD_C, REGISTRY, result, text, flat } from './fixture'
import { buildCase, displayWidth } from '../hooks/model'
import { STAGES, pipeline, stageLabel } from '../hooks/pipeline'
import { turnOf } from '../hooks/turn'
import { IDLE_WHY, REVIEW_WHY, refusalOf, idleNext, reviewNext } from '../hooks/dispatch'
import { TUTORIAL_INTRO } from '../hooks/tutorial'
import { passWords } from '../hooks/auto-pr'
import { nextStep } from '../hooks/chain'
import { summary } from '../hooks/model'
import { STATE, WORD } from '../hooks/theme'
import { queuedBrokeText } from '../hooks/verify-runner'
import type { Case, Verify } from '../types'

const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
const SID = 'bbbbbbbb-0000-4000-8000-000000000000'
const ok = (head: string): Verify => ({ command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head })
const screen = async (ui: any) => text(await ui.drawn())
/** 段名後面接六段字形：畫面上出現這種寫法就是舊段名還在。 */
const OLD_STAGE = /(檢查|審查)\s*[●◉◆✕○·]/
/** 「輪到你」與按鍵提示不再用的舊說法。 */
const OLD_HINT = /執行完成檢查|派審查|派獨立審查|自動審查|重新審查|檢查(?:通過|未通過|中斷|未執行|仍在執行|跑完|沒跑成)|完成檢查|審查(?:通過|結論|有要修)|重新檢查|複審|免審查|資安審查|進行中|仍在執行/
/** 測試結果、驗收結果的動態與通知不再用的舊說法。 */
const OLD_RESULT = /檢查(?:通過|未通過|中斷|未執行|仍在執行|跑完|沒跑成)|完成檢查|審查(?:通過|結論|有要修)|重新(?:檢查|審查)|免審查|資安審查/

/**
 * 三件：Alpha 在測試段（驗收過後又有新 commit，完成檢查還沒在新的 HEAD 跑），Beta 在驗收段（測試通過、待驗收），
 * Gamma 已過驗收（停在合併段）。Alpha 有審查檔（審查重點列），派出去的 Agent 照 cwd 對回任務。
 */
function threeStages(data: any, clock: any) {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Beta | \`${CARD_B}\` |\n| Gamma | \`${CARD_C}\` |`
  data.files[CARD_A] = `<!-- DESK -->\n- 狀態：Alpha 改了常數\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：依規格實作\n${PASSED}\n<!-- /DESK -->`
  data.files[CARD_B] = `<!-- DESK -->\n- 狀態：Beta 實作完成\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：依規格實作\n- 關卡：無\n<!-- /DESK -->`
  data.files[CARD_C] = `<!-- DESK -->\n- 狀態：Gamma 驗收過了\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：開 PR\n${PASSED}\n<!-- /DESK -->`
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [HIGH][稽核] hooks/a.ts:1 — 舊的發現\n'
  data.agents = []
  data.gh = []
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'a2' }
  data.git[BETA] = { branch: 'feature/beta', head: 'b1' }
  data.git[GAMMA] = { branch: 'feature/gamma', head: 'g1' }
  data.store.chains = { [ALPHA]: { owner: 'other-session', startedAt: 0, round: 0, passed: true, reviewHead: 'a1', judgedHead: 'a1' } }
  data.store.verifies = { [CARD_A]: ok('a1'), [CARD_B]: ok('b1') }
  // 檢查都核准過：按一次 v 就跑（沒核准要按兩次，另外測）
  data.store.trustedVerify = { [CARD_A]: 'npm test', [CARD_B]: 'npm test', [CARD_C]: 'npm test' }
  let n = 0
  data.launch = async (e: any) => {
    n++
    const id = `c000000${n}`
    const cwd = String(e.init?.cwd ?? '')
    data.agents = [...data.agents.filter((a: any) => a.cwd !== cwd), { id, kind: 'background', cwd, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
}

async function mount($: any, clock: any, width: number) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  return $.ui.mount(PANE(width))
}

/** 選這件當現在卡，回傳畫面文字。 */
async function pick(ui: any, card: string): Promise<string> {
  if (await ui.find({ key: `row-${card}` })) await ui.press({ key: `row-${card}` })
  return screen(ui)
}

const label = (b: any) => String(b?.text || b?.props?.label || '')

/** 跟面板一樣讀卡、算六段，給純函式看段名＋段內說明與「輪到你」。 */
function caseOf(gate: string, over: Partial<Case>, v?: Verify, next = '依規格實作'): Case {
  const card = `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：${next}\n${gate}\n<!-- /DESK -->`
  const base = { ...buildCase({ name: 'Beta', statusPath: CARD_B }, card, 1, {}, undefined), git: { branch: 'feature/beta', head: 'b1' }, ...over } as Case
  return { ...base, pipeline: pipeline(base, v) }
}

/** AC-1 */
test('test_stage_labels_read_test_and_acceptance', async ($, on) => {
  const { data, clock } = fixture(on)
  threeStages(data, clock)

  // 寬：「全部任務」表頭、各列六段字形、現在卡的六段列
  const wide = await mount($, clock, 100)
  const alpha = await pick(wide, CARD_A)
  const beta = await pick(wide, CARD_B)
  const gamma = await pick(wide, CARD_C)
  for (const shown of [alpha, beta, gamma]) {
    expect(shown).toContain('全部任務')
    expect(shown).toContain('規格 實作 測試 驗收 合併 上線')
    expect(shown).not.toMatch(OLD_STAGE)
    expect(shown).not.toContain('實作 檢查 審查')
  }
  expect(alpha).toContain('● 規格 ● 實作 ◆ 測試 ○ 驗收 ○ 合併 ○ 上線')
  expect(beta).toContain('● 規格 ● 實作 ● 測試 ◆ 驗收 ○ 合併 ○ 上線')
  expect(gamma).toContain('● 規格 ● 實作 ● 測試 ● 驗收 ◆ 合併 ○ 上線')
  // 欄寬與對齊不變：段名都是兩個全形字，表頭每段 5 欄，跟列上字形的間距一樣
  expect(STAGES.map(s => displayWidth(s.label))).toEqual([4, 4, 4, 4, 4, 4])
  expect(beta).toContain('●    ●    ●    ◆    ○    ○')
  await wide.unmount()

  // 窄：現在卡的六段列照樣是新段名，清單只畫字形
  const narrow = await mount($, clock, 44)
  const narrowAlpha = await pick(narrow, CARD_A)
  expect(narrowAlpha).toContain('● 規格 ● 實作 ◆ 測試 ○ 驗收 ○ 合併 ○ 上線')
  expect(narrowAlpha).not.toMatch(OLD_STAGE)
  expect(flat(narrowAlpha)).toContain('▷Alpha●●◆○○○')
  await narrow.unmount()

  // 摘要列：已選那件的段名
  const band = await $.ui.mount(BAND(120))
  expect(flat(await screen(band))).toContain(flat('▷ Alpha  ●●◆○○○ 測試'))
  await band.unmount()
  const ui = await mount($, clock, 100)
  await pick(ui, CARD_B)
  const bandBeta = await $.ui.mount(BAND(120))
  expect(flat(await screen(bandBeta))).toContain(flat('▷ Beta  ●●●◆○○ 驗收'))
  expect(await screen(bandBeta)).not.toMatch(/檢查|審查/)
  await bandBeta.unmount()

  // 段名＋段內說明（狀態列用的寫法），段內說明也用新詞
  expect(stageLabel(caseOf('- 關卡：無', {}, ok('b1')).pipeline!)).toBe('驗收・待驗收')
  expect(stageLabel(caseOf('- 關卡：無', { git: { branch: 'release/v1.0', head: 'r1' } }).pipeline!)).toBe('測試・尚未執行測試')
  expect(stageLabel(caseOf(PASSED, { chain: { round: 0, stale: true, passed: true } }).pipeline!)).toBe('測試・驗收後有新 commit，需重新測試')
  expect(stageLabel(caseOf('- 關卡：無', { chain: { round: 0, stale: true, passed: true } }, ok('b1')).pipeline!)).toBe('驗收・驗收後有新 commit，待重新驗收')

  // 輸入框下的狀態列：派出驗收後是「驗收・驗收中」
  await ui.press({ key: `case-${CARD_B}-review` })
  await ui.press({ key: `case-${CARD_B}-review` })
  await clock.settle()
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  expect(String(data.status)).toContain('▶ Beta 驗收・驗收中')
  expect(String(data.status)).not.toMatch(/檢查|審查/)
  await ui.unmount()
  await clock.advance(2500)
  await clock.settle()
})

/** 六段圖示在字前 AC-4：現在卡寬度 < 30 時六段列只畫字形，沒有段名與空白，跟改之前相同。 */
test('test_narrow_now_card_draws_stages_as_bare_glyphs', async ($, on) => {
  const { data, clock } = fixture(on)
  threeStages(data, clock)
  const ui = await mount($, clock, 28)
  await pick(ui, CARD_A)
  const row = await ui.find({ type: 'Text', text: /^[●◉◎◆✕○·]{6}$/ })
  expect(String(row?.text)).toBe('●●◆○○○')
  await ui.unmount()
})

/** AC-2 */
test('test_v_and_w_buttons_and_help_use_new_names', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  threeStages(data, clock)
  // 完成檢查由測試放行：按 v 之後掛著，看「測試中」
  let release: (() => void) | null = null
  data.run = () => new Promise(resolve => { release = () => resolve(result(0, 'all green\n')) })
  const ui = await mount($, clock, 100)

  // 測試段：v 按鈕、完成檢查列、審查重點列、關卡列
  const alpha = await pick(ui, CARD_A)
  expect(label(await ui.find({ key: `case-${CARD_A}-verify` }))).toBe('▶ 測試')
  expect(alpha).toMatch(/▎ 測試 +✓ 通過/)
  expect(alpha).toMatch(/▎ 驗收 +HIGH 稽核 hooks\/a\.ts:1/)
  expect(alpha).toContain('◆ 驗收  CRITICAL 0、HIGH 0、MEDIUM 0、LOW')
  expect(alpha).not.toMatch(/▎ (檢查|審查) /)
  expect(alpha).not.toContain('◆ 審查')
  await ui.press({ key: `case-${CARD_A}-verify` })
  await clock.settle()
  expect(label(await ui.find({ key: `case-${CARD_A}-verify` }))).toMatch(/^[◐◓◑◒] 測試中$/)
  release!()
  await clock.settle()

  // 驗收段：w 按鈕，按一次待確認
  await pick(ui, CARD_B)
  expect(label(await ui.find({ key: `case-${CARD_B}-review` }))).toBe('◆ 驗收')
  await ui.press({ key: `case-${CARD_B}-review` })
  expect(label(await ui.find({ key: `case-${CARD_B}-review` }))).toMatch(/^再按 w 確認驗收（.+）$/)
  await ui.press({ key: `case-${CARD_B}-review` })
  await clock.settle()
  expect(data.toasts).toContain('Beta：驗收已派出')
  // 動態紀錄：派工種類名稱組出來的「派驗收（<模型>）」；一般事件不上畫面
  expect(log.list.some(e => /Beta 派驗收（.+）/.test(e.text))).toBe(true)
  expect(log.list.some(e => /派審查/.test(e.text))).toBe(false)
  expect(await screen(ui)).not.toMatch(/Beta 派驗收/)

  // 不能派的時候用派工種類名稱說明（Beta 的驗收正在跑）
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'review Beta' } as any)
  await clock.settle()
  expect(data.toasts).toContain('Beta：無法驗收（Agent 處理中）；等 Agent 做完再按一次；要中途停掉按 k')

  // 說明頁
  await ui.press({ key: 'help' })
  const help = await screen(ui)
  expect(help).toMatch(/v +執行測試/)
  expect(help).toContain('繼續／驗收／同步')
  expect(help).not.toContain('完成檢查')
  expect(help).not.toContain('繼續／審查')
  await ui.press({ key: 'help' })
  await ui.unmount()

  // Agent 在跑：鎖住的 v 寫「▶ 測試（執行中，完成後可用）」
  data.files[CARD_C] = data.files[CARD_C]!.replace(PASSED, '- 關卡：spec：待確認規格（AC-1～AC-2）')
  data.agents = [{ id: 'bbbbbbbb', kind: 'background', cwd: GAMMA, state: 'working', status: 'busy', name: 'desk-gamma-0', sessionId: SID, startedAt: clock.now() }]
  data.store.jobs = { ...(data.store.jobs as object), [GAMMA]: { sessionId: SID, last: { launchName: 'desk-gamma-0', nativeId: 'bbbbbbbb', sessionId: SID, kind: 'continue', startedAt: clock.now(), fresh: false } } }
  const locked = await mount($, clock, 100)
  await pick(locked, CARD_C)
  // 執行中只列停止、輸出與開卡片；m 展開全部才看得到鎖住的動作
  await locked.press({ key: 'more' })
  expect(await locked.find({ type: 'Text', text: '▶ 測試（處理中，完成後可用）' })).toBeDefined()
  await locked.unmount()
  await clock.advance(2500)
  await clock.settle()
})

/** AC-3 */
test('test_turn_hints_say_run_test_and_dispatch_acceptance', async ($, on) => {
  const { data, clock } = fixture(on)
  threeStages(data, clock)
  // 窄版面：「全部任務」排在現在卡下面，「輪到你」那句不會跟清單交錯
  const ui = await mount($, clock, 44)

  // 面板上的「▶ 輪到你」
  const alpha = flat(await pick(ui, CARD_A))
  expect(alpha).toContain(flat('▶ 輪到你  v 重新執行測試（驗收後有新 commit，通過後按 w 重新驗收）'))
  const beta = flat(await pick(ui, CARD_B))
  expect(beta).toContain(flat('▶ 輪到你  w 派驗收（新對話，有 CRITICAL／HIGH 會自動修正、MEDIUM 只記錄，過關後開 PR'))
  const gamma = flat(await pick(ui, CARD_C))
  expect(gamma).toContain(flat('，驗收是自審，可按 w 派獨立驗收）'))
  for (const shown of [alpha, beta, gamma]) expect(shown).not.toMatch(OLD_HINT)

  // 檢查沒核准時按一次 v：不跳對話框，按鈕與檢查列說「測試」
  // 核准紀錄由重新整理讀進面板：改了 store 要整理一輪才看得到
  data.store.trustedVerify = {}
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await pick(ui, CARD_A)
  await ui.press({ key: `case-${CARD_A}-verify` })
  await clock.settle()
  expect(data.asks).toHaveLength(0)
  expect((await ui.find({ key: `case-${CARD_A}-verify` }))?.text).toBe('再按 v 核准並執行測試')
  await ui.unmount()

  // 各種情境的「輪到你」
  const atCheck = (chain?: Case['chain']) => {
    const c = caseOf('- 關卡：無', { chain: { round: 0, stale: true, ...chain } })
    return turnOf(c).text
  }
  const hints = [
    atCheck({ passed: true }),
    atCheck({ passed: true, foreign: true }),
    turnOf(caseOf('- 關卡：無', {}, ok('b1'))).text,
    turnOf(caseOf('- 關卡：無', { chain: { round: 0, lastKind: 'continue', autoReview: true } }, ok('b1'))).text,
    turnOf(caseOf('- 關卡：無', {}, undefined, '到面板按 v 執行測試')).text,
    turnOf(caseOf('- 關卡：無', {}, undefined, '派驗收（按 w）')).text,
    turnOf(caseOf('- 關卡：無', { chain: { round: 0, lastKind: 'continue', autoReview: true } }, undefined, '派審查（按 w）')).text,
  ]
  expect(hints).toEqual([
    'v 重新執行測試（驗收後有新 commit，通過後自動重新驗收）',
    'v 重新執行測試（驗收後有新 commit，通過後按 w 重新驗收）',
    'w 派驗收（新對話，有 CRITICAL／HIGH 會自動修正、MEDIUM 只記錄，過關後開 PR）',
    '接著自動驗收',
    'v 執行測試（下一步只剩等測試，通過後按 w 派驗收，要改程式先把下一步寫成要做的事）',
    'v 執行測試（下一步是驗收，通過後按 w 派驗收）',
    'v 執行測試（下一步是驗收，通過後自動驗收）',
  ])
  // 測試段的一般情況（完成檢查還沒跑、不是驗收後的新 commit）
  expect(turnOf({ ...caseOf('- 關卡：無', {}), pipeline: { stages: [], current: 'check', note: '' } } as Case).text).toBe('v 執行測試（通過後按 w 派驗收）')
  // 下一步寫派審查時按 g：被拒的提示
  expect(refusalOf(caseOf('- 關卡：無', {}, undefined, '派驗收（按 w）'), 'continue')).toEqual({ why: REVIEW_WHY, next: '先按 v 執行測試，通過後照「輪到你」派驗收' })
  expect(refusalOf(caseOf('- 關卡：無', {}, ok('b1'), '派審查（按 w）'), 'continue')).toEqual({ why: REVIEW_WHY, next: '按 w 派驗收' })
  for (const hint of hints) expect(hint).not.toMatch(OLD_HINT)

  // /desk tutorial 開場：第 3、4 段
  const intro = TUTORIAL_INTRO.split('\n')
  expect(intro.find(l => l.startsWith('  3 '))).toMatch(/^ {2}3 測試：/)
  expect(intro.find(l => l.startsWith('  4 '))).toMatch(/^ {2}4 驗收：自動派驗收/)
  expect(TUTORIAL_INTRO).not.toMatch(/ {2}[34] (檢查|審查)：/)
  expect(TUTORIAL_INTRO).not.toMatch(OLD_HINT)
})

/** 測試結果的動態與通知用新詞（AC-1）：手動按 v 與自動流程記下結果都說「測試」。 */
test('測試結果的動態與通知用新詞', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const sent: string[] = []
  on('ui.notify', (_: any, e: any) => { sent.push(e.text); return { value: { isSent: true as const, channel: 'terminal_bell' as const } } })
  threeStages(data, clock)
  const run = data.run
  const sh = (code: number) => { data.run = async (e: any) => e.argv[0] === 'sh' ? result(code, code ? 'FAILED\n' : 'ok\n') : run(e) }
  const verify = async (name: string) => {
    const out = await $.command.run({ command: 'desk', args: `verify ${name}` } as any)
    await clock.settle()
    return String((out as any).text)
  }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  // 沒過：動態、toast、系統通知都寫「測試未通過」
  sh(1)
  expect(await verify('Alpha')).toBe('Alpha：測試已開始。')
  expect(log.has('Alpha 測試未通過（exit 1）')).toBe(true)
  expect(data.toasts).toContain('Alpha：測試未通過')
  expect(sent).toContain('Alpha：測試未通過（exit 1）')

  // 通過
  sh(0)
  await verify('Beta')
  expect(log.has('Beta 測試通過')).toBe(true)
  expect(data.toasts).toContain('Beta：測試通過')

  // 在跑的時候再按、排隊：說「測試」
  let release: (() => void) | null = null
  data.run = (e: any) => e.argv[0] === 'sh' ? new Promise(resolve => { release = () => resolve(result(0, 'ok\n')) }) : run(e)
  void $.command.run({ command: 'desk', args: 'verify Alpha' } as any)
  await clock.settle()
  await $.command.run({ command: 'desk', args: 'verify Alpha' } as any)
  expect(data.toasts).toContain('Alpha：測試在跑；跑完結果會列在測試列')
  release!()
  await clock.settle()

  // 排隊的那件輪到時接手出錯（沒跑成）：也說「測試」
  expect(queuedBrokeText('Beta', new Error('狀態寫不進去'))).toBe('Beta：排隊的測試沒跑成（狀態寫不進去）')

  // 指令還沒核准：不跑，說「測試指令」
  data.store.trustedVerify = {}
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(await verify('Gamma')).toBe('Gamma：測試指令還沒經你核准，這次沒派工也沒跑測試；到面板按兩次 v（或 g）核准：npm test')

  // 從頭到尾：動態、toast、通知都沒有舊說法
  for (const said of [...log.list.map(e => e.text), ...data.toasts, ...sent]) expect(said).not.toMatch(OLD_RESULT)
  await clock.advance(2500)
  await clock.settle()
})

/** 驗收結果的動態與通知用新詞（AC-2）：過關、只動文件免驗收、結論缺分級、自動開 PR、驗收後的新 commit。 */
test('驗收結果的動態與通知用新詞', async ($, on) => {
  // 過關的動態與通知
  expect(passWords('Beta', undefined)).toEqual({ feed: 'Beta 驗收通過，可開 PR', say: 'Beta：驗收通過，可以開 PR' })
  expect(passWords('Beta', undefined, 'skipped')).toEqual({ feed: 'Beta 只動文件、測試通過，免驗收，可開 PR', say: 'Beta：只動文件，免驗收，可以開 PR' })
  expect(passWords('Beta', { kind: 'open' })).toEqual({ feed: 'Beta 驗收通過，自動派 Agent 開 PR', say: 'Beta：驗收通過，自動派 Agent 開 PR' })
  // 驗收結論缺分級：流程停下的原因
  expect(nextStep({ owner: 'me', startedAt: 1, round: 0 }, 'review', null, null, true)).toEqual({ kind: 'stop', reason: '驗收結論缺少 CRITICAL／HIGH／MEDIUM／LOW 分級' })
  // 清單摘要：過關、還沒開 PR
  const passed = caseOf(PASSED, {}, ok('b1'))
  expect(summary({ ...passed, state: 'ready' })).toBe('驗收通過，可開 PR')

  // 驗收過關後又有新 commit：流程自動重新測試與驗收
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h2' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；過')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.store.chains = { [ALPHA]: { owner: 'fixture-session', startedAt: 0, round: 2, passed: true, reviewHead: 'h1', judgedHead: 'h1' } }
  data.store.jobs = { [ALPHA]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  data.agents = []
  data.launch = async (e: any) => {
    data.agents = [{ id: 'a0000001', kind: 'background', cwd: ALPHA, name: e.argv[3], sessionId: 'a0000001-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, 'a0000001')
  }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  for (let i = 0; i < 3; i++) { await clock.advance(2500); await clock.settle() }
  expect(log.has('Alpha 驗收通過後有新 commit，自動重新測試與驗收')).toBe(true)
  for (const said of [...log.list.map(e => e.text), ...data.toasts]) expect(said).not.toMatch(OLD_RESULT)
})

/** done 的新舊下一步都不派 Agent（AC-3）：/desk:card done 寫的新句子與舊卡的寫法都叫你按 v，按 g 不會派出空的 Agent。 */
test('done 的新舊下一步都不派 Agent', () => {
  const pairs: [string, string][] = [
    ['到面板按 v 執行測試', '到面板按 v 執行完成檢查'],
    ['等自動重新測試與驗收；沒動靜就到面板按 v', '等自動重新檢查與審查；沒動靜就到面板按 v'],
  ]
  for (const [now, old] of pairs) {
    for (const next of [now, old]) {
      const c = caseOf('- 關卡：無', {}, undefined, next)
      expect(reviewNext(next)).toBe(false)
      expect(idleNext(next)).toBe(IDLE_WHY)
      expect(refusalOf(c, 'continue')?.why).toBe(IDLE_WHY)
      expect(turnOf(c)).toEqual({ who: 'you', text: 'v 執行測試（下一步只剩等測試，通過後按 w 派驗收，要改程式先把下一步寫成要做的事）', action: 'verify', key: 'v' })
    }
  }
})

/** 狀態詞只有處理中與已上線（AC-4）：Agent 在做事一律「處理中」、測試在跑「測試中」、六段全過「已上線」；CI 與容器的「執行中」不變。 */
test('狀態詞只有處理中與已上線', async ($, on) => {
  expect(STATE.running.label).toBe('處理中')
  expect(WORD.busyLocked).toBe('（處理中，完成後可用）')
  expect(WORD.busyRefused).toBe('Agent 處理中，完成後再')
  expect(refusalOf(caseOf('- 關卡：無', { state: 'running' }), 'continue')?.why).toBe('Agent 處理中')
  expect(stageLabel(caseOf('- 關卡：無', {}, ok('b1')).pipeline!)).not.toMatch(/執行中|進行中/)
  const done = caseOf(PASSED, {}, ok('b1'))
  expect(stageLabel({ ...done.pipeline!, current: null, note: '' })).toBe('已上線')

  const { data, clock } = fixture(on)
  threeStages(data, clock)
  let release: (() => void) | null = null
  data.run = () => new Promise(resolve => { release = () => resolve(result(0, 'all green\n')) })
  // Gamma 的 Agent 在跑（卡片停在關卡）
  data.files[CARD_C] = data.files[CARD_C]!.replace(PASSED, '- 關卡：spec：待確認規格（AC-1～AC-2）')
  data.agents = [{ id: 'bbbbbbbb', kind: 'background', cwd: GAMMA, state: 'working', status: 'busy', name: 'desk-gamma-0', sessionId: SID, startedAt: clock.now() }]
  data.store.jobs = { [GAMMA]: { sessionId: SID, last: { launchName: 'desk-gamma-0', nativeId: 'bbbbbbbb', sessionId: SID, kind: 'continue', startedAt: clock.now(), fresh: false } } }
  const ui = await mount($, clock, 100)
  const gamma = await pick(ui, CARD_C)
  // 標題徽章、輪到誰、清單都寫「處理中」
  expect(gamma).toContain('處理中')
  expect(gamma).not.toMatch(/進行中|仍在執行|Agent 執行中/)
  await ui.press({ key: 'more' })
  expect(await ui.find({ type: 'Text', text: '▶ 測試（處理中，完成後可用）' })).toBeDefined()

  // 測試在跑：結果列寫「測試中」
  const alpha = await pick(ui, CARD_A)
  expect(alpha).not.toContain('進行中')
  await ui.press({ key: `case-${CARD_A}-verify` })
  await clock.settle()
  expect(await screen(ui)).toMatch(/▎ 測試 +測試中/)
  release!()
  await clock.settle()

  // 說明頁圖例
  await ui.press({ key: 'help' })
  const help = await screen(ui)
  expect(help).toContain('已過／處理中／等你／卡住／未到／不適用')
  expect(help).not.toContain('進行中')
  await ui.press({ key: 'help' })
  await ui.unmount()
  await clock.advance(2500)
  await clock.settle()
})
