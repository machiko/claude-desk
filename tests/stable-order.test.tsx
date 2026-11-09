import { expect, test } from 'claude-code/testing'
import { fixture, pressHotkey, CARD_A, CARD_B, CARD_C, NOW, PANE, REGISTRY } from './fixture'

/** 清單固定順序：全部任務照開卡順序（登錄表順序）排，狀態或卡片修改時間變了也不跳動，數字鍵永遠對同一件。 */

const CARD_D = '/home/u/wt/delta/.desk/CARD.md'
const IDLE = (name: string) => `<!-- DESK -->\n- 狀態：${name} 閒置\n- 驗證：無\n- 等你：無\n- 下一步：無\n- 關卡：無\n<!-- /DESK -->`
const ASKING = (name: string) => `<!-- DESK -->\n- 狀態：${name} 等你決定\n- 驗證：無\n- 等你：要 push 嗎？A) 要 B) 等\n- 下一步：push\n- 關卡：無\n<!-- /DESK -->`
const runningAgent = (cwd: string, id: string) => ({ id, kind: 'background', cwd, state: 'working', status: 'busy', name: `${id}-agent`, sessionId: `${id}-0000-4000-8000-000000000000`, startedAt: NOW - 60_000 })

/** 登錄表依序 A、B、C：A 閒置、B 在等你、C 有 Agent 正在跑。依急迫度排會是 B、C、A，跟登錄表順序不同。 */
function threeCases(data: any) {
  data.files[CARD_A] = IDLE('Alpha')
  data.files[CARD_B] = ASKING('Beta')
  data.files[CARD_C] = IDLE('Gamma')
  data.mtimes = { [CARD_A]: NOW - 2 * 86_400_000, [CARD_B]: NOW - 20 * 60_000, [CARD_C]: NOW - 3 * 60_000 }
  data.agents = [runningAgent('/home/u/wt/gamma', 'cccccccc')]
  data.logs = { cccccccc: '跑測試中\n' }
}

/** 全部任務清單由上到下：每列的卡片路徑與數字鍵。 */
async function listed(ui: any): Promise<[string, string | undefined][]> {
  const rows = (await ui.findAll({ type: 'Button' })).filter((b: any) => String(b.key).startsWith('row-'))
  return rows.map((b: any) => [String(b.key).slice('row-'.length), b.props?.hotkey])
}

const refresh = ($: any) => $.command.run({ command: 'desk', args: 'refresh' } as any)

test('task list keeps registry order regardless of state', async ($, on) => {
  const { data } = fixture(on)
  threeCases(data)
  await refresh($)
  const ui = await $.ui.mount(PANE(72))
  // AC-1：B 等你、C 在跑、A 閒置，清單照登錄表 A、B、C，數字鍵 1、2、3。
  const registryOrder: [string, string][] = [[CARD_A, '1'], [CARD_B, '2'], [CARD_C, '3']]
  expect(await listed(ui)).toEqual(registryOrder)

  // AC-2：C 的卡片被 Agent 寫入（修改時間變新）、A 變成等你：順序與數字鍵不變。
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 狀態：Gamma 閒置', '- 狀態：Gamma 跑測試中')
  data.mtimes = { ...data.mtimes, [CARD_C]: NOW }
  data.files[CARD_A] = ASKING('Alpha')
  await refresh($)
  expect(await listed(ui)).toEqual(registryOrder)

  // AC-4：開一張新卡 D（登錄表新增在最後）：D 排最後，A、B、C 的位置與數字鍵不變。
  data.files[REGISTRY] = `${data.files[REGISTRY]}\n| Delta | \`${CARD_D}\` |`
  data.files[CARD_D] = ASKING('Delta')
  data.mtimes = { ...data.mtimes, [CARD_D]: NOW }
  await refresh($)
  expect(await listed(ui)).toEqual([...registryOrder, [CARD_D, '4']])
  await ui.unmount()
})

test('number keys stay on the same task when states change', async ($, on) => {
  const { data } = fixture(on)
  threeCases(data)
  await refresh($)
  const ui = await $.ui.mount(PANE(72))
  // AC-3：按 2 選到 B。
  expect((await pressHotkey(ui, '2')).key).toBe(`row-${CARD_B}`)
  expect((await ui.find({ key: `row-${CARD_B}` }))?.text).toContain('▸')

  // B 答完變閒置、C 跑完改等你（依急迫度會排成 C、A、B）：先選別件，再按 2 仍選到 B。
  data.files[CARD_B] = IDLE('Beta')
  data.files[CARD_C] = ASKING('Gamma')
  data.agents = []
  data.mtimes = { ...data.mtimes, [CARD_B]: NOW - 5 * 86_400_000, [CARD_C]: NOW }
  await refresh($)
  expect((await pressHotkey(ui, '1')).key).toBe(`row-${CARD_A}`)
  expect((await pressHotkey(ui, '2')).key).toBe(`row-${CARD_B}`)
  expect((await ui.find({ key: `row-${CARD_B}` }))?.text).toContain('▸')
  expect((await ui.find({ key: `row-${CARD_A}` }))?.text).not.toContain('▸')
  await ui.unmount()
})
