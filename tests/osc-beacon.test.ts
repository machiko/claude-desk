import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, REGISTRY, NOW, text, flat } from './fixture'
import {
  applyOscToAgent,
  approveText,
  beaconAgentInfo,
  parseBeaconJson,
  parseOsc7501,
  plain,
  stateOf,
  summary,
} from '../hooks/model'
import { touchesDesk } from '../hooks/touch'

const BETA = '/home/u/wt/beta'
const PREFIX = `case-${CARD_B}-`

test('parseOsc7501 extracts the latest Herdr-compatible OSC 7501 state and plain() strips it cleanly', () => {
  const raw = [
    '● 開始檢查程式碼',
    '\u001b]7501;state=working;agent=agy;msg=執行靜態分析\u001b\\',
    '發現需要資料庫權限',
    '\u001b]7501;state=blocked;agent=agy;wait=permission;msg=需要 migration 權限\u0007',
  ].join('\n')

  const sig = parseOsc7501(raw)
  expect(sig).toEqual({
    state: 'blocked',
    agent: 'agy',
    waitsFor: 'permission',
    message: '需要 migration 權限',
  })
  // plain() 必須把 OSC 7501 完全清掉，不留控制碼在畫面上
  const cleaned = plain(raw)
  expect(cleaned).not.toContain('7501')
  expect(cleaned).toContain('發現需要資料庫權限')
})

test('beaconAgentInfo maps working, blocked, done, and dead PIDs accurately', () => {
  const workingBeacon = parseBeaconJson(JSON.stringify({
    state: 'working',
    agent: 'agy',
    pid: 4242,
    startedAt: NOW - 15_000,
    message: '正在審查 diff',
  }))
  const workingInfo = beaconAgentInfo(BETA, workingBeacon, null, '● 正在檢查 hooks/probes.ts', true)
  expect(workingInfo).toEqual({
    id: `beacon:${BETA}`,
    name: 'agy',
    runner: 'agy',
    source: 'beacon',
    state: 'working',
    status: 'busy',
    startedAt: NOW - 15_000,
    pid: 4242,
    last: '● 正在檢查 hooks/probes.ts',
  })

  // PID 已死時不留殭屍狀態
  expect(beaconAgentInfo(BETA, workingBeacon, null, '● 正在檢查', false)).toBeUndefined()

  // blocked 預設或指定 permission → status waiting, waitsFor permission
  const blockedBeacon = parseBeaconJson(JSON.stringify({
    state: 'blocked',
    agent: 'agy',
    pid: 4242,
    waitsFor: 'permission',
    message: '等待執行 docker compose 權限',
  }))
  const blockedInfo = beaconAgentInfo(BETA, blockedBeacon, null, '', true)
  expect(blockedInfo?.status).toBe('waiting')
  expect(blockedInfo?.waitsFor).toBe('permission')
  expect(approveText({ agent: blockedInfo })).toBe(
    'Agent 在等權限批准：到 agy 終端機視窗確認（等待執行 docker compose 權限）；確認後面板會自動更新',
  )

  // done 與 idle 代表外部 Agent 已收工，不佔用面板進行中狀態
  const doneBeacon = parseBeaconJson(JSON.stringify({ state: 'done', agent: 'agy' }))
  expect(beaconAgentInfo(BETA, doneBeacon, { state: 'working', agent: 'agy' }, '舊輸出', true)).toBeUndefined()
})

test('applyOscToAgent upgrades a busy claude --bg agent to waiting when OSC 7501 reports blocked', () => {
  const base = { id: 'bbbbbbbb', name: 'desk-launch-1', state: 'working', status: 'busy' }
  const osc = parseOsc7501('\u001b]7501;state=blocked;wait=question;msg=要保留舊欄位嗎？\u001b\\')
  const upgraded = applyOscToAgent(base, osc, '要保留舊欄位嗎？')
  expect(upgraded?.status).toBe('waiting')
  expect(upgraded?.waitsFor).toBe('question')
  expect(upgraded?.waitingFor).toBe('要保留舊欄位嗎？')
  expect(stateOf({
    name: 'Beta',
    statusPath: CARD_B,
    root: BETA,
    hasCard: true,
    status: '實作中',
    verify: 'npm test',
    ask: '無',
    next: '跑測試',
    gate: '無',
    updatedAt: NOW,
    agent: upgraded,
  }, undefined)).toBe('reply')
  expect(summary({
    name: 'Beta',
    statusPath: CARD_B,
    root: BETA,
    hasCard: true,
    status: '實作中',
    verify: 'npm test',
    ask: '無',
    next: '跑測試',
    gate: '無',
    updatedAt: NOW,
    agent: upgraded,
    state: 'reply',
  })).toBe('Agent 等待：要保留舊欄位嗎？')
})

test('touchesDesk detects .task/agent-state.json writes and card.py emit commands', () => {
  expect(touchesDesk({ tool: 'Write', file_path: `${BETA}/.task/agent-state.json` }, [])).toBe(true)
  expect(touchesDesk({ tool: 'Bash', command: 'python3 skills/card/scripts/card.py emit beta blocked' }, [])).toBe(true)
})

test('desk panel displays external agy beacon state and opens .task/AGENT-OUT.md on pressing l', async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.agents = []
  data.files[`${BETA}/.task/agent-state.json`] = JSON.stringify({
    state: 'blocked',
    agent: 'agy',
    waitsFor: 'permission',
    message: '需要寫入設定檔權限',
    startedAt: NOW - 30_000,
    updatedAt: NOW - 1_000,
  })
  data.files[`${BETA}/.task/AGENT-OUT.md`] = [
    '\u001b]7501;state=working;agent=agy\u001b\\',
    '● 正在分析架構與邊界條件',
    '● 準備寫入設定檔，等待權限確認',
    '\u001b]7501;state=blocked;agent=agy;wait=permission;msg=需要寫入設定檔權限\u001b\\',
  ].join('\n')

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(110))
  const beforeLogs = flat(text(await ui.drawn()))

  expect(beforeLogs).toContain(flat('等批准'))
  expect(beforeLogs).toContain(flat('到 agy 終端機視窗確認（需要寫入設定檔權限）'))
  expect((await ui.find({ key: `${PREFIX}logs` }))?.props?.hotkey).toBe('l')

  await ui.press({ key: `${PREFIX}logs` })
  await clock.settle()
  const afterLogs = flat(text(await ui.drawn()))
  expect(afterLogs).toContain(flat('正在分析架構與邊界條件'))
  expect(afterLogs).toContain(flat('準備寫入設定檔，等待權限確認'))
  await ui.unmount()
})
