import { expect, test } from 'claude-code/testing'
import { fixture, PANE, BAND, CARD_A, CARD_B, REGISTRY, result } from './fixture'
import { pipeline, stageLabel } from '../hooks/pipeline'
import { buildCase } from '../hooks/model'
import { turnOf } from '../hooks/turn'
import type { Case, Verify } from '../types'

const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const ROOT: Record<string, string> = { [CARD_A]: ALPHA, [CARD_B]: BETA }
const NAME: Record<string, string> = { [CARD_A]: 'Alpha', [CARD_B]: 'Beta' }
const GLYPHS = /[●◉◆✕○·]/g

/** 兩件案子 Alpha、Beta：都沒有等你、檢查已授權、各在自己的分支；派出去的 Agent 照 cwd 對回案子。 */
function twoCases(data: any, clock: any) {
  data.files[REGISTRY] = `## 案子\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 驗證：`npm test`', '- 驗證：`node test.mjs`')
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'a1' }
  data.git[BETA] = { branch: 'feature/beta', head: 'b1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'node test.mjs' }
  data.agents = []
  data.gh = []
  let n = 0
  data.launch = async (e: any) => {
    n++
    const id = `c000000${n}`
    const cwd = String(e.init?.cwd ?? '')
    data.agents = [...data.agents.filter((a: any) => a.cwd !== cwd), { id, kind: 'background', cwd, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
}

/** 完成檢查由測試放行：每次 sh 先掛著，resolve 才算跑完；記下同時在跑的最多幾件。 */
function heldChecks(data: any) {
  const pending: { cwd: string; done: (ok: boolean) => void }[] = []
  const stats = { running: 0, max: 0, cwds: [] as string[] }
  data.run = (e: any) => new Promise(resolve => {
    stats.running++
    stats.max = Math.max(stats.max, stats.running)
    stats.cwds.push(String(e.init?.cwd))
    pending.push({ cwd: String(e.init?.cwd), done: ok => { stats.running--; resolve(result(ok ? 0 : 1, ok ? 'all green\n' : 'boom\n')) } })
  })
  const pass = (root: string) => { const i = pending.findIndex(p => p.cwd === root); pending.splice(i, 1)[0]!.done(true) }
  return { stats, pass }
}

const finish = (data: any, root: string) => { data.agents = data.agents.map((a: any) => a.cwd === root ? { ...a, status: 'idle', state: 'done' } : a) }
const setGate = (data: any, card: string, g: string) => { data.files[card] = data.files[card]!.replace(/- 關卡：.*$/m, `- 關卡：${g}`) }
const step = async (clock: any) => { await clock.advance(2500); await clock.settle() }

/** 現在卡上的六段（`規格● 實作● …`）與其他案子表格那一列的六段字形。 */
async function cardStages(ui: any): Promise<string> {
  const t = await ui.find({ type: 'Text', text: /^規格[●◉◆✕○·]/ })
  return String(t?.text ?? '')
}
async function rowGlyphs(ui: any, card: string): Promise<string> {
  const row = String((await ui.find({ key: `row-${card}` }))?.text ?? '')
  const after = row.slice(row.indexOf(NAME[card]!) + NAME[card]!.length)
  return (after.match(GLYPHS) ?? []).join('')
}
/** 把這件放到現在卡：它在其他案子表格裡就按那一列；不在表格裡就是已經在現在卡。 */
async function focus(ui: any, card: string) {
  if (await ui.find({ key: `row-${card}` })) await ui.press({ key: `row-${card}` })
}
/** 一件案子在現在卡與其他案子表格上的六段：先讓它當現在卡，再換另一件，讓它出現在表格。 */
async function bothViews(ui: any, card: string): Promise<{ card: string; row: string }> {
  await focus(ui, card)
  const onCard = await cardStages(ui)
  await focus(ui, card === CARD_A ? CARD_B : CARD_A)
  return { card: onCard, row: await rowGlyphs(ui, card) }
}
const glyphsOf = (stages: string) => (stages.match(GLYPHS) ?? []).join('')

async function goBoth($: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  // 一件派完再派下一件（像你在面板上先後按 g）
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  await $.command.run({ command: 'desk', args: 'go Beta' } as any)
  await clock.settle()
}

/** 兩件的實作在同一輪重新整理裡一起結束。 */
async function finishBoth($: any, data: any, clock: any) {
  finish(data, ALPHA); finish(data, BETA)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
}

/** Beta 卡片停在實作之後、還沒有檢查紀錄：給純函式測試用。 */
function betaCase(over: Partial<Case> = {}): Case {
  const card = `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`node test.mjs\`\n- 等你：無\n- 下一步：實作\n- 關卡：無\n<!-- /DESK -->`
  return { ...buildCase({ name: 'Beta', statusPath: CARD_B }, card, 1, {}, undefined), git: { branch: 'feature/beta', head: 'b1' }, ...over }
}
const passedAt = (head: string): Verify => ({ command: 'node test.mjs', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head })

/** AC-1 */
test('a running review shows the review stage active, not build', async ($, on) => {
  const { data, clock } = fixture(on)
  twoCases(data, clock)
  const { pass } = heldChecks(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  finish(data, ALPHA)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  pass(ALPHA)
  await clock.settle()
  await step(clock)
  expect(data.launches.length).toBe(2)
  expect(String(data.launches[1].argv[data.launches[1].argv.length - 1])).toContain('程式碼審查')

  const ui = await $.ui.mount(PANE(100))
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const alpha = await bothViews(ui, CARD_A)

  expect(alpha.card).toBe('規格● 實作● 檢查● 審查◉ 合併○ 上線○')
  expect(alpha.row).toBe(glyphsOf(alpha.card))
  expect(alpha.card).not.toContain('實作◆')
  // 單看六段推算：審查 Agent 在跑、檢查通過
  const reviewing = betaCase({ agent: { id: 'r1', name: 'desk-r', state: 'working', status: 'busy', kind: 'review' }, chain: { round: 0, lastKind: 'review' } })
  expect(stageLabel(pipeline(reviewing, passedAt('b1')))).toBe('審查・審查中')
  await ui.unmount()
})

/** AC-2 */
test('a running or queued check shows the check stage active', async ($, on) => {
  const { data, clock } = fixture(on)
  twoCases(data, clock)
  const { stats } = heldChecks(data)
  await goBoth($, clock)
  await finishBoth($, data, clock)
  expect(stats.cwds).toEqual([ALPHA])

  const ui = await $.ui.mount(PANE(100))
  const alpha = await bothViews(ui, CARD_A)
  const beta = await bothViews(ui, CARD_B)

  expect(alpha.card).toBe('規格● 實作● 檢查◉ 審查○ 合併○ 上線○')
  expect(alpha.row).toBe(glyphsOf(alpha.card))
  expect(beta.card).toBe('規格● 實作● 檢查◉ 審查○ 合併○ 上線○')
  expect(beta.row).toBe(glyphsOf(beta.card))
  // 註記：在跑的寫測試執行中、排隊的寫排隊中；上一次在同一個 HEAD 通過過也一樣退回檢查段
  expect(stageLabel(pipeline(betaCase(), undefined, true))).toBe('檢查・測試執行中')
  expect(stageLabel(pipeline(betaCase(), undefined, false, true))).toBe('檢查・排隊中')
  expect(stageLabel(pipeline(betaCase(), passedAt('b1'), false, true))).toBe('檢查・排隊中')
  await ui.unmount()
})

/** AC-3 */
test('a running sync keeps the stage it had', async ($, on) => {
  const { data, clock } = fixture(on)
  twoCases(data, clock)
  data.store.verifies = { [CARD_A]: passedAt('a1') }
  const ui = await $.ui.mount(PANE(100))
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const before = await bothViews(ui, CARD_A)

  await $.command.run({ command: 'desk', args: 'sync Alpha' } as any)
  await clock.settle()
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const during = await bothViews(ui, CARD_A)

  expect(data.launches.length).toBe(1)
  expect(before.card).toBe('規格● 實作● 檢查● 審查◆ 合併○ 上線○')
  expect(during.card).toBe(before.card)
  expect(during.row).toBe(glyphsOf(before.card))
  await focus(ui, CARD_A)
  expect(await ui.find({ type: 'Text', text: /Agent 在同步卡片/ })).toBeDefined()
  await ui.unmount()
})

/** AC-4 */
test('two chains finishing together run their checks one at a time', async ($, on) => {
  const { data, clock } = fixture(on)
  twoCases(data, clock)
  const { stats, pass } = heldChecks(data)
  await goBoth($, clock)
  await finishBoth($, data, clock)
  await step(clock)
  const first = [...stats.cwds]

  pass(ALPHA)
  await clock.settle()
  const second = [...stats.cwds]
  pass(BETA)
  await clock.settle()

  expect(first).toEqual([ALPHA])
  expect(second).toEqual([ALPHA, BETA])
  expect(stats.max).toBe(1)
  expect(stats.running).toBe(0)
})

/** AC-5 */
test('between a passing check and the auto review the turn line does not ask you to press w', async ($, on) => {
  const { data, clock } = fixture(on)
  twoCases(data, clock)
  const { pass } = heldChecks(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  finish(data, ALPHA)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(100))
  await focus(ui, CARD_A)

  pass(ALPHA)
  await clock.settle()
  const card = JSON.stringify(await ui.drawn())
  const band = await $.ui.mount(BAND(160))
  const strip = JSON.stringify(await band.drawn())
  await band.unmount()
  const stages = await cardStages(ui)
  const launchedBefore = data.launches.length
  await step(clock)

  expect(launchedBefore).toBe(1)
  expect(stages).toBe('規格● 實作● 檢查● 審查◆ 合併○ 上線○')
  expect(card).toContain('◐ 處理中')
  expect(card).toContain('接著自動審查')
  expect(card).not.toContain('按 w 派審查')
  expect(strip).toContain('接著自動審查')
  expect(strip).not.toContain('按 w 派審查')
  // 接力隨後派出審查
  expect(data.launches.length).toBe(2)
  // 沒有接力在等（手動按 v 通過的）：照舊請你按 w
  expect(turnOf({ ...betaCase(), pipeline: pipeline(betaCase(), passedAt('b1')) }).text).toContain('按 w 派審查')
  await ui.unmount()
})

/** AC-6 */
test('two cases chained together show their own stages at every step', async ($, on) => {
  const { data, clock } = fixture(on)
  twoCases(data, clock)
  const { pass } = heldChecks(data)
  const ui = await $.ui.mount(PANE(100))
  const seen: Record<string, string>[] = []
  const look = async (label: string) => {
    const a = await bothViews(ui, CARD_A)
    const b = await bothViews(ui, CARD_B)
    seen.push({ label, alpha: a.card, alphaRow: a.row, beta: b.card, betaRow: b.row })
  }

  await goBoth($, clock)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await look('實作中')
  await finishBoth($, data, clock)
  await look('Alpha 檢查、Beta 排隊')
  pass(ALPHA)
  await clock.settle()
  await step(clock)
  await look('Alpha 審查、Beta 檢查')
  pass(BETA)
  await clock.settle()
  await step(clock)
  await look('兩件都在審查')
  setGate(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可合併')
  setGate(data, CARD_B, 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；可合併')
  finish(data, ALPHA); finish(data, BETA)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await step(clock)
  await look('兩件都過關')

  const S = (s: string) => `規格● 實作${s}`
  expect(seen).toEqual([
    { label: '實作中', alpha: S('◉ 檢查○ 審查○ 合併○ 上線○'), alphaRow: '●◉○○○○', beta: S('◉ 檢查○ 審查○ 合併○ 上線○'), betaRow: '●◉○○○○' },
    { label: 'Alpha 檢查、Beta 排隊', alpha: S('● 檢查◉ 審查○ 合併○ 上線○'), alphaRow: '●●◉○○○', beta: S('● 檢查◉ 審查○ 合併○ 上線○'), betaRow: '●●◉○○○' },
    { label: 'Alpha 審查、Beta 檢查', alpha: S('● 檢查● 審查◉ 合併○ 上線○'), alphaRow: '●●●◉○○', beta: S('● 檢查◉ 審查○ 合併○ 上線○'), betaRow: '●●◉○○○' },
    { label: '兩件都在審查', alpha: S('● 檢查● 審查◉ 合併○ 上線○'), alphaRow: '●●●◉○○', beta: S('● 檢查● 審查◉ 合併○ 上線○'), betaRow: '●●●◉○○' },
    { label: '兩件都過關', alpha: S('● 檢查● 審查● 合併◆ 上線○'), alphaRow: '●●●●◆○', beta: S('● 檢查● 審查● 合併◆ 上線○'), betaRow: '●●●●◆○' },
  ])
  expect(data.launches.length).toBe(4)
  expect(data.toasts.filter(t => t.includes('審查通過')).length).toBe(2)
  await ui.unmount()
})
