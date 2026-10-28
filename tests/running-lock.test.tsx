import { expect, test } from 'claude-code/testing'
import { fixture, BAND, PANE, CARD_A, CARD_B, NOW, REGISTRY, result, text, flat } from './fixture'

const BETA = '/home/u/wt/beta'
const PREFIX = `case-${CARD_B}-`
const SID = 'bbbbbbbb-0000-4000-8000-000000000000'
const LAUNCH = 'desk-beta-0'
const LOCKED = '（執行中，完成後可用）'
const GITHUB = 'git@github.com:acme/shop.git'
const MERGED_PR = { number: 12, state: 'MERGED', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [] }
const PASS = { command: 'npm test', at: NOW - 60_000, ok: true, exitCode: 0, tail: ['all green'], truncated: false, head: 'b1' }
/** 工作桌派出去、正在跑的那一個。 */
const RUNNING = { id: 'bbbbbbbb', kind: 'background', cwd: BETA, state: 'working', status: 'busy', name: LAUNCH, sessionId: SID, startedAt: NOW - 60_000 }
/** 同一個，停在權限提示。 */
const APPROVING = { ...RUNNING, state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' }

/** 會搶 worktree／卡片的四個動作：鍵、原本的標籤、處理端擋下時 toast 寫的動作；有確認的要按兩次。 */
const LOCKABLE = {
  verify: { label: '▶ 檢查', doing: '檢查', presses: 1 },
  'spec-ok': { label: '✓ 確認規格', doing: '確認規格', presses: 2 },
  ship: { label: '✓ 上線確認', doing: '確認上線', presses: 2 },
  archive: { label: '⌫ 歸檔', doing: '歸檔', presses: 2 },
} as const
type Lockable = keyof typeof LOCKABLE

const screen = async (ui: any) => flat(text(await ui.drawn()))
/** 鎖住的動作：不是按鈕，是一段「<原標籤>（執行中，完成後可用）」的文字。 */
const lockedText = (ui: any, id: Lockable) => ui.find({ type: 'Text', text: `${LOCKABLE[id].label}${LOCKED}` })
/** 按下去引擎找不到可按的按鈕（只是文字）就丟錯：回 true 代表按不了。 */
const pressRefused = async (ui: any, key: string) => ui.press({ key }).then(() => false, () => true)

/** 只留 Beta 一件；Agent 由呼叫端給。 */
function onlyBeta(data: any, base: string) {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = base
  data.gh = []
  data.store = {}
  data.agents = []
  data.toasts.length = 0
  data.asks.length = 0
  data.processCalls.length = 0
  data.store.jobs = { [BETA]: { sessionId: SID, last: { launchName: LAUNCH, nativeId: 'bbbbbbbb', sessionId: SID, kind: 'continue', startedAt: NOW - 60_000, fresh: false } } }
}

/**
 * 三種「原本的條件」：規格段停在 spec 關卡（t），上線段有 tag 包含 HEAD、關卡是 release（u），六段全過（歸檔）；
 * 卡片都有完成檢查（v）。同一件任務不會同時在三段，所以分三種卡片各驗一次。
 */
const STAGES: { name: string; ids: Lockable[]; setup: (data: any) => void }[] = [
  {
    name: 'spec',
    ids: ['verify', 'spec-ok'],
    setup: data => {
      data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', '- 關卡：spec：待確認規格（AC-1～AC-2）')
      data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: GITHUB }
    },
  },
  {
    name: 'ship',
    ids: ['verify', 'ship'],
    setup: data => {
      data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', '- 關卡：release：v0.2.0 待上線確認')
      data.git[BETA] = { branch: 'feature/b', head: 'h1', tag: 'v0.2.0', remote: GITHUB }
    },
  },
  {
    name: 'done',
    ids: ['verify', 'archive'],
    setup: data => {
      data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過').replace(/- 下一步：.*$/m, '- 下一步：可歸檔')
      data.git[BETA] = { branch: 'feature/b', head: 'b1', tag: 'v0.19.0', remote: GITHUB }
      data.gh = [MERGED_PR]
      data.store.verifies = { [CARD_B]: PASS }
    },
  },
]

async function mount($: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(120))
  // 已上線的那件不會自動當現在卡：點它的列
  await ui.press({ key: `row-${CARD_B}` })
  // 「更多動作」展開後跨 mount 保留：只在還沒展開（沒有 r 重新整理）時按 m。
  if (!(await ui.find({ key: 'refresh' }))) await ui.press({ key: 'more' })
  return ui
}

/** 四個動作列成淡色文字、寫原因；連按（含第二次確認）都按不了，也不跑指令、不改卡片、不問、不出現「再按…確認」。 */
async function expectLocked(ui: any, data: any, ids: Lockable[], card: string, clock: any) {
  for (const id of ids) {
    expect(await ui.find({ type: 'Button', key: PREFIX + id })).toBeUndefined()
    expect((await lockedText(ui, id))?.props?.color).toBe('inactive')
    for (let i = 0; i < LOCKABLE[id].presses; i++) expect(await pressRefused(ui, PREFIX + id)).toBe(true)
  }
  await clock.settle()
  // v、t、u 這三個鍵沒有任何按鈕接
  const hotkeys = (await ui.findAll({ type: 'Button' })).map((b: any) => b.props?.hotkey)
  for (const k of ['v', 't', 'u']) expect(hotkeys).not.toContain(k)
  expect(data.processCalls).toHaveLength(0)
  expect(data.files[CARD_B]).toBe(card)
  expect(data.asks).toHaveLength(0)
  expect(await screen(ui)).not.toContain('再按')
}

/** AC-1 */
test('test_running_case_lists_locked_actions_with_reason_and_keys_do_nothing', async ($, on) => {
  const { data, clock } = fixture(on)
  const base = data.files[CARD_B]!
  for (const stage of STAGES) {
    onlyBeta(data, base)
    stage.setup(data)
    data.agents = [RUNNING]
    const ui = await mount($, clock)
    await expectLocked(ui, data, stage.ids, data.files[CARD_B]!, clock)
    // 輸出、開啟照常可按
    expect((await ui.find({ key: `${PREFIX}logs` }))?.props?.hotkey).toBe('l')
    expect((await ui.find({ key: `${PREFIX}open` }))?.props?.hotkey).toBe('o')
    await ui.unmount()
  }
})

/** AC-2 */
test('test_permission_waiting_case_locks_the_same_actions', async ($, on) => {
  const { data, clock } = fixture(on)
  const base = data.files[CARD_B]!
  for (const stage of STAGES) {
    onlyBeta(data, base)
    stage.setup(data)
    data.agents = [APPROVING]
    const ui = await mount($, clock)
    expect(await screen(ui)).toContain(flat('等批准'))
    await expectLocked(ui, data, stage.ids, data.files[CARD_B]!, clock)
    await ui.unmount()
  }
})

/** AC-3 */
test('test_stale_buttons_pressed_after_agent_started_are_refused_with_toast', async ($, on) => {
  const { data, clock } = fixture(on)
  const base = data.files[CARD_B]!
  for (const stage of STAGES) {
    onlyBeta(data, base)
    stage.setup(data)
    // 閒置時畫出按鈕
    const ui = await mount($, clock)
    for (const id of stage.ids) expect((await ui.find({ key: PREFIX + id }))?.type).toBe('Button')
    const card = data.files[CARD_B]!
    // Agent 開始跑，面板還沒重新整理：按舊按鈕
    data.agents = [RUNNING]
    for (const id of stage.ids) {
      for (let i = 0; i < LOCKABLE[id].presses; i++) await ui.press({ key: PREFIX + id })
      await clock.settle()
      expect(data.toasts).toContain(`Beta：Agent 仍在執行，完成後再${LOCKABLE[id].doing}`)
    }
    expect(data.processCalls).toHaveLength(0)
    expect(data.files[CARD_B]).toBe(card)
    expect(data.asks).toHaveLength(0)
    expect(await screen(ui)).not.toContain('再按')
    await ui.unmount()
  }
})

/** AC-4 */
test('test_running_case_keeps_stop_logs_open_and_other_cases_unlocked', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, data.files[CARD_B]!)
  // Beta：已合併、還沒打 tag（可以發版），Agent 在跑；Alpha：閒置、有完成檢查
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 等你：.*$/m, '- 等你：無')
  data.git[BETA] = { branch: 'feature/b', head: 'b1', remote: GITHUB }
  data.gh = [MERGED_PR]
  data.agents = [RUNNING]
  const ui = await mount($, clock)
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Button', key: `${PREFIX}verify` })).toBeUndefined()
  expect(await lockedText(ui, 'verify')).toBeDefined()
  const card = data.files[CARD_B]!

  // 輸出、開啟、發版照常
  await ui.press({ key: `${PREFIX}logs` })
  await clock.settle()
  expect(await screen(ui)).toContain(flat('跑測試中'))
  await ui.press({ key: `${PREFIX}open` })
  await clock.settle()
  expect(data.processCalls.some((c: any) => c.argv.includes(CARD_B))).toBe(true)
  await ui.press({ key: `${PREFIX}release` })
  await clock.settle()
  expect(data.fills).toHaveLength(1)
  // 停止：按兩次派出 claude stop
  await ui.press({ key: `${PREFIX}stop` })
  await ui.press({ key: `${PREFIX}stop` })
  await clock.settle()
  expect(data.stops).toEqual(['bbbbbbbb'])
  expect(data.files[CARD_B]).toBe(card)
  expect(data.toasts.some((t: string) => t.includes('Agent 仍在執行'))).toBe(false)

  // 另一件閒置的任務：檢查照常執行（換件後「更多動作」收回，重新展開）
  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: 'more' })
  const verify = await ui.find({ key: `case-${CARD_A}-verify` })
  expect(verify?.type).toBe('Button')
  expect(verify?.props?.hotkey).toBe('v')
  await ui.press({ key: `case-${CARD_A}-verify` })
  await clock.settle()
  expect(data.processCalls.some((c: any) => c.argv.join(' ') === 'sh -c node test.mjs')).toBe(true)
  await ui.unmount()
})

/** AC-5 */
test('test_actions_unlock_after_agent_finishes', async ($, on) => {
  const { data, clock } = fixture(on)
  const base = data.files[CARD_B]!
  for (const stage of STAGES) {
    onlyBeta(data, base)
    stage.setup(data)
    data.agents = [RUNNING]
    const ui = await mount($, clock)
    for (const id of stage.ids) expect(await lockedText(ui, id)).toBeDefined()
    // Agent 做完：清單裡不再是 busy；重新整理
    data.agents = [{ ...RUNNING, state: 'done', status: 'idle' }]
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    await clock.settle()
    for (const id of stage.ids) {
      expect((await ui.find({ key: PREFIX + id }))?.text).toBe(LOCKABLE[id].label)
      expect(await lockedText(ui, id)).toBeUndefined()
    }
    await ui.unmount()
  }
})

/** AC-6：卡片停在 release 關卡（state 是 gate）、Agent 在跑：現在卡與摘要列都說處理中，不叫你按已鎖住的 u。 */
test('test_turn_line_says_processing_while_agent_runs_on_gated_case', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, data.files[CARD_B]!)
  STAGES.find(s => s.name === 'ship')!.setup(data)
  data.agents = [RUNNING]
  const ui = await mount($, clock)
  const pane = await screen(ui)
  expect(pane).toContain(flat('處理中'))  // 前面的圖示會轉，不比對字形
  expect(pane).not.toContain(flat('按 u 確認上線'))
  const band = await $.ui.mount(BAND(120))
  const top = flat(text(await band.drawn()))
  expect(top).toContain(flat('處理中'))
  expect(top).not.toContain(flat('按 u'))
  await band.unmount()
  await ui.unmount()
})

/** AC-7：排進隊伍後、或停在第一次執行的核准對話框時 Agent 開始跑：輪到它／按「執行」都不跑檢查，提示原因，隊伍接著走。 */
test('test_queued_or_approved_check_does_not_run_once_agent_started', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, data.files[CARD_B]!)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 等你：.*$/m, '- 等你：無')
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: GITHUB }
  let finishAlpha = () => {}
  data.run = (e: any) => e.argv.join(' ') === 'sh -c node test.mjs' ? new Promise(done => { finishAlpha = () => done(result(0, 'ok\n')) }) : Promise.resolve(result(0, 'ok\n'))
  const ui = await mount($, clock)
  // Alpha 的檢查在跑；Beta 排進隊伍（每換一件「更多動作」都收回，重新展開）
  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: 'more' })
  await ui.press({ key: `case-${CARD_A}-verify` })
  await clock.settle()
  await ui.press({ key: `row-${CARD_B}` })
  await ui.press({ key: 'more' })
  await ui.press({ key: `${PREFIX}verify` })
  await clock.settle()
  expect(data.toasts.some((t: string) => t.startsWith('Beta：已排隊'))).toBe(true)
  // 排隊期間 Beta 的 Agent 開始跑，然後 Alpha 跑完
  data.agents = [RUNNING]
  finishAlpha()
  await clock.settle()
  expect(data.toasts).toContain('Beta：Agent 仍在執行，完成後再檢查')
  expect(data.processCalls.some((c: any) => c.argv.join(' ') === 'sh -c npm test')).toBe(false)
  expect(await screen(ui)).not.toContain(flat('排隊中'))
  await ui.unmount()

  // 核准對話框：問的時候還閒置，回答的這段時間 Agent 開始跑
  onlyBeta(data, data.files[CARD_B]!)
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: GITHUB }
  Object.defineProperty(data, 'answer', { configurable: true, get: () => { data.agents = [RUNNING]; return '執行' } })
  const again = await mount($, clock)
  await again.press({ key: `${PREFIX}verify` })
  await clock.settle()
  expect(data.asks).toHaveLength(1)
  expect(data.toasts).toContain('Beta：Agent 仍在執行，完成後再檢查')
  expect(data.processCalls.some((c: any) => c.argv.join(' ') === 'sh -c npm test')).toBe(false)
  await again.unmount()
})

/** AC-7：對執行中的任務輸入 /desk verify：不跑檢查，回覆寫原因。 */
test('test_desk_verify_command_refuses_while_agent_runs', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data, data.files[CARD_B]!)
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: GITHUB }
  data.agents = [RUNNING]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const out = await $.command.run({ command: 'desk', args: 'verify Beta' } as any)
  await clock.settle()
  expect(String((out as any).text)).toBe('Beta：Agent 仍在執行，完成後再檢查')
  expect(data.processCalls.some((c: any) => c.argv.join(' ') === 'sh -c npm test')).toBe(false)
  expect(data.asks).toHaveLength(0)
})

/** AC-8：t、u、歸檔第一次按只看快照、立刻待確認，不問 claude agents；第二次按（真的要做）才查。 */
test('test_first_press_arms_without_querying_agents', async ($, on) => {
  const { data, clock } = fixture(on)
  const base = data.files[CARD_B]!
  // 動作的副作用：寫檔（上線確認寫卡片、歸檔寫登錄表與歸檔檔）加上跑指令（確認規格跑卡片腳本）。
  const effects = () => data.writes.length + data.processCalls.length
  // 每次查 claude agents 當下已經有幾個副作用：看查詢是不是發生在動作之前（動作之後面板重新整理也會查，那不算）。
  let queries: number[] = []
  data.exec = (e: any) => { if (e.argv[0] === 'claude' && e.argv[1] === 'agents') queries.push(effects()); return null }
  for (const stage of STAGES) {
    onlyBeta(data, base)
    stage.setup(data)
    const ui = await mount($, clock)
    const id = stage.ids.find(x => x !== 'verify')!
    queries = []
    await ui.press({ key: PREFIX + id })
    await clock.settle()
    expect(queries).toEqual([])
    expect(String((await ui.find({ key: PREFIX + id }))?.props?.label ?? '')).toContain('再按')
    const before = effects()
    await ui.press({ key: PREFIX + id })
    await clock.settle()
    // 第二次按：動作之前先查了一次，而且動作真的做了
    expect(queries[0]).toBe(before)
    expect(effects()).toBeGreaterThan(before)
    await ui.unmount()
  }
})

/**
 * AC-6：PR 已合併、Agent 在跑：「下一步」列與部署列的「全部做完後」不叫你按已鎖住的 u，
 * 寫 Agent 完成後再確認上線（六段全過的寫再歸檔）；部署步驟照常列出。
 */
test('test_next_step_rows_do_not_ask_for_u_while_agent_runs', async ($, on) => {
  const { data, clock } = fixture(on)
  const base = data.files[CARD_B]!
  const cases = [
    { stage: 'ship', steps: false, says: 'Agent 執行中，完成後再確認上線' },
    { stage: 'ship', steps: true, says: '全部做完後：Agent 執行中，完成後再確認上線' },
    { stage: 'done', steps: false, says: 'Agent 執行中，完成後再歸檔' },
  ]
  for (const k of cases) {
    onlyBeta(data, base)
    STAGES.find(s => s.name === k.stage)!.setup(data)
    data.gh = [MERGED_PR]
    if (k.steps) data.files[CARD_B] = data.files[CARD_B]! + '\n## 部署步驟（合併後）\n1. php artisan migrate\n'
    data.agents = [RUNNING]
    const ui = await mount($, clock)
    const shown = await screen(ui)
    expect(shown).toContain(flat(k.says))
    if (k.steps) expect(shown).toContain(flat('1. php artisan migrate'))
    expect(shown).not.toContain(flat('按 u'))
    expect(shown).not.toContain(flat('/desk:card archive'))
    await ui.unmount()
  }
})
