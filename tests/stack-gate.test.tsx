import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, PANE, CARD_A, CARD_B, CARD_C, REGISTRY, result } from './fixture'
import { screen, busyAgent as busy } from './world'
import { flat } from './fixture'
import { setFields } from '../hooks/tutorial'
import { buildCase } from '../hooks/model'
import { finalState, pipeline } from '../hooks/pipeline'
import { buildPrompt, queueRefusal, refusalOf } from '../hooks/dispatch'
import { stageActions } from '../hooks/turn'
import { STACK_NEXT, stackWaitOf } from '../hooks/stack'
import type { Case } from '../types'

// stack-gate：疊在另一張卡分支上的後續卡（卡片有「疊放於」），原卡合併前不派工；合併（或歸檔）後自動派一次實作、先把基準分支併進來。
const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const ME = 'fixture-session'
const SPEC_GATE = 'spec：待確認規格（AC-1～AC-2）'
const SLUG: Record<string, string> = { beta: CARD_B, gamma: CARD_C }
const turnDone = (turnId = 't1') => ({ answer: '', durationMs: 4000, isAborted: false, turnId, reason: 'answer' }) as any
const script = (target: string) => `python3 /home/u/.claude/plugins/desk/skills/card/scripts/card.py spec-ok ${target}`
/** Alpha 在 GitHub 上、PR 已合併（gh pr list 的回答）。 */
const ALPHA_MERGED = [{ number: 7, state: 'MERGED', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/7', headRefOid: 'a1', statusCheckRollup: [] }]

/** 疊在 Alpha（feature/a）上的後續卡：停在 spec 關卡、有完成檢查（已核准）、「等你」無、下一步是實作。 */
const stackedCard = (name: string, gate = SPEC_GATE) =>
  `<!-- DESK -->\n- 狀態：${name} 開卡\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：依規格與實作計畫實作\n- 關卡：${gate}\n- 基準：origin/main\n- 疊放於：feature/a\n<!-- /DESK -->\n\n## History\n\n- 2030-01-05 11:00：開卡\n`

/** Alpha 是原卡（GitHub、還沒有 PR）；Beta、Gamma 疊在它上面。派出去的 Agent 會出現在 claude agents 清單（在跑）。 */
function stacked(data: any, clock: any, cards: string[] = [CARD_B]) {
  const rows = [['Alpha', CARD_A], ['Beta', CARD_B], ['Gamma', CARD_C]].filter(([, card]) => card === CARD_A || cards.includes(card!))
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n${rows.map(([name, card]) => `| ${name} | \`${card}\` |`).join('\n')}`
  data.agents = []
  data.gh = []
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '無', 下一步: '依規格實作' })
  data.files[CARD_B] = stackedCard('Beta')
  data.files[CARD_C] = stackedCard('Gamma')
  data.git[ALPHA] = { branch: 'feature/a', head: 'a1', remote: 'git@github.com:acme/shop.git' }
  data.git[BETA] = { branch: 'feature/a-medium', head: 'a1' }
  data.git[GAMMA] = { branch: 'feature/a-low', head: 'a1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test', [CARD_C]: 'npm test' }
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    data.agents = [...data.agents, { ...busy(e.argv[3], e.init.cwd), id, sessionId: `${id}-0000-4000-8000-000000000000`, startedAt: clock.now() }]
    return result(0, id)
  }
  // card.py spec-ok 的效果（腳本本身在 skills/card/tests 驗）：關卡清掉、狀態寫已確認。
  data.run = async (e: any) => {
    const card = SLUG[String(e.argv.at(-1))]
    if (!e.argv.includes('spec-ok') || !card) return result(0, '')
    data.files[card] = setFields(data.files[card]!, { 關卡: '無', 狀態: '規格已確認（AC-1～AC-2），可派實作' })
    return result(0, `規格已確認（AC-1～AC-2），關卡清為「無」：${card}\n`)
  }
}

/** 主對話跑 card.py spec-ok：照腳本改卡、stdout 印成功那一行。 */
function conversationBash(on: any, data: any) {
  on('tool.call', { tool: 'Bash' }, (_: any, e: any) => {
    const card = SLUG[String(e.command).split(' ').at(-1)!]
    if (!card) return { result: { stdout: '', stderr: '', interrupted: false } }
    data.files[card] = setFields(data.files[card]!, { 關卡: '無', 狀態: '規格已確認（AC-1～AC-2），可派實作' })
    return { result: { stdout: `規格已確認（AC-1～AC-2），關卡清為「無」：${card}\n`, stderr: '', interrupted: false } }
  })
  on('turn.complete', () => ({ text: '' }))
}

function helpers($: any, clock: any) {
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  const pressT = async (ui: any, card: string) => {
    await ui.press({ key: `row-${card}` })
    await ui.press({ key: `case-${card}-spec-ok` }); await clock.settle()
    await ui.press({ key: `case-${card}-spec-ok` }); await clock.settle()
  }
  return { refresh, pressT }
}

/** AC-2 */
test('spec ok does not dispatch a stacked card while its original is unmerged', { timeoutMs: 20000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  const feed = feedLog(on)
  stacked(data, clock, [CARD_B, CARD_C])
  conversationBash(on, data)
  const h = helpers($, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  // 等原卡時照樣能確認規格（D-04），句子不再說「並派實作」
  expect(await screen(ui)).toContain(flat('t 確認規格（原卡「Alpha」合併後才派實作，先按 o 看過規格'))

  // 面板按兩次 t：規格確認了，但不派實作
  await h.pressT(ui, CARD_B)
  expect(data.files[CARD_B]).toContain('- 關卡：無')
  expect(data.launches).toHaveLength(0)
  expect(data.toasts).toContain('Beta：規格已確認；無法自動派實作（等原卡「Alpha」合併）；原卡合併後自動接著做')
  expect(feed.has('Beta 規格已確認；無法自動派實作（等原卡「Alpha」合併）')).toBe(true)
  // 流程紀錄記下「合併後派實作」，擁有者是這個對話
  expect((data.store.chains as any)[BETA]).toMatchObject({ owner: ME, stackDispatch: true })
  await h.refresh()
  expect(await screen(ui)).toContain(flat('等原卡「Alpha」合併（合併後自動派實作）'))

  // 對話執行 spec ok（Gamma）：回合結束後一樣不派，說同一句
  await $.tool.call({ tool: 'Bash', command: script('gamma') } as any)
  await clock.advance(1000); await clock.settle()
  await $.turn.complete(turnDone())
  await clock.settle()
  expect(data.files[CARD_C]).toContain('- 關卡：無')
  expect(data.launches).toHaveLength(0)
  expect(data.toasts).toContain('Gamma：規格已確認；無法自動派實作（等原卡「Alpha」合併）；原卡合併後自動接著做')
  expect((data.store.chains as any)[GAMMA]).toMatchObject({ owner: ME, stackDispatch: true })

  // /desk go 也擋下、附下一步
  const go = await $.command.run({ command: 'desk', args: 'go Beta' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(0)
  expect(data.toasts).toContain(`Beta：無法繼續（等原卡「Alpha」合併）；${STACK_NEXT}`)
  expect(String((go as any)?.text ?? '')).not.toContain('已派出')
  await ui.unmount()
})

const ROOT_A = '/w/order-export'
const ROOT_B = '/w/order-export-medium'
const deskCard = (f: { gate?: string; stacked?: string }) =>
  `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：依規格實作\n- 關卡：${f.gate ?? '無'}\n- 基準：origin/main\n${f.stacked ? `- 疊放於：${f.stacked}\n` : ''}<!-- /DESK -->`

/** 跟工作桌一樣：讀卡 → 疊上 git／PR → 算六段 → 決定狀態；最後照重新整理補 stackWait。 */
function mk(name: string, root: string, branch: string, f: Parameters<typeof deskCard>[0], extra: Partial<Case> = {}): Case {
  const base = { ...buildCase({ name, statusPath: `${root}/.desk/CARD.md` }, deskCard(f), 1, {}, undefined), git: { branch, head: 'h1' }, ...extra }
  const piped = { ...base, pipeline: pipeline(base as Case, undefined) }
  return { ...piped, state: finalState(piped) } as Case
}
const waiting = (b: Case, cases: Case[]): Case => { const w = stackWaitOf(b, cases); return w ? { ...b, stackWait: w } : b }

/** AC-3 */
test('refusalOf refuses a stacked card until the original merges', () => {
  const parent = mk('訂單匯出', ROOT_A, 'feature/order-export', {})
  const raw = mk('訂單匯出：審查 MEDIUM', ROOT_B, 'feature/order-export-medium', { stacked: 'origin/feature/order-export' })
  // 「疊放於」去掉 origin/ 後跟原卡分支比對
  expect(raw.stackedOn).toBe('feature/order-export')
  const b = waiting(raw, [parent, raw])
  expect(b.stackWait).toBe('訂單匯出')
  expect(b.pipeline?.current).toBe('build')
  for (const kind of ['continue', 'review'] as const) expect(refusalOf(b, kind)).toEqual({ why: '等原卡「訂單匯出」合併', next: STACK_NEXT })
  // footer 沒有 g、w（同步照樣能派）
  const actions = stageActions(b)
  expect(actions.has('continue')).toBe(false)
  expect(actions.has('review')).toBe(false)
  expect(refusalOf(b, 'sync')).toBeNull()

  // 原卡合併：不再等，g 派得出去、footer 有 g
  const merged = mk('訂單匯出', ROOT_A, 'feature/order-export', {}, { pr: { id: 7, state: 'MERGED', ci: 'none' } })
  const released = waiting(raw, [merged, raw])
  expect(released.stackWait).toBeUndefined()
  expect(refusalOf(released, 'continue')).toBeNull()
  expect(stageActions(released).has('continue')).toBe(true)
  // 不是疊放卡（沒有「疊放於」）：不看別的卡
  const plain = mk('其他', ROOT_B, 'feature/order-export-medium', {})
  expect(waiting(plain, [parent, plain]).stackWait).toBeUndefined()
})

/** AC-4 */
test('auto chain and queue hold a stacked card until the original merges', { timeoutMs: 20000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  stacked(data, clock, [CARD_B])
  // Beta 有這個對話的流程紀錄：剛結束的審查有 CRITICAL，平常會自動派修正
  data.files[CARD_B] = stackedCard('Beta', 'review：CRITICAL 1、HIGH 0、MEDIUM 0、LOW 0；要修')
  data.store.chains = { [BETA]: { owner: ME, startedAt: clock.now() - 60_000, round: 0, reviewHead: 'a1', reviewBranch: 'feature/a-medium' } }
  data.store.jobs = { [BETA]: { last: { launchName: 'desk-review-1', nativeId: 'r0000001', sessionId: 'r0000001-0000-4000-8000-000000000000', kind: 'review', startedAt: clock.now() - 30_000, fresh: true, owner: ME, ended: { how: 'finished' } } } }
  const h = helpers($, clock)
  await h.refresh()
  await h.refresh()
  // 原卡還沒合併：流程不派任何 Agent
  expect(data.launches).toHaveLength(0)

  // 派工隊伍輪到 Beta：自動排的一律不派，手動排的照手動派工的拒絕
  const b = waiting(mk('Beta', ROOT_B, 'feature/a-medium', { stacked: 'feature/a' }), [mk('Alpha', ROOT_A, 'feature/a', {}), mk('Beta', ROOT_B, 'feature/a-medium', { stacked: 'feature/a' })])
  const run = { owner: ME, startedAt: 0, round: 0 }
  for (const kind of ['continue', 'review', 'catchup', 'publish'] as const) expect(queueRefusal(b, { kind, opts: { auto: true } }, run, ME)).toBe('等原卡「Alpha」合併')
  expect(queueRefusal(b, { kind: 'continue', opts: {} }, run, ME)).toBe(`等原卡「Alpha」合併；${STACK_NEXT}`)

  // 對照：原卡合併後，同一份流程紀錄照常自動派修正（擋下的就是原卡）
  data.gh = ALPHA_MERGED
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(BETA)
  expect(String(data.launches[0].argv.at(-1))).toContain('修正')
})

/** AC-5 */
test('stacked card dispatches its build once after the original merges', { timeoutMs: 20000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  stacked(data, clock, [CARD_B, CARD_C])
  // Gamma 的 Agent 開不起來：記號只試一次，之後重新整理不再重派
  const launch = data.launch
  data.launch = async (e: any) => e.init.cwd === GAMMA ? result(1, '', 'boom') : launch(e)
  const h = helpers($, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await h.pressT(ui, CARD_B)
  await h.pressT(ui, CARD_C)
  expect(data.launches).toHaveLength(0)

  // 原卡的 PR 合併：下一次重新整理自動派兩張的實作
  data.gh = ALPHA_MERGED
  await h.refresh()
  const beta = data.launches.filter((e: any) => e.init.cwd === BETA)
  expect(beta).toHaveLength(1)
  expect(data.launches.filter((e: any) => e.init.cwd === GAMMA)).toHaveLength(1)
  // 實作提示的第一步：把基準分支 merge 進來（不 rebase，已經包含就略過）
  const prompt = String(beta[0].argv.at(-1))
  const lines = prompt.split('\n')
  expect(lines[0]).toBe('依卡片的下一步繼續：依規格與實作計畫實作')
  expect(lines[1]).toContain('第一步：這張卡疊在 feature/a 上，先把基準分支併進來')
  expect(lines[1]).toContain('git merge --no-ff origin/main')
  expect(lines[1]).toContain('不要 rebase')
  expect(lines[1]).toContain('已經包含就略過這步')
  expect(data.toasts).toContain('Beta：繼續已派出')

  // 只派一次：再重新整理兩次，Beta（在跑）與 Gamma（沒派成）都不再派
  await h.refresh()
  await h.refresh()
  expect(data.launches).toHaveLength(2)
  const shown = await screen(ui)
  expect(shown).not.toContain(flat('等原卡「Alpha」合併'))
  await ui.unmount()
})

/** AC-5：D-02 原卡從登錄表消失也算解除 */
test('stacked card is released when the original is archived', { timeoutMs: 20000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  stacked(data, clock, [CARD_B])
  const h = helpers($, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await h.pressT(ui, CARD_B)
  await h.refresh()
  expect(data.launches).toHaveLength(0)
  expect(await screen(ui)).toContain(flat('等原卡「Alpha」合併（合併後自動派實作）'))

  // 原卡歸檔：登錄表拿掉那一列
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(BETA)
  expect(String(data.launches[0].argv.at(-1))).toContain('第一步：這張卡疊在 feature/a 上')
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(await screen(ui)).not.toContain(flat('等原卡'))
  await ui.unmount()
})

/** AC-5：解除後自動派也照額度煞車：額度低於門檻不派，動態與提示寫原因、叫你按 g；記號拿掉，之後重新整理不再試。 */
test('stacked card is not dispatched after release while quota is low', { timeoutMs: 20000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  const feed = feedLog(on)
  stacked(data, clock, [CARD_B])
  const h = helpers($, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await h.pressT(ui, CARD_B)
  data.usage = { ...data.usage, rateLimits: [{ kind: 'five_hour', percentUsed: 80, resetsAt: new Date(clock.now() + 3_600_000).toISOString() }] }
  data.gh = ALPHA_MERGED
  await h.refresh()
  expect(data.launches).toHaveLength(0)
  expect(data.toasts.some(t => t.startsWith('Beta：不用再等原卡，但5 小時額度剩 20%，低於門檻 30%，沒有自動派實作；要派請按 g'))).toBe(true)
  expect(feed.has('Beta 不用再等原卡，但5 小時額度剩 20%')).toBe(true)
  expect((data.store.chains as any)[BETA]?.stackDispatch).toBeUndefined()
  // 額度回來也不再自動派（只試一次）；「輪到你」照一般實作叫你按 g
  data.usage = { ...data.usage, rateLimits: [] }
  await h.refresh()
  expect(data.launches).toHaveLength(0)
  expect(await screen(ui)).toContain(flat('g 派 Agent 做下一步（依規格與實作計畫實作）'))
  await ui.unmount()
})

/** AC-5：最後一次派工剛結束、還沒處理時原卡合併：先照常處理那次（跑測試），不搶先派實作蓋掉它。 */
test('stacked release waits until the last finished job is handled', { timeoutMs: 20000 }, async ($, on) => {
  const { data, clock } = fixture(on)
  stacked(data, clock, [CARD_B])
  const h = helpers($, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await h.pressT(ui, CARD_B)
  // 等原卡期間有一次實作做完、還沒處理（例如記號之前就派出去的）
  data.store.jobs = { [BETA]: { last: { launchName: 'desk-build-1', nativeId: 'c0000001', sessionId: 'c0000001-0000-4000-8000-000000000000', kind: 'continue', startedAt: clock.now() - 30_000, fresh: false, owner: ME, ended: { how: 'finished' } } } }
  const calls = data.processCalls.length
  data.gh = ALPHA_MERGED
  await h.refresh()
  // 先處理那次：自動跑完成檢查，不派實作
  expect(data.launches).toHaveLength(0)
  expect(data.processCalls.slice(calls).some((e: any) => e.init?.cwd === BETA && String(e.argv.join(' ')).includes('npm test'))).toBe(true)
  expect((data.store.chains as any)[BETA]?.stackDispatch).toBe(true)
  await ui.unmount()
})

/** 沒有「疊放於」的卡：實作提示不多第一步。 */
test('build prompt of a card without stacked-on has no merge step', () => {
  const plain = mk('其他', ROOT_B, 'feature/x', {})
  expect(buildPrompt(plain, 'continue')).not.toContain('第一步：這張卡疊在')
})
