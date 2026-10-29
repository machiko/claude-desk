import { expect, test } from 'claude-code/testing'
import { fixture, leaves, text, PANE, CARD_B, NOW, REGISTRY, flat } from './fixture'
import { releasePrompt } from '../hooks/card'
import { buildCase } from '../hooks/model'
import { finalState, pipeline } from '../hooks/pipeline'
import { caseActions } from '../hooks/pane-card'
import type { Case } from '../types'

const BETA = '/home/u/wt/beta'
const PREFIX = `case-${CARD_B}-`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
const GITHUB = 'git@github.com:acme/shop.git'
const MERGED_PR = { number: 12, state: 'MERGED', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [] }
/** Agent 紀錄：跑完、閒著的那個（面板照樣認得它，能看輸出）。 */
const IDLE_AGENT = { id: 'cccccccc', kind: 'background', cwd: BETA, state: 'done', status: 'idle', name: 'desk-beta-0', sessionId: 'cccccccc-0000-4000-8000-000000000000', startedAt: NOW - 3_600_000 }
const PASS = { command: 'npm test', at: NOW - 60_000, ok: true, exitCode: 0, tail: ['all green'], truncated: false, head: 'b1' }

/** 帶頭的按鈕：粗體（或已待確認的加框）。 */
const isLead = (b: any) => b?.props?.variant === 'primary' || leaves(b, 'Text').some((t: any) => t.props?.bold)
const screen = async (ui: any) => flat(text(await ui.drawn()))
/** 畫面上這件任務的按鈕（不含決策選項）。 */
const caseKeys = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key ?? '')).filter((k: string) => k.startsWith(PREFIX) && !k.startsWith(`${PREFIX}opt`)).map((k: string) => k.slice(PREFIX.length)).sort()

/** 只留 Beta 一件，沒有 Agent 在跑。 */
function onlyBeta(data: any) {
  data.agents = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
}

/** Beta 已合併（PR #12）、審查過關、檢查通過、有審查檔與一筆跑完的 Agent 紀錄；tag 與關卡由呼叫端給。 */
function mergedBeta(data: any, opts: { tag?: string; gate?: string; next?: string; ask?: string } = {}) {
  onlyBeta(data)
  data.agents = [IDLE_AGENT]
  data.gh = [MERGED_PR]
  let card = data.files[CARD_B]!.replace(/- 關卡：.*$/m, opts.gate ?? PASSED)
  if (opts.next) card = card.replace(/- 下一步：.*$/m, `- 下一步：${opts.next}`)
  if (opts.ask) card = card.replace(/- 等你：.*$/m, `- 等你：${opts.ask}`)
  data.files[CARD_B] = card
  data.files[`${BETA}/.task/REVIEW.md`] = '- [HIGH][稽核] hooks/a.ts:1 — 舊的發現\n'
  data.git[BETA] = { branch: 'feature/b', head: 'b1', remote: GITHUB, ...(opts.tag ? { tag: opts.tag } : {}) }
  data.store.verifies = { [CARD_B]: PASS }
}

/**
 * 合併之後沒有在跑的 Agent 不會掛在任務上（畫面上看不到它的輸出鍵），「有 Agent 紀錄」直接用 Case 驗：
 * 跟工作桌一樣讀卡 → 疊上 git／PR／Agent → 算六段 → 決定狀態，再看 footer 列出哪些動作。
 */
function mergedCase(opts: { tag?: string; gate?: string; next?: string } = {}): Case {
  const card = `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：${opts.next ?? '依審核修正'}\n${opts.gate ?? PASSED}\n<!-- /DESK -->`
  const base = { ...buildCase({ name: 'Beta', statusPath: CARD_B }, card, 1, {}, undefined), git: { branch: 'feature/b', head: 'b1' }, pr: { id: 12, state: 'MERGED' as const, ci: 'none' as const, url: MERGED_PR.url }, reviewTop: ['HIGH 稽核 hooks/a.ts:1 — 舊的發現'], agent: { id: 'cccccccc', name: 'desk-beta-0', state: 'done', status: 'idle' }, ...(opts.tag ? { tag: opts.tag } : {}) } as Case
  const piped = { ...base, pipeline: pipeline(base, undefined) }
  return { ...piped, state: finalState(piped) } as Case
}
const footer = (c: Case, showAll: boolean) => {
  const view = { s: { tutorial: false, cases: [c] }, picks: {}, verifying: {}, queue: [], launching: {}, armed: null, now: NOW, logsOpen: null, sent: {}, showAll } as any
  return caseActions(view, c, new Proxy({}, { get: () => () => {} }) as any).map(a => a.key.slice(PREFIX.length)).sort()
}

async function mount($: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(100))
  // Beta 不在現在卡時，點它的列看詳情
  if (await ui.find({ key: `row-${CARD_B}` })) await ui.press({ key: `row-${CARD_B}` })
  return ui
}

/** AC-1 */
test('test_sync_hidden_unless_card_is_behind', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data)
  // 實作中、卡片比分支最近一次變更新：沒有落後
  data.git[BETA] = { branch: 'feature/b', head: 'h2', commitAt: NOW - 2 * 3_600_000 }
  const ui = await mount($, clock)
  expect(await screen(ui)).not.toContain(flat('按 s 同步'))
  expect(await caseKeys(ui)).not.toContain('sync')
  expect(await caseKeys(ui)).toContain('continue')
  // 按 m 展開才出現；按 s 照舊派同步（兩次確認）
  await ui.press({ key: 'more' })
  expect((await ui.find({ key: `${PREFIX}sync` }))?.props?.hotkey).toBe('s')
  await ui.press({ key: `${PREFIX}sync` })
  await ui.press({ key: `${PREFIX}sync` })
  await clock.settle()
  expect(data.launches.length).toBe(1)
  expect(String(data.launches[0].argv[data.launches[0].argv.length - 1])).toContain('同步卡片')
  await ui.unmount()
})

/** AC-2 */
test('test_sync_leads_when_card_is_behind', async ($, on) => {
  const { data, clock } = fixture(on)
  onlyBeta(data)
  // 卡片沒有下一步（這一段沒有該按的鍵）、分支有比卡片新的 commit
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 下一步：.*$/m, '- 下一步：無')
  data.mtimes[CARD_B] = NOW - 2 * 3_600_000
  data.git[BETA] = { branch: 'feature/b', head: 'h2', commitAt: NOW - 10 * 60_000 }
  let ui = await mount($, clock)
  // 卡片列：「分支最近一次變更（…）比卡片新：按 s 同步」（窄的時候尾巴截斷）
  expect(await screen(ui)).toContain(flat('分支最近一次變更（10 分鐘前）比卡片'))
  let sync = await ui.find({ key: `${PREFIX}sync` })
  expect(sync).toBeDefined()
  expect(isLead(sync)).toBe(true)
  await ui.unmount()

  // 同一件、這一段另有該按的鍵（g 派 Agent）：同步照樣列出、不變淡，但不帶頭
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 下一步：.*$/m, '- 下一步：依審核修正')
  data.mtimes[CARD_B] = NOW - 2 * 3_600_000
  ui = await mount($, clock)
  sync = await ui.find({ key: `${PREFIX}sync` })
  expect(sync).toBeDefined()
  expect(!!sync?.props?.dimColor).toBe(false)
  expect(isLead(sync)).toBe(false)
  expect(isLead(await ui.find({ key: `${PREFIX}continue` }))).toBe(true)
  await ui.unmount()
})

/** AC-3 */
test('test_archive_stage_lists_only_archive', async ($, on) => {
  const { data, clock } = fixture(on)
  mergedBeta(data, { tag: 'v0.19.0', next: '可歸檔' })
  const ui = await mount($, clock)
  // 現在卡：檢查列只剩一行「檢查 ✓ 通過」，不列指令
  const drawn = await screen(ui)
  expect(drawn).toContain(flat('檢查      ✓ 通過'))
  expect(drawn).not.toContain('npmtest')
  expect(drawn).not.toContain('allgreen')
  // footer：這件只有歸檔；全域鍵照舊
  expect(await caseKeys(ui)).toEqual(['archive'])
  expect((await ui.find({ key: `${PREFIX}archive` }))?.text).toBe('⌫ 歸檔')
  for (const k of ['more', 'expand', 'help']) expect(await ui.find({ key: k })).toBeDefined()
  expect(drawn).not.toContain(flat('≡ 輸出'))
  expect(drawn).not.toContain(flat('↗ 審查檔'))
  expect(drawn).not.toContain(flat('↗ PR'))
  expect(drawn).not.toContain(flat('↗ 開啟'))
  // 按 m 才列出
  await ui.press({ key: 'more' })
  const all = await caseKeys(ui)
  for (const k of ['archive', 'review-file', 'pr', 'open']) expect(all).toContain(k)
  await ui.unmount()

  // 帶 Agent 紀錄的同一件：輸出一樣收進 m
  const c = mergedCase({ tag: 'v0.19.0', next: '可歸檔' })
  expect(c.state).toBe('done')
  expect(footer(c, false)).toEqual(['archive'])
  for (const k of ['archive', 'logs', 'review-file', 'pr', 'open']) expect(footer(c, true)).toContain(k)
})

/** AC-4 */
test('test_ship_stage_lists_release_then_ship', async ($, on) => {
  const { data, clock } = fixture(on)
  // 已合併、還沒打 tag：帶頭是發版，只另列開啟
  mergedBeta(data)
  let ui = await mount($, clock)
  expect(await caseKeys(ui)).toEqual(['open', 'release'])
  expect(isLead(await ui.find({ key: `${PREFIX}release` }))).toBe(true)
  expect(isLead(await ui.find({ key: `${PREFIX}open` }))).toBe(false)
  // PR、審查檔、輸出收進 m
  await ui.press({ key: 'more' })
  for (const k of ['pr', 'review-file']) expect(await caseKeys(ui)).toContain(k)
  await ui.press({ key: 'more' })
  await ui.unmount()
  // 帶 Agent 紀錄的同一件：輸出一樣收進 m
  const untagged = mergedCase()
  expect(footer(untagged, false)).toEqual(['open', 'release'])
  for (const k of ['pr', 'review-file', 'logs']) expect(footer(untagged, true)).toContain(k)

  // 打了 tag、有 release 關卡：帶頭換成上線確認
  mergedBeta(data, { tag: 'v0.19.0', gate: '- 關卡：release：v0.19.0 待上線確認' })
  ui = await mount($, clock)
  expect(await caseKeys(ui)).toEqual(['open', 'ship'])
  const ship = await ui.find({ key: `${PREFIX}ship` })
  expect(ship?.text).toBe('✓ 上線確認')
  expect(isLead(ship)).toBe(true)
  expect(await ui.find({ key: `${PREFIX}release` })).toBeUndefined()
  await ui.unmount()
  expect(footer(mergedCase({ tag: 'v0.19.0', gate: '- 關卡：release：v0.19.0 待上線確認' }), false)).toEqual(['open', 'ship'])
})

/** AC-5：發版請求要求對話把確認點寫進卡片「等你」、狀態寫進度、收到決策才做下一步、做完清掉等你。 */
test('test_release_prompt_asks_confirmations_through_card', async ($, on) => {
  const { data, clock } = fixture(on)
  mergedBeta(data)
  const ui = await mount($, clock)
  await ui.press({ key: `${PREFIX}release` })
  await clock.settle()
  expect(data.fills).toHaveLength(1)
  const asked = data.fills[0].text as string
  expect(asked).toBe(releasePrompt([{ name: 'Beta', root: BETA, git: { branch: 'feature/b' } as any, gate: PASSED.replace('- 關卡：', ''), pr: { id: 12, state: 'MERGED', ci: 'none' } as any }]))
  expect(asked).toStartWith('發版：已合併待發版 1 件（「Beta」PR #12）；照這個專案的發版流程，先提版號給我確認')
  for (const part of ['版號', '打 tag 並 push', '「等你」', 'A) … B) …', '「狀態」寫做到哪一步', '收到我的決策才做下一步', '做完把「等你」清成無']) expect(asked).toContain(part)
  expect(data.submitted).toHaveLength(0)
  await ui.unmount()
})

/** AC-5：對話把版號寫進已合併那張卡的「等你」：面板出現選項，按字母＋f 送出「「任務名」決策：…」。 */
test('test_release_decision_on_merged_card_is_answerable_from_pane', async ($, on) => {
  const { data, clock } = fixture(on)
  mergedBeta(data, { ask: '版號：A) v0.32.0 B) v1.0.0' })
  const ui = await mount($, clock)
  const drawn = await screen(ui)
  expect(drawn).toContain(flat('v0.32.0'))
  expect(drawn).toContain(flat('v1.0.0'))
  // 字母是選項的快捷鍵
  const optA = await ui.find({ key: `${PREFIX}opt0A` })
  expect(optA?.props?.hotkey).toBe('a')
  await ui.press({ key: `${PREFIX}opt0A` })
  const fill = await ui.find({ key: `${PREFIX}fill` })
  expect(fill?.props?.hotkey).toBe('f')
  await ui.press({ key: `${PREFIX}fill` })
  await clock.settle()
  expect(data.fills).toEqual([{ text: '「Beta」決策：A', mode: 'replace' }])
  await ui.unmount()
})
