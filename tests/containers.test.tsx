import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C } from './fixture'
import { gate, screen } from './world'
import { CONTAINERS_TTL_MS } from '../hooks/probes'
import { parseCompose, summarize, servicesFor, missingServices } from '../hooks/containers'

const svc = (Service: string, State = 'running', Health = '') => JSON.stringify({ Service, State, Health })

test('compose output: one json per line or an array; down and unhealthy services named', () => {
  const lines = [svc('app'), svc('worker', 'exited'), svc('mysql'), svc('redis', 'running', 'unhealthy')].join('\n')
  expect(summarize(parseCompose(lines))).toEqual({ total: 4, running: 3, down: ['worker'], unhealthy: ['redis'] })
  expect(parseCompose(`[${svc('app')}]`)).toEqual([{ service: 'app', state: 'running', health: '' }])
  expect(parseCompose('not json')).toEqual([])
})

const COMPOSE = { options: { composeDir: '/home/u/app' } }

test('which services a check needs', () => {
  expect(servicesFor('docker compose exec -T app php artisan test --parallel')).toEqual(['app'])
  expect(servicesFor('docker compose exec -T -w /var/www app php artisan test && docker compose exec -T worker php artisan queue:work --once')).toEqual(['app', 'worker'])
  // 包好的測試腳本：設定檔 checkServices 指定它要哪些服務；沒設定就不猜
  expect(servicesFor('~/work/.bin/run-tests login', { 'run-tests': ['mysql'] })).toEqual(['mysql'])
  expect(servicesFor('~/work/.bin/run-tests login')).toEqual([])
  expect(servicesFor('run-tests-all', { 'run-tests': ['mysql'] })).toEqual([])
  expect(missingServices('run-tests x', { total: 2, running: 1, down: ['mysql'], unhealthy: [] }, { 'run-tests': ['mysql'] })).toEqual(['mysql'])
  expect(servicesFor('node test.mjs')).toEqual([])
  expect(missingServices('docker compose exec -T app x', { total: 2, running: 1, down: ['app'], unhealthy: [] })).toEqual(['app'])
  expect(missingServices('docker compose exec -T app x', { total: 0, running: 0, down: [], unhealthy: [], error: 'x' })).toEqual([])
})

test('container trouble shows in the header; all running is one mark in the footer status', COMPOSE, async ($, on) => {
  const { data } = fixture(on)
  data.compose = [svc('app'), svc('worker', 'exited'), svc('mysql')].join('\n')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  let ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: '✕ worker 未啟動' })).toBeDefined()
  await ui.unmount()
  data.compose = [svc('app'), svc('mysql')].join('\n')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: ' 容器 2/2 執行中' })).toBeDefined()
  await ui.unmount()
  data.compose = null
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: /無法讀取/ })).toBeDefined()
  await ui.unmount()
})

test('a check that needs a stopped container does not run and is not recorded as failed', COMPOSE, async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[CARD_A] = data.files[CARD_A]!.replace('`node test.mjs`', '`docker compose exec -T app php artisan test`')
  data.compose = [svc('app', 'exited'), svc('mysql')].join('\n')
  data.store.trustedVerify = { [CARD_A]: 'docker compose exec -T app php artisan test' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'verify Alpha' } as any)
  await clock.settle()
  expect(data.processCalls.length).toBe(0)
  expect(data.store.verifies).toBeUndefined()
  expect(data.toasts.some(t => t.includes('容器 app 未啟動'))).toBe(true)
})

test('only one check runs at a time; the next waits in line and runs after', COMPOSE, async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[CARD_B] = data.files[CARD_B]!.replace('`npm test`', '`npm test`')
  data.agents = []
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test' }
  const order: string[] = []
  data.run = async (e: any) => { order.push(`start ${e.argv[2]}`); await clock.sleep(1000); order.push(`end ${e.argv[2]}`); return { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'verify Alpha' } as any)
  await clock.settle()
  await $.command.run({ command: 'desk', args: 'verify Beta' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: '排隊中（第 1 位）' })).toBeDefined()
  await ui.unmount()
  expect(data.toasts.some(t => t.includes('已排隊'))).toBe(true)
  await clock.advance(1000); await clock.settle()
  await clock.advance(1000); await clock.settle()
  expect(order).toEqual(['start node test.mjs', 'end node test.mjs', 'start npm test', 'end npm test'])
})

test('no compose folder set: no container row, no docker call, checks are not held back', async ($, on) => {
  const { data } = fixture(on)
  data.compose = [svc('app', 'exited')].join('\n')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: /未啟動/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /容器/ })).toBeUndefined()
})

const APP_CHECK = 'docker compose exec -T app php artisan test'

/** Alpha 的完成檢查要 app 容器（已核准）；下一次 docker compose ps 卡住，open() 才回來。 */
function alphaNeedsApp(data: any) {
  data.files[CARD_A] = data.files[CARD_A]!.replace('`node test.mjs`', `\`${APP_CHECK}\``)
  data.store.trustedVerify = { [CARD_A]: APP_CHECK }
}
function holdDocker(data: any) {
  const held = gate()
  data.exec = async (e: any) => { if (e.argv[0] === 'docker') { data.exec = null; await held.wait } return null }
  return held
}

/** 按鍵即時反應 AC-2：按 v 後容器狀態還沒查回來就顯示測試中；容器都在跑照常執行並記結果，沒在跑就退回原樣、不記成未通過 */
test('test_v_shows_testing_before_container_status_returns', COMPOSE, async ($, on) => {
  const { data, clock } = fixture(on)
  alphaNeedsApp(data)
  data.compose = [svc('app'), svc('mysql')].join('\n')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_A}` })

  // 容器都在跑：查回來之前已經是測試中，查回來才真的執行
  let docker = holdDocker(data)
  await $.command.run({ command: 'desk', args: 'verify Alpha' } as any)
  await clock.settle()
  expect(await screen(ui)).toContain('測試中')
  expect(data.processCalls).toHaveLength(0)
  docker.open()
  await clock.settle()
  expect(data.processCalls.map((e: any) => e.argv.join(' '))).toEqual([`sh -c ${APP_CHECK}`])
  expect((data.store.verifies as any)?.[CARD_A]?.ok).toBe(true)
  expect(await screen(ui)).not.toContain('測試中')
  const recorded = (data.store.verifies as any)[CARD_A]

  // app 停了：一樣先顯示測試中，查回來後退回原樣、提示先啟動 app，結果不記成未通過
  data.compose = [svc('app', 'exited'), svc('mysql')].join('\n')
  docker = holdDocker(data)
  await $.command.run({ command: 'desk', args: 'verify Alpha' } as any)
  await clock.settle()
  expect(await screen(ui)).toContain('測試中')
  docker.open()
  await clock.settle()
  expect(await screen(ui)).not.toContain('測試中')
  expect(data.processCalls).toHaveLength(1)
  expect((data.store.verifies as any)[CARD_A]).toEqual(recorded)
  expect(data.toasts.some(t => t.includes('容器 app 未啟動'))).toBe(true)
  await ui.unmount()
})

/** 每輪重新整理的間隔設成最短（10 秒），面板開著（不閒置）。 */
const EVERY_10S = { options: { composeDir: '/home/u/app', refreshSeconds: '10' } }

/** 按鍵即時反應 AC-5：30 秒內的重新整理沿用容器狀態，不再問 docker；過了 30 秒就重問、容器狀態更新 */
test('test_container_status_is_reused_within_thirty_seconds_and_requeried_after', EVERY_10S, async ($, on) => {
  const { data, clock } = fixture(on)
  data.compose = [svc('app'), svc('mysql')].join('\n')
  // 數重新整理了幾輪（每輪問一次 claude agents），確認 10、20 秒時真的有整理
  const rounds = { n: 0 }
  data.exec = (e: any) => { if (e.argv[0] === 'claude' && e.argv[1] === 'agents') rounds.n++; return null }
  await $.command.run({ command: 'desk', args: '' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(80))
  expect(data.composeCalls).toHaveLength(1)
  expect(await screen(ui)).toContain('容器2/2執行中')
  const first = rounds.n

  // 10、20 秒後的兩輪：沿用，畫面照舊（docker 那邊其實停了一個，也還不知道）
  data.compose = [svc('app', 'exited'), svc('mysql')].join('\n')
  await clock.advance(10_000); await clock.settle()
  await clock.advance(10_000); await clock.settle()
  expect(rounds.n - first).toBe(2)
  expect(data.composeCalls).toHaveLength(1)
  expect(await screen(ui)).toContain('容器2/2執行中')

  // 過了 30 秒的那一輪：重問，標頭換成 app 未啟動
  await clock.advance(CONTAINERS_TTL_MS - 20_000); await clock.settle()
  expect(data.composeCalls).toHaveLength(2)
  expect(await screen(ui)).toContain('✕app未啟動')
  await ui.unmount()
})

/** 按鍵即時反應 AC-5：按 r（面板或 /desk refresh）不沿用 30 秒內的容器狀態，馬上重問 */
test('test_pressing_r_requeries_container_status', COMPOSE, async ($, on) => {
  const { data, clock } = fixture(on)
  data.compose = [svc('app'), svc('mysql')].join('\n')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(80))
  expect(data.composeCalls).toHaveLength(1)

  data.compose = [svc('app', 'exited'), svc('mysql')].join('\n')
  await clock.advance(1000)
  await ui.press({ key: 'more' })
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(data.composeCalls).toHaveLength(2)
  expect(await screen(ui)).toContain('✕app未啟動')

  data.compose = [svc('app'), svc('mysql')].join('\n')
  await clock.advance(1000)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(data.composeCalls).toHaveLength(3)
  expect(await screen(ui)).toContain('容器2/2執行中')
  await ui.unmount()
})

/**
 * 按鍵即時反應審查 HIGH 同類：檢查在一輪重新整理開始前就在跑、在那輪卡著時跑完；
 * 那輪（讀到的是「測試中」）跑完後畫面仍是這次的結果，不退回測試中
 */
test('test_check_result_survives_a_refresh_that_started_before_it', COMPOSE, async ($, on) => {
  const { data, clock } = fixture(on)
  data.compose = [svc('app'), svc('mysql')].join('\n')
  // Gamma：沒有要你決定的事、沒有 Agent；檢查會沒過（沒過會改這張卡的狀態）
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 驗證：無', '- 驗證：`node test.mjs`')
  data.store.trustedVerify = { [CARD_C]: 'node test.mjs' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_C}` })

  // 檢查開跑、還沒跑完
  const check = gate()
  data.run = async () => { await check.wait; return { exitCode: 1, stdout: '1 failing\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  await $.command.run({ command: 'desk', args: 'verify Gamma' } as any)
  await clock.settle()
  expect(await screen(ui)).toContain('測試中')
  // 接著一輪重新整理讀到「測試中」後卡在 docker compose ps；這時檢查跑完（沒過）
  const docker = holdDocker(data)
  const stuck = $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  check.open()
  await clock.settle()
  expect((data.store.verifies as any)?.[CARD_C]?.ok).toBe(false)
  const failed = await screen(ui)
  expect(failed).not.toContain('測試中')

  docker.open()
  await stuck
  await clock.settle()
  expect(await screen(ui)).toEqual(failed)
  await ui.unmount()
})
