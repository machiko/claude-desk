import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, CARD_C, PROJECT_DIR, REGISTRY, result, text } from './fixture'
import { setFields, tutorialPaths, TUTORIAL_TAG } from '../hooks/tutorial'
import { canArchive } from '../hooks/pipeline'
import { stageActions } from '../hooks/turn'

const BETA = '/home/u/wt/beta'
const KEY = `case-${CARD_B}-archive`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
const PR_MERGED = [{ number: 12, state: 'MERGED', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [] }]
const ARCHIVED = `${PROJECT_DIR}/archive/beta-CARD.md`
const flat = (x: string) => x.replace(/\s+/g, '')
const screen = async (ui: any) => flat(text(await ui.drawn()))
const archiveRuns = (data: any) => data.processCalls.filter((c: any) => c.argv.includes('archive'))

/** 只留 Beta 一件；預設六段全過：已合併、v0.19.0 已打、關卡不是 release。 */
function only(data: any, gate = PASSED, extra: Record<string, unknown> = { tag: 'v0.19.0' }) {
  data.agents = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', gate)
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git', ...extra }
  data.gh = PR_MERGED
}

/** 記下所有外部指令（含 git），驗證沒有刪 worktree 或分支。 */
function recordAll(data: any): any[] {
  const all: any[] = []
  data.exec = (e: any) => { all.push(e); return null }
  return all
}

/** /desk:card archive 是真的腳本（skills/card/tests 驗它）；這裡照它的效果複製卡片、移除登錄表那一列。 */
function scriptOk(data: any) {
  data.run = async (e: any) => {
    if (!e.argv.includes('archive')) return result(0, '')
    data.files[ARCHIVED] = data.files[CARD_B]!
    data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Gamma | \`${CARD_C}\` |\n\n## 已歸檔的卡（worktree 刪除後，卡片留存供查閱）\n\n- beta：2030-01-05 歸檔；卡片在 \`${ARCHIVED}\``
    return result(0, `歸檔完成：${PROJECT_DIR}/archive（登錄表移除 1 列）\nworktree 與分支請自己確認後再刪：\n  git -C /home/u/shop worktree remove ${BETA}\n`)
  }
}

async function mountBeta($: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  // 完成的任務不搶「現在」，點它的列看詳情
  await ui.press({ key: `row-${CARD_B}` })
  return ui
}

test('a done case offers an archive button with no hotkey', async ($, on) => {
  const { data } = fixture(on)
  only(data)
  const ui = await mountBeta($)
  const button = await ui.find({ key: KEY })
  expect(button?.text).toBe('⌫ 歸檔')
  expect(button?.props?.hotkey).toBeUndefined()
  // 下一步列與輪到你仍寫指令
  expect(await screen(ui)).toContain(flat('▶ 輪到你'))
  expect(await screen(ui)).toContain(flat('輸入 /desk:card archive beta 歸檔'))
  expect(await screen(ui)).toContain(flat('已合併，可歸檔：/desk:card archive beta'))
  expect(archiveRuns(data)).toHaveLength(0)
  await ui.unmount()
})

test('pressing archive twice archives the case like /desk:card archive and keeps the worktree', async ($, on) => {
  const { data, clock } = fixture(on)
  only(data)
  // 登錄表還有別的任務（Gamma 閒置）：歸檔後面板照常顯示「最近」
  data.files[REGISTRY] += `\n| Gamma | \`${CARD_C}\` |`
  scriptOk(data)
  const all = recordAll(data)
  const ui = await mountBeta($)
  const before = JSON.stringify(data.files)
  await ui.press({ key: KEY })
  await clock.settle()
  expect((await ui.find({ key: KEY }))?.text).toBe('再按一次確認歸檔')
  expect(JSON.stringify(data.files)).toBe(before)
  expect(archiveRuns(data)).toHaveLength(0)

  await ui.press({ key: KEY })
  await clock.settle()
  // 跑的是 /desk:card archive <slug> 用的那支腳本，在任務的 worktree 裡
  const run = archiveRuns(data)
  expect(run).toHaveLength(1)
  expect(run[0].argv[0]).toBe('python3')
  expect(String(run[0].argv[1]).endsWith('/skills/card/scripts/card.py')).toBe(true)
  expect(run[0].argv.slice(2)).toEqual(['archive', 'beta'])
  expect(run[0].init.cwd).toBe(BETA)
  expect(data.files[ARCHIVED]).toContain('- 關卡：review：CRITICAL 0')
  expect(data.files[REGISTRY]).not.toContain(`\`${CARD_B}\``)
  // 提示列出刪 worktree 的指令，「最近」記一筆成功
  expect(data.toasts.some(t => t.includes('已歸檔') && t.includes(`git -C /home/u/shop worktree remove ${BETA}`))).toBe(true)
  const feed = (await ui.findAll({ type: 'Text' })).find((n: any) => /Beta 已歸檔/.test(n.text) && n.props?.color === 'success')
  expect(feed).toBeDefined()

  // 不手動重新整理：歸檔自己的那輪重新整理就要讓這件消失
  await clock.settle()
  expect(await ui.find({ key: `row-${CARD_B}` })).toBeUndefined()
  expect(await ui.find({ key: KEY })).toBeUndefined()
  expect(await screen(ui)).not.toContain(flat('✓ 完成 v0.19.0'))
  expect(await screen(ui)).not.toContain(flat('輸入 /desk:card archive beta 歸檔'))
  // worktree 與分支仍在：沒有任何刪除的指令
  expect(all.some((e: any) => /worktree remove|branch -[dD]|rm -rf/.test(e.argv.join(' ')))).toBe(false)
  expect(data.files[CARD_B]).toBeDefined()
  expect(data.launches).toHaveLength(0)
  await ui.unmount()
})

test('a failed archive shows the error and keeps the case', async ($, on) => {
  const { data, clock } = fixture(on)
  only(data)
  data.run = async (e: any) => e.argv.includes('archive')
    // card.py 真的會印的格式：原因在第一行，後面接整份登錄表
    ? result(1, '', '找不到唯一的任務「beta」（符合 0 件）。登錄表裡有：\n  Alpha  (/home/u/wt/alpha/.desk/CARD.md)\n  Gamma  (/home/u/wt/gamma/.desk/CARD.md)\n')
    : result(0, '')
  const ui = await mountBeta($)
  const registry = data.files[REGISTRY]
  await ui.press({ key: KEY })
  await ui.press({ key: KEY })
  await clock.settle()
  expect(archiveRuns(data)).toHaveLength(1)
  expect(data.toasts.some(t => t.includes('歸檔失敗') && t.includes('找不到唯一的任務「beta」'))).toBe(true)
  expect(data.toasts.some(t => t.includes('歸檔失敗') && t.includes('Gamma'))).toBe(false)
  const feed = (await ui.findAll({ type: 'Text' })).find((n: any) => /Beta 歸檔失敗/.test(n.text) && n.props?.color === 'error')
  expect(feed).toBeDefined()
  expect(data.files[REGISTRY]).toBe(registry)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(await screen(ui)).toContain(flat('✓ 完成 v0.19.0'))
  expect(await screen(ui)).toContain(flat('輸入 /desk:card archive beta 歸檔'))
  expect((await ui.find({ key: KEY }))?.text).toBe('⌫ 歸檔')
  await ui.unmount()
})

test('no archive button before the case is done or on tutorial and sample cases', async ($, on) => {
  const { data, clock } = fixture(on)
  const noArchive = async (ui: any) => {
    expect(await ui.find({ key: KEY })).toBeUndefined()
    // 展開全部動作也一樣沒有
    await ui.press({ key: 'more' })
    expect((await ui.findAll({ type: 'Button' })).filter((b: any) => /歸檔/.test(b.text ?? ''))).toHaveLength(0)
    await ui.press({ key: 'more' })
  }
  // 已合併但沒打 tag
  only(data, PASSED, {})
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  let ui = await $.ui.mount(PANE(80))
  expect(await screen(ui)).toContain(flat('打 tag 發版'))
  await noArchive(ui)
  await ui.unmount()

  // tag 打了、等按 u 確認上線
  data.files[CARD_B] = data.files[CARD_B]!.replace(PASSED, '- 關卡：release：v0.19.0 待上線確認')
  data.git[BETA] = { ...data.git[BETA]!, tag: 'v0.19.0' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  ui = await $.ui.mount(PANE(80))
  expect(await screen(ui)).toContain(flat('部署 v0.19.0 後按 u 確認上線'))
  await noArchive(ui)
  await ui.unmount()

  // 審查中（還沒合併）
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：release：v0.19.0 待上線確認', '- 關卡：review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；修')
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
  data.gh = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  ui = await $.ui.mount(PANE(80))
  await noArchive(ui)
  await ui.unmount()

  // 示範任務：完成了也不提供
  const demo: any = { demo: true, state: 'done', git: { branch: 'feature/x' }, pipeline: { current: null, stages: [], note: '' } }
  expect(canArchive(demo)).toBe(false)
  expect(stageActions(demo).has('archive')).toBe(false)
  expect(canArchive({ ...demo, demo: false })).toBe(true)
  expect(stageActions({ ...demo, demo: false }).has('archive')).toBe(true)
  expect(stageActions({ ...demo, demo: false }, { tutorial: true }).has('archive')).toBe(false)
  // 發版線本身不算一件要歸檔的任務
  expect(canArchive({ ...demo, demo: false, git: { branch: 'release/v1.4' } })).toBe(false)

  // 教學那件走完六段（已上線確認）：也沒有歸檔按鈕
  const P = tutorialPaths('/home/u')
  data.git[P.wt] = { branch: 'feature/discount', head: 'h0' }
  data.git[P.main] = { branch: 'release/v1.0', head: 'm0' }
  data.run = async () => result(0, '')
  await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  await clock.settle()
  data.files[P.card] = setFields(data.files[P.card]!, { 關卡: '無', 狀態: `${TUTORIAL_TAG} 已上線（工作桌確認）`, 下一步: '可歸檔：/desk:card archive discount' })
  data.git[P.wt] = { ...data.git[P.wt]!, tag: TUTORIAL_TAG }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  ui = await $.ui.mount(PANE(80))
  expect(await screen(ui)).toContain(flat('教學完成！'))
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => /歸檔/.test(b.text ?? ''))).toHaveLength(0)
  await ui.press({ key: 'more' })
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => /歸檔/.test(b.text ?? ''))).toHaveLength(0)
  await ui.unmount()

  expect(archiveRuns(data)).toHaveLength(0)
})

const LAUNCH = 'desk-launch-9'
const SID = 'bbbbbbbb-0000-4000-8000-000000000000'
const TAG = 'v0.29.0'
const LAUNCHED_AT = Date.parse('2030-01-05T11:00:00Z')

/** 最後一次派工（回覆）的 Agent 停在 blocked、沒有回覆過；status 不給代表程序已結束（沒有 pid 也沒有 status）。 */
function leftoverAsk(data: any, status?: string) {
  data.agents = [{ id: 'bbbbbbbb', kind: 'background', cwd: BETA, name: LAUNCH, sessionId: SID, state: 'blocked', ...(status ? { status } : {}), startedAt: LAUNCHED_AT }]
  data.store.jobs = { [BETA]: { sessionId: SID, last: { launchName: LAUNCH, nativeId: 'bbbbbbbb', sessionId: SID, kind: 'reply', startedAt: LAUNCHED_AT, fresh: false } } }
}

/** 卡片標題列右邊的狀態字（「已上線」「等回覆」…）。 */
const labelShown = async (ui: any, word: string) => (await ui.findAll({ type: 'Text' })).some((n: any) => String(n.text ?? '').trim() === word)

/** 已合併（或 tag 已打）的任務：最後一次派工停在提問是合併前留下的，照六段算完成、可歸檔。 */
async function expectArchivable(ui: any) {
  expect(await labelShown(ui, '已上線')).toBe(true)
  expect(await labelShown(ui, '等回覆')).toBe(false)
  const shown = await screen(ui)
  expect(shown).toContain(flat(`✓ 完成 ${TAG}`))
  expect(shown).toContain(flat('▶ 輪到你 輸入 /desk:card archive beta 歸檔'))
  expect(shown).not.toContain(flat('Agent 等待你回覆'))
  expect((await ui.find({ key: KEY }))?.text).toBe('⌫ 歸檔')
  expect(await ui.find({ key: `case-${CARD_B}-reply` })).toBeUndefined()
}

/** exited-agent-asks AC-1：PR 已合併、tag 包含 HEAD，殘留的 blocked Agent（程序已結束）不再讓任務停在「等回覆」。 */
test('a merged case ignores a leftover blocked agent and offers archive', async ($, on) => {
  const { data } = fixture(on)
  only(data, PASSED, { tag: TAG })
  leftoverAsk(data)
  const ui = await mountBeta($)
  await expectArchivable(ui)
  await ui.unmount()
})

/** exited-agent-asks AC-2：沒有 PR 資訊、只靠 tag 認得已合併，Agent 程序還在（idle）也一樣。 */
test('a tagged case without PR info ignores an idle blocked agent', async ($, on) => {
  const { data } = fixture(on)
  only(data, PASSED, { tag: TAG })
  data.gh = []
  leftoverAsk(data, 'idle')
  const ui = await mountBeta($)
  await expectArchivable(ui)
  await ui.unmount()
})

/** exited-agent-asks AC-3：範圍外：還沒合併時，停在 blocked 的 Agent 照舊等你回覆。 */
test('an unmerged case still waits for the reply of a blocked agent', async ($, on) => {
  const { data } = fixture(on)
  only(data, PASSED, {})
  data.gh = [{ ...PR_MERGED[0], state: 'OPEN' }]
  leftoverAsk(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(await labelShown(ui, '等回覆')).toBe(true)
  expect(await screen(ui)).toContain(flat('▶ 輪到你 按 y 回覆 Agent 的提問'))
  expect((await ui.find({ key: `case-${CARD_B}-reply` }))?.text).toBe('↩ 回覆')
  expect(await ui.find({ key: KEY })).toBeUndefined()
  await ui.unmount()
})
