import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, REGISTRY, NOW, leaves, text } from './fixture'
import { touchesDesk } from '../hooks/touch'

const BETA = '/home/u/wt/beta'
const flat = (x: string) => x.replace(/\s+/g, '')
const screen = async (ui: any) => flat(leaves(await ui.drawn(), 'Text').map(text).join(''))
const agentReads = (data: any) => data.processCalls.length + data.launches.length
/** 讓對話的工具呼叫有人回答：Write 寫進假的檔案系統，Bash 什麼都不做。 */
function tools(on: any, data: any) {
  on('tool.call', { tool: 'Write' }, (_: any, e: any) => { data.files[e.file_path] = e.content; return { result: { type: 'update', filePath: e.file_path } } })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
}
/** 數 claude agents 被叫了幾次：每一輪重新整理叫一次（用 fixture 的 exec，回 null 交給預設的回答）。 */
function countReads(data: any) {
  const box = { n: 0 }
  data.exec = (e: any) => { if (e.argv[0] === 'claude' && e.argv[1] === 'agents') box.n++; return null }
  return box
}
/** 回合開始、結束由引擎發；測試裡補一個最底下的回答。 */
const turnEnds = (on: any) => on('turn.complete', () => ({ text: '' }))
const turnStarts = (on: any) => on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
const turnDone = (turnId = 't1') => ({ answer: '', durationMs: 4000, isAborted: false, turnId, reason: 'answer' }) as any

// ── 對話改了卡片、跑了指令：面板馬上重讀 ──

/** 對話用 Write 改了卡片：不用等回合結束或 30 秒，面板就看到新內容。 */
test('a card written by the conversation shows on the pane without waiting for the turn to end', async ($, on) => {
  const { data, clock } = fixture(on)
  tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  const card = data.files[CARD_B]!.replace('Beta 修正中', 'Beta 已改好欄位順序')
  await $.tool.call({ tool: 'Write', file_path: CARD_B, content: card } as any)
  await clock.advance(1000)
  await clock.settle()
  expect(await screen(ui)).toContain(flat('Beta 已改好欄位順序'))
  await ui.unmount()
})

/** 對話跑 git commit 或卡片腳本：重讀一次；跟工作桌無關的指令不重讀。 */
test('git commits and card script runs reread the desk; unrelated commands do not', async ($, on) => {
  const { data, clock } = fixture(on)
  const reads = countReads(data)
  tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const before = reads.n
  await $.tool.call({ tool: 'Bash', command: 'ls -la' } as any)
  await clock.advance(1000); await clock.settle()
  expect(reads.n).toBe(before)
  await $.tool.call({ tool: 'Bash', command: `git -C ${BETA} commit -m "fix"` } as any)
  await clock.advance(1000); await clock.settle()
  expect(reads.n).toBe(before + 1)
  await $.tool.call({ tool: 'Bash', command: 'python3 ~/.claude/plugins/desk/skills/card/scripts/card.py spec-ok beta' } as any)
  await clock.advance(1000); await clock.settle()
  expect(reads.n).toBe(before + 2)
})

/** 一串工具呼叫只重讀一次。 */
test('a burst of card edits rereads once', async ($, on) => {
  const { data, clock } = fixture(on)
  const reads = countReads(data)
  tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const before = reads.n
  for (const n of [1, 2, 3]) await $.tool.call({ tool: 'Write', file_path: CARD_B, content: data.files[CARD_B]!.replace(/狀態：.*/, `狀態：第 ${n} 次`) } as any)
  await clock.advance(1000); await clock.settle()
  expect(reads.n).toBe(before + 1)
})

/** 輸入框的 ! 指令（例如 ! git commit）記進對話後重讀。 */
test('a ! command typed at the prompt rereads the desk', async ($, on) => {
  const { data, clock } = fixture(on)
  const reads = countReads(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const before = reads.n
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: '<bash-input>git commit -m wip</bash-input>' }] }, door: 'command', origin: { kind: 'composer' }, uuid: 'u-1' } as any)
  await clock.advance(1000); await clock.settle()
  expect(reads.n).toBe(before + 1)
})

/** ! 指令的那一列若記成一般提示列：看內容認出來，一樣重讀；一般打字的提示不重讀。 */
test('a ! command recorded as a prompt row rereads the desk; a typed prompt row does not', async ($, on) => {
  const { data, clock } = fixture(on)
  const reads = countReads(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const before = reads.n
  await $.session.append({ message: { type: 'user', content: '幫我看一下 CI' }, door: 'prompt', origin: { kind: 'composer' }, uuid: 'u-2' } as any)
  await clock.advance(1000); await clock.settle()
  expect(reads.n).toBe(before)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: '<bash-input>git commit -m wip</bash-input>' }] }, door: 'prompt', origin: { kind: 'composer' }, uuid: 'u-3' } as any)
  await clock.advance(1000); await clock.settle()
  expect(reads.n).toBe(before + 1)
})

test('touchesDesk: card and registry edits, card script, branch-moving git; nothing else', () => {
  const known = [REGISTRY, CARD_A, CARD_B]
  expect(touchesDesk({ tool: 'Edit', file_path: CARD_A }, known)).toBe(true)
  expect(touchesDesk({ tool: 'Write', file_path: REGISTRY }, known)).toBe(true)
  // 還沒在登錄表裡的新卡（/desk:card new 剛建）也算。
  expect(touchesDesk({ tool: 'Write', file_path: '/home/u/wt/delta/.desk/CARD.md' }, known)).toBe(true)
  expect(touchesDesk({ tool: 'Edit', file_path: '/home/u/wt/beta/src/app.ts' }, known)).toBe(false)
  expect(touchesDesk({ tool: 'Bash', command: 'git switch -c fix/x origin/main' }, known)).toBe(true)
  expect(touchesDesk({ tool: 'Bash', command: `cat ${CARD_A}` }, known)).toBe(true)
  // git 子指令前帶選項、路徑有空白，以及會改 PR 狀態的 gh 也算。
  expect(touchesDesk({ tool: 'Bash', command: 'git -C "/home/u/my repo" commit -m x' }, known)).toBe(true)
  expect(touchesDesk({ tool: 'Bash', command: 'git -c user.name=x --no-pager commit --amend' }, known)).toBe(true)
  expect(touchesDesk({ tool: 'Bash', command: 'git stash push -m wip' }, known)).toBe(true)
  expect(touchesDesk({ tool: 'Bash', command: 'gh pr merge 12 --squash' }, known)).toBe(true)
  expect(touchesDesk({ tool: 'Bash', command: 'gh pr view 12' }, known)).toBe(false)
  expect(touchesDesk({ tool: 'Bash', command: 'git status --short' }, known)).toBe(false)
  expect(touchesDesk({ tool: 'Bash', command: 'npm test' }, known)).toBe(false)
  expect(touchesDesk({ tool: 'Read', file_path: CARD_A }, known)).toBe(false)
})

// ── 決策送出後：鎖住那題，等對話寫回卡片 ──

/** 從面板選 A、按 f 填入並送出；給 turnId 代表送出時有回合正在跑。 */
async function sendDecision($: any, data: any, turnId?: string) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `case-${CARD_A}-opt0A` })
  await ui.press({ key: `case-${CARD_A}-fill` })
  expect(data.fills[0].text).toBe('「Alpha」決策：A')
  await $.prompt.submit({ text: data.fills[0].text, ...(turnId ? { turnId } : {}) } as any)
  return ui
}

/** 送出決策後：選項不能再點、沒有填入鍵，輪到誰那句說在等對話寫回；提示附上「寫回卡片」的要求。 */
test('after a decision is sent its options lock and the turn line says it is waiting for the card', async ($, on) => {
  const { data } = fixture(on)
  const ui = await sendDecision($, data)
  const context = (data.submitted.at(-1).context ?? []).join('\n')
  expect(context).toContain('卡片「等你」的決策')
  expect(context).toContain('寫回卡片')
  expect(await ui.find({ key: `case-${CARD_A}-opt0A` })).toBeUndefined()
  expect(await ui.find({ key: `case-${CARD_A}-fill` })).toBeUndefined()
  const all = await screen(ui)
  expect(all).toContain(flat('◐ 處理中'))
  expect(all).toContain(flat('決策已送出，等對話處理並寫回卡片'))
  // 選了哪個還看得到
  expect(all).toContain(flat('◉ A'))
  await ui.unmount()
})

/** 對話把「等你」寫回卡片：回合結束後面板回到平常，不再有那題。 */
test('once the card is written back the pane drops the question', async ($, on) => {
  const { data, clock } = fixture(on)
  turnEnds(on)
  const ui = await sendDecision($, data)
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 等你：.*/, '- 等你：無')
  await clock.advance(5000)
  await $.turn.complete(turnDone())
  await clock.settle()
  const all = await screen(ui)
  expect(all).not.toContain(flat('決策已送出'))
  expect(all).not.toContain(flat('要 push 嗎'))
  expect(data.toasts.some((t: string) => t.includes('沒有改'))).toBe(false)
  await ui.unmount()
})

/** 回合結束了卡片卻沒改：提醒一次，說要開卡片改掉或重送；選項與填入鍵回來，可以再送。 */
test('a turn that ends without writing the card back says so and lets you send again', async ($, on) => {
  const { data, clock } = fixture(on)
  turnEnds(on)
  const ui = await sendDecision($, data)
  await clock.advance(5000)
  await $.turn.complete(turnDone())
  await clock.settle()
  expect(data.toasts.filter((t: string) => t.includes('Alpha：決策已送出，但卡片的「等你」沒有改')).length).toBe(1)
  const all = await screen(ui)
  expect(all).toContain(flat('▶ 輪到你'))
  expect(all).toContain(flat('卡片的「等你」沒有改'))
  expect(await ui.find({ key: `case-${CARD_A}-opt0A` })).toBeDefined()
  expect(await ui.find({ key: `case-${CARD_A}-fill` })).toBeDefined()
  // 再一個回合結束不重複提醒
  await $.turn.complete(turnDone())
  await clock.settle()
  expect(data.toasts.filter((t: string) => t.includes('沒有改')).length).toBe(1)
  await ui.unmount()
})

/** 決策送出中按 m 展開全部動作：仍然沒有 f，不能重送。 */
test('more actions does not bring back fill while a decision is waiting', async ($, on) => {
  const { data } = fixture(on)
  const ui = await sendDecision($, data)
  await ui.press({ key: 'more' })
  expect(await ui.find({ key: `case-${CARD_A}-fill` })).toBeUndefined()
  await ui.unmount()
})

/** 回合進行中才送出（排隊）的決策：這個回合結束不算，下一個回合結束才判斷寫回了沒。 */
test('a decision queued during a running turn is judged when the next turn ends', async ($, on) => {
  const { data, clock } = fixture(on)
  turnEnds(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `case-${CARD_A}-opt0A` })
  await ui.press({ key: `case-${CARD_A}-fill` })
  await $.prompt.submit({ text: data.fills[0].text, turnId: 't1' } as any)
  await $.turn.complete(turnDone('t1'))
  await clock.settle()
  expect(data.toasts.some((t: string) => t.includes('沒有改'))).toBe(false)
  expect(await screen(ui)).toContain(flat('決策已送出，等對話處理並寫回卡片'))
  await $.turn.complete(turnDone('t2'))
  await clock.settle()
  expect(data.toasts.filter((t: string) => t.includes('沒有改')).length).toBe(1)
  await ui.unmount()
})

/** 回合中送出、提示當輪就交給了模型（之後沒有新回合）：那個回合結束一下子之後就判斷，不會一直鎖著。 */
test('a decision delivered into the running turn is judged shortly after that turn ends', async ($, on) => {
  const { data, clock } = fixture(on)
  turnEnds(on)
  const ui = await sendDecision($, data, 't1')
  await $.turn.complete(turnDone('t1'))
  await clock.settle()
  expect(await screen(ui)).toContain(flat('決策已送出，等對話處理並寫回卡片'))
  await clock.advance(6000); await clock.settle()
  expect(data.toasts.filter((t: string) => t.includes('Alpha：決策已送出，但卡片的「等你」沒有改')).length).toBe(1)
  expect(await ui.find({ key: `case-${CARD_A}-fill` })).toBeDefined()
  await ui.unmount()
})

/** 回合中送出、排到下一個回合：下一個回合馬上開始（比面板重讀完還早），就等它結束，不因為過了一陣子就先判斷。 */
test('a decision queued behind a running turn waits for the turn that picks it up', async ($, on) => {
  const { data, clock } = fixture(on)
  turnEnds(on); turnStarts(on)
  const ui = await sendDecision($, data, 't1')
  await $.turn.complete(turnDone('t1'))
  await $.turn.start({ text: data.fills[0].text, turnId: 't2' } as any)
  await clock.settle()
  await clock.advance(10_000); await clock.settle()
  expect(data.toasts.some((t: string) => t.includes('沒有改'))).toBe(false)
  expect(await screen(ui)).toContain(flat('決策已送出，等對話處理並寫回卡片'))
  await $.turn.complete(turnDone('t2'))
  await clock.settle()
  expect(data.toasts.filter((t: string) => t.includes('沒有改')).length).toBe(1)
  await ui.unmount()
})

/** 下一個回合在面板重讀完之後才開始（仍在幾秒內）：一樣留給那個回合判斷。 */
test('a turn starting a moment after the last one still picks up the queued decision', async ($, on) => {
  const { data, clock } = fixture(on)
  turnEnds(on); turnStarts(on)
  const ui = await sendDecision($, data, 't1')
  await $.turn.complete(turnDone('t1'))
  await clock.settle()
  await clock.advance(2000)
  await $.turn.start({ text: data.fills[0].text, turnId: 't2' } as any)
  await clock.advance(10_000); await clock.settle()
  expect(data.toasts.some((t: string) => t.includes('沒有改'))).toBe(false)
  expect(await ui.find({ key: `case-${CARD_A}-fill` })).toBeUndefined()
  await ui.unmount()
})

/** 新對話（/clear）沒看過之前送出的決策：不帶著鎖進來，那題可以再送。 */
test('a new conversation does not inherit a decision lock', async ($, on) => {
  const { data } = fixture(on)
  // 開新對話由引擎發；測試裡補最底下的回答（含 /desk 指令的註冊）。
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  const ui = await sendDecision($, data)
  expect(await ui.find({ key: `case-${CARD_A}-fill` })).toBeUndefined()
  await ui.unmount()
  await $.session.start({ cwd: '/home/u', surface: null, isInteractive: true } as any)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const again = await $.ui.mount(PANE(80))
  await again.press({ key: `case-${CARD_A}-opt0A` })
  expect(await again.find({ key: `case-${CARD_A}-fill` })).toBeDefined()
  expect(await screen(again)).not.toContain(flat('決策已送出'))
  await again.unmount()
})

/** 填入決策不會把那件設成選取的主角：決策那則附上卡片，之後的提示不再附。 */
test('filling a decision attaches its card once without making the case the subject', async ($, on) => {
  const { data } = fixture(on)
  const ui = await sendDecision($, data)
  const first = (data.submitted.at(-1).context ?? []).join('\n')
  expect(first).toContain('- 等你：要 push 嗎')
  expect(first).not.toContain('預設以它為主')
  await $.prompt.submit({ text: '順便看一下 CI' } as any)
  expect(data.submitted.at(-1).context ?? []).toEqual([])
  await ui.unmount()
})

/** 一般的提示不會被當成決策，也不鎖任何東西。 */
test('an ordinary prompt locks nothing', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await $.prompt.submit({ text: 'Alpha 要 push 嗎？' } as any)
  expect(await ui.find({ key: `case-${CARD_A}-opt0A` })).toBeDefined()
  expect(await screen(ui)).not.toContain(flat('決策已送出'))
  await ui.unmount()
})

// ── 重新整理收進「更多動作」；卡片比分支舊時提示同步 ──

test('refresh is not in the footer until more actions is opened', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ key: 'refresh' })).toBeUndefined()
  await ui.press({ key: 'more' })
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  await ui.unmount()
})

/** 面板外 commit 了、卡片沒跟著寫：現在卡提示按 s 同步，同步鍵不變淡。 */
test('a card older than the latest commit suggests a sync', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  data.mtimes[CARD_B] = NOW - 2 * 3_600_000
  data.git[BETA] = { branch: 'feature/b', head: 'h2', commitAt: NOW - 10 * 60_000 }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await screen(ui)).toContain(flat('比卡片新：按 s 同步'))
  const sync = await ui.find({ key: `case-${CARD_B}-sync` })
  expect(sync).toBeDefined()
  expect(!!sync?.props?.dimColor).toBe(false)
  await ui.unmount()
})

/** 卡片比分支最近一次變更新：不提示。 */
test('no sync hint when the card is newer than the latest commit', async ($, on) => {
  const { data } = fixture(on)
  data.git[BETA] = { branch: 'feature/b', head: 'h2', commitAt: NOW - 2 * 3_600_000 }
  data.agents = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await screen(ui)).not.toContain(flat('按 s 同步'))
  await ui.unmount()
})

/** 先寫卡、跑完測試才 commit（卡片可能也在那次 commit 裡）：commit 改到的程式都比卡片早改好，不算卡片過期。 */
test('no sync hint when the latest commit only records code written before the card', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  data.mtimes[CARD_B] = NOW - 30 * 60_000
  data.mtimes[`${BETA}/hooks/a.ts`] = NOW - 40 * 60_000
  data.git[BETA] = { branch: 'feature/b', head: 'h2-code-before-card', commitAt: NOW - 10 * 60_000, commitFiles: ['hooks/a.ts', 'hooks/gone.ts'] }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await screen(ui)).not.toContain(flat('按 s 同步'))
  await ui.unmount()
})

/** commit 裡有程式是寫完卡片之後才改的：仍然提示同步。 */
test('a commit with code edited after the card still suggests a sync', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  data.mtimes[CARD_B] = NOW - 2 * 3_600_000
  data.mtimes[`${BETA}/hooks/a.ts`] = NOW - 3 * 3_600_000
  data.mtimes[`${BETA}/hooks/b.ts`] = NOW - 30 * 60_000
  data.git[BETA] = { branch: 'feature/b', head: 'h2-code-after-card', commitAt: NOW - 10 * 60_000, commitFiles: ['hooks/a.ts', 'hooks/b.ts'] }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await screen(ui)).toContain(flat('比卡片新：按 s 同步'))
  await ui.unmount()
})

/** Agent 正在跑（它還沒寫回卡片是正常的）：不提示。 */
test('no sync hint while an agent is running on the case', async ($, on) => {
  const { data } = fixture(on)
  data.agents = [{ id: 'bbbbbbbb', kind: 'background', cwd: BETA, state: 'working', status: 'busy', name: 'beta-agent', sessionId: 'bbbbbbbb-0000-4000-8000-000000000000', startedAt: NOW - 60_000 }]
  data.mtimes[CARD_B] = NOW - 2 * 3_600_000
  data.git[BETA] = { branch: 'feature/b', head: 'h2', commitAt: NOW - 10 * 60_000 }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await screen(ui)).not.toContain(flat('按 s 同步'))
  await ui.unmount()
})

/** 剛 commit（兩分鐘內）：對話多半接著就寫卡，先不提示。 */
test('no sync hint right after a commit', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  data.mtimes[CARD_B] = NOW - 2 * 3_600_000
  data.git[BETA] = { branch: 'feature/b', head: 'h2', commitAt: NOW - 60_000 }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await screen(ui)).not.toContain(flat('按 s 同步'))
  await ui.unmount()
})

// ── 選取：只附在人打的提示；壓縮後重附全文；/desk off 後不再重讀 ──

/** 排程、背景通知這類不是人打的提示，不附選取的卡。 */
test('prompts that are not typed by the person do not get the selected card', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  await $.prompt.submit({ text: '背景工作完成', origin: { kind: 'task-notification' } } as any)
  expect(data.submitted.at(-1).context ?? []).toEqual([])
  await $.prompt.submit({ text: '我打的', origin: { kind: 'composer' } } as any)
  expect((data.submitted.at(-1).context ?? []).join('')).toContain('案子「Beta」')
  await ui.unmount()
})

/** 壓縮之後模型看不到之前附的卡：下一則重新附全文。 */
test('after a compaction the selected card is attached in full again', async ($, on) => {
  const { data } = fixture(on)
  on('session.compact', () => ({ skip: 'test' }))
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  await $.prompt.submit({ text: '一' } as any)
  await $.prompt.submit({ text: '二' } as any)
  expect((data.submitted.at(-1).context ?? []).join('')).toContain('沒有變動')
  await $.session.compact({ trigger: 'manual' } as any)
  await $.prompt.submit({ text: '三' } as any)
  expect((data.submitted.at(-1).context ?? []).join('')).toContain('- 下一步：依審核修正')
  await ui.unmount()
})

/** 斜線指令送出時照樣附卡，但不算附過（有些指令不進模型）：下一則一般提示仍附全文。 */
test('a slash command does not use up the full card for the next prompt', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  await $.prompt.submit({ text: '/desk:card spec beta', command: { name: 'desk:card', args: 'spec beta' } } as any)
  expect((data.submitted.at(-1).context ?? []).join('')).toContain('- 下一步：依審核修正')
  await $.prompt.submit({ text: '這件下一步是什麼？' } as any)
  const context = (data.submitted.at(-1).context ?? []).join('')
  expect(context).toContain('- 下一步：依審核修正')
  expect(context).not.toContain('沒有變動')
  await ui.unmount()
})

/** /desk off 之後，對話剛改的卡片不會再把面板與狀態列叫回來。 */
test('turning the desk off cancels a pending reread', async ($, on) => {
  const { data, clock } = fixture(on)
  const reads = countReads(data)
  tools(on, data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.tool.call({ tool: 'Write', file_path: CARD_B, content: data.files[CARD_B]! } as any)
  await $.command.run({ command: 'desk', args: 'off' } as any)
  const before = reads.n
  await clock.advance(2000); await clock.settle()
  expect(reads.n).toBe(before)
  expect(data.status).toBeUndefined()
})
