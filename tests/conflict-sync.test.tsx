import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, PANE, BAND, PROJECT_DIR, CARD_A, CARD_B, CARD_C, REGISTRY, result, text, flat } from './fixture'
import { buildPrompt, NO_PUSH_RULE, PUSH_RULE } from '../hooks/dispatch'
import { buildCase } from '../hooks/model'
import { catchupHold, parseMergeTree } from '../hooks/catchup'
import { PUBLISH_PUSH_TURN } from '../hooks/turn'

const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const DELTA = '/home/u/wt/delta'
const CARD_D = `${DELTA}/.desk/CARD.md`
const ME = 'fixture-session'
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 1；可合併'
const OPEN_PR = { number: 12, state: 'OPEN', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }
const FORBIDDEN = new Set(['merge', 'commit', 'push', 'checkout', 'switch', 'reset', 'rebase', 'add', 'stash', 'cherry-pick', 'pull'])
/** 整條流程走好幾輪重新整理（派工、檢查、審查）：機器忙時 5 秒不夠，照 tutorial 測試放寬。 */
const SLOW_MS = 15_000
const FETCH_MAIN = ['fetch', '--quiet', '--no-tags', 'origin', 'main']

const card = (name: string, gate = PASSED, ask = '無') => `<!-- DESK -->\n- 狀態：${name} 過關\n- 驗證：\`npm test\`\n- 等你：${ask}\n- 下一步：合併\n${gate}\n<!-- /DESK -->`
const registry = (rows: [string, string][]) => `## 任務\n| Project | path |\n| --- | --- |\n${rows.map(([n, p]) => `| ${n} | \`${p}\` |`).join('\n')}`

/** 這個對話的流程在 head 審查過關；檢查也在 head 跑過。 */
function passedAt(data: any, root: string, statusPath: string, head: string, extra: Record<string, unknown> = {}) {
  data.store.chains = { ...(data.store.chains as any), [root]: { owner: ME, startedAt: 0, round: 0, passed: true, reviewHead: head, reviewBranch: data.git[root]?.branch, judgedHead: head, judgedBranch: data.git[root]?.branch, ...extra } }
  data.store.verifies = { ...(data.store.verifies as any), [statusPath]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head } }
  data.store.jobs = { ...(data.store.jobs as any), [root]: { sessionId: 'b0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'b0000009', sessionId: 'b0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: ME, handled: true, ended: { how: 'finished' } } } }
  data.store.trustedVerify = { ...(data.store.trustedVerify as any), [statusPath]: 'npm test' }
}

/** 只留 Beta：PR #12 → main 開著、審查過關、worktree 乾淨；main 前進後試合併有兩個檔衝突。 */
function conflictingBeta(data: any, clock: any) {
  data.agents = []
  data.gh = [OPEN_PR]
  data.files[REGISTRY] = registry([['Beta', CARD_B]])
  data.files[CARD_B] = card('Beta')
  data.git[BETA] = { branch: 'feature/b', head: 'h1', remote: 'git@github.com:acme/shop.git', releases: '', conflicts: ['src/a.ts', 'src/b.ts'] }
  passedAt(data, BETA, CARD_B, 'h1')
  startsAgents(data, clock)
}

/** 派工會啟動一個背景 Agent：清單裡多一個同名、在跑的 Agent（照 `claude --bg` 的回應）。 */
function startsAgents(data: any, clock: any) {
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    const cwd = String(e.init?.cwd ?? '')
    data.agents = [...data.agents.filter((a: any) => a.cwd !== cwd), { id, kind: 'background', cwd, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
}
const finish = (data: any, root: string) => { data.agents = data.agents.map((a: any) => a.cwd === root ? { ...a, status: 'idle', state: 'done' } : a) }
const promptOf = (data: any, i = 0) => String(data.launches[i].argv[data.launches[i].argv.length - 1])

/** 記下動態（整份清單）。 */
function watchFeed(on: any) {
  const box = { feed: [] as any[] }
  on('state.set', (_: any, e: any, next: any) => { if (e?.plugin === 'desk' && e?.key === 'feed') box.feed = e.value; return next(e) })
  return box
}

async function refresh($: any, clock: any, times = 1) {
  for (let i = 0; i < times; i++) {
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    await clock.settle()
    await clock.advance(2500); await clock.settle()
  }
}
/** 摘要列：「輪到你：」接現在卡的那一句（不換行）。 */
async function bandText($: any): Promise<string> {
  const band = await $.ui.mount(BAND(240))
  const drawn = text(await band.drawn())
  await band.unmount()
  return drawn
}
const screen = async (ui: any) => flat(text(await ui.drawn()))
async function cardStages(ui: any): Promise<string> {
  const t = await ui.find({ type: 'Text', text: /^規格[●◉◆✕○·]/ })
  return String(t?.text ?? '')
}
async function focus(ui: any, statusPath: string) {
  if (await ui.find({ key: `row-${statusPath}` })) await ui.press({ key: `row-${statusPath}` })
}

/** AC-1 */
test('test_conflict_agent_is_dispatched_once_when_reviewed_branch_conflicts_with_base', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  const seen = watchFeed(on)
  conflictingBeta(data, clock)

  await refresh($, clock, 2)
  const ui = await $.ui.mount(PANE(100))
  await refresh($, clock, 1)

  // 先 fetch origin 的 main，再試合併；重新整理幾次都只派一個
  const calls = data.gitCalls.filter(g => g.root === BETA)
  const fetchAt = calls.findIndex(g => g.args.join(' ') === FETCH_MAIN.join(' '))
  const treeAt = calls.findIndex(g => g.args[0] === 'merge-tree')
  expect(fetchAt >= 0).toBe(true)
  expect(treeAt > fetchAt).toBe(true)
  expect(calls[treeAt]!.args).toEqual(['merge-tree', '--write-tree', '--name-only', '--no-messages', 'origin/main', 'HEAD'])
  expect(data.launches.length).toBe(1)
  expect(data.launches[0].init?.cwd).toBe(BETA)

  const prompt = promptOf(data)
  expect(prompt).toContain('合併基準分支、解衝突')
  expect(prompt).toContain('git fetch origin main')
  expect(prompt).toContain('git merge --no-ff --no-edit origin/main')
  expect(prompt).toContain('逐檔解衝突')
  expect(prompt).toContain('完成檢查 `npm test`')
  expect(prompt).toContain('git commit')
  expect(prompt).toContain('不 rebase')
  expect(prompt).toContain('不 force push')
  expect(prompt).toContain('不 push')
  expect(prompt).not.toContain(PUSH_RULE)

  expect(seen.feed.filter(e => e.text === 'Beta 與 main 有衝突（2 個檔），自動派 Agent 合併 main、解衝突').length).toBe(1)

  expect(await screen(ui)).toContain(flat('Agent 在合併基準分支、解衝突（l 看輸出）'))
  // 進行中那段在 ◉／◎ 間交替
  expect(await cardStages(ui)).toMatch(/合併[◉◎]/)
  // 六段的合併段（狀態列寫現在在跑的那件停在哪一段）
  expect(data.status).toContain('合併・合併基準分支、解衝突中')
  await ui.unmount()
})

/** AC-2 */
test('test_recheck_and_merge_aware_review_run_when_conflict_agent_commits_the_merge', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  conflictingBeta(data, clock)
  await refresh($, clock, 2)
  expect(data.launches.length).toBe(1)

  // 解衝突 Agent 做完：多了合併 main 的 commit（h1 → h2），試合併不再衝突；本機領先遠端
  data.git[BETA] = { ...data.git[BETA]!, head: 'h2', conflicts: undefined, ahead: 1 }
  finish(data, BETA)
  await refresh($, clock, 3)

  // 自動重新檢查，通過後派重新審查：只看 h1 之後，main 帶進來的不審、看衝突怎麼解
  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(1)
  expect(data.launches.length).toBe(2)
  const review = promptOf(data, 1)
  expect(review).toContain('審查通過後又有新 commit 的重新審查')
  expect(review).toContain('git diff h1..HEAD')
  expect(review).toContain('main 帶進來的改動不審')
  expect(review).toContain('git log -p --remerge-diff --first-parent h1..HEAD')
  const run = (data.store.chains as any)[BETA]
  expect(run.round).toBe(0)
  expect(run.recheck).toBe(true)

  // 重新審查過關：回到合併段，PR 開著又有新 commit → ⇡ push；不再派解衝突
  finish(data, BETA)
  await refresh($, clock, 3)
  expect((data.store.chains as any)[BETA].passed).toBe(true)
  expect((data.store.chains as any)[BETA].judgedHead).toBe('h2')
  expect(data.launches.length).toBe(2)
  const ui = await $.ui.mount(PANE(100))
  expect(await screen(ui)).toContain(flat(PUBLISH_PUSH_TURN))
  await ui.unmount()
})

/** AC-3 */
test('test_conflict_agent_is_not_retried_when_head_is_unchanged_after_an_attempt', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  const seen = watchFeed(on)
  conflictingBeta(data, clock)
  await refresh($, clock, 2)
  expect(data.launches.length).toBe(1)

  // 做完但沒 commit：等你寫了一題業務判斷
  data.files[CARD_B] = card('Beta', PASSED, 'main 也改了結帳金額的算法，保留哪邊：A) 分支的 B) main 的')
  finish(data, BETA)
  await refresh($, clock, 3)
  const ui = await $.ui.mount(PANE(100))
  expect(await screen(ui)).toContain(flat('按選項字母 → f 填入 → Enter 送出'))
  expect(data.launches.length).toBe(1)

  // 在對話處理、等你清成無；HEAD 沒變、衝突還在：按 r 也不再派
  data.files[CARD_B] = card('Beta')
  await refresh($, clock, 3)
  // /desk refresh 跟面板按 r 一樣：強制重查（fetch 不等五分鐘）
  await refresh($, clock, 1)
  expect(data.launches.length).toBe(1)
  const shown = await screen(ui)
  expect(shown).toContain(flat('與 main 有衝突：在對話把 main 合併進來、解衝突並 commit（自動合併試過一次沒解開）'))
  expect(seen.feed.some(e => String(e.text).includes('流程已暫停'))).toBe(false)
  const stages = await cardStages(ui)
  expect(stages).toContain('驗收●')
  expect(stages).toContain('合併✕')
  await ui.unmount()
})

/** AC-4 */
test('test_conflict_dispatch_is_held_or_queued_when_chain_off_risky_dirty_or_full', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  const seen = watchFeed(on)
  data.gh = []
  data.files[REGISTRY] = registry([['A', CARD_A], ['B', CARD_B], ['C', CARD_C], ['D', CARD_D]])
  const git = (branch: string, extra: Record<string, unknown> = {}) => ({ branch, head: 'h1', remote: 'git@gitlab.com:acme/shop.git', releases: '', originHead: 'origin/main', conflicts: ['src/a.ts'], ...extra })
  for (const [root, path, name] of [[ALPHA, CARD_A, 'A'], [BETA, CARD_B, 'B'], [GAMMA, CARD_C, 'C'], [DELTA, CARD_D, 'D']] as const) {
    data.files[path] = card(name)
    data.git[root] = git(`feature/${name.toLowerCase()}`, root === GAMMA ? { changed: 1 } : {})
    passedAt(data, root, path, 'h1')
  }
  // A 的流程是別的對話開的；B 是高風險改動（審查過了、等你看過）
  ;(data.store.chains as any)[ALPHA].owner = 'other-session'
  ;(data.store.chains as any)[BETA].needsHuman = '高風險改動（migration），審查已過，請你看過再開 PR'
  // 別處已有 3 個工作桌 Agent 在跑（上限 3）
  const others = [1, 2, 3].map(i => ({ id: `f000000${i}`, kind: 'background', cwd: `/home/u/wt/other${i}`, name: `desk-zz-${i}`, sessionId: `f000000${i}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: 0 }))
  data.agents = others
  startsAgents(data, clock)

  await refresh($, clock, 2)
  const ui = await $.ui.mount(PANE(100))
  expect(data.launches.length).toBe(0)
  for (const [path, why] of [[CARD_A, '流程是別的對話開的'], [CARD_B, '高風險改動'], [CARD_C, 'worktree 有未提交的改動（1 個檔）']] as const) {
    await focus(ui, path)
    expect(await bandText($), path).toContain(`輪到你：與 main 有衝突：在對話把 main 合併進來、解衝突並 commit（${why}）`)
  }
  expect(seen.feed.filter(e => e.text === 'D 自動派解衝突排隊中（第 1 位）').length).toBe(1)

  // 有空位：D 的解衝突派出，A、B、C 照舊不派
  data.agents = []
  await refresh($, clock, 2)
  expect(data.launches.length).toBe(1)
  expect(data.launches[0].init?.cwd).toBe(DELTA)
  expect(promptOf(data)).toContain('合併基準分支、解衝突')
  await refresh($, clock, 2)
  expect(data.launches.length).toBe(1)
  await ui.unmount()
})

/** 派不出去（claude --bg 失敗）不算試過：流程停下寫原因，不說「試過一次沒解開」，也不每次重新整理都重派（審查 MEDIUM，D-05）。 */
test('test_conflict_attempt_is_not_recorded_when_launch_fails', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  const seen = watchFeed(on)
  conflictingBeta(data, clock)
  data.launch = async () => result(1, '', 'claude: 無法啟動背景 Agent')

  await refresh($, clock, 2)
  await refresh($, clock, 3)

  expect(data.launches.length).toBe(1)
  const chain = (data.store.chains as any)[BETA]
  expect(chain.catchupHead).toBeUndefined()
  expect(chain.stopped).toContain('解衝突沒派出')
  expect(seen.feed.some(e => String(e.text).includes('解衝突失敗：claude: 無法啟動背景 Agent'))).toBe(true)
  const ui = await $.ui.mount(PANE(100))
  const shown = await screen(ui)
  expect(shown).not.toContain(flat('試過一次沒解開'))
  expect(shown).toContain(flat('與 main 有衝突：在對話把 main 合併進來、解衝突並 commit（流程已暫停）'))
  await ui.unmount()
})

/** 排進隊伍後隊伍被清空（/desk off）不算試過：重開工作桌、有空位時照樣自動派一次（審查 MEDIUM，D-05）。 */
test('test_conflict_attempt_is_not_recorded_when_queue_is_cleared', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  const seen = watchFeed(on)
  conflictingBeta(data, clock)
  const others = [1, 2, 3].map(i => ({ id: `f000000${i}`, kind: 'background', cwd: `/home/u/wt/other${i}`, name: `desk-zz-${i}`, sessionId: `f000000${i}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: 0 }))
  data.agents = others

  await refresh($, clock, 2)
  expect(seen.feed.filter(e => e.text === 'Beta 自動派解衝突排隊中（第 1 位）').length).toBe(1)
  expect((data.store.chains as any)[BETA].catchupHead).toBeUndefined()

  await $.command.run({ command: 'desk', args: 'off' } as any)
  await clock.settle()
  data.agents = []
  await refresh($, clock, 3)

  expect(data.launches.length).toBe(1)
  expect(data.launches[0].init?.cwd).toBe(BETA)
  expect((data.store.chains as any)[BETA].catchupHead).toBe('h1')
  await refresh($, clock, 2)
  expect(data.launches.length).toBe(1)
})

/** 背景 fetch 不停下來問帳密：關掉 git 的提示，ssh 用 BatchMode 並沿用你設的 ssh 指令（審查 MEDIUM，D-05）。 */
test('test_background_fetch_never_prompts_for_credentials', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  conflictingBeta(data, clock)
  data.git[BETA] = { ...data.git[BETA], conflicts: [] }
  const fetches: any[] = []
  data.exec = (e: any) => {
    if (e.argv[0] === 'git' && e.argv[3] === 'fetch') fetches.push(e)
    if (e.argv[0] === 'git' && e.argv.slice(3).join(' ') === 'config --get core.sshCommand') return result(0, 'ssh -i ~/.ssh/work_key\n')
    return null
  }

  await refresh($, clock, 2)

  expect(fetches.length).toBeGreaterThan(0)
  for (const e of fetches) {
    expect(e.init?.env?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(e.init?.env?.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/work_key -o BatchMode=yes')
  }
})

/**
 * 專案設了 autoPr、審查剛過關時就跟 main 有衝突：過關當下照 autoPr 先派推送（開 PR），推送 Agent 做完才派解衝突，
 * 同一個 worktree 一次只派一個；合併 commit 重新審查過關後再照 autoPr 自動 push 到已開的 PR。
 */
test('test_auto_pr_goes_first_and_conflict_agent_follows_when_review_passes_with_conflict', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  conflictingBeta(data, clock)
  // 還沒有 PR：基準分支照 origin/HEAD（main），過關當下就試合併得出衝突
  data.gh = []
  data.git[BETA] = { ...data.git[BETA]!, originHead: 'origin/main' }
  data.files[`${PROJECT_DIR}/dispatch.json`] = JSON.stringify({ autoPr: true })
  // 審查剛結束、流程還沒處理（還沒過關）
  const chain = (data.store.chains as any)[BETA]
  delete chain.passed
  ;(data.store.jobs as any)[BETA].last.handled = false

  await refresh($, clock, 2)
  expect(data.gitCalls.some(g => g.root === BETA && g.args[0] === 'merge-tree')).toBe(true)
  expect(data.launches.length).toBe(1)
  expect(promptOf(data, 0).split('\n')[0]).toContain('推送：push feature/b')
  expect(log.has('Beta 審查通過，自動派 Agent 開 PR')).toBe(true)
  // 推送 Agent 在跑：不同時派解衝突
  await refresh($, clock, 2)
  expect(data.launches.length).toBe(1)
  expect(log.has('Beta 與 main 有衝突（2 個檔），自動派 Agent 合併 main、解衝突')).toBe(false)

  // 推送做完、PR 開了：衝突還在 → 派一個解衝突
  data.gh = [OPEN_PR]
  finish(data, BETA)
  await refresh($, clock, 3)
  expect(data.launches.length).toBe(2)
  expect(promptOf(data, 1)).toContain('合併基準分支、解衝突')
  expect(log.list.filter(e => e.text === 'Beta 與 main 有衝突（2 個檔），自動派 Agent 合併 main、解衝突').length).toBe(1)

  // 解衝突做完（h1 → h2、不再衝突、領先遠端）→ 重新檢查與審查 → 過關後照 autoPr 只 push 到 PR #12
  data.git[BETA] = { ...data.git[BETA]!, head: 'h2', conflicts: undefined, ahead: 1 }
  finish(data, BETA)
  await refresh($, clock, 3)
  expect(data.launches.length).toBe(3)
  expect(promptOf(data, 2)).toContain('審查通過後又有新 commit 的重新審查')
  finish(data, BETA)
  await refresh($, clock, 3)
  expect(data.launches.length).toBe(4)
  expect(promptOf(data, 3).split('\n')[0]).toContain('推送：只 push feature/b（PR #12 已開')
})

/** AC-5 */
test('test_desk_only_fetches_and_dry_runs_and_skips_cards_outside_the_merge_stage', { timeoutMs: SLOW_MS }, async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  data.files[REGISTRY] = registry([['Clean', CARD_A], ['Reviewing', CARD_B], ['Merged', CARD_C], ['Line', CARD_D]])
  const github = { remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', head: 'h1' }
  const prs: Record<string, any[]> = {
    'feature/clean': [OPEN_PR],
    'feature/merged': [{ ...OPEN_PR, number: 13, state: 'MERGED' }],
  }
  data.exec = (e: any) => e.argv[0] === 'gh' ? result(0, JSON.stringify(prs[String(e.argv[e.argv.indexOf('--head') + 1])] ?? [])) : null
  // 沒衝突的過關卡
  data.files[CARD_A] = card('Clean')
  data.git[ALPHA] = { ...github, branch: 'feature/clean' }
  passedAt(data, ALPHA, CARD_A, 'h1')
  // 還在審查段（檢查過了、還沒審查）
  data.files[CARD_B] = card('Reviewing', '- 關卡：無')
  data.git[BETA] = { ...github, branch: 'feature/reviewing', conflicts: ['src/a.ts'] }
  data.store.verifies = { ...(data.store.verifies as any), [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h1' } }
  // PR 已合併
  data.files[CARD_C] = card('Merged')
  data.git[GAMMA] = { ...github, branch: 'feature/merged', conflicts: ['src/a.ts'] }
  passedAt(data, GAMMA, CARD_C, 'h1')
  // 發版線
  data.files[CARD_D] = card('Line')
  data.git[DELTA] = { ...github, branch: 'release/v1.5', conflicts: ['src/a.ts'] }
  passedAt(data, DELTA, CARD_D, 'h1')

  await refresh($, clock, 2)
  const ui = await $.ui.mount(PANE(100))
  // /desk refresh 跟面板按 r 一樣：強制重查（fetch 不等五分鐘）
  await refresh($, clock, 2)
  await ui.unmount()

  expect(data.launches.length).toBe(0)
  // 不在合併段或已合併的：連 fetch 與試合併都不跑
  for (const root of [BETA, GAMMA, DELTA]) {
    expect(data.gitCalls.some(g => g.root === root && (g.args[0] === 'fetch' || g.args[0] === 'merge-tree')), root).toBe(false)
  }
  // 沒衝突的過關卡：fetch＋試合併，沒有衝突就不派
  expect(data.gitCalls.some(g => g.root === ALPHA && g.args[0] === 'merge-tree')).toBe(true)
  // desk 自己跑的 git 只有讀取、fetch origin <基準分支> 與 merge-tree
  expect(data.gitCalls.filter(g => FORBIDDEN.has(g.args[0]!))).toEqual([])
  for (const g of data.gitCalls.filter(g => g.args[0] === 'fetch')) expect(g.args).toEqual(FETCH_MAIN)

  // 解衝突的提示：只在這件的根目錄作業、不 push 到任何分支
  const c = { ...buildCase({ name: 'Beta', statusPath: CARD_B }, card('Beta'), 1, {}, undefined), root: BETA }
  const prompt = buildPrompt(c, 'catchup', 'origin/main')
  expect(prompt).toContain(`根目錄：${BETA}`)
  expect(prompt).toContain('只在此任務根目錄作業')
  expect(prompt).toContain(NO_PUSH_RULE)
  expect(prompt).not.toContain(PUSH_RULE)
  expect(prompt).not.toContain('git push')
})

test('conflict sync: merge-tree exit codes map to none, conflicts or unknown', () => {
  expect(parseMergeTree(0, 'abc123\n')).toEqual([])
  expect(parseMergeTree(1, 'abc123\nsrc/a.ts\nsrc/b.ts\n')).toEqual(['src/a.ts', 'src/b.ts'])
  expect(parseMergeTree(1, 'abc123\n')).toBeNull()
  expect(parseMergeTree(128, 'usage: git merge-tree')).toBeNull()
  expect(parseMergeTree(null, '')).toBeNull()
})

test('conflict sync: hold reasons come in order and empty means dispatch', () => {
  const conflict = { into: 'main', ref: 'origin/main', files: ['a'], dirty: 0 }
  const chain = { round: 0, passed: true }
  expect(catchupHold({ conflict, chain })).toBe('')
  expect(catchupHold({ conflict, chain, manual: true })).toBe('手動任務')
  expect(catchupHold({ conflict })).toBe('沒有自動流程')
  expect(catchupHold({ conflict, chain: { round: 0, selfReview: true } })).toBe('沒有自動流程')
  expect(catchupHold({ conflict, chain: { ...chain, foreign: true, needsHuman: 'x' } })).toBe('流程是別的對話開的')
  expect(catchupHold({ conflict, chain: { ...chain, stopped: 'x', needsHuman: 'x' } })).toBe('流程已暫停')
  expect(catchupHold({ conflict: { ...conflict, dirty: 2 }, chain: { ...chain, needsHuman: 'x' } })).toBe('高風險改動')
  expect(catchupHold({ conflict: { ...conflict, dirty: 2 }, chain: { ...chain, catchupTried: true } })).toBe('worktree 有未提交的改動（2 個檔）')
  expect(catchupHold({ conflict, chain: { ...chain, catchupTried: true } })).toBe('自動合併試過一次沒解開')
})
