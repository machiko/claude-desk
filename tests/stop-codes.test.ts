import { expect, test } from 'claude-code/testing'
import { fixture, NOW, PANE, CARD_A, text, flat } from './fixture'
import { ROOT, alphaOnly, helpers } from './alpha-chain'
import { handedOver, nextStep, paused, shownStopped } from '../hooks/chain'
import { quotaHold, resetText } from '../hooks/model'
import { STOP, STOP_CODES, containersStop, readStop, specGapStop, stopText, verifyBrokeStop } from '../hooks/stop-reason'
import type { StopCause, StopReason } from '../hooks/stop-reason'
import { markRefusalStop } from '../hooks/worktree-mark'

// 流程停下的原因存成代碼＋參數（流程紀錄不含中文字），畫面顯示時才組句，句子跟改之前逐字相同；
// 更新前停下的流程存的是中文句，讀的時候照樣認得。

const run = (round = 0) => ({ owner: 'me', startedAt: 1, round })
const v = (critical: number, high: number) => ({ critical, high, medium: 0, low: 0 })
const RESETS_AT = new Date(NOW + 2.5 * 3_600_000).toISOString()
const LOW_FIVE_HOUR = [{ kind: 'five_hour', remaining: 25, resetsAt: RESETS_AT }]
/** 中日韓文字與全形標點：流程紀錄裡一個都不能有。 */
const CJK = /[　-〿一-鿿＀-￯]/

const stopOf = (step: ReturnType<typeof nextStep>): StopCause => {
  if (step?.kind !== 'stop') throw new Error(`not a stop: ${JSON.stringify(step)}`)
  return step.reason
}
const needsHumanOf = (step: ReturnType<typeof nextStep>): StopReason => {
  if (step?.kind !== 'pass' || !step.needsHuman) throw new Error(`not a high-risk pass: ${JSON.stringify(step)}`)
  return step.needsHuman
}

/** 每種停下原因：實際產生它的地方給的值，與改之前寫進流程紀錄、顯示在面板的那句話（逐字）。 */
const EVERY_STOP: readonly [string, StopCause, string][] = [
  ['測試指令改過', stopOf(nextStep(run(), 'continue', null, null, false, { changed: true })), '測試指令改過、還沒經你核准：按兩次 v 核准並執行，流程接著走'],
  ['測試指令還沒核准', stopOf(nextStep(run(), 'continue', null, null, false)), '測試指令還沒經你核准：按兩次 v 核准並執行，流程接著走'],
  ['Agent 被停止', stopOf(nextStep(run(), 'continue', true, null, true, { stopped: true })), 'Agent 被停止，未完成；看過 worktree 後按 g 重開'],
  ['MEDIUM 沒派出', STOP.mediumFixNotSent, '你選了修掉的審查 MEDIUM 沒派出修正：按 g 重派'],
  ['依審查修正沒派出', STOP.reviewFixNotSent, '依審查修正沒派出，失敗原因見動態：按 g 重派'],
  ['提問已在對話處理', stopOf(handedOver(nextStep(run(), 'review', null, v(1, 0), true))), '提問已在對話處理，不自動派修正'],
  ['自動修正上限（測試）', stopOf(nextStep(run(2), 'continue', false, null, true)), '整張卡已自動修 2 輪仍未通過測試：開 PR、按 g 再修一輪，或改規格'],
  ['自動修正上限（CRITICAL HIGH）', stopOf(nextStep(run(2), 'review', null, v(1, 2), true)), '整張卡已自動修 2 輪仍有 CRITICAL 1、HIGH 2：開 PR、按 g 再修一輪，或改規格'],
  ['驗收結論缺分級', stopOf(nextStep(run(), 'review', null, null, true)), '驗收結論缺少 CRITICAL／HIGH／MEDIUM／LOW 分級'],
  ['高風險改動', needsHumanOf(nextStep(run(), 'review', null, v(0, 0), true, { risk: { level: 'high', reasons: ['資料範圍', 'migration'] }, lastWasSecurity: true })), '高風險改動（資料範圍、migration），驗收已過，請你看過再開 PR'],
  ['額度煞車（審查段）', quotaHold(LOW_FIVE_HOUR, 30, NOW)!, `5 小時額度剩 25%，低於門檻 30%，${resetText(RESETS_AT, NOW)}後按 g 重開`],
  ['額度煞車（合併段）', quotaHold(LOW_FIVE_HOUR, 30, NOW, true)!, `5 小時額度剩 25%，低於門檻 30%，${resetText(RESETS_AT, NOW)}後在對話合併基準分支、解衝突`],
  ['額度煞車（讀不到重置時間）', quotaHold([{ kind: 'five_hour', remaining: 25 }], 30, NOW)!, '5 小時額度剩 25%，低於門檻 30%，重置後按 g 重開'],
  ['規格沒有驗收情境', specGapStop('alpha'), '規格沒有驗收情境：先輸入 /desk:card spec alpha'],
  ['別的對話開的改動', markRefusalStop({ files: 3, hash: 'h' }, undefined)!, 'worktree 有未提交的改動（3 個檔），不是上一個 Agent 留下的；可能有別的對話在改，commit 或還原後再派'],
  ['測試中斷', verifyBrokeStop('spawn sh ENOENT'), '測試中斷：spawn sh ENOENT'],
  ['容器沒起來', containersStop(['app', 'db']), '容器 app、db 未啟動，請先在主工作區執行 docker compose up -d app db'],
  ['解衝突沒派出', STOP.catchupNotSent, '解衝突沒派出（失敗原因見動態），排除後在對話合併基準分支、解衝突'],
]

/** AC-2 */
test('test_every_stop_reason_is_stored_as_code_and_shown_unchanged', () => {
  for (const [name, cause, sentence] of EVERY_STOP) {
    expect({ name, isCode: typeof cause !== 'string' }).toEqual({ name, isCode: true })
    const stop = cause as StopReason
    if (stop.code === 'highRisk') {
      // 高風險改動不是 stopped：過關時 needsHuman 只存代碼（面板只看有沒有），句子在動態／通知當下組
      expect(stopText(stop)).toBe(sentence)
      continue
    }
    // 存：流程紀錄（JSON 存進 $.store）只有代碼與參數，沒有中文字
    const stored = JSON.parse(JSON.stringify(paused(run(), cause)))
    expect({ name, stopped: stored.stopped }).toEqual({ name, stopped: stop.code })
    expect({ name, chinese: CJK.test(JSON.stringify({ stopped: stored.stopped, stopArgs: stored.stopArgs })) }).toEqual({ name, chinese: false })
    // 顯示：讀回來組出的句子跟改之前逐字相同
    expect({ name, shown: readStop(stored.stopped, stored.stopArgs)?.text }).toEqual({ name, shown: sentence })
    expect({ name, shown: shownStopped(stored.stopped, stored.stopArgs) }).toEqual({ name, shown: sentence })
    expect(readStop(stored.stopped, stored.stopArgs)?.code).toBe(stop.code)
  }
  // 每一種代碼都列舉到了（之後加新的停下原因，這裡會提醒要補）
  const covered = new Set(EVERY_STOP.map(([, cause]) => (cause as StopReason).code))
  expect([...STOP_CODES].filter(code => !covered.has(code as StopReason['code']))).toEqual([])
})

/** 更新前存進流程紀錄的舊句，與同一種停下現在存的代碼紀錄（heldAtCheck 照當時的寫法）。 */
const LEGACY: readonly { old: string; now: Record<string, unknown> }[] = [
  { old: '測試指令改過、還沒經你核准：按兩次 v 核准並執行，流程接著走', now: { stopped: 'checkChanged', heldAtCheck: true } },
  { old: '測試指令還沒經你核准：按兩次 v 核准並執行，流程接著走', now: { stopped: 'checkUnapproved', heldAtCheck: true } },
  { old: '完成檢查的指令改過、還沒經你核准：按兩次 v 核准並執行，流程接著走', now: { stopped: 'checkChanged', heldAtCheck: true } },
  { old: '完成檢查的指令還沒經你核准：按兩次 v 核准並執行，流程接著走', now: { stopped: 'checkUnapproved', heldAtCheck: true } },
  { old: 'Agent 被停止，未完成；看過 worktree 後按 g 重開', now: { stopped: 'agentStopped' } },
  { old: '你選了修掉的審查 MEDIUM 沒派出修正：按 g 重派', now: { stopped: 'mediumFixNotSent' } },
  { old: '依審查修正沒派出，失敗原因見動態：按 g 重派', now: { stopped: 'reviewFixNotSent' } },
  { old: '提問已在對話處理，不自動派修正', now: { stopped: 'askHandedOver' } },
  { old: '整張卡已自動修 2 輪仍未通過測試：開 PR、按 g 再修一輪，或改規格', now: { stopped: 'fixLimitCheck', stopArgs: { rounds: 2 } } },
  { old: '整張卡已自動修 2 輪仍有 CRITICAL 1、HIGH 2：開 PR、按 g 再修一輪，或改規格', now: { stopped: 'fixLimitReview', stopArgs: { rounds: 2, critical: 1, high: 2 } } },
  { old: '驗收結論缺少 CRITICAL／HIGH／MEDIUM／LOW 分級', now: { stopped: 'verdictMissing' } },
  { old: `5 小時額度剩 25%，低於門檻 30%，${resetText(RESETS_AT, NOW)}後按 g 重開`, now: { stopped: 'quotaHold', stopArgs: { left: 25, threshold: 30, at: NOW, resetsAt: RESETS_AT } } },
  { old: `5 小時額度剩 25%，低於門檻 30%，${resetText(RESETS_AT, NOW)}後在對話合併基準分支、解衝突`, now: { stopped: 'quotaHoldCatchup', stopArgs: { left: 25, threshold: 30, at: NOW, resetsAt: RESETS_AT } } },
  { old: '規格沒有驗收情境：先輸入 /desk:card spec alpha', now: { stopped: 'specGap', stopArgs: { slug: 'alpha' } } },
  { old: 'worktree 有未提交的改動（3 個檔），不是上一個 Agent 留下的；可能有別的對話在改，commit 或還原後再派', now: { stopped: 'foreignChanges', stopArgs: { files: 3 } } },
  { old: '測試中斷：spawn sh ENOENT', now: { stopped: 'verifyBroke', stopArgs: { error: 'spawn sh ENOENT' }, heldAtCheck: true } },
  { old: '容器 app、db 未啟動，請先在主工作區執行 docker compose up -d app db', now: { stopped: 'containersDown', stopArgs: { services: 'app db' }, heldAtCheck: true } },
  { old: '解衝突沒派出（失敗原因見動態），排除後在對話合併基準分支、解衝突', now: { stopped: 'catchupNotSent' } },
]
/** 換詞前的兩句：認得，顯示改成現在的說法。 */
const RENAMED: Record<string, string> = {
  '完成檢查的指令改過、還沒經你核准：按兩次 v 核准並執行，流程接著走': '測試指令改過、還沒經你核准：按兩次 v 核准並執行，流程接著走',
  '完成檢查的指令還沒經你核准：按兩次 v 核准並執行，流程接著走': '測試指令還沒經你核准：按兩次 v 核准並執行，流程接著走',
}

/** AC-3 */
test('test_legacy_sentence_records_are_still_recognized', async ($, on) => {
  // 讀：舊句認回同一種代碼，參數（數字、名稱）一起還原；句子原樣顯示（換詞前的兩句顯示新說法）
  for (const { old, now } of LEGACY) {
    const read = readStop(old)
    expect({ old, code: read?.code }).toEqual({ old, code: now.stopped })
    expect({ old, text: read?.text }).toEqual({ old, text: RENAMED[old] ?? old })
    const want = now.stopArgs as Record<string, unknown> | undefined
    const { at: _at, resetsAt: _resetsAt, ...args } = want ?? {}
    if (want) expect({ old, args: { ...read?.args } }).toMatchObject({ old, args })
  }
  // 認不得的舊句（沒改代碼的派工訊息、未來的新句）：原樣顯示、不當成任何一種停下
  const unknown = '排隊期間測試指令改了：重新核准後按 g 重派'
  expect(readStop(unknown)).toEqual({ text: unknown })

  // 面板：舊句紀錄與現在的代碼紀錄，整個面板（輪到你、檢查列、按鍵）畫出來一模一樣
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const h = helpers($, data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs --old' }
  data.store.jobs = { [ROOT]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'continue', startedAt: 0, fresh: false, owner: 'fixture-session', handled: true } } }
  const screen = async (chain: Record<string, unknown>) => {
    data.store.chains = { [ROOT]: { owner: 'fixture-session', startedAt: 0, round: 0, ...chain } }
    await h.refresh()
    const ui = await $.ui.mount(PANE(160))
    const shown = flat(text(await ui.drawn()))
    await ui.unmount()
    return shown
  }
  for (const { old, now } of LEGACY) {
    const legacy = await screen({ ...now, stopped: old, stopArgs: undefined })
    const current = await screen(now)
    expect({ old, same: legacy === current }).toEqual({ old, same: true })
    expect({ old, turn: legacy.includes(flat('▶ 輪到你')) }).toEqual({ old, turn: true })
  }
  expect(await screen({ stopped: unknown })).toContain(flat(unknown))
})
