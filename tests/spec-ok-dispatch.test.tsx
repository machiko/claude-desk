import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, REGISTRY, result, text, flat } from './fixture'
import { appendTo, setFields, tutorialPaths, TUTORIAL_INTRO } from '../hooks/tutorial'
import { afterSpecRefusal } from '../hooks/dispatch'
import { specOkCards, specOkTarget } from '../hooks/touch'

// 確認規格後自動派實作：面板按兩次 t 當下派；對話跑 /desk:card spec … ok 的，回合結束後派。核准、排隊、不能派的原因都跟按 g 一樣。
const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const SPEC_GATE = '- 關卡：spec：待確認規格（AC-1～AC-2）'
const CONFIRMED = '規格已確認（AC-1～AC-2），可派實作'
const SPEC_OK = (card: string) => `case-${card}-spec-ok`
const SLUG: Record<string, string> = { alpha: CARD_A, beta: CARD_B, gamma: CARD_C }
const screen = async (ui: any) => flat(text(await ui.drawn()))
const busy = (name: string, cwd: string) => ({ id: name.slice(-8), kind: 'background', cwd, name, sessionId: `${name.slice(-8)}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: 0 })
const turnDone = (turnId = 't1') => ({ answer: '', durationMs: 4000, isAborted: false, turnId, reason: 'answer' }) as any

/** 這幾張停在 spec 關卡（有完成檢查、「等你」無、下一步是實作），沒有 Agent 在跑；完成檢查預設都核准過。 */
function atSpec(data: any, clock: any, cards: string[], opts: { trusted?: boolean } = {}) {
  data.agents = []
  data.gh = []
  for (const card of cards) {
    data.files[card] = setFields(data.files[card]!, { 驗證: '`npm test`', 等你: '無', 下一步: '依規格與實作計畫實作', 關卡: SPEC_GATE.slice('- 關卡：'.length) }) + '\n\n## Decisions\n\n- D-01 2030-01-05 Alex：只匯出 CSV\n\n## History\n\n- 2030-01-05：產生規格草稿\n'
  }
  data.git[ALPHA] = { branch: 'feature/a', head: 'a1' }
  data.git[BETA] = { branch: 'feature/b', head: 'g1' }
  data.git[GAMMA] = { branch: 'feature/c', head: 'c1' }
  if (opts.trusted !== false) data.store.trustedVerify = Object.fromEntries(cards.map(c => [c, 'npm test']))
  // 派出去的 Agent 會出現在 claude agents 清單（在跑）
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    data.agents = [...data.agents, { ...busy(e.argv[3], e.init.cwd), id, sessionId: `${id}-0000-4000-8000-000000000000`, startedAt: clock.now() }]
    return result(0, id)
  }
}

/** /desk:card spec-ok 是真的腳本（skills/card/tests 驗它）；這裡照它的效果改那張卡。 */
function confirmCard(data: any, card: string) {
  const withGate = setFields(data.files[card]!, { 關卡: '無', 狀態: CONFIRMED })
  data.files[card] = appendTo(appendTo(withGate, '## Decisions', '- D-02 2030-01-05 Alex：確認規格（AC-1～AC-2，共 2 條）'), '## History', '- 2030-01-05：規格確認，關卡清為無，可派實作')
}

function scriptOk(data: any) {
  data.run = async (e: any) => {
    if (!e.argv.includes('spec-ok')) return result(0, '')
    const card = SLUG[String(e.argv.at(-1))]
    if (card) confirmCard(data, card)
    return result(0, `規格已確認（AC-1～AC-2），關卡清為「無」：${card}\n`)
  }
}

/**
 * 對話的 Bash 照 card.py spec-ok 的行為回答：關卡還是 spec 才改卡，stdout 印成功那一行；
 * 不是 spec 就不動卡片、只在 stderr 說原因（腳本本身在 skills/card/tests 驗）。
 */
function conversationBash(on: any, data: any) {
  on('tool.call', { tool: 'Bash' }, (_: any, e: any) => {
    const card = SLUG[String(specOkTarget(e))]
    if (!card || !data.files[card]!.includes(SPEC_GATE)) return { result: { stdout: '', stderr: card ? '關卡不是 spec：…（目前是「無」），不動卡片\n' : '', interrupted: false } }
    confirmCard(data, card)
    return { result: { stdout: `規格已確認（AC-1～AC-2），關卡清為「無」：${card}\n`, stderr: '', interrupted: false } }
  })
  on('turn.complete', () => ({ text: '' }))
}
const script = (target: string) => `python3 /home/u/.claude/plugins/desk/skills/card/scripts/card.py spec-ok ${target}`

function helpers($: any, clock: any) {
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  /** 面板上選那件、按兩次 t。 */
  const pressT = async (ui: any, card: string) => {
    await ui.press({ key: `row-${card}` })
    await ui.press({ key: SPEC_OK(card) }); await clock.settle()
    await ui.press({ key: SPEC_OK(card) }); await clock.settle()
  }
  return { refresh, pressT }
}

/** AC-1 */
test('test_spec_confirm_dispatches_build_agent_when_card_is_ready', { timeoutMs: 15000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  atSpec(data, clock, [CARD_B])
  scriptOk(data)
  const h = helpers($, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(120))
  expect(await screen(ui)).toContain(flat('看過規格（o 開卡片）後按 t 確認並派實作（或輸入 /desk:card spec beta ok）'))

  await h.pressT(ui, CARD_B)
  // 卡片跟 /desk:card spec beta ok 一樣：關卡清掉、Decisions 與 History 各一筆
  expect(data.files[CARD_B]).toContain('- 關卡：無')
  expect(data.files[CARD_B]).toContain('- D-02 2030-01-05 Alex：確認規格（AC-1～AC-2，共 2 條）')
  expect(data.files[CARD_B]).toContain('- 2030-01-05：規格確認，關卡清為無，可派實作')
  // 同一次就派出實作（派繼續），不用再按 g；檢查早就核准過，不再問
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(BETA)
  expect(String(data.launches[0].argv.at(-1))).toContain('依規格與實作計畫實作')
  expect(data.asks).toHaveLength(0)
  expect(data.toasts).toContain('Beta：繼續已派出')
  await h.refresh()
  const shown = await screen(ui)
  expect(shown).toContain(flat('Agent 在寫程式'))
  expect(shown).not.toContain(flat('按 g 派 Agent'))
  await ui.unmount()

  // 教學：說明第 2 步改成確認後自動派；按一次 t，模擬 Agent 直接開始寫
  expect(TUTORIAL_INTRO).toContain('  2 實作：確認規格後自動派 Agent（教學裡由腳本扮演，不花額度）')
  const P = tutorialPaths('/home/u')
  data.git[P.wt] = { branch: 'feature/discount', head: 'h0' }
  data.git[P.main] = { branch: 'release/v1.0', head: 'm0' }
  data.run = async (e: any) => {
    if (e.argv.includes('spec-ok')) { data.files[P.card] = setFields(data.files[P.card]!, { 關卡: '無', 狀態: '規格已確認（AC-1～AC-3），可派實作' }); return result(0, 'ok\n') }
    return result(0, '')
  }
  const launched = data.launches.length
  await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  const tut = await $.ui.mount(PANE(72))
  await tut.press({ key: `case-${P.card}-tutorial` })
  await clock.settle()
  expect(data.files[P.card]).toContain('關卡：無')
  expect(await screen(tut)).toContain(flat('Agent 在寫程式'))
  // 教學派的是模擬 Agent，不啟動 claude
  expect(data.launches.length).toBe(launched)
  await tut.unmount()
  await $.command.run({ command: 'desk', args: 'tutorial end' } as any)
})

/** AC-2 */
test('test_spec_confirm_dispatches_nothing_when_check_approval_is_declined', { timeoutMs: 15000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  atSpec(data, clock, [CARD_B], { trusted: false })
  scriptOk(data)
  const h = helpers($, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(120))

  // 取消：規格照樣確認，沒有派
  data.approve = '取消'
  await h.pressT(ui, CARD_B)
  expect(data.asks).toHaveLength(1)
  expect(data.askOptions[0]).toEqual(['核准並派工', '取消'])
  expect(data.files[CARD_B]).toContain('- 關卡：無')
  expect(data.launches).toHaveLength(0)
  expect(data.toasts).toContain('Beta：規格已確認；沒有核准完成檢查，沒有派實作：要派時按 g')
  await h.refresh()
  expect(await screen(ui)).toContain(flat('按 g 派 Agent：'))

  // 核准：對話框還是只跳一次（跟按 g 同一個），同一次派出
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', SPEC_GATE)
  await h.refresh()
  data.approve = '核准並派工'
  await h.pressT(ui, CARD_B)
  expect(data.asks).toHaveLength(2)
  expect(data.askOptions[1]).toEqual(['核准並派工', '取消'])
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(BETA)
  expect(data.toasts).toContain('Beta：繼續已派出')

  // 核准記在按 g 用的同一份紀錄：之後這張卡同一條指令按 g 不再問
  expect((data.store.trustedVerify as Record<string, string>)[CARD_B]).toBe('npm test')
  await ui.unmount()
})

/** AC-3 */
test('test_spec_confirm_queues_build_with_position_when_agents_are_full', { timeoutMs: 15000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  atSpec(data, clock, [CARD_B])
  scriptOk(data)
  // 三個在跑的工作桌 Agent（別的專案）：maxAgents 預設 3，已滿
  data.agents = [busy('desk-m0-0', '/home/u/other/one'), busy('desk-m0-1', '/home/u/other/two'), busy('desk-m0-2', '/home/u/other/three')]
  const h = helpers($, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))

  await h.pressT(ui, CARD_B)
  expect(data.files[CARD_B]).toContain('- 關卡：無')
  expect(data.launches).toHaveLength(0)
  expect(data.toasts).toContain('Beta：同時執行的 Agent 已達上限 3 個，已排隊（第 1 位）')
  expect(await screen(ui)).toContain(flat('派工排隊中（第 1 位）'))

  // 一個 Agent 結束：自動派出 Beta 的實作
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(BETA)
  expect(String(data.launches[0].argv.at(-1))).toContain('依規格與實作計畫實作')
  await ui.unmount()
})

/** AC-4 */
test('test_spec_confirm_dispatches_nothing_when_card_asks_or_is_manual_or_worktree_is_foreign', { timeoutMs: 15000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[REGISTRY] = `## 任務\n| Project | path | Scope | Executor |\n| --- | --- | --- | --- |\n| Alpha | \`${CARD_A}\` | a | |\n| Beta | \`${CARD_B}\` | b | manual |\n| Gamma | \`${CARD_C}\` | c | |`
  atSpec(data, clock, [CARD_A, CARD_B, CARD_C])
  scriptOk(data)
  // Alpha 的「等你」還有決策；Gamma 的 worktree 有 2 個不是上一個 Agent 留下的未提交檔
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '匯出要含稅嗎？A) 含 B) 不含' })
  data.git[GAMMA] = { ...data.git[GAMMA]!, changed: 2 }
  const h = helpers($, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))

  for (const card of [CARD_A, CARD_B, CARD_C]) await h.pressT(ui, card)
  // 三張的規格都確認
  for (const card of [CARD_A, CARD_B, CARD_C]) expect(data.files[card]).toContain('- 關卡：無')
  // 都沒有派 Agent，也沒有問核准
  expect(data.launches).toHaveLength(0)
  expect(data.asks).toHaveLength(0)
  expect(data.toasts).toContain('Alpha：規格已確認；沒有自動派實作（卡片「等你」還有要你決定的事）')
  expect(data.toasts).toContain('Beta：規格已確認；沒有自動派實作（登錄表設為 manual，只追蹤不派工）')
  expect(data.toasts.some(t => t.startsWith('Gamma：目前無法繼續（worktree 有未提交的改動（2 個檔），不是上一個 Agent 留下的'))).toBe(true)
  await ui.unmount()
})

/** AC-5 */
test('test_conversation_spec_ok_dispatches_after_turn_ends_but_not_from_subagent_or_failed_script', { timeoutMs: 15000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |\n| Gamma | \`${CARD_C}\` |`
  atSpec(data, clock, [CARD_B, CARD_C])
  // Beta 的完成檢查還沒核准過：要在回合結束時才問
  data.store.trustedVerify = { [CARD_C]: 'npm test' }
  conversationBash(on, data)
  const h = helpers($, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))

  // (a) 主對話跑 spec-ok beta，腳本成功：回合進行中不派、也不問核准
  await $.tool.call({ tool: 'Bash', command: script('beta') } as any)
  await clock.advance(1000); await clock.settle()
  expect(data.files[CARD_B]).toContain('- 關卡：無')
  expect(data.launches).toHaveLength(0)
  expect(data.asks).toHaveLength(0)
  // (b) 同一回合跑 spec-ok gamma，可是 Gamma 的關卡被改掉了，腳本失敗（只回 stderr）
  const gammaSpec = data.files[CARD_C]!
  data.files[CARD_C] = gammaSpec.replace(SPEC_GATE, '- 關卡：spec：規格改寫中')
  await $.tool.call({ tool: 'Bash', command: script('gamma') } as any)
  await clock.advance(1000); await clock.settle()
  expect(data.launches).toHaveLength(0)
  // 回合結束、重讀後：這時才跳核准對話框（跟按 g 同一個），核准後派 Beta；Gamma 關卡留著、不派
  await $.turn.complete(turnDone())
  await clock.settle()
  expect(data.asks).toHaveLength(1)
  expect(data.askOptions[0]).toEqual(['核准並派工', '取消'])
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(BETA)
  expect(data.toasts).toContain('Beta：繼續已派出')
  expect(data.files[CARD_C]).toContain('- 關卡：spec：規格改寫中')
  expect(data.toasts.some(t => t.startsWith('Gamma：'))).toBe(false)

  // (b') 關卡早就清成「無」（手改）之後，主對話跑 spec-ok gamma 失敗：不當成剛確認，不派、不出聲
  data.files[CARD_C] = setFields(gammaSpec, { 關卡: '無' })
  await h.refresh()
  const toasts = data.toasts.length
  await $.tool.call({ tool: 'Bash', command: script('gamma') } as any)
  await clock.advance(1000); await clock.settle()
  await $.turn.complete(turnDone('t1b'))
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  expect(data.asks).toHaveLength(1)
  expect(data.toasts.slice(toasts).some(t => t.startsWith('Gamma：'))).toBe(false)

  // (c) subagent 跑的 spec-ok（腳本成功）、手改卡片清掉關卡：只確認，不派、不問
  data.files[CARD_C] = gammaSpec
  await $.tool.call({ tool: 'Bash', command: script('gamma'), agentId: 'sub-1' } as any)
  expect(data.files[CARD_C]).toContain('- 關卡：無')
  await clock.advance(1000); await clock.settle()
  await $.turn.complete(turnDone('t2'))
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  expect(data.asks).toHaveLength(1)
  await ui.press({ key: `row-${CARD_C}` })
  await h.refresh()
  expect(await screen(ui)).toContain(flat('按 g 派 Agent：'))
  await ui.unmount()
})

/** AC-5 (a)：對話確認的，回合結束時不能派就說原因、Agent 已滿就排隊，跟面板按 t 一樣。 */
test('conversation spec ok follows the t rules at turn end: refusal reason and queue', { timeoutMs: 15000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Beta | \`${CARD_B}\` |`
  atSpec(data, clock, [CARD_A, CARD_B])
  // Alpha 的「等你」還有決策；三個工作桌 Agent 在別的專案跑（已滿）
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '匯出要含稅嗎？A) 含 B) 不含' })
  data.agents = [busy('desk-m0-0', '/home/u/other/one'), busy('desk-m0-1', '/home/u/other/two'), busy('desk-m0-2', '/home/u/other/three')]
  conversationBash(on, data)
  const h = helpers($, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))

  // 同一回合確認兩張
  await $.tool.call({ tool: 'Bash', command: script('alpha') } as any)
  await $.tool.call({ tool: 'Bash', command: script('beta') } as any)
  await clock.advance(1000); await clock.settle()
  expect(data.files[CARD_A]).toContain('- 關卡：無')
  expect(data.files[CARD_B]).toContain('- 關卡：無')
  expect(data.toasts.some(t => t.startsWith('Alpha：') || t.startsWith('Beta：'))).toBe(false)
  await $.turn.complete(turnDone())
  await clock.settle()
  expect(data.toasts).toContain('Alpha：規格已確認；沒有自動派實作（卡片「等你」還有要你決定的事）')
  expect(data.toasts).toContain('Beta：同時執行的 Agent 已達上限 3 個，已排隊（第 1 位）')
  expect(data.launches).toHaveLength(0)
  await ui.press({ key: `row-${CARD_B}` })
  expect(await screen(ui)).toContain(flat('派工排隊中（第 1 位）'))
  await ui.unmount()
})

test('afterSpecRefusal blocks open decisions on top of the g rules', () => {
  const ready: any = { name: 'Beta', root: BETA, statusPath: CARD_B, state: 'ready', ask: '無', next: '依規格與實作計畫實作', verify: 'npm test', gate: '無', pipeline: { current: 'build', stages: [], note: '' } }
  expect(afterSpecRefusal(ready)).toBe('')
  expect(afterSpecRefusal({ ...ready, ask: '匯出要含稅嗎？A) 含 B) 不含', state: 'ask' })).toBe('卡片「等你」還有要你決定的事')
  expect(afterSpecRefusal({ ...ready, manual: true })).toBe('登錄表設為 manual，只追蹤不派工')
  expect(afterSpecRefusal({ ...ready, state: 'running' })).toBe('Agent 仍在執行')
  expect(afterSpecRefusal({ ...ready, verify: '' })).toBe('卡片尚缺完成檢查，規格未通過')
})

test('specOkTarget reads the target of card.py spec-ok only', () => {
  const bash = (command: string) => specOkTarget({ tool: 'Bash', command })
  expect(bash('python3 /home/u/.claude/plugins/desk/skills/card/scripts/card.py spec-ok beta')).toBe('beta')
  expect(bash('python3 "/p/card.py" spec-ok "匯出 CSV"')).toBe('匯出 CSV')
  expect(bash("python3 card.py spec-ok 'beta' && echo ok")).toBe('beta')
  expect(bash('python3 card.py spec-init beta')).toBeNull()
  expect(bash('python3 card.py done beta 好了')).toBeNull()
  expect(bash('python3 card.py spec-ok')).toBeNull()
  expect(specOkTarget({ tool: 'Write', file_path: '/x/card.py' })).toBeNull()
})

test('specOkCards takes the card path only from a successful card.py spec-ok', () => {
  const bash = (command: string) => ({ tool: 'Bash', command })
  const ok = `規格已確認（AC-1～AC-5），關卡清為「無」：${CARD_B}\n`
  expect(specOkCards(bash(script('beta')), ok)).toEqual([CARD_B])
  // 一條指令確認兩張
  expect(specOkCards(bash(`${script('beta')} && ${script('gamma')}`), `${ok}規格已確認（AC-1），關卡清為「無」：${CARD_C}\n`)).toEqual([CARD_B, CARD_C])
  // 腳本失敗（只有 stderr）、沒有輸出、指令不是 spec-ok 都不算
  expect(specOkCards(bash(script('gamma')), '')).toEqual([])
  expect(specOkCards(bash(script('gamma')), undefined)).toEqual([])
  expect(specOkCards(bash(`cat ${CARD_B}`), ok)).toEqual([])
  expect(specOkCards(bash('echo "card.py spec-ok beta"'), 'card.py spec-ok beta\n')).toEqual([])
})
