import { expect, test } from 'claude-code/testing'
import { fixture, BAND, PANE, CARD_B, REGISTRY, NOW, text } from './fixture'
import { setFields } from '../hooks/tutorial'
import { agentsByRoot, asksFor, buildCase, isNoise, lastMeaningful } from '../hooks/model'
import { pipeline, stageLabel } from '../hooks/pipeline'
import { logLines } from '../hooks/extras'
import type { Verify } from '../types'

const BETA = '/home/u/wt/beta'
const SID = 'bbbbbbbb-0000-4000-8000-000000000000'
const LAUNCH = 'desk-launch-1'
const PREFIX = `case-${CARD_B}-`
const APPROVE = `Agent 在等權限批准：到終端機跑 claude agents 選 ${LAUNCH} 批准`
const flat = (x: string) => x.replace(/\s+|▎/g, '') // ▎ 是現在卡每列的狀態邊條，換行處會插進句子
const screen = async (ui: any) => flat(text(await ui.drawn()))

/** 只留 Beta 一件：工作桌派出去的那次停下來（blocked）。 */
function blocked(data: any, agent: Record<string, unknown>, logs = '要先跑整套測試嗎？\n') {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
  data.gh = []
  data.agents = [{ id: 'bbbbbbbb', kind: 'background', cwd: BETA, name: LAUNCH, sessionId: SID, state: 'blocked', startedAt: NOW - 60_000, ...agent }]
  data.logs = { bbbbbbbb: logs }
  data.store.jobs = { [BETA]: { sessionId: SID, last: { launchName: LAUNCH, nativeId: 'bbbbbbbb', sessionId: SID, kind: 'continue', startedAt: NOW - 60_000, fresh: false } } }
}

test('permission wait: a permission prompt asks you to approve in claude agents, not to reply', async ($, on) => {
  // 停在權限提示的 Agent：清單上可能是 status waiting，也可能已經不是 busy（idle）；兩種都要認得。
  const { data } = fixture(on)
  for (const status of ['waiting', 'idle']) {
    blocked(data, { status, waitingFor: 'permission prompt' })
    data.toasts.length = 0

    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    const ui = await $.ui.mount(PANE(120))
    const shown = await screen(ui)

    // 任務狀態：等你批准權限，不是等你回覆
    expect(shown).toContain(flat('等批准'))
    expect(shown).not.toContain(flat('等回覆'))
    expect(shown).not.toContain(flat('Agent 等待你回覆'))
    // ▶ 輪到你：去 claude agents 批准
    expect(shown).toContain(flat(`▶ 輪到你`))
    expect(shown).toContain(flat(APPROVE))
    expect(shown).not.toContain(flat('按 y 回覆'))
    // 動作列：沒有 y（回覆），有 k（停止）與 l（輸出）
    expect(await ui.find({ key: `${PREFIX}reply` })).toBeUndefined()
    expect((await ui.find({ key: `${PREFIX}stop` }))?.props?.hotkey).toBe('k')
    expect((await ui.find({ key: `${PREFIX}logs` }))?.props?.hotkey).toBe('l')
    await ui.unmount()

    // 六段：實作段停在「等你批准權限」，不是「Agent 處理中」（status waiting 也一樣）
    const info = status === 'waiting' ? agentsByRoot(data.agents)[BETA] : asksFor(data.agents, LAUNCH)
    const c = buildCase({ name: 'Beta', statusPath: CARD_B }, data.files[CARD_B]!, NOW, { [BETA]: info! }, undefined)
    expect(stageLabel(pipeline(c, undefined))).toBe('實作・Agent 等你批准權限')
    // 同一 HEAD 有檢查結果也一樣：等批准的 Agent 做到一半，通過的結果不能推進到「待審查」、失敗的不能停在「檢查未通過」
    const held = { ...c, git: data.git[BETA] }
    const passed: Verify = { command: c.verify, at: NOW, ok: true, exitCode: 0, tail: [], truncated: false, head: 'g1' }
    expect(stageLabel(pipeline(held, passed))).toBe('實作・Agent 等你批准權限')
    expect(stageLabel(pipeline(held, { ...passed, ok: false, exitCode: 1 }))).toBe('實作・Agent 等你批准權限')

    // 摘要列同樣措辭
    const band = await $.ui.mount(BAND(200))
    const bar = flat(text(await band.drawn()))
    expect(bar).toContain(flat(`輪到你：${APPROVE}`))
    expect(bar).not.toContain(flat('按 y 回覆'))
    await band.unmount()

    // /desk reply 也不送：說清楚它在等權限批准
    const out: any = await $.command.run({ command: 'desk', args: 'reply Beta 好' } as any)
    const said = [String(out?.text ?? ''), ...data.toasts].join('\n')
    expect(said).toContain('Agent 在等權限批准，不是提問')
    expect(data.launches).toHaveLength(0)
    expect(data.asks).toHaveLength(0)
  }
})

test('permission wait: a blocked agent waiting on anything else still asks you to reply', async ($, on) => {
  const { data } = fixture(on)
  for (const agent of [{ status: 'waiting', waitingFor: 'input needed' }, { status: 'idle' }]) {
    blocked(data, agent)

    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    const ui = await $.ui.mount(PANE(120))
    const shown = await screen(ui)

    expect(shown).toContain(flat('等回覆'))
    expect(shown).toContain(flat('按 y 回覆 Agent 的提問'))
    expect(shown).not.toContain(flat('等權限批准'))
    expect((await ui.find({ key: `${PREFIX}reply` }))?.text).toBe('↩ 回覆')
    await ui.unmount()
  }
})

/** 背景 Agent 的 `claude logs`：整個畫面的重繪紀錄，顏色、游標移動、轉圈圈與狀態列夾在句子裡。 */
const QUESTION = '要先跑整套測試，還是只跑 permission-wait 的測試？'
const REPAINT = [
  '\u001b[2C\u001b[1B-\u001b[5G測試已寫好\u001b[K\n',
  '\u001b[1B⏺\u001b[3G要先跑整套測試，還是\u001b[38;2;153;153;153m只跑\u001b[39m\u001b[28Gpermission-wait\u001b[44G的測試？\u001b[K\n',
  '\u001b[42B✻\u001b[3GCogitated fo\u001b[16G 2m 43s · done 3:20 PM\u001b[K\n\u001b[3B❯ \u001b[50;1H\u001b[46;3H\u001b[H\n',
  '\u001b[43C\u001b[49B51\u001b[50;1H\u001b[46;3H\u001b[H\n\u001b[38C\u001b[47B51\u001b[46G3\u001b[50;1H\n',
  '\u001b[43C\u001b[47B62m31s │ 5h:40% 7d:43%\n\u001b[2C\u001b[1B+20/-22 │ stale-ask\u001b[K\u001b[50;1H\n',
  '\u001b[160C\u001b[43Bnew task? /clear to save 129.3k tokens\u001b[50;1H\u001b[46;3H\u001b[H',
].join('')

test('last line: terminal control codes are stripped before picking the question', async ($, on) => {
  // 游標右移、跳到某一欄是字與字之間的空白，不是換行；顏色碼直接拿掉。狀態列、計時、token 計數不算一句話。
  expect(lastMeaningful(REPAINT)).toBe(QUESTION)

  const { data, clock } = fixture(on)
  blocked(data, { status: 'waiting', waitingFor: 'input needed' }, REPAINT)
  data.answer = '取消'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(120))
  await ui.press({ key: `${PREFIX}reply` })
  await clock.settle()
  expect(data.asks).toHaveLength(1)
  expect(data.asks[0]).toContain(`Agent 提問：${QUESTION}`)
  expect(data.asks[0]).not.toMatch(/\u001b|to save|7d:43%/)

  // 全是控制碼、沒有一句話：才說讀不到
  data.logs = { bbbbbbbb: '\u001b[43C\u001b[49B51\u001b[50;1H\u001b[46;3H\u001b[H\u001b[2K\u001b[?25l\u001b[38;2;153;153;153m\u001b[39m' }
  await ui.press({ key: `${PREFIX}reply` })
  await clock.settle()
  expect(data.asks).toHaveLength(2)
  expect(data.asks[1]).toContain('讀不到 Agent 的提問，按 l 看輸出')
  await ui.unmount()
})

/**
 * 真實的 `claude logs` 尾段（三個背景 Agent，分支名、路徑、人名已換成假的；中間只轉圈圈的重繪略去）。
 * 共同的形狀：最後一句在畫面中段，之後是計時、`new task?`、狀態列「<分支> │ +n/-m │ <worktree>」；
 * 狀態列只重繪有變的格子，所以尾段裡常是「r leas v14.2.6」這種斷字碎片。
 */
const REAL_LOGS: [string, string][] = [
  // 8c905a3b：API 錯誤後停住；狀態列「release/v14.2.6 │ +115/-0 │ permission-wait」畫在最後
  ["\u001b[H\u001b[38;2;78;186;101m⏺\u001b[39m Background command \"python3\u001b[31G-\u001b[33G<<'EOF'\r\u001b[1Bdef\u001b[5Gedit(p, old, new):\u001b[K\r\u001b[4C\u001b[1Bs=open(p,encoding='utf-8').rea\u001b[36G()\u001b[K\r\u001b[4C\u001b[1Bassert s.cou\u001b[18Gt(old)\u001b[25G=1, (p, old[:70])\u001b[K\r\u001b[1B    \u001b[6Gpen(p,'w',encoding='utf-8').write(s.replace(old,new,1))\r\u001b[1BM='hooks/model.ts'\u001b[K\r\u001b[1Bedit(M\u001b[44G行首的轉圈圈、項目符號拿掉，連續空白併成一格。\r\u001b[6C\u001b[1B,\u001b[9G\"\"\"\u001b[13G*\u001b[15G其他游標移動與\u001b[30G\\\\r\u001b[34G才是分行。連續空白併成一格。\r\u001b[1B */\"\"\")\u001b[9G\u001b[K\r\u001b[1Bedit(M, \"\"\"  \u001b[15G .map(l\u001b[23G=> plain\u001b[34G.replace(/\\\\s+/g, '\u001b[54G').trim().replace(/^[⏺●✻✽✢✳✶·❯]\\\\s*/, ''\u001b[95G)\r\u001b[37C\u001b[1B,\u001b[40G\"\"\"\u001b[47G.map(l\u001b[54G=>\u001b[57Gplain(l).replace(/\\\\s+/g,\u001b[83G'\u001b[85G').trim())\r\u001b[1B    .filter(l => l && !isNoise(l))\"\"\")\u001b[K\r\u001b[1C\u001b[1Bdit(M, \"\"\"/** Agen\u001b[21G 記錄的最後一句有意義的話（見\u001b[51GscreenLines），略過雜訊。\u001b[77G*/\r\u001b[1Bexport function lastMeaningful\u001b[32Graw:\u001b[37Gstring, max = 120): string {\u001b[K\r\u001b[1B  return (screenLines(raw).pop() ?? '').replace(/^\\\\[[^\\\\]]*\\\\]\\\\s*/, '').slice(0, max)\u001b[K\r\u001b[1B}\"\"\", \"\"\"/** Agent 記錄的最後一句有意義的話（見\u001b[49GscreenLines），略過雜訊；行首的轉圈圈、項目符號與\u001b[99G[標籤]\u001b[106G拿掉。\u001b[113G*/\r\u001b[1Bexport function lastMeaningful\u001b[32Graw:\u001b[37Gstring, max = 120): string {\u001b[K\r\u001b[1B  return\u001b[10G(screenLines(raw).pop()\u001b[34G??\u001b[37G'').replace(/^[⏺●✻✽✢✳✶·❯]\\\\s*/,\u001b[69G'').replace(/^\\\\[[^\\\\]]*\\\\]\\\\s*/,\u001b[103G'').slice(0,\u001b[116Gmax)\r\u001b[1B}\"\"\")\u001b[K\r\u001b[1Bedit('tests/model.test.ts',\u001b[29G\"toEqual({\u001b[40Gask:\u001b[45G2,\u001b[48Greply:\u001b[55G0,\u001b[58Ggate:\u001b[64G0,\",\u001b[69G\"toEqual({\u001b[80Gask:\u001b[85G2,\u001b[88Greply:\u001b[95G0,\u001b[98Gapprove:\u001b[107G0,\u001b[110Ggate:\u001b[116G0,\")\r\u001b[1B\u001b[K\r\u001b[1B# restructu\u001b[13Ge loops in permission-wait\u001b[40Gtest:\u001b[46Gone\u001b[50Gfixture\u001b[58Gper\u001b[62Gtest\r\u001b[1BP='\u001b[5Gests/permission-wait.\u001b[27Gest.tsx'\u001b[K\r\u001b[1Bedit(P, \"\"\"\u001b[13G for\u001b[18G(const status of\u001b[35G['waiting',\u001b[47G'idle'])\u001b[56G{\r\u001b[4C\u001b[1Bconst { \u001b[17G } = fixture(on)\u001b[K\r\u001b[1B    blocked(da\u001b[16Ga,\u001b[19G{ status, waitingFor:\u001b[41G'permission\u001b[53Gprompt'\u001b[61G})\r\u001b[1B\"\"\", \"\"\"  con\u001b[16G { data\u001b[24G} = fixture(on)\u001b[K\r\u001b[2C\u001b[1Bfor (\u001b[9Gonst s\u001b[17Gtus\u001b[21Gof ['waiting', 'idle\u001b[42G]) {\u001b[K\r\u001b[4C\u001b[1Bblocked(data, { status,\u001b[29GwaitingFor:\u001b[41G'permission\u001b[53Gprompt'\u001b[61G})\r\u001b[1B    data.toasts.length\u001b[24G=\u001b[26G0\r\u001b[1B\"\"\")\u001b[K\r\u001b[1Bedit(P, \"\"\"\u001b[13G for\u001b[18G(const agent of\u001b[34G[{\u001b[37Gstatus:\u001b[45G'waiting',\u001b[56GwaitingFor:\u001b[68G'input\u001b[75Gneeded'\u001b[83G},\u001b[86G{\u001b[88Gstatus:\u001b[96G'idle'\u001b[103G}])\u001b[107G{\r\u001b[4C\u001b[1Bconst { \u001b[17G } = fixture(on)\u001b[35G\u001b[K\r\u001b[2C\u001b[1B  blo\u001b[9Gked(d\u001b[15Gta, agent)\"\"\", \"\"\"\u001b[34G const { dat\u001b[47G } = fixture(on)\u001b[64G\u001b[K\r\u001b[2C\u001b[1Bfor (\u001b[9Gonst \u001b[15Ggent of [{ status:\u001b[34G'waiting',\u001b[45GwaitingFor:\u001b[57G'input\u001b[64Gneeded'\u001b[72G},\u001b[75G{\u001b[77Gstatus:\u001b[85G'idle'\u001b[92G}])\u001b[96G{\r\u001b[1B   \u001b[5Gblocked(data,\u001b[19Gagent)\"\"\")\r\u001b[1BEOF\u001b[K\r\u001b[1Bclaude plugin\u001b[15Gtest\u001b[20G.\u001b[22G>\u001b[24G/Users/alice/.claude/jobs/8c905a3b/tmp/run3.txt\u001b[72G2>&1;\u001b[78Gecho\u001b[83Gexit=$?;\u001b[92Ggrep\u001b[97G-E\u001b[100G\"^\\(fail\\)|pass$|fail$|^Ran\"\u001b[129G/Users/alice/.claude/jobs/8c905a3b/tmp/run3.txt\u001b[177G|\u001b[179Gtail\u001b[184G-15\"\u001b[189Gcompleted\r\u001b[1B(exit\u001b[7Gcode\u001b[12G0)\r\u001b[1B\u001b[K\r\u001b[1B\u001b[38;2;255;193;7m⏺\u001b[3GAPI Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)\r\u001b[1B\u001b[39m\u001b[K\r\u001b[1B\u001b[38;2;153;153;153m✻\u001b[39m \u001b[38;2;153;153;153mChurned\u001b[11Gfor\u001b[15G1h 5m 38s\u001b[25G· done 2:51\u001b[37GAM\u001b[39m\u001b[K\r\u001b[3B❯ \u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[47B\u001b[90m4461m27s\u001b[39m\u001b[K\r\u001b[3C\u001b[1B\u001b[90mrelease/v14.2.6\u001b[38;2;153;153;153m │ \u001b[32m+115\u001b[38;2;153;153;153m/\u001b[31m-0\u001b[38;2;153;153;153m │ \u001b[34mpermission-wait\u001b[39m\u001b[K\u001b[50;1H\u001b[46;3H", "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"],
  // ccda8031：額度用完；狀態列沒有 +n/-m、只剩碎片「r leas v14.2.6 │ payment-business-type-v14.2.6」
  ["\u001b[H\u001b[3G\u001b[48;2;55;55;55m\u001b[38;2;255;255;255m先讀專案常犯錯誤清單 /Users/alice/.claude/handoffs/acme-widget-gitlab/revi\u001b[78Gw-pitfalls.md，逐條對照這次的改動。\u001b[39m                                                                      \r\u001b[2C\u001b[1B\u001b[38;2;255;255;255m問題分 CRITICAL（資安、資料外洩、資料毀損）、HIGH（實際的 bug、漏套 AccessFilter、漏稽核、測試沒測到需求）、MEDIUM（可維護性）、LOW（風格）四級。每條寫成「- [等級][類別] 檔案:行 — \r\u001b[2C\u001b[1B說明」，類別用短詞（例如 資料範圍、稽核、個資、測試、命名）。寫進 .task/REVIEW.md（整份覆寫）。\u001b[39m              \r\u001b[2C\u001b[1B\u001b[38;2;255;255;255m最後把卡片 關卡 寫成這個格式，四個數字都要有：review：CRITICAL <n>、HIGH <n>、MEDIUM <n>、LOW <n>；<一句結論>\u001b[39m                        \r\u001b[2C\u001b[1B\u001b[38;2;255;255;255m審完後看 /U\u001b[15Gers/rey\u001b[23Gs/.claude\u001b[33Ghandoffs/isoc\u001b[47Ga\u001b[49Gwork-g\u001b[56Gtlab/reviews 裡過去的審查紀錄：這次某條發現的類別若過去已出現過、而清單沒有，在 \u001b[39m               \r\u001b[2C\u001b[1B\u001b[38;2;255;255;255m/Users/alice/.claude/handoffs/acme-widget-gitlab/review-pitfalls.md 檔尾追加一行「- 類別：怎麼避免」。這是唯一可以寫的根目錄外檔案；不要改既有條目。\r\u001b[2C\u001b[1B不改程式、不 commit。\u001b[39m        \r\u001b[2C\u001b[1B\u001b[38;2;255;255;255m任務：訂單匯出類型（v14.2.6）\u001b[39m                                                     \r\u001b[2C\u001b[1B\u001b[38;2;255;255;255m根目錄：/Users/r\u001b[20Gyes/Workspace/acme-widget-worktrees/payment-business-type-v26\u001b[82G2.6\u001b[39m            \r\u001b[6C\u001b[1B\u001b[38;2;255;255;255m：/Users/alice/Workspace/acme-widget-worktrees/payment-business-type-v14.2.6/.desk/CARD.md\u001b[39m                                          \r\u001b[6C\u001b[1B\u001b[38;2;255;255;255m要精簡：狀態一句話 60 字內、下一步 40 字內，多件事用「；」分開；commit、測試數字、檔案清單等細節寫在卡片下方的歷程，不要塞進這兩欄。\u001b[39m                                                 \r\u001b[2C\u001b[1B\u001b[38;2;255;255;255m卡片在 .desk/CARD.md（或 .console/STATUS.md）；結束這一輪前把五欄寫回，每欄一行。保留卡片既有的欄位名，不要改名：舊卡用「驗證」「等使用者」，新卡用「檢查」「等你」，工作桌兩種都讀得懂。\r\u001b[2C\u001b[1B寫入前重讀卡片；內容與你開始時讀到的不同就停止並回報衝突，不要覆寫。\u001b[39m                         \r\u001b[2C\u001b[1B\u001b[38;2;255;255;255m檢查欄只放一條可執行的完成檢查（反引號），exit 0 代表做完；發現寫在 狀態 或 .task/REPORT.md。\r\u001b[2C\u001b[1B要 Alice 決定的事寫進 等你（有選項寫成 問題：A) … B) …）後結束這一輪，不要提問等待。\r\u001b[2C\u001b[1B做完實作：關卡留 無；完成檢查與審查由工作桌自動接手，你不用自己送審查。\u001b[39m                                \r\u001b[2C\u001b[1B\u001b[38;2;255;255;255m只在此任務根目錄作業；不 push、不開 PR、不碰正式環境、不啟動或重建容器、不改 port、不在主工作區切分支。\u001b[39m                                                                         \r\u001b[1B  \u001b[38;2;255;255;255mPHP 測試只能用主工作區容器：docker compose exec -T app php artisan test --parallel --testsuite=Unit,Feature，worktree 用 ~/Workspace/acme-widget-worktrees/.bin/wt-exec <slug>。\u001b[39m                      \r\u001b[2C\u001b[1B\u001b[49m\u001b[K\r\u001b[2C\u001b[1B\u001b[38;2;153;153;153mRead \u001b[1m2\u001b[22m files, listed \u001b[1m3\u001b[22m directories, ran \u001b[1m2\u001b[22m shell commands \r\u001b[1B\u001b[39m\u001b[K\r\u001b[1B\u001b[38;2;255;255;255m⏺\u001b[3G\u001b[39m完成檢查已在背景跑。merge-base\u001b[34G是\u001b[37G0c5d0830（與\u001b[50Grelease/v14.2.6\u001b[66G相同），共\u001b[77G25\u001b[80G個\u001b[83Gcommit、82\u001b[94G檔、+4350/−986，接著逐檔看\u001b[121Gdiff。\r\u001b[2C\u001b[1B\u001b[K\r\u001b[1B  \u001b[38;2;153;153;153mSearched for \u001b[1m2\u001b[22m patterns, ran \u001b[1m5\u001b[22m shell commands \u001b[39m\u001b[K\r\u001b[39C\u001b[1B\u001b[38;2;153;153;153m\u001b[1mcoding-style.md\r\u001b[39C\u001b[1Btes\u001b[44Ging.md\u001b[22m\u001b[39m\u001b[K\r\u001b[39C\u001b[1B\u001b[38;2;153;153;153m\u001b[1mpatterns.md\r\u001b[39C\u001b[1Bhooks.md\u001b[22m\u001b[39m\u001b[K\r\u001b[1B\u001b[38;2;153;153;153m  ⎿  Loaded \u001b[1m../../../.claude/rules/php/security.md\r\u001b[1B\u001b[22m\u001b[39m\u001b[K\r\u001b[1B\u001b[38;2;255;255;255m⏺\u001b[3G\u001b[39m進度：核心授權層（AccessFilter、AppTokenOwner、後台\u001b[55GUserController、審核\u001b[76Gcontroller）看完，目前沒發現擋不住的路徑。接著看\u001b[125GApp\u001b[129GAPI\u001b[133G與\u001b[136Glegacy\u001b[143G路由。\r\u001b[2C\u001b[1B\u001b[K\r\u001b[1B  \u001b[38;2;153;153;153mSearched for \u001b[1m2\u001b[22m patterns, ran \u001b[1m6\u001b[22m shell commands \u001b[39m\u001b[K\r\u001b[1B\u001b[38;2;153;153;153m  ⎿  \u001b[38;2;255;107;128mYou've hit your session limit · resets 6:30pm (Asia/Taipei)\r\u001b[5C\u001b[1B\u001b[38;2;153;153;153m/usage-credits to request more usage from your admin.\r\u001b[1B\u001b[39m\u001b[K\r\u001b[1B\u001b[38;2;153;153;153m✻\u001b[3GCrunched for 2m 10s · done 5:02 PM\r\u001b[1B\u001b[39m\u001b[K\r\u001b[1B\u001b[38;2;78;186;101m⏺\u001b[39m Background command \"背景執行完成檢查（目標＋整套）\" completed (exit\u001b[71Gcode\u001b[76G0)\r\u001b[1B\u001b[38;2;153;153;153m  ⎿  \u001b[38;2;255;107;128mYou've hit your session limit · resets 6:30pm (Asia/Taipei)\r\u001b[5C\u001b[1B\u001b[38;2;153;153;153m/usage-credits to request more usage from your admin.\r\u001b[1B\u001b[39m\u001b[K\r\u001b[1B\u001b[38;2;153;153;153m✻\u001b[39m \u001b[38;2;153;153;153mSautéed\u001b[11Gfor 0s · done 5:02 PM\u001b[39m\u001b[K\r\u001b[3B❯ \u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[47B\u001b[90m89\u001b[47G54s\u001b[38;2;153;153;153m │ \u001b[90m7d:53%\u001b[39m\u001b[K\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[47B\u001b[90m6299m59s\u001b[39m\u001b[K\r\u001b[3C\u001b[1B\u001b[90mr\u001b[6Gleas\u001b[12Gv14.2.6\u001b[38;2;153;153;153m │ \u001b[34mpayment-business-type-v14.2.6\u001b[39m\u001b[K\u001b[50;1H\u001b[46;3H", '/usage-credits to request more usage from your admin.'],
  // eb374cfa：審查做完；狀態列碎片「tale- sk │ +38/-0 │ stale-ask」
  ["\u001b[H\u001b[6G\u001b[K\r\u001b[5C\u001b[1B\u001b[K\r\u001b[1B\u001b[38;2;255;255;255m⏺\u001b[3G\u001b[39mNow update the card:\u001b[24Gre-read\u001b[32Gfirst\u001b[38Gand\u001b[42Gcompare.\r\u001b[2B \u001b[3G\u001b[38;2;153;153;153mRan \u001b[1m2\u001b[22m shell commands \u001b[39m\u001b[K\r\u001b[2B\u001b[38;2;255;255;255m⏺\u001b[3G\u001b[39m\u001b[1m審查過關：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 4。\u001b[51G\u001b[22mAC-1～AC-5\u001b[62G都有實作，每條也都有測試驗到「則」那一欄的結果。剩一條\u001b[117GMEDIUM\u001b[124G要你決定。\r\u001b[2B \u001b[3G\u001b[1m要你決定的 MED\u001b[18GUM\u001b[22m\u001b[K\r\u001b[2C\u001b[2B\u001b[38;2;177;185;249mhooks/register.tsx:164\u001b[39m：重新整理時會先等「停掉舊\u001b[52GAgent」做完才往下走。每個\u001b[78G\u001b[38;2;177;185;249mclaude stop\u001b[90G\u001b[39m一個接一個跑，各最多等\u001b[113G30\u001b[116G秒。如果卡住，這一輪的自動流程跟下一次重新整理最多會晚「30\u001b[175G秒\u001b[178G×\u001b[180G被停的\u001b[187GAgent\r\u001b[2C\u001b[1B數」。每個\u001b[14GAgent\u001b[20G只會發生一次。\r\u001b[2C\u001b[1B\u001b[K\r\u001b[2C\u001b[1B已寫進卡片「等你」：A) 不修，記錄原因\u001b[41GB)\u001b[44G修掉\u001b[49GC)\u001b[52G改規格。要修的話，改成不等它，或讓幾個\u001b[91G\u001b[38;2;177;185;249mclaude stop\u001b[103G\u001b[39m同時跑。\r\u001b[2C\u001b[2B\u001b[1m完成檢查（我自己重跑三次）\u001b[22m\u001b[K\r\u001b[2C\u001b[2B┌──────┬──────────────────────────┬──────────┐\r\u001b[2C\u001b[1B│\u001b[5G次數\u001b[10G│\u001b[22G結果\u001b[37G│\u001b[39G機器負載\u001b[48G│\r\u001b[2C\u001b[1B├\u001b[10G┼\u001b[37G┼\u001b[48G┤\r\u001b[4C\u001b[1B1   \u001b[12Gexit\u001b[17G1，270 過、6\u001b[30G支逾時\u001b[39G63      \r\u001b[4C\u001b[2B2\u001b[22G5\u001b[28G1\u001b[39G7\r\u001b[4C\u001b[2B3\u001b[12G\u001b[1mexit 0，276 全過\u001b[22m \u001b[30G      \u001b[39G58–66\r\u001b[2C\u001b[1B└\u001b[10G┴\u001b[37G┴\u001b[48G┘\r\u001b[2C\u001b[1B\u001b[K\r\u001b[2C\u001b[1B前兩次失敗都是 5 秒逾時，逾時的都不是本卡測試。那些測試裡沒有停在提問的\u001b[75GAgent，新程式根本不會動到。同一支測試第三次只跑了\u001b[125G2\u001b[127G秒，判斷是機器太忙。五支\u001b[152G\u001b[38;2;177;185;249mstale ask:\u001b[163G\u001b[39m三次都過。\r\u001b[2C\u001b[2B\u001b[1mLOW（4 條，不擋合併）\u001b[22m\u001b[K\r\u001b[2C\u001b[2B- \u001b[38;2;177;185;249mhooks/model.ts:162-163\u001b[39m：同一個判斷對每個\u001b[46GAgent\u001b[52G跑了兩次，可以一次分成兩邊。\r\u001b[2C\u001b[1B-\u001b[5G\u001b[38;2;177;185;249mhooks/model.ts:163\u001b[39m：被取代的\u001b[34GAgent\u001b[40G如果沒有\u001b[49Gid，會從畫面消失，但不會被停掉，「最近」也不會記。正常情況都有\u001b[112Gid，影響很小。\r\u001b[10C\u001b[1B\u001b[38;2;177;185;249mstale-agents.ts:43-44\u001b[39m：有三處用 \u001b[38;2;177;185;249mcard!\u001b[39m 硬說不會是空值，換個寫法就能拿掉。\r\u001b[10C\u001b[1B\u001b[38;2;177;185;249mregister.tsx\u001b[25G\u001b[39m現在 871\u001b[34G行，超過 800 行上限。改之前就有 866 行，這次只多 5 行。\u001b[K\r\u001b[2C\u001b[1B\u001b[K\r\u001b[2C\u001b[1B\u001b[1m寫在哪\u001b[22m\u001b[K\r\u001b[2C\u001b[2B- 審查檔：\u001b[38;2;177;185;249m.task/REVIEW.md\u001b[39m，開頭是規格對照表。\r\u001b[2C\u001b[1B-\u001b[5G卡片：寫入前重讀過，跟開始時一樣，才寫回五欄並在\u001b[54GHistory\u001b[62G加了一筆。關卡現在是\u001b[83G\u001b[38;2;177;185;249mreview：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 4；規格全做到且有測試，可合併\u001b[39m，下一步是「決定\u001b[171GMEDIUM\u001b[178G後\u001b[181Gpush、開\u001b[190GPR」。\r\u001b[4C\u001b[1B沒改程式、沒 commit。我本來想把 main 的版本解到暫存資料夾跑一次測試做對照，這個指令被權限擋掉，所以沒做。\r\u001b[2C\u001b[1B\u001b[K\r\u001b[1B\u001b[38;2;215;119;87m✳\u001b[3GSynthesizing… \u001b[38;2;153;153;153m(4m 1s · ↓\u001b[28G17.1k tokens)\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[17C\u001b[42B\u001b[38;2;153;153;153mrunning\u001b[26GStop hooks… 0/7 · 4m 5s · ↓\u001b[54G17.1k tokens)\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[45C\u001b[47B\u001b[90m9\r\u001b[8C\u001b[1Btale-\u001b[15Gsk\u001b[38;2;153;153;153m │ \u001b[32m+38\u001b[38;2;153;153;153m/\u001b[31m-0\u001b[38;2;153;153;153m │ \u001b[34mstale-ask\u001b[39m\u001b[K\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[47B\u001b[90m63m55s\u001b[51G\u001b[38;2;153;153;153m│ \u001b[90m5h:37%\u001b[38;2;153;153;153m \u001b[90m7d:42%\r\u001b[2C\u001b[1B\u001b[32m+38\u001b[38;2;153;153;153m/\u001b[31m-0\u001b[38;2;153;153;153m │ \u001b[34mstale-ask\u001b[39m\u001b[K\u001b[50;1H\u001b[46;3H", '沒改程式、沒 commit。我本來想把 main 的版本解到暫存資料夾跑一次測試做對照，這個指令被權限擋掉，所以沒做。'],
]

test('last line: real claude logs never end on the status line or a repaint fragment', async ($, on) => {
  for (const [raw, sentence] of REAL_LOGS) {
    const last = lastMeaningful(raw)
    expect(last).toBe(sentence)
    expect(last).not.toMatch(/│|\+\d+\/-\d+|\bv14\.2\.6\b/)
  }

  // 按 y 回覆時題目也是那一句
  const { data, clock } = fixture(on)
  blocked(data, { status: 'waiting', waitingFor: 'input needed' }, REAL_LOGS[2]![0])
  data.answer = '取消'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(120))
  await ui.press({ key: `${PREFIX}reply` })
  await clock.settle()
  expect(data.asks).toHaveLength(1)
  expect(data.asks[0]).toContain(`Agent 提問：${REAL_LOGS[2]![1]}`)
  expect(data.asks[0]).not.toMatch(/stale-ask|\+38\/-0/)
  await ui.unmount()
})

/**
 * 短 session 的真實 `claude logs`（完整或只去掉中段；路徑、分支名、人名、Agent 名字已換成假的）：
 * 總輸出夠短時紀錄從 Claude Code 啟動的整頁畫起，畫面最底的輸入框「──…── <名字> ─」、`❯`、框線、模型列、分支列、
 * 模式列「⏸ manual mode on · ← for agents」都在畫面裡。真實紀錄列與列之間是 \r（回到行首），列由它後面的 \e[nB 決定；這兩份 fixture 保留 \r。
 */
const SHORT_LOGS: [string, string][] = [
  // 7ed14dbf：啟動後打錯指令就停住（整份）；最後一句在畫面上段，輸入框以下是模型列、分支列與殘留的模式列
  ["\u001b7\u001b8\u001b[2J\u001b[H\u001b[H\r\u001b[1B\u001b[38;2;215;119;87m ▐\u001b[48;2;0;0;0m▛███▛█\u001b[12G\u001b[39m\u001b[49m\u001b[1mClaude Code\u001b[24G\u001b[22m\u001b[38;2;153;153;153mv2.1.270\r\u001b[1B\u001b[38;2;215;119;87m▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀\u001b[12G\u001b[38;2;153;153;153mFable 5.1 with high effort · Claude Team\r\u001b[1B\u001b[38;2;215;119;87m  ▝▝ ▝▝  \u001b[12G\u001b[38;2;153;153;153m@claude · ~/Workspace/acme-widget-gitlab\r\u001b[3B⏺\u001b[3Gecc: hooks.json: unknown keys \"$schema\", \"description\" in \r\u001b[2C\u001b[1Bhooks.PreToolUse[0], \"id\" in hooks.PreToolUse[0], \"description\" in \r\u001b[2C\u001b[1Bhooks.PreToolUse[1], \"id\" in hooks.PreToolUse[1] and 58 more ignored\r\u001b[68C\u001b[39B● high · /effort\r\u001b[1B\u001b[38;2;136;136;136m───────────────────────────────────────────────────────────────────────────── claude ─\r\u001b[1B\u001b[39m❯ \u001b[7m \r\u001b[1B\u001b[27m\u001b[38;2;136;136;136m──────────────────────────────────────────────────────────────────────────────────────\r\u001b[2C\u001b[2B\u001b[38;2;153;153;153m⏸ manual mode on · ← for agents\u001b[39m\u001b[53;1H\u001b[50;3H\u001b[H\r\u001b[10B\u001b[38;2;255;193;7m⏺\u001b[3GUnknown command: /qiot. Did you mean /quit?\u001b[39m\u001b[53;1H\u001b[50;3H\u001b[H\r\u001b[68C\u001b[46B\u001b[38;2;153;153;153m● high · /effort\r\u001b[1B\u001b[38;2;136;136;136m───────────────────────────────────────────────────────────────────────────── claude ─\r\u001b[1B\u001b[39m❯ \u001b[7m \u001b[27m\u001b[K\r\u001b[1B\u001b[38;2;136;136;136m──────────────────────────────────────────────────────────────────────────────────────\r\u001b[1B\u001b[39m  \u001b[38;2;114;102;234m◆\u001b[38;2;153;153;153m \u001b[36mFable 5.1\u001b[38;2;153;153;153m │ \u001b[38;2;60;60;60m░░░░░░░░░░\u001b[38;2;153;153;153m \u001b[32m0%\u001b[38;2;153;153;153m \u001b[90m1M\u001b[38;2;153;153;153m │ \u001b[90m$0.00\u001b[39m\u001b[K\r\u001b[2C\u001b[1B\u001b[90m⎇release/v14.2.2\u001b[38;2;153;153;153m │ \u001b[34macme-widget-gitlab\u001b[38;2;153;153;153m │ \u001b[33m⚙ claude\u001b[39m\u001b[53;1H\u001b[49;3H\u001b[H\r\u001b[68C\u001b[46B\u001b[K\u001b[53;1H\u001b[49;3H\u001b[H\r\u001b[2C\u001b[48B\u001b[K\u001b[53;1H\u001b[49;3H\u001b[H\r\u001b[5B\u001b[38;2;255;193;7m⚠\u001b[3GYour login expires in 3 days\u001b[38;2;153;153;153m · run /login to renew\r\u001b[1B\u001b[39m\u001b[K\r\u001b[1B\u001b[38;2;153;153;153m⏺\u001b[3Gecc: hooks.json: unknown keys \"$schema\", \"description\" in \u001b[39m\u001b[K\r\u001b[19C\u001b[1B\u001b[38;2;153;153;153m0\u001b[49G0\u001b[51G, \"\u001b[55Gescription\" in \u001b[39m\u001b[K\r\u001b[2C\u001b[1B\u001b[38;2;153;153;153mhooks.PreToolUse[1], \"id\" in hooks.PreToolUse[1] and 58 more ignored\r\u001b[1B\u001b[39m\u001b[K\r\u001b[1B\u001b[38;2;255;193;7m⏺\u001b[3GUnknown command: /qiot. Did you mean /quit?\u001b[39m\u001b[53;1H\u001b[49;3H\u001b[H\r\u001b[5B\u001b[K\r\u001b[1B\u001b[38;2;153;153;153m⏺\u001b[3Gecc: hooks.json: unknown keys \"$schema\", \"description\" in \r\u001b[1B\u001b[39m \u001b[3G\u001b[38;2;153;153;153mhooks.PreToolUse[0], \"id\" in hooks.PreToolUse[0], \"description\" in \r\u001b[19C\u001b[1B1\u001b[49G1\u001b[51G an\u001b[55G 58 more ignored\r\u001b[2C\u001b[1B\u001b[39m\u001b[K\r\u001b[1B\u001b[38;2;255;193;7m⏺\u001b[3GUnknown command: /qiot. Did you mean /quit?\r\u001b[1B\u001b[39m\u001b[K\u001b[53;1H\u001b[49;3H", 'Unknown command: /qiot. Did you mean /quit?'],
  // f24e1427：工作桌派的同步，做完回一段結論就停住；輸入框的框線夾著 Agent 名字
  ["\u001b7\u001b8\u001b[2J\u001b[H\u001b[H\r\u001b[1B\u001b[38;2;215;119;87m ▐\u001b[48;2;0;0;0m▛███▛█\u001b[12G\u001b[39m\u001b[49m\u001b[1mClaude Code\u001b[24G\u001b[22m\u001b[38;2;153;153;153mv2.1.302\r\u001b[1B\u001b[38;2;215;119;87m▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀\u001b[12G\u001b[38;2;153;153;153mHaiku 5.5 with high effort · Claude Team\r\u001b[1B\u001b[38;2;215;119;87m ▝▝   ▝▝ \u001b[12G\u001b[38;2;153;153;153m~/Workspace/acme-worktrees/sync-skill\r\u001b[3B\u001b[48;2;55;55;55m❯ \u001b[38;2;255;255;255m同步卡片：這是新的對話，沒有先前記憶。先讀卡片、git log -5 與 git status，只寫檔案與 git \u001b[39m                                                                                                             \r\u001b[1B  \u001b[38;2;255;255;255m看得到的事實；看不出結果的寫「待確認」，不要補做工作。只在狀態、下一步、檢查確實與事實不符時才改那一欄；歷程只在有新的事實（新 \u001b[39m                                                                       \r\u001b[23B\u001b[49m\u001b[38;2;215;119;87m·\u001b[3GForming… \r\u001b[182C\u001b[1B\u001b[38;2;153;153;153m● high · /effort\r\u001b[1B\u001b[38;2;136;136;136m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── desk-mvq1test0-a ─\r\u001b[1B\u001b[39m❯ \u001b[7m \r\u001b[1B\u001b[27m\u001b[38;2;136;136;136m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\u001b[2C\u001b[2B\u001b[38;2;255;193;7m⏵⏵ auto mode on\u001b[38;2;153;153;153m (shift+tab to cycle) · ← for agents\u001b[39m\u001b[50;1H\u001b[47;3H\u001b[H\r\u001b[22B \u001b[3G\u001b[38;2;153;153;153mRan \u001b[1m2\u001b[22m shell commands \u001b[39m\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[38;2;255;255;255m⏺\u001b[6G\u001b[39m\u001b[K\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[42B\u001b[38;2;215;119;87m✢\u001b[40G\u001b[38;2;181;181;181mthinking with high effort\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[2C\u001b[24B\u001b[1m結論：卡片不用改，這一輪沒有寫入。\r\u001b[18B\u001b[22m\u001b[K\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[2C\u001b[26B我讀了\u001b[10G\u001b[38;2;177;185;249m.desk/CARD.md\u001b[39m、\u001b[38;2;177;185;249mgit log -5\u001b[36G\u001b[39m與\u001b[39G\u001b[38;2;177;185;249mgit status\u001b[39m，比對結果如下：\r\u001b[2C\u001b[2B-\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[45C\u001b[47B\u001b[90m20\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[4C\u001b[28B\u001b[1mHEAD 是 \u001b[38;2;177;185;249m73091bb\u001b[22m\u001b[39m，已和\u001b[27G\u001b[38;2;177;185;249morigin/feature/sync-skill\u001b[53G\u001b[39m同步，工作區乾淨。\r\u001b[2C\u001b[1B-\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[4C\u001b[29B\u001b[1m最新 commit \u001b[38;2;177;185;249m73091bb\u001b[25G\u001b[22m\u001b[39m已記在卡片的\u001b[38GHistory\u001b[46G裡，沒有新的\u001b[59Gcommit\u001b[66G需要補記。\r\u001b[2C\u001b[1B-\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[4C\u001b[30B\u001b[1m狀態、下一步、檢查、等你、關卡\u001b[36G\u001b[22m都與\u001b[41Ggit\u001b[45G看得到的事實相符。檢查指令引用的\u001b[78G\u001b[38;2;177;185;249mskills/card/tests\u001b[39m、\u001b[38;2;177;185;249mscripts/tests\u001b[39m、\u001b[38;2;177;185;249mskills/flow/SKILL.md\u001b[133G\u001b[39m都存在。\r\u001b[2C\u001b[1B-\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[4C\u001b[31B\u001b[1m「整套 327 綠」\u001b[21G\u001b[22m是卡片\u001b[28GHistory\u001b[36G記下的結果。這一輪我沒有重跑測試，所以沒有新的測試數字可寫。\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[2C\u001b[33B卡片狀態是\u001b[14G\u001b[38;2;177;185;249m關卡：無\u001b[39m，也沒有需要\u001b[35GAlice\u001b[41G決定的事，所以這一輪不提問。\r\u001b[9B\u001b[38;2;215;119;87m✽\u001b[3GBoondoggling… \u001b[38;2;153;153;153m(20s · ↓\u001b[26G2.7k tokens)\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[2C\u001b[42B\u001b[38;2;220;129;97mBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[42B\u001b[38;2;215;119;87m✻\u001b[3G\u001b[38;2;218;124;92mBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[42B\u001b[38;2;215;119;87m✶\u001b[3GBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[42B\u001b[38;2;215;119;87m✳\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[39C\u001b[47B\u001b[33m2\u001b[47G\u001b[90m2\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[42B\u001b[38;2;215;119;87m✢\u001b[3G\u001b[38;2;218;124;92mBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[42B\u001b[38;2;215;119;87m·\u001b[3G\u001b[38;2;220;129;97mBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[2C\u001b[42B\u001b[38;2;223;134;102mBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[2C\u001b[42B\u001b[38;2;228;144;112mBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[2C\u001b[42B\u001b[38;2;230;149;117mBoondoggling…\u001b[19G\u001b[38;2;153;153;153m1\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[42B\u001b[38;2;215;119;87m✢\u001b[3G\u001b[38;2;233;154;122mBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[42B\u001b[38;2;215;119;87m✳\u001b[3G\u001b[38;2;235;159;127mBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[42B\u001b[38;2;215;119;87m✶\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[42B\u001b[38;2;215;119;87m✻\u001b[3G\u001b[38;2;233;154;122mBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[42B\u001b[38;2;215;119;87m✽\u001b[3G\u001b[38;2;230;149;117mBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[2C\u001b[42B\u001b[38;2;228;144;112mBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[17C\u001b[42B\u001b[38;2;153;153;153mrunning Stop\u001b[31Gh\u001b[33Goks… 4/7 · 21s · ↓\u001b[52G2.7k tokens)\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[37C\u001b[42B\u001b[38;2;153;153;153m5\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[37C\u001b[42B\u001b[38;2;153;153;153m6\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[2C\u001b[42B\u001b[38;2;223;134;102mBoondoggling…\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[2C\u001b[42B\u001b[38;2;220;129;97mBoondoggling…\u001b[45G\u001b[38;2;153;153;153m2\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[35B\u001b[38;2;153;153;153m✻\u001b[3GChurned for 22s · done 11:26 PM\r\u001b[7B\u001b[39m\u001b[K\r\u001b[3B❯ \u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[46C\u001b[47B\u001b[90m4\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[49B\u001b[38;2;78;186;101m56\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[49B\u001b[38;2;153;153;153m56\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[49B\u001b[38;2;255;193;7m57\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[49B\u001b[38;2;153;153;153m57\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[49B\u001b[38;2;255;193;7m58\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[49B\u001b[38;2;153;153;153m58\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[49B\u001b[38;2;255;193;7m57\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[49B\u001b[38;2;153;153;153m57\u001b[39m\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[43C\u001b[47B\u001b[90m69m\u001b[48G9s\u001b[38;2;153;153;153m │ \u001b[90m5h:1%\u001b[38;2;153;153;153m \u001b[90m7d:2%\r\u001b[3C\u001b[1Br\u001b[6Gleas\u001b[12Gv14.2.6\u001b[38;2;153;153;153m │ \u001b[34msync-skill\u001b[39m\u001b[K\u001b[50;1H\u001b[46;3H", '卡片狀態是 關卡：無，也沒有需要 Alice 決定的事，所以這一輪不提問。'],
]

test('last line: a short session replays the whole screen; the input box and everything below it is UI, not a sentence', () => {
  for (const [raw, sentence] of SHORT_LOGS) {
    expect(lastMeaningful(raw)).toBe(sentence)
    expect(lastMeaningful(raw)).not.toMatch(/─{10,}|mode on|← for agents|\/effort|│/)
    // 按 l 看輸出也不該列出這些 UI 列
    expect(logLines(raw).join('\n')).not.toMatch(/─{10,}|mode on|← for agents|\/effort|^❯$/m)
  }
})

test('last line: a question that mentions "mode on" is kept; only the ⏸／⏵⏵ UI line is noise', () => {
  for (const q of ['Should I leave safe mode on?', 'The dark mode on the dashboard looks wrong, should I fix it?', '要不要把 plan mode on 留著？', 'Keep accept edits on?']) {
    expect(isNoise(q)).toBe(false)
    expect(lastMeaningful(`⏺ 做完了\r\u001b[1B${q}\r\u001b[1B⏸ manual mode on · ← for agents\r\u001b[1B`)).toBe(q)
  }
  expect(isNoise('⏸ manual mode on · ← for agents')).toBe(true)
  expect(isNoise('⏵⏵ accept edits on')).toBe(true)
})

/** 與 AC-5 同一條規則：按 y 選「照卡片的下一步繼續」時，佔位的下一步也不原樣送給 Agent。 */
test('reply: a placeholder next step is not sent as the reply', async ($, on) => {
  const { data, clock } = fixture(on)
  blocked(data, { status: 'waiting', waitingFor: 'input needed' })
  const placeholder = '<可以直接派給 Agent 的一件事>'
  data.files[CARD_B] = setFields(data.files[CARD_B]!, { 下一步: placeholder })
  data.answer = '照卡片的下一步繼續'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(120))
  await ui.press({ key: `${PREFIX}reply` })
  await clock.settle()
  await ui.unmount()

  expect(data.launches).toHaveLength(1)
  const prompt = String(data.launches[0].argv.at(-1))
  expect(prompt).toContain('的回覆：依卡片的規格與實作計畫實作')
  expect(prompt).not.toContain(placeholder)
  expect(prompt).not.toContain('照卡片的下一步繼續：')
})
