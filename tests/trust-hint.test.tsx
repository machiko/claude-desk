import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, BAND, PANE, CARD_A, CARD_C, REGISTRY, result, text, flat, pressHotkey } from './fixture'
import { ROOT, alphaOnly, helpers } from './alpha-chain'
import { isUntrustedLaunch, untrustedSteps } from '../hooks/dispatch'
import { approveText, buildCase } from '../hooks/model'
import { stageActions, turnOf } from '../hooks/turn'
import { finalState, pipeline } from '../hooks/pipeline'
import { TUTORIAL_INTRO } from '../hooks/tutorial'
import type { Case } from '../types'

// 信任失敗提示與空狀態文案：沒信任過的 repo 派 Agent 失敗時直接列出三步；各種空狀態、錯誤都說下一步；說明頁換行不截字。
const STEPS = untrustedSteps(ROOT, 'g')
const STEPS_WITH_NAME = `Alpha：${STEPS}`
/** 多行輸出，信任那行不是最後一行。 */
const UNTRUSTED_OUTPUT = 'Starting background agent…\nError: workspace not trusted\nRun claude in this folder first.'
const screen = async (ui: any) => flat(text(await ui.drawn()))

/** 只看 Alpha 與 Gamma（閒置、沒有檢查指令）：另一件從頭到尾不受 Alpha 的信任問題影響。 */
function alphaAndGamma(data: any, clock: any) {
  alphaOnly(data, clock)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Gamma | \`${CARD_C}\` |`
}

/** 沒有選取任務時，現在卡是誰：選 Gamma 看它的現在卡。 */
async function gammaShown($: any, clock: any): Promise<string> {
  const ui = await $.ui.mount(PANE(96))
  await ui.press({ key: `row-${CARD_C}` })
  await clock.settle()
  const shown = await screen(ui)
  await ui.unmount()
  return shown
}

test('test_untrusted_launch_shows_three_steps_in_toast_feed_and_turn', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  alphaAndGamma(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  data.launch = async () => result(1, '', UNTRUSTED_OUTPUT)

  const ui = await $.ui.mount(PANE(96))
  await ui.press({ key: `row-${CARD_A}` })
  await h.pressGo(ui)

  // 提示與動態：「Alpha：」接三步
  expect(data.toasts).toContain(STEPS_WITH_NAME)
  expect(data.toasts.some(t => t.includes('繼續失敗'))).toBe(false)
  expect(log.list.some(e => e.text === STEPS_WITH_NAME && e.tone === 'error')).toBe(true)
  // 現在卡的「輪到你」：同一句、不含任務名
  const shown = await screen(ui)
  expect(shown).toContain(flat(`▶ 輪到你 ${STEPS}`))
  await ui.unmount()
  // 摘要列的「輪到你」也是這句
  const band = await $.ui.mount(BAND(400))
  const bandShown = flat(text(await band.drawn()))
  expect(bandShown).toContain(flat(`輪到你：${STEPS}`))
  expect(bandShown).not.toContain(flat(`輪到你：Alpha：`))
  await band.unmount()
  // 標 g：「輪到你」該按的鍵是 g
  const alpha = { ...buildCase({ name: 'Alpha', statusPath: CARD_A }, data.files[CARD_A]!, 1, {}), git: { branch: 'feature/alpha', head: 'h1' } } as Case
  expect(turnOf(alpha, { hold: { dispatch: 'continue', auto: false } })).toEqual({ who: 'you', text: STEPS, action: 'continue', key: 'g' })
})

test('test_untrusted_pattern_matches_listed_samples_only', () => {
  for (const sample of ['Error: workspace not trusted', 'This folder is not trusted', 'Folder is not yet trusted', 'untrusted workspace', 'WORKSPACE NOT TRUSTED']) {
    expect(isUntrustedLaunch(sample), sample).toBe(true)
    // 出現在任何一行都算
    expect(isUntrustedLaunch(`starting\n${sample}\ndone`), sample).toBe(true)
  }
  for (const sample of ['rate limited', 'network down', 'loaded trusted settings from ~/.claude', 'trusted', 'distrusted', '']) {
    expect(isUntrustedLaunch(sample), sample).toBe(false)
  }
})

test('test_general_launch_failure_keeps_old_message_without_steps', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  alphaAndGamma(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  data.launch = async () => result(1, '', 'network down')

  const ui = await $.ui.mount(PANE(96))
  await ui.press({ key: `row-${CARD_A}` })
  await h.pressGo(ui)

  expect(data.toasts).toContain('Alpha：繼續失敗，network down')
  expect(data.toasts.some(t => t.includes('還沒信任'))).toBe(false)
  expect(log.has('Alpha 繼續失敗：network down')).toBe(true)
  expect(log.list.some(e => e.text.includes('還沒信任'))).toBe(false)
  expect(await screen(ui)).not.toContain(flat('還沒信任'))
  await ui.unmount()
  const band = await $.ui.mount(BAND(400))
  expect(flat(text(await band.drawn()))).not.toContain(flat('還沒信任'))
  await band.unmount()
})

test('test_untrusted_hint_clears_after_successful_dispatch', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaAndGamma(data, clock)
  const succeed = data.launch
  const h = helpers($, data, clock)
  await h.refresh()
  data.launch = async () => result(1, '', UNTRUSTED_OUTPUT)

  let ui = await $.ui.mount(PANE(96))
  await ui.press({ key: `row-${CARD_A}` })
  await h.pressGo(ui)
  expect(await screen(ui)).toContain(flat(STEPS))
  await ui.unmount()
  // 另一件（Gamma）不受影響
  expect(await gammaShown($, clock)).not.toContain(flat('還沒信任'))

  // 使用者在終端機信任了 repo：回面板再按 g，這次派出成功
  data.launch = succeed
  await clock.advance(5000)
  await clock.settle()
  ui = await $.ui.mount(PANE(96))
  await ui.press({ key: `row-${CARD_A}` })
  await h.pressGo(ui)
  expect(data.launches.length).toBeGreaterThan(0)
  await h.refresh()
  const shown = await screen(ui)
  expect(shown).not.toContain(flat('還沒信任'))
  expect(shown).toContain(flat('Agent 在寫程式'))
  await ui.unmount()
  const band = await $.ui.mount(BAND(400))
  expect(flat(text(await band.drawn()))).not.toContain(flat('還沒信任'))
  await band.unmount()
  expect(await gammaShown($, clock)).not.toContain(flat('還沒信任'))
})

test('test_empty_and_error_states_say_next_step', async ($, on) => {
  const { data, clock } = fixture(on)
  // 這個對話沒開工作桌卻畫出面板
  let ui = await $.ui.mount(PANE(72))
  expect(await screen(ui)).toContain(flat('此對話未開啟工作桌；輸入 /desk 開啟。'))
  await ui.unmount()

  // 登錄表沒有任何任務：分行列出教學與開第一張卡
  data.files[REGISTRY] = '## 任務\n| Project | path |\n| --- | --- |'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  ui = await $.ui.mount(PANE(72))
  const lines = (await ui.findAll({ type: 'Text' })).map((n: any) => String(n.text ?? ''))
  expect(lines).toContain('第一次用：輸入 /desk tutorial 看教學')
  expect(lines).toContain('開第一張卡：/desk:card new <分支> <任務名>')
  await ui.unmount()

  // 登錄表讀不到：紅字下多一行淡色的排除後重讀
  data.unreadable.push(REGISTRY)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  ui = await $.ui.mount(PANE(72))
  const texts = await ui.findAll({ type: 'Text' })
  const red = texts.findIndex((n: any) => /無法讀取登錄表/.test(String(n.text ?? '')))
  const hint = texts.findIndex((n: any) => n.text === '排除後輸入 /desk refresh 重讀')
  expect(texts[red]?.props?.color).toBe('error')
  expect(texts[hint]?.props?.color).toBe('inactive')
  expect(hint).toBeGreaterThan(red)
  await ui.unmount()

  // 等批准：結尾說批准後面板會自動更新
  expect(approveText({ agent: { name: 'desk-x-1' } } as any).endsWith('批准後面板會自動更新')).toBe(true)
  // 教學開場最後一句：教學不需要信任資料夾，回自己的專案前先在 repo 根目錄開過一次 claude 並選信任
  expect(TUTORIAL_INTRO.split('\n').pop()).toBe('教學不需要信任資料夾；回自己的專案前，先在那個 repo 根目錄開過一次 claude 並選信任，背景 Agent 才派得出去。')
})

/** 說明頁的描述欄從第 12 格起；續列對齊那裡。 */
const HELP_INDENT = 12

test('test_help_rows_wrap_without_truncation_and_list_i', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: 'help' })
  const shown = await screen(ui)
  // 長描述完整出現（換行不截字）
  for (const d of [
    '選任務（數字依清單固定，選了不會換號；取消選取在「現在 · 你選的」那列或「更多動作」裡）',
    '「⇡ 更新到 <版本>」「⇡ 檢查並更新」把 desk 更新到 GitHub 上的最新版本（用點的，不綁快捷鍵）；已是最新只顯示文字，要重查用 /desk update',
    '重新整理（在「更多動作」裡；平常每 30 秒、每回合結束、對話改了卡片時自動重讀）',
  ]) expect(shown).toContain(flat(d))
  // 說明區沒有截字的「…」；放不下的續列對齊描述欄
  const at = (await ui.findAll({ type: 'Text' })).findIndex((n: any) => n.text === '說明')
  expect(at).toBeGreaterThan(-1)
  const help = (await ui.findAll({ type: 'Text' })).slice(at)
  expect(help.some((n: any) => String(n.text ?? '').includes('…'))).toBe(false)
  expect((await ui.findAll({ type: 'Box' })).some((b: any) => b.props?.paddingLeft === HELP_INDENT)).toBe(true)
  // i 這份說明；h 只在說明開著時能按，或輸入 /desk bar
  expect(shown).toContain(flat('i 說明（這份；再按 i 收起）'))
  expect(shown).toContain(flat('h 隱藏摘要列：只在說明開著時能按，或輸入 /desk bar'))
  await ui.unmount()
})

test('test_help_lists_create_registry_n_only_without_registry', async ($, on) => {
  const { data, clock } = fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  let ui = await $.ui.mount(PANE(72))
  await ui.press({ key: 'help' })
  let shown = await screen(ui)
  expect(shown).toContain(flat('⇡ 開 PR／⇡ push：派 Agent 推送（按兩次確認）'))
  expect(shown).not.toContain(flat('建立空的登錄表'))
  await ui.press({ key: 'help' })
  await ui.unmount()

  // 換到還沒有登錄表的 repo：說明頁多一條 n 建立空的登錄表，推送那條照舊
  data.root = '/home/u/blog'
  data.repos['/home/u/blog'] = '/home/u/blog/.git'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  ui = await $.ui.mount(PANE(72))
  await ui.press({ key: 'help' })
  shown = await screen(ui)
  expect(shown).toContain(flat('n ＋ 建立空的登錄表（還沒有登錄表時）'))
  expect(shown).toContain(flat('⇡ 開 PR／⇡ push：派 Agent 推送（按兩次確認）'))
  await ui.unmount()
})

/** 卡片：沒有等你、規格已確認、檢查已核准；只改需要的欄位。 */
const card = (f: { check?: string; ask?: string } = {}) =>
  `<!-- DESK -->\n- 狀態：ok\n- 檢查：${f.check ?? '`node test.mjs`'}\n- 等你：${f.ask ?? '無'}\n- 下一步：依規格實作\n- 關卡：無\n<!-- /DESK -->`
/** 跟工作桌一樣：讀卡 → 疊上 git → 算六段 → 決定狀態。 */
function alphaCase(f: Parameters<typeof card>[0] = {}): Case {
  const base = { ...buildCase({ name: 'Alpha', statusPath: CARD_A }, card(f), 1, {}), git: { branch: 'feature/alpha', head: 'h1' } } as Case
  const piped = { ...base, pipeline: pipeline(base) }
  return { ...piped, state: finalState(piped) } as Case
}

/** 審查 HIGH：驗收段按兩次 w 遇到未信任，③ 與「輪到你」說 w、列上有 w，不叫你按不存在的 g。 */
test('test_untrusted_review_dispatch_says_press_w_and_keeps_w_on_the_row', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  await h.refresh()
  await h.verify()
  const ui = await $.ui.mount(PANE(96))
  expect(await screen(ui)).toContain(flat('按 w 派驗收'))
  data.launch = async () => result(1, '', UNTRUSTED_OUTPUT)
  await pressHotkey(ui, 'w'); await clock.settle()
  await pressHotkey(ui, 'w'); await clock.settle()

  const steps = untrustedSteps(ROOT, 'w')
  expect(data.toasts).toContain(`Alpha：${steps}`)
  const shown = await screen(ui)
  expect(shown).toContain(flat(`▶ 輪到你 ${steps}`))
  expect(shown).not.toContain(flat('回面板再按 g'))
  // 照三步回來按 w 按得到：列上有 w，沒有綁 g 的按鈕也不叫你按 g
  expect((await ui.findAll({ type: 'Button' })).some((b: any) => b.props?.hotkey === 'w')).toBe(true)
  await ui.unmount()
})

/** 手動按的鍵平常收在 m 裡（同步 s）：還沒信任時 s 留在列上；自動流程派的照「輪到你」原本的派工鍵，沒有派工鍵就說重新派工。 */
test('test_untrusted_hold_key_follows_dispatch_kind_and_auto_flow', () => {
  const c = alphaCase()
  const sync = turnOf(c, { hold: { dispatch: 'sync', auto: false } })
  expect(sync).toEqual({ who: 'you', text: untrustedSteps(ROOT, 's'), action: 'sync', key: 's' })
  expect(stageActions(c, { hold: { dispatch: 'sync', auto: false } }).has('sync')).toBe(true)
  expect(stageActions(c).has('sync')).toBe(false)
  // 自動流程派的（例如修正）：照原本「按 g 派 Agent」的 g
  expect(turnOf(c, { hold: { dispatch: 'continue', auto: true } })).toEqual({ who: 'you', text: untrustedSteps(ROOT, 'g'), action: 'continue', key: 'g' })
  // 原本的「輪到你」不是派工鍵（還沒有檢查指令，叫你按 o）：不編一個鍵，說重新派工
  const noCheck = turnOf(alphaCase({ check: '無' }), { hold: { dispatch: 'catchup', auto: true } })
  expect(noCheck).toEqual({ who: 'you', text: untrustedSteps(ROOT) })
  expect(noCheck.text).toContain('③輸入 /exit 回面板再重新派工（不要用 ! 跑）')
})

/** 審查 HIGH：還沒信任的紀錄只在這個對話；別的對話派出 Agent、或卡片在等你決定時，「輪到你」照那件事說。 */
test('test_untrusted_hint_yields_to_running_agent_and_pending_decision', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  await h.refresh()
  data.launch = async () => result(1, '', UNTRUSTED_OUTPUT)
  let ui = await $.ui.mount(PANE(96))
  await h.pressGo(ui)
  expect(await screen(ui)).toContain(flat(STEPS))
  await ui.unmount()

  // 別的對話信任後派出 Agent：重新整理後是處理中，三步不見
  await clock.advance(60_000)
  data.agents = [{ id: 'cccccccc', kind: 'background', cwd: ROOT, name: 'desk-other-1', sessionId: 'cccccccc-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: clock.now() }]
  await h.refresh()
  ui = await $.ui.mount(PANE(96))
  let shown = await screen(ui)
  expect(shown).toContain(flat('Agent 在寫程式'))
  expect(shown).not.toContain(flat('還沒信任'))
  await ui.unmount()
  // 那個 Agent 做完：紀錄已清掉，不會再冒出三步
  data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
  await h.refresh()
  ui = await $.ui.mount(PANE(96))
  shown = await screen(ui)
  expect(shown).not.toContain(flat('還沒信任'))
  await ui.unmount()
  const band = await $.ui.mount(BAND(400))
  expect(flat(text(await band.drawn()))).not.toContain(flat('還沒信任'))
  await band.unmount()

  // 同一個對話：卡片寫了要你決定的題目，「輪到你」照決策說，不蓋掉
  expect(turnOf(alphaCase({ ask: '要 push 嗎？A) 要 B) 等' }), { hold: { dispatch: 'continue', auto: false } })).toMatchObject({ who: 'you', key: 'f' })
})

/** 審查 MEDIUM：三步裡的路徑是給人照抄的，有空白或引號時加單引號，一般路徑照原樣。 */
test('test_untrusted_steps_quote_paths_with_spaces', () => {
  expect(untrustedSteps('/home/u/wt/alpha', 'g')).toContain('cd /home/u/wt/alpha && claude')
  expect(untrustedSteps('/home/u/My Projects/app', 'g')).toContain("cd '/home/u/My Projects/app' && claude")
  expect(untrustedSteps("/home/u/it's/app", 'g')).toContain("cd '/home/u/it'\\''s/app' && claude")
})

/** 審查 MEDIUM：自動流程派驗收遇到未信任，toast 與動態的 ③ 跟「輪到你」說同一個鍵（w），不說重新派工。 */
test('test_untrusted_auto_review_toast_names_the_same_key_as_turn', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const log = feedLog(on)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(96))
  await ui.press({ key: `row-${CARD_A}` })
  await h.pressGo(ui)
  expect(data.launches.length).toBe(1)
  data.launch = async () => result(1, '', UNTRUSTED_OUTPUT)

  // 實作結束 → 自動檢查通過 → 自動派驗收，派的時候遇到未信任
  await h.finish()

  const steps = untrustedSteps(ROOT, 'w')
  expect(data.toasts).toContain(`Alpha：${steps}`)
  expect(data.toasts.some(t => t.includes('回面板再重新派工'))).toBe(false)
  expect(log.list.some(e => e.text === `Alpha：${steps}` && e.tone === 'error')).toBe(true)
  expect(await screen(ui)).toContain(flat(`▶ 輪到你 ${steps}`))
  await ui.unmount()
})

/** 複審 MEDIUM：檢查失敗後自動派修正遇到未信任，toast、動態與「輪到你」說同一個鍵（g），不說「重新派工」。 */
test('test_untrusted_auto_fix_after_failed_check_toast_names_the_same_key_as_turn', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const log = feedLog(on)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(96))
  await ui.press({ key: `row-${CARD_A}` })
  await h.pressGo(ui)
  expect(data.launches.length).toBe(1)
  const run = data.run
  data.run = async (e: any) => e.argv[0] === 'sh' ? result(1, 'FAILED\n') : run(e)
  data.launch = async () => result(1, '', UNTRUSTED_OUTPUT)

  // 實作結束 → 自動檢查沒過 → 自動派修正，派的時候遇到未信任
  await h.finish()

  const steps = untrustedSteps(ROOT, 'g')
  expect(data.toasts).toContain(`Alpha：${steps}`)
  expect(data.toasts.some(t => t.includes('回面板再重新派工'))).toBe(false)
  expect(log.list.some(e => e.text === `Alpha：${steps}` && e.tone === 'error')).toBe(true)
  expect(await screen(ui)).toContain(flat(`▶ 輪到你 ${steps}`))
  await ui.unmount()
})
