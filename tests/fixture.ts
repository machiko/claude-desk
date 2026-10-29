import { mock } from 'claude-code/testing'
import { EDGE } from '../hooks/theme'

export const NOW = Date.parse('2030-01-05T12:00:00Z')
/** 對話所在的 repo（shop）；它的登錄表與設定在 ~/.claude/handoffs/shop/。 */
export const SESSION_ROOT = '/home/u/shop'
export const PROJECT_DIR = '/home/u/.claude/handoffs/shop'
export const REGISTRY = `${PROJECT_DIR}/projects-scope.md`
export const CARD_A = '/home/u/wt/alpha/.desk/CARD.md'
export const CARD_B = '/home/u/wt/beta/.desk/CARD.md'
export const CARD_C = '/home/u/wt/gamma/.desk/CARD.md'

export const BAND = (bodyColumns: number) => ({ plugin: 'desk', component: 'AbovePrompt', surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, bodyColumns, maxRows: 3, scroll: { offset: 0, total: 0, visible: 0 }, view: {} } } as any)
export const PANE = (bodyColumns = 72, placement: 'dock' | 'inline' = 'inline', bodyRows?: number) => ({ plugin: 'desk', component: 'Pane', requestId: 'desk', surface: 'terminal',
  props: { title: 'desk', isFocused: true, bodyColumns, placement, scroll: { offset: 0, bodyRows }, view: {} } } as any)

export const result = (exitCode = 0, stdout = '', stderr = '') => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

export function fixture(on: any) {
  const clock = mock.clock(on, { now: NOW })
  // state.get 的攔截只在測試設了 seedState 或 refuseAfterNewLoad 時才掛：多一層 async hook，面板每次重畫的狀態讀取都慢一截。
  // 兩個都要在第一次呼叫 $ 之前設（kit 只在那之前接受註冊）。
  let seedState: Record<string, unknown> = {}
  let refuseAfterNewLoad = false
  let isStateGetHooked = false
  const hookStateGet = () => {
    if (isStateGetHooked) return
    isStateGetHooked = true
    // 新版已載入：新的模組在 session.start 會把載入計數再加 1，這裡讓舊版之後讀到的計數多 1。
    on('state.get', async (_: any, e: any, next: any) => {
      const r = await next(e)
      // 只在 desk 還沒寫過這個 key（讀不到值）時套用；寫過之後（連 null 也算）就讀真正的值。
      if (e?.plugin === 'desk' && e?.key in seedState && r.value?.value === undefined) return { value: { ...r.value, value: seedState[e.key] } }
      return data.newerLoaded && e?.plugin === 'desk' && e?.key === 'loads' ? { value: { ...r.value, value: (r.value?.value ?? 0) + 1 } } : r
    })
  }
  mock.env(on, { HOME: '/home/u' })
  const data = {
    files: {
      [REGISTRY]: `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Beta | \`${CARD_B}\` |\n| Gamma | \`${CARD_C}\` |`,
      [CARD_A]: `<!-- DESK -->\n- 狀態：Alpha 一切就緒\n- 驗證：\`node test.mjs\`\n- 等你：要 push 嗎？A) 要 B) 等\n- 下一步：push\n- 關卡：無\n<!-- /DESK -->`,
      [CARD_B]: `<!-- DESK -->\n- 狀態：Beta 修正中\n- 驗證：\`npm test\`\n- 等你：無\n- 下一步：依審核修正\n- 關卡：無\n<!-- /DESK -->`,
      [CARD_C]: `<!-- DESK -->\n- 狀態：Gamma 閒置\n- 驗證：無\n- 等你：無\n- 下一步：無\n- 關卡：無\n<!-- /DESK -->`,
    } as Record<string, string>,
    mtimes: { [CARD_A]: NOW - 20 * 60_000, [CARD_B]: NOW - 3 * 60_000, [CARD_C]: NOW - 2 * 86_400_000 } as Record<string, number>,
    agents: [{ id: 'bbbbbbbb', kind: 'background', cwd: '/home/u/wt/beta', state: 'working', status: 'busy', name: 'beta-agent', sessionId: 'bbbbbbbb-0000-4000-8000-000000000000', startedAt: NOW - 60_000 }] as any[],
    toasts: [] as string[],
    logs: { bbbbbbbb: '跑測試中\n' } as Record<string, string>,
    launches: [] as any[],
    git: {} as Record<string, { branch: string; head: string; tag?: string; files?: string[]; /** origin 的網址；預設 Bitbucket。 */ remote?: string; /** for-each-ref origin/release/ 的輸出；預設 origin/release/v1.4。 */ releases?: string; /** origin/HEAD 指到哪（symbolic-ref）。 */ originHead?: string; /** HEAD 已經在這些分支裡（merge-base --is-ancestor）。 */ merged?: string[]; /** HEAD 是從這些 commit 長出來的（merge-base --is-ancestor <commit> HEAD）。 */ descends?: string[]; /** rev-list --first-parent <commit>..HEAD 的輸出（沿 HEAD 的第一個父往回走）。 */ branchLine?: string; /** merge-base HEAD <ref> 的回答（分叉點）；預設 base0。 */ forkPoint?: string; /** rev-list --first-parent HEAD..<ref> 的輸出。 */ firstParent?: string; /** rev-parse <commit>^ 的回答。 */ parents?: Record<string, string>; /** false：分支沒有 upstream（從沒 push 過）。 */ upstream?: boolean; /** 沒有 upstream 時，rev-list --left-right --count refs/remotes/origin/<分支>...HEAD 的輸出（「落後\t領先」）；沒填＝origin 上沒有這個分支。 */ remoteAb?: string; /** 領先遠端幾個 commit（branch.ab）；預設 0。 */ ahead?: number; /** 幾檔已追蹤但未提交；預設 0。 */ changed?: number; /** 分支最近一次變更（不算只改卡片的）的時間，毫秒。 */ commitAt?: number; /** 那次 commit 改到的檔案（相對路徑；修改時間放 mtimes）。 */ commitFiles?: string[] }>,
    mcpCalls: [] as any[],
    /** gh pr list 的回應；null 模擬沒裝或沒登入。 */
    gh: [] as any[] | null,
    ghCalls: [] as any[],
    compose: '' as string | null,
    composeCalls: [] as any[],
    opens: [] as any[],
    closes: [] as any[],
    panes: [] as any[],
    /** 引擎會不會畫出這次開啟；false 模擬「主動開啟、終端機不夠寬」。 */
    placeOpen: (_e: any) => true as boolean,
    usage: { startedAt: NOW, context: { percent: 34 }, rateLimits: [] as any[] } as any,
    writes: [] as string[],
    /** 存在但讀不到的檔案（權限不對、是資料夾）：fs.exists 照樣回 true，fs.read 拒絕。 */
    unreadable: [] as string[],
    status: undefined as string | undefined,
    prs: [] as any[],
    statuses: [] as string[],
    launch: async (_e: any): Promise<any> => result(0, ''),
    processCalls: [] as any[],
    fills: [] as any[],
    submitted: [] as any[],
    asks: [] as string[],
    answer: '執行',
    /** 按 g 時核准完成檢查的那個對話框（選項有「核准並派工」）的回答；其他對話框用 answer。 */
    approve: '核准並派工',
    /** 每個對話框的選項，跟 asks 一一對應。 */
    askOptions: [] as string[][],
    /** false 模擬輸入框無法預填。 */
    fillable: true,
    run: async (_e: any): Promise<any> => result(0, 'all green\n'),
    /** `claude stop <id>` 停過的 id（依序）。 */
    stops: [] as string[],
    /** 不是 null 就讓 `claude stop` 失敗，stderr 是這句；null 交給 run。 */
    stopError: null as string | null,
    store: {} as Record<string, unknown>,
    /** session 根目錄；git common dir 依 repos 回答，沒列的就不是 git。 */
    root: SESSION_ROOT,
    repos: { [SESSION_ROOT]: `${SESSION_ROOT}/.git` } as Record<string, string>,
    /** 先問這個：回傳結果就用它（update 測試模擬 claude plugin 與 desk 的 git）；null 交給下面的預設。 */
    exec: null as null | ((e: any) => Promise<any> | any),
    /** 載入中的 desk 版號（plugin 自己的 plugin.json）。 */
    deskVersion: '9.9.9',
    /** 每次執行 /reload-plugins 時已經跳過的 toast，與 feedAtReload 讀到的畫面（看重新載入是不是在回報之後）。 */
    reloads: [] as { toasts: string[]; seen?: string }[],
    /** 執行 /reload-plugins 的當下讀面板畫面（測試掛好面板後設定）。 */
    feedAtReload: null as null | (() => Promise<string>),
    /** false 模擬 Claude Code 不讓 plugin 執行 /reload-plugins。 */
    reloadable: true,
    /** 搭配 reloadable: false：拒絕之前新版其實已經載入了（之後讀到的 desk 載入計數多 1），舊版這邊才收到拒絕。 */
    get refuseAfterNewLoad() { return refuseAfterNewLoad },
    set refuseAfterNewLoad(value: boolean) { refuseAfterNewLoad = value; if (value) hookStateGet() },
    newerLoaded: false,
    /** desk 的 state 還沒寫過之前讀到的值（模擬舊版存下的值）；desk 寫過那個 key 後就不再套用。 */
    get seedState() { return seedState },
    set seedState(value: Record<string, unknown>) { seedState = value; if (Object.keys(value ?? {}).length) hookStateGet() },
  }
  on('fs.read', (_: any, e: any) => data.unreadable.includes(e.path) ? { deny: 'EACCES' } : data.files[e.path] !== undefined ? { value: data.files[e.path] } : String(e.path).endsWith('/.claude-plugin/plugin.json') ? { value: JSON.stringify({ version: data.deskVersion }) } : { deny: 'ENOENT' })
  on('fs.stat', (_: any, e: any) => data.mtimes[e.path] !== undefined ? { value: { kind: 'file', size: 1, mtimeMs: data.mtimes[e.path], isLink: false } } : { deny: 'ENOENT' })
  on('fs.exists', (_: any, e: any) => ({ value: data.files[e.path] !== undefined }))
  on('fs.write', (_: any, e: any) => { data.files[e.path] = e.text; data.writes.push(e.path); return { value: undefined } })
  on('process.run', async (_: any, e: any) => {
    const own = data.exec ? await data.exec(e) : null
    if (own) return { value: own }
    // desk 自我更新的自動檢查：預設查不到安裝（失敗不出聲），也不算進 processCalls。
    if (e.argv[0] === 'claude' && e.argv[1] === 'plugin') return { value: result(1, '', 'plugin list unavailable in tests') }
    if (e.argv[0] === 'claude' && e.argv[1] === 'agents') return { value: result(0, JSON.stringify(data.agents)) }
    if (e.argv[0] === 'docker' && e.argv[1] === 'compose' && e.argv[2] === 'ps') { data.composeCalls.push(e); return { value: data.compose === null ? result(1, '', 'Cannot connect to the Docker daemon') : result(0, data.compose) } }
    if (e.argv[0] === 'git') {
      if (e.argv.slice(3).join(' ') === 'rev-parse --path-format=absolute --git-common-dir') return { value: data.repos[e.argv[2]] ? result(0, `${data.repos[e.argv[2]]}\n`) : result(128, '', 'not a git repository') }
      const g = data.git[e.argv[2]]
      if (!g) return { value: result(128, '', 'not a git repository') }
      const args = e.argv.slice(3).join(' ')
      if (/^rev-parse \S+\^$/.test(args)) { const p = g.parents?.[args.slice(10, -1)]; return { value: p ? result(0, `${p}\n`) : result(128, '', 'bad revision') } }
      // 照真實 git：只有查到 origin 上「同名」分支才有數字；查錯分支名跟沒有分支一樣回 128。
      const remoteAb = args.match(/^rev-list --left-right --count refs\/remotes\/origin\/(\S+)\.\.\.HEAD$/)
      if (remoteAb) return { value: g.remoteAb === undefined || remoteAb[1] !== g.branch ? result(128, '', 'unknown revision') : result(0, `${g.remoteAb}\n`) }
      if (/^rev-list --first-parent \S+\.\.HEAD$/.test(args)) return { value: result(0, g.branchLine ?? '') }
      if (args.startsWith('rev-list --first-parent')) return { value: result(0, g.firstParent ?? '') }
      if (args.startsWith('log -1 --format=%ct')) return { value: result(0, g.commitAt ? `${Math.floor(g.commitAt / 1000)}\n${g.commitFiles?.length ? `\n${g.commitFiles.join('\n')}\n` : ''}` : '') }
      // 照真實 git 回答：--abbrev-ref 會套用到它後面每一個參數。
      if (args === 'rev-parse --abbrev-ref HEAD HEAD') return { value: result(0, `${g.branch}\n${g.branch}\n`) }
      if (args === 'rev-parse HEAD --abbrev-ref HEAD') return { value: result(0, `${g.head}\n${g.branch}\n`) }
      if (args.startsWith('rev-parse')) return { value: result(0, `${g.branch}\n${g.head}\n`) }
      if (args.startsWith('status --porcelain=v2')) return { value: result(0, `# branch.oid ${g.head}\n# branch.head ${g.branch}\n${g.upstream === false ? '' : `# branch.upstream origin/${g.branch}\n# branch.ab +${g.ahead ?? 0} -0\n`}${Array.from({ length: g.changed ?? 0 }, (_, i) => `1 .M N... 100644 100644 100644 a b f${i}.ts\n`).join('')}`) }
      if (args.startsWith('tag --contains')) return { value: result(0, g.tag ? `${g.tag}\n` : '') }
      if (args.startsWith('tag --list')) return { value: result(0, 'v1.3.0\nv1.2.0\n') }
      if (args.startsWith('remote get-url')) return { value: result(0, `${g.remote ?? 'git@bitbucket.org:acme/shop.git'}\n`) }
      if (args.startsWith('for-each-ref')) return { value: result(0, g.releases ?? 'origin/release/v1.4\n') }
      if (args.startsWith('symbolic-ref')) return { value: g.originHead ? result(0, `${g.originHead}\n`) : result(1, '', 'not a symbolic ref') }
      if (args.startsWith('merge-base --is-ancestor') && e.argv[e.argv.length - 1] === 'HEAD') return { value: (g.descends ?? []).includes(e.argv[e.argv.length - 2]) ? result(0) : result(1) }
      if (args.startsWith('merge-base --is-ancestor')) return { value: (g.merged ?? []).includes(e.argv[e.argv.length - 1]) ? result(0) : result(1) }
      if (args.startsWith('merge-base')) return { value: result(0, `${g.forkPoint ?? 'base0'}\n`) }
      if (args.startsWith('diff --name-only')) return { value: result(0, (g.files ?? []).join('\n')) }
      return { value: result(0, '') }
    }
    if (e.argv[0] === 'gh') { data.ghCalls.push(e); return { value: data.gh === null ? result(1, '', 'gh: not logged in') : result(0, JSON.stringify(data.gh)) } }
    if (e.argv[0] === 'claude' && e.argv[1] === 'logs') return { value: result(0, data.logs[e.argv[2]] ?? '') }
    if (e.argv[0] === 'claude' && e.argv[1] === 'stop') {
      data.stops.push(String(e.argv[2]))
      if (data.stopError !== null) return { value: result(1, '', data.stopError) }
    }
    if (e.argv[0] === 'claude' && e.argv[1] === '--bg') { data.launches.push(e); return { value: await data.launch(e) } }
    data.processCalls.push(e)
    return { value: await data.run(e) }
  })
  on('mcp.call', (_: any, e: any) => {
    data.mcpCalls.push(e)
    const body = String(e.args?.path ?? '').endsWith('/statuses') ? data.statuses : data.prs
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } }
  })
  on('session.usage', () => ({ value: data.usage }))
  on('session.id', () => ({ value: 'fixture-session' }))
  on('session.root', () => ({ value: data.root }))
  on('store.get', (_: any, e: any) => ({ value: data.store[e.key] ?? null }))
  on('store.set', (_: any, e: any) => { data.store[e.key] = e.value; return { value: undefined } })
  on('ui.toast', (_: any, e: any) => { data.toasts.push(e.text); return { value: undefined } })
  on('ui.status', (_: any, e: any) => { data.status = e.text; return { value: undefined } })
  on('ui.open', (_: any, e: any) => {
    data.opens.push(e)
    const placed = data.placeOpen(e)
    data.panes = [...data.panes.filter((p: any) => p.id !== e.id), { id: e.id, title: e.title ?? e.id, isShown: placed, isFocused: false, isPlaced: placed }]
    return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'needs 144 columns, 120 now' } }
  })
  on('ui.close', (_: any, e: any) => { data.closes.push(e); data.panes = data.panes.filter((p: any) => p.id !== e.id); return { value: undefined } })
  on('ui.panes', () => ({ value: data.panes }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    const q = e.questions?.[0]
    const labels = ((q?.options ?? []) as any[]).map(o => String(o?.label ?? o))
    data.asks.push(String(q?.question ?? ''))
    data.askOptions.push(labels)
    return { result: { questions: e.questions, answers: { [String(q?.question ?? '')]: labels.includes('核准並派工') ? data.approve : data.answer } } }
  })
  // 拒絕＝交給核心：測試裡沒有核心的實作，$.command.run 會被拒（跟 Claude Code 不讓 plugin 執行一樣是 reject）。
  on('command.run', { command: 'reload-plugins' }, async (_: any, e: any, next: any) => {
    if (!data.reloadable) { if (data.refuseAfterNewLoad) data.newerLoaded = true; return next(e) }
    const toasts = [...data.toasts]
    const seen = data.feedAtReload ? await data.feedAtReload() : undefined
    data.reloads.push({ toasts, ...(seen === undefined ? {} : { seen }) })
    return { text: 'Reloaded plugins' }
  })
  on('prompt.fill', (_: any, e: any) => { data.fills.push({ text: e.text, mode: e.mode }); return { isFilled: data.fillable } })
  on('prompt.submit', (_: any, e: any) => { data.submitted.push(e); return { text: e.text, context: e.context } })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  return { data, clock }
}

export const leaves = (node: any, type: string): any[] => typeof node === 'string' ? [] : node?.type === type ? [node] : (node?.children ?? []).flatMap((child: any) => leaves(child, type))
export const text = (node: any): string => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')
/** 畫面字串去掉空白與現在卡每列的狀態邊條（換行處會插進句子），用來比對整句。 */
export const flat = (x: string): string => x.replace(/\s+/g, '').split(EDGE).join('')

/**
 * desk 寫進動態紀錄的內容（新的在前）。面板只在最新一筆是錯誤或警告時顯示一行，一般事件（派工、檢查通過、排隊）要從這裡看。
 * 要在第一次呼叫 $ 之前掛（跟 fixture 一起）。has 用 flat 比對，跟畫面斷言的寫法一樣。
 */
export function feedLog(on: any) {
  const log = {
    list: [] as { at: number; text: string; tone: string; card?: string }[],
    has: (s: string) => log.list.some(e => flat(e.text).includes(flat(s))),
  }
  on('state.set', (_: any, e: any, next: any) => { if (e?.plugin === 'desk' && e?.key === 'feed' && Array.isArray(e.value)) log.list = e.value; return next(e) })
  return log
}
