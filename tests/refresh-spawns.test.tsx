import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, NOW, REGISTRY, flat, text } from './fixture'
import { setFields } from '../hooks/tutorial'

// 減少每次重新整理的子行程（refresh-spawns 卡）：git 的 ref 沒變就不重問 tag 與遠端領先落後、同一個 Agent 的 log 只讀一次、
// CI 跑中的 PR 每 60 秒查一次。
const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
/** 三個 worktree 共用的 git common dir（主 repo 的 .git）。 */
const COMMON = '/home/u/shop/.git'
const TAGS = `${COMMON}/refs/tags`
const PACKED = `${COMMON}/packed-refs`
const remoteRef = (branch: string) => `${COMMON}/refs/remotes/origin/${branch}`
const BRANCHES: Record<string, string> = { [ALPHA]: 'feature/a', [BETA]: 'feature/b', [GAMMA]: 'feature/c' }
const ROWS: [string, string][] = [[ALPHA, CARD_A], [BETA, CARD_B], [GAMMA, CARD_C]]

async function refresh($: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
}

/** 三張功能分支卡：沒有 tag、沒設追蹤分支，origin 上有同名分支（領先 2）；ref 檔的修改時間讀得到。沒有 Agent 在跑。 */
function featureCards(data: any) {
  data.agents = []
  for (const [root] of ROWS) {
    data.git[root] = { branch: BRANCHES[root]!, head: `${root.slice(-1)}1`, upstream: false, remoteAb: '0\t2', remote: 'git@gitlab.com:acme/shop.git' }
    data.repos[root] = COMMON
    data.mtimes[remoteRef(BRANCHES[root]!)] = NOW - 60_000
  }
  data.mtimes[TAGS] = NOW - 3_600_000
  data.mtimes[PACKED] = NOW - 86_400_000
}

/** 從某個位置之後（到 to 之前），對這個根目錄跑過的 git 指令（以空白接起來）。 */
const gitSince = (data: any, from: number, root: string, to?: number) => data.gitCalls.slice(from, to).filter((g: any) => g.root === root).map((g: any) => g.args.join(' ')) as string[]
const tagQueries = (calls: string[]) => calls.filter(a => a.startsWith('tag --contains'))
const aheadQueries = (calls: string[]) => calls.filter(a => a.startsWith('rev-list --left-right --count'))

/** 每張卡的畫面（逐一選取那張卡再讀）。 */
async function screens(ui: any): Promise<string[]> {
  const out: string[] = []
  for (const [, card] of ROWS) {
    await ui.press({ key: `row-${card}` })
    out.push(flat(text(await ui.drawn())))
  }
  return out
}

/** AC-1 */
test('test_second_refresh_skips_tag_and_ahead_queries_when_refs_unchanged', async ($, on) => {
  const { data, clock } = fixture(on)
  featureCards(data)
  const ui = await $.ui.mount(PANE(100))

  await refresh($, clock)
  const first = await screens(ui)
  const mark = data.gitCalls.length
  await refresh($, clock)
  const second = await screens(ui)
  await ui.unmount()

  for (const [root] of ROWS) {
    // 第一次有問過（測試前提），第二次 tag 與遠端分支都沒變就不再問
    expect(tagQueries(gitSince(data, 0, root)).length, root).toBe(1)
    expect(aheadQueries(gitSince(data, 0, root)).length, root).toBe(1)
    expect(tagQueries(gitSince(data, mark, root)), root).toEqual([])
    expect(aheadQueries(gitSince(data, mark, root)), root).toEqual([])
  }
  expect(first[0]).toContain(flat('feature/a · 領先 2'))
  expect(second).toEqual(first)
})

/** AC-1：repo 沒有 packed-refs（git init 起家、沒 gc 過）也一樣不重問；之後建立了 packed-refs 才重問。 */
test('test_second_refresh_skips_queries_when_repo_has_no_packed_refs', async ($, on) => {
  const { data, clock } = fixture(on)
  featureCards(data)
  delete data.mtimes[PACKED]
  const ui = await $.ui.mount(PANE(100))

  await refresh($, clock)
  const first = await screens(ui)
  const mark = data.gitCalls.length
  await refresh($, clock)
  const second = await screens(ui)
  // git gc／pack-refs 建立了 packed-refs：ref 可能搬進去了，重問一次
  data.mtimes[PACKED] = NOW - 1000
  const packedAt = data.gitCalls.length
  await refresh($, clock)
  await ui.unmount()

  for (const [root] of ROWS) {
    expect(tagQueries(gitSince(data, 0, root)).length, root).toBeGreaterThan(0)
    expect(aheadQueries(gitSince(data, 0, root)).length, root).toBeGreaterThan(0)
    expect(tagQueries(gitSince(data, mark, root, packedAt)), root).toEqual([])
    expect(aheadQueries(gitSince(data, mark, root, packedAt)), root).toEqual([])
    expect(tagQueries(gitSince(data, packedAt, root)).length, root).toBe(1)
    expect(aheadQueries(gitSince(data, packedAt, root)).length, root).toBe(1)
  }
  expect(first[0]).toContain(flat('feature/a · 領先 2'))
  expect(second).toEqual(first)
})

/** AC-2 */
test('test_new_tag_shows_on_next_refresh_after_miss', async ($, on) => {
  const { data, clock } = fixture(on)
  featureCards(data)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |`
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '無', 關卡: 'release：待上線' })
  const ui = await $.ui.mount(PANE(100))

  await refresh($, clock)
  const before = flat(text(await ui.drawn()))
  // 打了一個包含 Alpha HEAD 的 tag：refs/tags 多一個檔，資料夾時間變了
  data.git[ALPHA]!.tag = 'v1.5.0'
  data.mtimes[TAGS] = NOW - 1000
  const mark = data.gitCalls.length
  await refresh($, clock)
  const after = flat(text(await ui.drawn()))
  await ui.unmount()

  expect(before).not.toContain('v1.5.0')
  expect(tagQueries(gitSince(data, mark, ALPHA)).length).toBe(1)
  expect(after).toContain(flat('部署 v1.5.0 後按'))
})

/** AC-3 */
test('test_ahead_behind_updates_after_remote_branch_moves', async ($, on) => {
  const { data, clock } = fixture(on)
  featureCards(data)
  const ui = await $.ui.mount(PANE(100))

  await refresh($, clock)
  const before = (await screens(ui))[0]
  // Alpha 推了 origin：遠端分支跟上 HEAD（HEAD 不變），ref 檔換新
  data.git[ALPHA]!.remoteAb = '0\t0'
  data.mtimes[remoteRef('feature/a')] = NOW - 1000
  const mark = data.gitCalls.length
  await refresh($, clock)
  const after = (await screens(ui))[0]
  await ui.unmount()

  expect(before).toContain(flat('feature/a · 領先 2'))
  expect(aheadQueries(gitSince(data, mark, ALPHA)).length).toBe(1)
  expect(after).toContain(flat('feature/a · 與遠端一致、無未提交變更'))
  // 沒動的卡照樣沿用
  expect(aheadQueries(gitSince(data, mark, BETA))).toEqual([])
})

/** K-1 */
test('test_falls_back_to_git_when_ref_times_unreadable', async ($, on) => {
  const { data, clock } = fixture(on)
  featureCards(data)
  // Alpha：stat 失敗（讀不到 refs/tags、packed-refs 與遠端分支的時間）；Beta：不是一般的 git 資料夾（問不到 common dir）
  delete data.mtimes[TAGS]
  delete data.mtimes[PACKED]
  delete data.mtimes[remoteRef('feature/a')]
  delete data.repos[BETA]
  const ui = await $.ui.mount(PANE(100))

  await refresh($, clock)
  const first = await screens(ui)
  const mark = data.gitCalls.length
  await refresh($, clock)
  const second = await screens(ui)
  await ui.unmount()

  for (const root of [ALPHA, BETA]) {
    expect(tagQueries(gitSince(data, mark, root)).length, root).toBe(1)
    expect(aheadQueries(gitSince(data, mark, root)).length, root).toBe(1)
  }
  expect(first[1]).toContain(flat('feature/b · 領先 2'))
  expect(second).toEqual(first)
})

/** AC-4 */
test('test_one_refresh_reads_agent_logs_once', async ($, on) => {
  const { data, clock } = fixture(on)
  data.logs.bbbbbbbb = '● 讀卡片\n● 跑測試中\n'
  const logCalls: string[] = []
  // exec 先看到每個子行程；回 null 交給 fixture 照常回答
  data.exec = (e: any) => { if (e.argv[0] === 'claude' && e.argv[1] === 'logs') logCalls.push(String(e.argv[2])); return null }
  await refresh($, clock)
  const ui = await $.ui.mount(PANE(100))
  await ui.press({ key: `row-${CARD_B}` })
  // 打開 Beta 的 log 檢視（打開時會先讀一次），之後才開始數這一輪
  await ui.press({ key: `case-${CARD_B}-logs` })
  await clock.settle()
  const opened = flat(text(await ui.drawn()))
  // Agent 又多寫了兩行：「改完匯出」只會出現在 log 檢視（最後一句是「全部通過」）
  data.logs.bbbbbbbb = '● 讀卡片\n● 跑測試中\n● 改完匯出\n● 全部通過\n'
  logCalls.length = 0

  await refresh($, clock)
  const drawn = flat(text(await ui.drawn()))
  await ui.unmount()

  expect(logCalls).toEqual(['bbbbbbbb'])
  expect(opened).toContain(flat('讀卡片'))
  expect(opened).not.toContain(flat('改完匯出'))
  expect(drawn).toContain(flat('改完匯出'))
  expect(drawn).toContain(flat('全部通過'))
})

/** AC-5 */
test('test_pending_ci_rechecks_pr_after_sixty_seconds', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  data.git[BETA] = { branch: 'feature/b', head: 'b1', remote: 'git@github.com:acme/shop.git' }
  data.gh = [{ number: 21, state: 'OPEN', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, statusCheckRollup: [{ conclusion: '', status: 'IN_PROGRESS' }] }]
  // 定時更新（不強制重讀 PR）：每 30 秒一輪
  const tick = async () => { await clock.advance(30_000); await clock.settle() }

  await refresh($, clock)
  expect(data.ghCalls.length).toBe(1)
  await tick()
  const within = data.ghCalls.length
  await tick()
  const after = data.ghCalls.length
  await refresh($, clock)
  const forced = data.ghCalls.length

  expect(within).toBe(1)
  expect(after).toBe(2)
  expect(forced).toBe(3)
})
