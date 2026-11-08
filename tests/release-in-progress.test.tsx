import { expect, test } from 'claude-code/testing'
import SAMPLE from './release-sample.mjs'
import { fixture, PANE, CARD_B, REGISTRY, NOW, pressHotkey } from './fixture'
import { buildCase, events } from '../hooks/model'
import { canRelease, finalState, pipeline, releaseStep } from '../hooks/pipeline'
import { SPIN_MS } from '../hooks/desk-io'
import type { Case, Snapshot } from '../types'

// 發版進行中狀態卡的 AC-1～AC-5、K-2。
const BETA = '/home/u/wt/beta'
const KEY = `case-${CARD_B}-release`
const GITHUB = 'git@github.com:acme/shop.git'
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
const IN_REVIEW = '發版 v0.58.0：進行中（整版審查）'
const AT_TAG = '發版 v0.58.0：進行中（打 tag）'
const BLOCKED = '發版 v0.58.0：整版審查擋下'
const RUNNING_TURN = '發版中，等它跑完（目前在整版審查）'
const STOPPED_TURN = 'z 重新發版（按兩次，上次停在打 tag）'
const RELEASE_TURN = 'z 發版（按兩次，再按 Enter 送出'
const RUNNING_TOAST = '發版中，等它跑完'

/** 只有 Beta：PR #12 已合併、審查過、沒打 tag（走到上線段）；狀態寫 status，卡片 agoMs 前更新。 */
function setup(data: any, status: string, agoMs: number) {
  data.agents = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED).replace('- 狀態：Beta 修正中', `- 狀態：${status}`)
  data.mtimes[CARD_B] = NOW - agoMs
  data.git[BETA] = { branch: 'feature/b', head: 'b1', remote: GITHUB }
  const pr = { number: 12, state: 'MERGED', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [] }
  data.exec = (e: any) => e.argv[0] === 'gh'
    ? { exitCode: 0, stdout: JSON.stringify(e.argv[e.argv.indexOf('--head') + 1] === 'feature/b' ? [pr] : []), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    : null
}

async function mount($: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  return $.ui.mount(PANE(80))
}

const count = async (ui: any, t: string) => (await ui.findAll({ type: 'Text', text: t })).length
/** 現在卡頭一列的狀態徽章（前後各一格的狀態名）。 */
const badge = async (ui: any, name: string) => (await ui.findAll({ type: 'Text', text: ` ${name} ` })).length > 0
/** 處理中那句前面的圖示（跟著 SPIN 轉）。 */
const spinner = async (ui: any) => (await ui.find({ type: 'Text', text: /^\S 處理中\s+$/ }))?.text[0]
const releaseButtons = async (ui: any) => (await ui.findAll({ type: 'Button' })).filter((b: any) => /⚑ 發版/.test(b.text ?? ''))

/** AC-1：發版進行中、卡片 3 分鐘前更新：處理中（圖示轉動），輪到你寫發版中，動作列與 m 展開都沒有發版。 */
test('release in progress shows running and hides release key', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, IN_REVIEW, 3 * 60_000)
  const ui = await mount($)
  // 「▶ 輪到你」和「下一步」列講同一句
  expect(await count(ui, RUNNING_TURN)).toBe(2)
  expect(await count(ui, RELEASE_TURN)).toBe(0)
  expect(await badge(ui, '處理中')).toBe(true)
  expect(await badge(ui, '待辦')).toBe(false)
  const glyph = await spinner(ui)
  expect(glyph).toBeDefined()
  await clock.advance(SPIN_MS); await clock.settle()
  await clock.advance(SPIN_MS); await clock.settle()
  expect(await spinner(ui)).not.toBe(glyph)
  expect(await ui.find({ key: KEY })).toBeUndefined()
  await ui.press({ key: 'more' })
  expect(await releaseButtons(ui)).toHaveLength(0)
  await ui.press({ key: 'more' })
  await ui.unmount()
})

/**
 * AC-2：發版中按 z 不填發版請求、輸入框不變。發版中 z 不在畫面上（AC-1），按了沒有反應；
 * 第一次按時面板還沒看到發版開始、第二次按之前對話已把卡片改成進行中：重讀卡片，跳「發版中，等它跑完」，不填。
 */
test('pressing z while release in progress does not fill prompt', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, IN_REVIEW, 3 * 60_000)
  data.draft = '還沒送出的字'
  let ui = await mount($)
  await expect(pressHotkey(ui, 'z')).rejects.toThrow('綁在 0 顆按鈕上')
  await clock.settle()
  expect(data.fills).toEqual([])
  expect(data.draft).toBe('還沒送出的字')
  await ui.unmount()

  data.draft = ''
  data.files[CARD_B] = data.files[CARD_B]!.replace(IN_REVIEW, 'Beta 已合併')
  ui = await mount($)
  expect((await pressHotkey(ui, 'z')).key).toBe(KEY)
  await clock.settle()
  // 對話開始發版、寫了卡片；面板還沒重新整理
  data.files[CARD_B] = data.files[CARD_B]!.replace('Beta 已合併', IN_REVIEW)
  data.mtimes[CARD_B] = NOW
  await pressHotkey(ui, 'z')
  await clock.settle()
  expect(data.toasts).toContain(RUNNING_TOAST)
  expect(data.fills).toEqual([])
  expect(data.draft).toBe('')
  await ui.unmount()
})

/** AC-3：進行中但卡片 11 分鐘沒更新：當成停了，回到待辦、說停在哪步，發版鍵回來。 */
test('stale release in progress restores release key after 10 minutes', async ($, on) => {
  const { data } = fixture(on)
  setup(data, AT_TAG, 11 * 60_000)
  const ui = await mount($)
  expect(await count(ui, STOPPED_TURN)).toBe(2)
  expect(await badge(ui, '待辦')).toBe(true)
  expect(await badge(ui, '處理中')).toBe(false)
  expect((await ui.find({ key: KEY }))?.text).toBe('⚑ 發版')
  await ui.unmount()
})

/** AC-4：發版狀態不是「進行中」（例如整版審查擋下）：照原本的判斷，發版鍵照 canRelease 出現。 */
test('release status other than in progress keeps existing behavior', async ($, on) => {
  const { data } = fixture(on)
  setup(data, BLOCKED, 3 * 60_000)
  let ui = await mount($)
  expect(await count(ui, RELEASE_TURN)).toBe(2)
  expect(await badge(ui, '待辦')).toBe(true)
  expect((await ui.find({ key: KEY }))?.text).toBe('⚑ 發版')
  await ui.unmount()

  // 擋下的題目寫在等你：照等你判斷（等你、按選項字母），不算處理中
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 等你：無', '- 等你：整版審查 CRITICAL 0、HIGH 2：A) 開修正卡再發 B) 照發 C) 先不發')
  ui = await mount($)
  expect(await badge(ui, '等你')).toBe(true)
  expect(await count(ui, 'f 填入決策（先按選項字母，填入後按 Enter 送出）')).toBeGreaterThan(0)
  expect(await count(ui, RUNNING_TURN)).toBe(0)
  await ui.unmount()
})

const card = (status: string) => `<!-- DESK -->\n- 狀態：${status}\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：無\n- 關卡：${PASSED.slice('- 關卡：'.length)}\n<!-- /DESK -->`
/** 跟工作桌一樣：讀卡（帶 now）→ 疊上 git／PR → 算六段 → 決定狀態。 */
function mk(status: string, extra: Partial<Case> = {}, agoMs = 60_000): Case {
  const base = { ...buildCase({ name: 'Beta', statusPath: CARD_B }, card(status), NOW - agoMs, {}, undefined, NOW), git: { branch: 'feature/b', head: 'b1' }, pr: { id: 12, state: 'MERGED' as const, ci: 'none' as const }, ...extra }
  const piped = { ...base, pipeline: pipeline(base as Case, undefined) }
  return { ...piped, state: finalState(piped) } as Case
}
const snap = (c: Case, at = NOW): Snapshot => ({ at, cases: [c], error: null, contextPercent: null })

/** AC-5：發版開始寫「開始發版」，結束（狀態改寫、打了 tag）寫「發版步驟結束」，不寫開始執行、Agent 已完成或已停止（停字樣卡 AC-5）。 */
test('feed says release started and ended instead of agent', () => {
  const merged = mk('Beta 已合併')
  const running = mk(IN_REVIEW)
  expect(running.state).toBe('running')
  expect(canRelease(running)).toBe(false)
  const started = events(snap(merged), snap(running)).map(e => e.text)
  expect(started).toEqual(['Beta 開始發版'])

  const done = mk('發版 v0.58.0：完成', { tag: 'v0.58.0' })
  const ended = events(snap(running), snap(done)).map(e => e.text)
  expect(ended).toEqual(['Beta 發版步驟結束'])
  expect(ended.join()).not.toContain('Agent 已完成')
  expect(ended.join()).not.toContain('Agent 已停止')
})

/**
 * K-2：面板認得的「進行中」格式跟 skills/release/SKILL.md 的範本是同一串字。
 * 測試環境不能讀 .md：範本與照樣本填好的狀態放在 release-sample.mjs，SKILL.md 含這個範本由
 * skills/card/tests/test_release_skill.py 的 test_release_in_progress_pattern_matches_release_skill 斷言。
 */
test('release in progress pattern matches release skill', () => {
  const sample = SAMPLE.inProgress
  const filled = Object.entries(sample.fill as Record<string, string>).reduce((t, [slot, value]) => t.split(slot).join(value), sample.template as string)
  expect(filled).toBe(sample.status)
  expect(releaseStep(sample.status)).toBe(sample.fill['<步驟>'])
  expect(mk(sample.status).releasing).toBe(sample.fill['<步驟>'])
})
