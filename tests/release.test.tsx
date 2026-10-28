import { expect, test } from 'claude-code/testing'
import { fixture, leaves, PANE, CARD_A, CARD_B, CARD_C, REGISTRY } from './fixture'
import { buildCase } from '../hooks/model'
import { canRelease, finalState, pipeline } from '../hooks/pipeline'
import { RELEASE_ASKS } from '../hooks/card'
import { stageActions, turnOf } from '../hooks/turn'
import { caseActions } from '../hooks/pane-card'
import type { Case } from '../types'

const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const KEY = `case-${CARD_B}-release`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
const RELEASE_GATE = '- 關卡：release：待上線'
const GITHUB = 'git@github.com:acme/shop.git'
const LEAD = '按 ⚑ 發版填入對話（Enter 送出）'
const AFTER_ARCHIVE = '打了 tag 之後歸檔'
const AFTER_DEPLOY = '打了 tag 之後部署並按 u 確認上線'
const REQUEST = '發版：已合併待發版 2 件（「Beta」PR #12、「Gamma」PR #13）；照這個專案的發版流程，先提版號給我確認。' + RELEASE_ASKS
const FILLED = '發版請求已填入，按 Esc 回到輸入框再按 Enter 送出'
const pr = (n: number, state = 'MERGED', dest = 'main') => ({ number: n, state, baseRefName: dest, headRepositoryOwner: { login: 'acme' }, url: `https://github.com/acme/shop/pull/${n}`, statusCheckRollup: [] })
/** 帶頭的按鈕：粗體（或已待確認的加框）。 */
const isLead = (b: any) => b?.props?.variant === 'primary' || leaves(b, 'Text').some((t: any) => t.props?.bold)

/**
 * Alpha 還沒合併（等你決定）；Beta PR #12、Gamma PR #13 已合併、都沒打 tag。
 * gh 依 --head 回各自分支的 PR；所有外部指令（含 git）記在回傳的陣列裡。
 */
function setup(data: any, gates: { beta?: string; gamma?: string } = {}, betaPrs: any[] = [pr(12)]) {
  data.agents = []
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', gates.beta ?? PASSED)
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 關卡：無', gates.gamma ?? PASSED)
  data.git[ALPHA] = { branch: 'feature/a', head: 'a1', remote: GITHUB }
  data.git[BETA] = { branch: 'feature/b', head: 'b1', remote: GITHUB }
  data.git[GAMMA] = { branch: 'feature/c', head: 'c1', remote: GITHUB }
  const byBranch: Record<string, any[]> = { 'feature/a': [], 'feature/b': betaPrs, 'feature/c': [pr(13)] }
  const calls: any[] = []
  data.exec = (e: any) => {
    calls.push(e)
    if (e.argv[0] !== 'gh') return null
    const head = e.argv[e.argv.indexOf('--head') + 1]
    return { exitCode: 0, stdout: JSON.stringify(byBranch[head] ?? []), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }
  return calls
}

async function mountBeta($: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  // Beta 不在現在卡時，點它的列看詳情
  if (await ui.find({ key: `row-${CARD_B}` })) await ui.press({ key: `row-${CARD_B}` })
  return ui
}

const texts = async (ui: any, t: string) => (await ui.findAll({ type: 'Text', text: t })).length

test('a merged untagged case leads with the release button', async ($, on) => {
  const { data } = fixture(on)
  setup(data, { gamma: RELEASE_GATE })
  const ui = await mountBeta($)
  // 「▶ 輪到你」和「下一步」列講同一句
  expect(await texts(ui, LEAD)).toBe(2)
  expect(await texts(ui, AFTER_ARCHIVE)).toBe(2)
  const button = await ui.find({ key: KEY })
  expect(button?.text).toBe('⚑ 發版')
  expect(button?.props?.hotkey).toBeUndefined()
  expect(isLead(button)).toBe(true)
  // 動作列上只有它帶頭
  for (const k of ['pr', 'open']) expect(isLead(await ui.find({ key: `case-${CARD_B}-${k}` }))).toBe(false)
  expect(JSON.stringify(await ui.drawn())).not.toContain('打 tag 發版')

  // 對照組：關卡是 release 的那張，做完之後是部署並按 u
  await ui.press({ key: `row-${CARD_C}` })
  expect(await texts(ui, LEAD)).toBe(2)
  expect(await texts(ui, AFTER_DEPLOY)).toBe(2)
  expect(isLead(await ui.find({ key: `case-${CARD_C}-release` }))).toBe(true)
  expect(JSON.stringify(await ui.drawn())).not.toContain('打 tag 發版')
  await ui.unmount()
})

test('pressing release fills the prompt with every case waiting for a tag', async ($, on) => {
  const { data, clock } = fixture(on)
  const calls = setup(data)
  const ui = await mountBeta($)
  await clock.settle()
  const before = calls.length
  const launches = data.launches.length
  await ui.press({ key: KEY })
  await clock.settle()
  expect(data.fills).toEqual([{ text: REQUEST, mode: 'replace' }])
  expect(data.fills[0].text).not.toContain('Alpha')
  expect(data.submitted.length).toBe(0)
  expect(data.toasts.some(t => t.includes(FILLED))).toBe(true)
  expect(data.launches.length).toBe(launches)
  // 按下之後沒有執行任何 git、gh、claude 指令
  expect(calls.slice(before).filter(c => ['git', 'gh', 'claude'].includes(c.argv[0]))).toEqual([])
  await ui.unmount()
})

test('release falls back to a toast when the prompt cannot be filled', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data)
  data.fillable = false
  const ui = await mountBeta($)
  await ui.press({ key: KEY })
  await clock.settle()
  expect(data.toasts.some(t => t.includes(`輸入框無法預填，請直接輸入：${REQUEST}`))).toBe(true)
  expect(data.toasts.some(t => t.includes(FILLED))).toBe(false)
  expect(data.launches.length).toBe(0)
  await ui.unmount()
})

const card = (gate: string) => `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：依規格實作\n- 關卡：${gate}\n<!-- /DESK -->`
/** 跟工作桌一樣：讀卡 → 疊上 git／PR → 算六段 → 決定是否完成。 */
function mk(gate: string, extra: Partial<Case> = {}): Case {
  const base = { ...buildCase({ name: 'A', statusPath: '/w/a/.desk/CARD.md' }, card(gate), 1, {}), git: { branch: 'feature/a', head: 'h2' }, pr: { id: 12, state: 'MERGED' as const, ci: 'none' as const, url: 'https://github.com/acme/shop/pull/12' }, ...extra }
  const piped = { ...base, pipeline: pipeline(base as Case, undefined) }
  return { ...piped, state: finalState(piped) } as Case
}
/** 畫面上才知道的事：showAll 打開（m 展開全部），看守門的是 canRelease 本身。 */
const view = (tutorial: boolean): any => ({ picks: {}, verifying: {}, queue: [], launching: {}, armed: {}, sent: {}, now: 0, tick: 0, showAll: true, logsOpen: null, s: { tutorial, models: {} } })
const noop: any = new Proxy({}, { get: () => () => {} })
const hasRelease = (c: Case, tutorial = false) => caseActions(view(tutorial), c, noop).some(a => /發版/.test(a.label))

test('no release button once tagged, before merge, in the tutorial or on sample cases', async ($, on) => {
  const { data } = fixture(on)
  setup(data)
  const noRelease = async (ui: any, key: string) => {
    expect(await ui.find({ key })).toBeUndefined()
    // 展開全部動作也一樣沒有
    await ui.press({ key: 'more' })
    expect((await ui.findAll({ type: 'Button' })).filter((b: any) => /⚑ 發版/.test(b.text ?? ''))).toHaveLength(0)
    await ui.press({ key: 'more' })
  }
  // 只留一件，避免別張待發版的卡出現在畫面上
  const onlyBeta = () => { data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |` }
  onlyBeta()

  // tag 已打、不是 release 關卡：完成，照舊有歸檔
  data.git[BETA] = { ...data.git[BETA]!, tag: 'v0.19.0' }
  let ui = await mountBeta($)
  expect((await ui.find({ key: `case-${CARD_B}-archive` }))?.text).toBe('⌫ 歸檔')
  await noRelease(ui, KEY)
  await ui.unmount()

  // tag 已打、release 關卡：待確認上線，照舊有上線確認
  data.files[CARD_B] = data.files[CARD_B]!.replace(PASSED, '- 關卡：release：v0.19.0 待上線確認')
  ui = await mountBeta($)
  expect((await ui.find({ key: `case-${CARD_B}-ship` }))?.text).toBe('✓ 上線確認')
  await noRelease(ui, KEY)
  await ui.unmount()

  // 還沒合併（Alpha）
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |`
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  ui = await $.ui.mount(PANE(80))
  await noRelease(ui, `case-${CARD_A}-release`)
  await ui.unmount()

  // 教學模式走到上線段：沒有發版，「輪到你」照舊叫你按 t 打 tag
  const shipping = mk('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  expect(shipping.pipeline?.current).toBe('ship')
  expect(canRelease(shipping)).toBe(true)
  expect(hasRelease(shipping)).toBe(true)
  expect(stageActions(shipping, { tutorial: true }).has('release')).toBe(false)
  expect(hasRelease(shipping, true)).toBe(false)
  expect(turnOf(shipping, { tutorial: true }).text).toMatch(/^按 t 打 /)

  // 示範任務
  const demo = { ...shipping, demo: true }
  expect(canRelease(demo)).toBe(false)
  expect(stageActions(demo).has('release')).toBe(false)
  expect(hasRelease(demo)).toBe(false)
})

/** AC-6（D-03）：發版線（release/* 分支本身）走到上線段、沒打 tag，不是「已合併待發版」的卡：沒有發版鍵、不列進請求，輪到你照舊叫你打 tag。 */
test('a release line gets no release button and is not listed in the request', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |\n| Gamma | \`${CARD_C}\` |`
  data.files[CARD_C] = '<!-- DESK -->\n- 狀態：v1.4 發版線\n- 檢查：`npm test`\n- 等你：無\n- 下一步：打 tag 發版\n- 關卡：無\n<!-- /DESK -->'
  data.git[GAMMA] = { branch: 'release/v1.4', head: 'c1', remote: GITHUB }
  data.store.verifies = { [CARD_C]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c1' } }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))

  // 發版線：輪到你照舊叫你打 tag，沒有發版鍵（展開全部動作也沒有）
  if (await ui.find({ key: `row-${CARD_C}` })) await ui.press({ key: `row-${CARD_C}` })
  expect(JSON.stringify(await ui.drawn())).toContain('打 tag 發版')
  expect(await texts(ui, LEAD)).toBe(0)
  expect(await ui.find({ key: `case-${CARD_C}-release` })).toBeUndefined()
  await ui.press({ key: 'more' })
  expect(await ui.find({ key: `case-${CARD_C}-release` })).toBeUndefined()
  await ui.press({ key: 'more' })

  // Beta 的發版請求只列 Beta
  await ui.press({ key: `row-${CARD_B}` })
  await ui.press({ key: KEY })
  await clock.settle()
  expect(data.fills).toEqual([{ text: '發版：已合併待發版 1 件（「Beta」PR #12）；照這個專案的發版流程，先提版號給我確認。' + RELEASE_ASKS, mode: 'replace' }])
  await ui.unmount()
})

const LINE = 'release/v26.2.7'
const WITH_LINE = `隨 ${LINE} 發版`
const AFTER_LINE_TAG = '發版線打 tag 後歸檔'
const ONLY_GAMMA = '發版：已合併待發版 1 件（「Gamma」PR #13）；照這個專案的發版流程，先提版號給我確認。' + RELEASE_ASKS

/**
 * 合併進發版線的 Beta：上線段說隨那條線發版、待打 tag，下一步與輪到你同一句；沒有發版鍵（展開全部也沒有）、沒有歸檔，
 * 從 Gamma 按發版時請求不列它。
 */
async function shipsWithLine(ui: any, data: any, clock: any) {
  expect(await texts(ui, WITH_LINE)).toBe(2)
  expect(await texts(ui, AFTER_LINE_TAG)).toBe(2)
  expect(await texts(ui, LEAD)).toBe(0)
  expect(await ui.find({ key: KEY })).toBeUndefined()
  expect(await ui.find({ key: `case-${CARD_B}-archive` })).toBeUndefined()
  await ui.press({ key: 'more' })
  expect(await ui.find({ key: KEY })).toBeUndefined()
  expect(await ui.find({ key: `case-${CARD_B}-archive` })).toBeUndefined()
  await ui.press({ key: 'more' })
  await ui.press({ key: `row-${CARD_C}` })
  await ui.press({ key: `case-${CARD_C}-release` })
  await clock.settle()
  expect(data.fills).toEqual([{ text: ONLY_GAMMA, mode: 'replace' }])
}

/** AC-1：PR 合併進 release/v26.2.7、還沒有 tag 包含 HEAD：隨發版線發版，沒有自己的發版鍵。 */
test('a case merged into a release line ships with that line and gets no release button', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, {}, [pr(12, 'MERGED', LINE)])
  const ui = await mountBeta($)
  await shipsWithLine(ui, data, clock)
  await ui.unmount()

  // 上線段備註
  const merged = mk('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過', { pr: { id: 12, state: 'MERGED', ci: 'none', dest: LINE } })
  expect(merged.pipeline?.current).toBe('ship')
  expect(merged.pipeline?.note).toBe(`${WITH_LINE}，待打 tag`)
  expect(turnOf(merged)).toEqual({ who: 'you', text: `${WITH_LINE}；${AFTER_LINE_TAG}` })

  // 關卡是 release 的：做完之後是部署並按 u
  const gated = mk('release：待上線', { pr: { id: 12, state: 'MERGED', ci: 'none', dest: LINE } })
  expect(gated.pipeline?.note).toBe(`${WITH_LINE}，待打 tag`)
  expect(canRelease(gated)).toBe(false)
  expect(turnOf(gated).text).toBe(`${WITH_LINE}；發版線打 tag 後部署並按 u 確認上線`)
  expect(turnOf(gated).key).toBeUndefined()
  expect(stageActions(gated).has('release')).toBe(false)
  // 合併進 main 的照舊有發版鍵
  expect(canRelease(mk('release：待上線'))).toBe(true)
})

/** AC-2：沒有 PR，git 看到審查過的分支已併進 origin/release/v26.2.7：一樣隨發版線發版。 */
test('a case merged into a release line through git alone also ships with that line', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, {}, [])
  data.git[BETA] = { branch: 'feature/b', head: 'g2', remote: GITHUB, releases: `origin/${LINE}`, originHead: 'origin/main', merged: [`origin/${LINE}`], firstParent: 'm2\nm1\n', parents: { m1: 'base0' } }
  const ui = await mountBeta($)
  expect(await ui.find({ type: 'Text', text: new RegExp(`已合併到 ${LINE}（git）`) })).toBeDefined()
  await shipsWithLine(ui, data, clock)
  await ui.unmount()

  // 上線段備註：分支名去掉 origin/
  const merged = mk('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過', { pr: undefined, mergedInto: `origin/${LINE}` })
  expect(merged.pipeline?.current).toBe('ship')
  expect(merged.pipeline?.note).toBe(`${WITH_LINE}，待打 tag`)
  expect(canRelease(merged)).toBe(false)
  expect(turnOf(merged)).toEqual({ who: 'you', text: `${WITH_LINE}；${AFTER_LINE_TAG}` })
})

/** AC-2：PR 還開著（目標 main）、被拒絕或被取代，分支卻用 git 併進 origin/release/v26.2.7：一樣隨發版線發版，不給「⚑ 發版」。 */
test('a case whose PR is not merged but git merged into a release line also ships with that line', async () => {
  for (const state of ['OPEN', 'DECLINED', 'SUPERSEDED'] as const) {
    const c = mk('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過', { pr: { id: 12, state, ci: 'none', url: 'https://github.com/acme/shop/pull/12', dest: 'main' }, mergedInto: `origin/${LINE}` })

    expect(c.pipeline?.current).toBe('ship')
    expect(c.pipeline?.note).toBe(`${WITH_LINE}，待打 tag`)
    expect(canRelease(c)).toBe(false)
    expect(turnOf(c)).toEqual({ who: 'you', text: `${WITH_LINE}；${AFTER_LINE_TAG}` })
  }
})
