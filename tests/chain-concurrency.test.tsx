import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, REGISTRY, result, text, flat, feedLog } from './fixture'
import { AGENT_STOPPED } from '../hooks/chain'
import { endedHow } from '../hooks/model'

// 工作桌與主對話撞同一個 worktree：被停掉的 Agent 不算做完；別人留下的未提交改動擋住派工；Agent 知道自己的名字。
const ROOT = '/home/u/wt/alpha'
const PREFIX = `case-${CARD_A}-`
const SID = 'a0000009-0000-4000-8000-000000000000'
const FOREIGN = '不是上一個 Agent 留下的'
const screen = async (ui: any) => flat(text(await ui.drawn()))
const sh = (data: any) => data.processCalls.filter((c: any) => c.argv[0] === 'sh').length

/** 只看 Alpha：完成檢查已核准、沒有別的 Agent；每次派工都換一個背景 agent。 */
function alphaOnly(data: any, clock: any) {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |`
  data.git[ROOT] = { branch: 'feature/alpha', head: 'h1' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.agents = []
  let n = 0
  data.launch = async (e: any) => {
    n++
    const id = `a000000${n}`
    data.agents = [{ id, kind: 'background', cwd: ROOT, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
}

function helpers($: any, data: any, clock: any) {
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  const run = async (args: string) => { await $.command.run({ command: 'desk', args } as any); await clock.settle() }
  return {
    step, refresh, run,
    go: () => run('go Alpha'),
    /** Agent 做完（status idle、state done）。 */
    done: () => { data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' })) },
    /** 在面板外被 `claude stop` 停掉：清單裡 state 變 stopped、沒有 status（照真實輸出）；重新整理並讓流程有機會動。 */
    stopOutside: async () => { data.agents = data.agents.map(({ status: _, ...a }: any) => ({ ...a, state: 'stopped' })); await refresh(); await step(); await step() },
    chain: () => (data.store.chains as any)[ROOT],
    jobs: () => (data.store.jobs as any)[ROOT],
    prompt: (i: number) => String(data.launches[i].argv[data.launches[i].argv.length - 1]),
    name: (i: number) => String(data.launches[i].argv[3]),
  }
}

/** AC-1、AC-3、AC-4 */
test('an agent stopped outside the desk pauses the chain instead of being treated as done', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  await h.go()
  expect(data.launches.length).toBe(1)
  // AC-4：提示詞告訴 Agent 自己的名字
  expect(h.name(0)).toMatch(/^desk-/)
  expect(h.prompt(0)).toContain(`你的背景 Agent 名字是 ${h.name(0)}`)
  expect(h.prompt(0)).toContain('清單裡這個名字就是你自己')

  // Agent 改到一半被 `claude stop` 停掉，留下 2 個檔沒 commit：不跑檢查、不派審查或修正
  data.git[ROOT]!.changed = 2
  await h.stopOutside()
  expect(sh(data)).toBe(0)
  expect(data.launches.length).toBe(1)
  expect(h.chain().stopped).toBe(AGENT_STOPPED)
  expect(h.chain().heldAtCheck).toBeUndefined()
  expect(h.jobs().last.ended).toEqual({ how: 'stopped' })
  expect(data.toasts.some((t: string) => t.includes(AGENT_STOPPED))).toBe(true)

  const ui = await $.ui.mount(PANE(120))
  const shown = await screen(ui)
  expect(shown).toContain(flat(`▶ 輪到你  ${AGENT_STOPPED}`))
  expect(shown).toContain(flat(`Alpha 流程已暫停：${AGENT_STOPPED}`))
  expect((await ui.find({ key: `${PREFIX}continue` }))?.props?.hotkey).toBe('g')
  await ui.unmount()

  // AC-3：看過 worktree，留下的就是那個 Agent 的（指紋相同）：按 g 照舊派出
  await h.go()
  expect(data.launches.length).toBe(2)
  expect(data.toasts.some((t: string) => t.includes(FOREIGN))).toBe(false)
  expect(h.prompt(1)).toContain(`你的背景 Agent 名字是 ${h.name(1)}`)
})

/** AC-1：面板的 k 與外面的 claude stop 走到同一個結果 */
test('pressing k and an outside stop leave the same pause', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  alphaOnly(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  await h.go()
  let ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `${PREFIX}stop` }); await clock.settle()
  await ui.press({ key: `${PREFIX}stop` }); await clock.settle()
  await ui.unmount()
  expect(data.stops).toEqual(['a0000001'])
  expect(h.chain().stopped).toBe(AGENT_STOPPED)

  // 停掉之後清單裡 state 變 stopped：流程不會再把它當成做完
  await h.stopOutside()
  expect(sh(data)).toBe(0)
  expect(data.launches.length).toBe(1)
  expect(h.chain().stopped).toBe(AGENT_STOPPED)
  expect(h.jobs().last.ended).toEqual({ how: 'stopped' })
  ui = await $.ui.mount(PANE(160))
  const shown = await screen(ui)
  expect(shown).toContain(flat(`▶ 輪到你  ${AGENT_STOPPED}`))
  // 停止的原因照樣記進動態（警告）；之後 Agent 離開清單記的「Agent 已完成」是一般事件，問題列跟著收掉，原因看「輪到你」那列。
  expect(log.list.some(e => e.tone === 'warning' && e.text.startsWith(`Alpha ${AGENT_STOPPED}`))).toBe(true)
  await ui.unmount()
})

/** AC-2（手動）、AC-5 */
test('a dirty worktree that is not the last agent\'s leftovers refuses manual dispatch', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.git[ROOT]!.changed = 2
  const h = helpers($, data, clock)
  await h.refresh()

  // 從沒派過工、worktree 髒：g 與 w 都拒絕並說原因
  await h.go()
  await h.run('review Alpha')
  expect(data.launches.length).toBe(0)
  expect(data.toasts.filter((t: string) => t.includes(FOREIGN) && t.includes('2 個檔')).length).toBe(2)
  expect(data.toasts.some((t: string) => t.includes('目前無法繼續'))).toBe(true)
  expect(data.toasts.some((t: string) => t.includes('目前無法驗收'))).toBe(true)

  // 上一個會改程式的 Agent 結束時留下的指紋跟現在不同：一樣拒絕
  data.store.jobs = { [ROOT]: { sessionId: SID, mark: 'ffffffff', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: SID, kind: 'continue', startedAt: 0, fresh: false, owner: 'fixture-session', handled: true, ended: { how: 'finished' } } } }
  await h.go()
  expect(data.launches.length).toBe(0)

  // AC-5：同步不受擋；同步做完也不會把別人的改動算成 Agent 留下的
  await h.run('sync Alpha')
  expect(data.launches.length).toBe(1)
  expect(h.prompt(0)).toContain('同步卡片')
  h.done()
  await h.refresh()
  expect(h.jobs().last.ended).toEqual({ how: 'finished' })
  expect(h.jobs().mark).toBe('ffffffff')
  await h.go()
  expect(data.launches.length).toBe(1)

  // commit 或還原後（乾淨）：照舊派出
  data.git[ROOT]!.changed = 0
  await h.go()
  expect(data.launches.length).toBe(2)
})

/** AC-2（自動流程） */
test('the chain stops before dispatching into a worktree someone else changed', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  await h.go()
  // Agent 做完、全部 commit：完成檢查自動跑，結束時的指紋是「乾淨」
  h.done()
  await h.refresh()
  expect(sh(data)).toBe(1)
  expect(h.jobs().last.ended).toEqual({ how: 'finished' })
  expect(h.jobs().mark).toBe('')

  // 檢查通過、要派審查的那一刻，主對話已經在 worktree 改了 3 個檔：流程停下，不派
  data.git[ROOT]!.changed = 3
  await h.step(); await h.step()
  expect(data.launches.length).toBe(1)
  expect(h.chain().stopped).toContain(FOREIGN)
  expect(h.chain().stopped).toContain('3 個檔')
  expect(h.chain().heldAtCheck).toBeUndefined()
  expect(data.toasts.some((t: string) => t.includes('流程已暫停') && t.includes(FOREIGN))).toBe(true)
  const ui = await $.ui.mount(PANE(120))
  expect(await screen(ui)).toContain(flat('Alpha 流程已暫停：worktree 有未提交的改動（3 個檔）'))
  await ui.unmount()

  // 同樣的指紋（例如上一個 Agent 自己留下的）照舊派：這裡讓 Agent 結束時就留著 3 個檔
  data.store.chains = {}
  data.git[ROOT]!.changed = 0
  await h.go()
  expect(data.launches.length).toBe(2)
  data.git[ROOT]!.changed = 3
  h.done()
  await h.refresh(); await h.step(); await h.step()
  expect(sh(data)).toBe(2)
  expect(data.launches.length).toBe(3)
  expect(h.prompt(2)).toContain('程式碼審查')
})

/**
 * AC-2（recheck 路徑）：審查通過後人在面板外 commit、又留下未提交改動。流程自己排的「重新檢查、審查」那一筆合成紀錄
 * 不是真的派工：不能把當下 worktree 重算成指紋（否則人的改動被洗成 Agent 留下的），要派審查時得停下並寫原因。
 * @param lastAgent 上一筆紀錄是已結束的審查 Agent（清單裡找得到名字），或從沒派過工（名字找不到）。
 */
async function passedThenOutsideCommit($: any, on: any, lastAgent: boolean) {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const h = helpers($, data, clock)
  data.git[ROOT] = { branch: 'feature/alpha', head: 'h2' }
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  // 上一輪：程式 Agent 結束時 worktree 乾淨（指紋空字串），在 h1 派的審查已通過；審查 Agent 還留在清單裡（做完）
  data.store.chains = { [ROOT]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'h1', judgedHead: 'h1' } }
  if (lastAgent) {
    data.store.jobs = { [ROOT]: { sessionId: SID, mark: '', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: SID, kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true, ended: { how: 'finished' } } } }
    data.agents = [{ id: 'a0000009', kind: 'background', cwd: ROOT, name: 'desk-x', sessionId: SID, state: 'done', status: 'idle', startedAt: 0 }]
  }
  // 人在面板外 commit 了 h2，手上還有 2 個檔沒提交
  data.git[ROOT]!.changed = 2
  await h.refresh()
  await h.step(); await h.step(); await h.step()
  // 不派審查，流程停下寫原因
  expect(data.launches.length).toBe(0)
  expect(h.jobs().last.recheck).toBe(true)
  expect(h.jobs().last.ended).toEqual({ how: 'finished' })
  // 指紋維持上一個程式 Agent 結束時記的那份，沒被重算成人的改動
  expect(h.jobs().mark).toBe(lastAgent ? '' : undefined)
  expect(h.chain().stopped).toContain(FOREIGN)
  expect(h.chain().stopped).toContain('2 個檔')
  expect(data.toasts.some((t: string) => t.includes('流程已暫停') && t.includes(FOREIGN))).toBe(true)
  const ui = await $.ui.mount(PANE(120))
  expect(await screen(ui)).toContain(flat('Alpha 流程已暫停：worktree 有未提交的改動（2 個檔）'))
  await ui.unmount()
  // AC-3：commit 或還原後（乾淨）按 g 照舊派出
  data.git[ROOT]!.changed = 0
  await h.go()
  expect(data.launches.length).toBe(1)
}

test('a recheck after an outside commit does not launder uncommitted changes into the last agent\'s mark', async ($, on) => {
  await passedThenOutsideCommit($, on, true)
})

test('a recheck with no prior dispatch still refuses to review a dirty worktree', async ($, on) => {
  await passedThenOutsideCommit($, on, false)
})

test('endedHow: stopped, finished, still running, asking, or unknown', () => {
  const a = (x: any) => ({ kind: 'background', name: 'desk-1', ...x })
  expect(endedHow([a({ state: 'stopped' })], 'desk-1')).toBe('stopped')
  expect(endedHow([a({ state: 'done', status: 'idle' })], 'desk-1')).toBe('finished')
  expect(endedHow([a({ state: 'done' })], 'desk-1')).toBe('finished')
  expect(endedHow([a({ state: 'working', status: 'busy' })], 'desk-1')).toBeNull()
  expect(endedHow([a({ state: 'blocked', status: 'waiting', waitingFor: 'x' })], 'desk-1')).toBeNull()
  expect(endedHow([a({ state: 'blocked', status: 'idle' })], 'desk-1')).toBeNull()
  expect(endedHow([a({ state: 'stopped', kind: 'interactive' })], 'desk-1')).toBeNull()
  expect(endedHow([a({ state: 'stopped', name: 'desk-2' })], 'desk-1')).toBeNull()
  expect(endedHow([], 'desk-1')).toBeNull()
  expect(endedHow([a({ state: 'stopped' })], undefined)).toBeNull()
})
