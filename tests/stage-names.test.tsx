import { expect, test } from 'claude-code/testing'
import { fixture, PANE, BAND, CARD_A, CARD_B, CARD_C, REGISTRY, result, text, flat } from './fixture'
import { buildCase, displayWidth } from '../hooks/model'
import { STAGES, pipeline, stageLabel } from '../hooks/pipeline'
import { turnOf } from '../hooks/turn'
import { dispatchRefusal } from '../hooks/dispatch'
import { TUTORIAL_INTRO } from '../hooks/tutorial'
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
const OLD_HINT = /執行完成檢查|派審查|派獨立審查|自動審查|重新審查/

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
  expect(alpha).toContain('規格● 實作● 測試◆ 驗收○ 合併○ 上線○')
  expect(beta).toContain('規格● 實作● 測試● 驗收◆ 合併○ 上線○')
  expect(gamma).toContain('規格● 實作● 測試● 驗收● 合併◆ 上線○')
  // 欄寬與對齊不變：段名都是兩個全形字，表頭每段 5 欄，跟列上字形的間距一樣
  expect(STAGES.map(s => displayWidth(s.label))).toEqual([4, 4, 4, 4, 4, 4])
  expect(beta).toContain('●    ●    ●    ◆    ○    ○')
  await wide.unmount()

  // 窄：現在卡的六段列照樣是新段名，清單只畫字形
  const narrow = await mount($, clock, 44)
  const narrowAlpha = await pick(narrow, CARD_A)
  expect(narrowAlpha).toContain('規格● 實作● 測試◆ 驗收○ 合併○ 上線○')
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

/** AC-2 */
test('test_v_and_w_buttons_and_help_use_new_names', async ($, on) => {
  const { data, clock } = fixture(on)
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
  // 動態列：派工種類名稱組出來的「派驗收（<模型>）」
  const sent = (await ui.findAll({ type: 'Text' })).map((n: any) => String(n.text ?? ''))
  expect(sent.some(s => /Beta 派驗收（.+）/.test(s))).toBe(true)
  expect(sent.some(s => /派審查/.test(s))).toBe(false)

  // 不能派的時候用派工種類名稱說明（Beta 的驗收正在跑）
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'review Beta' } as any)
  await clock.settle()
  expect(data.toasts).toContain('Beta：目前無法驗收（Agent 仍在執行）')

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
  expect(await locked.find({ type: 'Text', text: '▶ 測試（執行中，完成後可用）' })).toBeDefined()
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
  expect(alpha).toContain(flat('▶ 輪到你  驗收後有新 commit：按 v 重新執行測試；通過後按 w 重新驗收'))
  const beta = flat(await pick(ui, CARD_B))
  expect(beta).toContain(flat('▶ 輪到你  按 w 派驗收（新對話）；有 CRITICAL／HIGH 會自動修正，過關後開 PR'))
  const gamma = flat(await pick(ui, CARD_C))
  expect(gamma).toContain(flat('（驗收是自審，可按 w 派獨立驗收）'))
  for (const shown of [alpha, beta, gamma]) expect(shown).not.toMatch(OLD_HINT)

  // 按 v 的確認框
  data.store.trustedVerify = {}
  await pick(ui, CARD_A)
  await ui.press({ key: `case-${CARD_A}-verify` })
  await clock.settle()
  expect(data.asks.at(-1)).toContain(`在 ${ALPHA} 執行測試：\nnpm test\n`)
  expect(data.askHeaders.at(-1)).toBe('Alpha 測試')
  expect(data.asks.at(-1)).not.toContain('完成檢查')
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
    '驗收後有新 commit：按 v 重新執行測試；通過後自動重新驗收',
    '驗收後有新 commit：按 v 重新執行測試；通過後按 w 重新驗收',
    '按 w 派驗收（新對話）；有 CRITICAL／HIGH 會自動修正，過關後開 PR',
    '接著自動驗收',
    '下一步只剩等測試：按 v 執行測試，通過後按 w 派驗收；要改程式先把下一步寫成要做的事',
    '下一步是驗收：按 v 執行測試，通過後按 w 派驗收',
    '下一步是驗收：按 v 執行測試，通過後自動驗收',
  ])
  // 測試段的一般情況（完成檢查還沒跑、不是驗收後的新 commit）
  expect(turnOf({ ...caseOf('- 關卡：無', {}), pipeline: { stages: [], current: 'check', note: '' } } as Case).text).toBe('按 v 執行測試；通過後按 w 派驗收')
  // 下一步寫派審查時按 g：被拒的提示
  expect(dispatchRefusal(caseOf('- 關卡：無', {}, undefined, '派驗收（按 w）'), 'continue')).toBe('下一步是驗收：先按 v 執行測試，再按 w 派驗收（g 派的是繼續，不會驗收）')
  expect(dispatchRefusal(caseOf('- 關卡：無', {}, ok('b1'), '派審查（按 w）'), 'continue')).toBe('下一步是驗收：按 w 派驗收（g 派的是繼續，不會驗收）')
  for (const hint of hints) expect(hint).not.toMatch(OLD_HINT)

  // /desk tutorial 開場：第 3、4 段
  const intro = TUTORIAL_INTRO.split('\n')
  expect(intro.find(l => l.startsWith('  3 '))).toMatch(/^ {2}3 測試：/)
  expect(intro.find(l => l.startsWith('  4 '))).toMatch(/^ {2}4 驗收：自動派驗收/)
  expect(TUTORIAL_INTRO).not.toMatch(/ {2}[34] (檢查|審查)：/)
  expect(TUTORIAL_INTRO).not.toMatch(OLD_HINT)
})
