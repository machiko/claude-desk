import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B } from './fixture'
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
  expect(await ui.find({ type: 'Text', text: ' 容器 2' })).toBeDefined()
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
