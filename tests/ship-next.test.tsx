import { expect, test } from 'claude-code/testing'
import { fixture, BAND, PANE, CARD_B, REGISTRY } from './fixture'

const BETA = '/home/u/wt/beta'
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
const PR_MERGED = [{ number: 12, state: 'MERGED', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [] }]

/** 只留 Beta 一件：現在卡與摘要列都是它。 */
function only(data: any, gate: string, extra: Record<string, unknown> = {}) {
  data.agents = []
  data.files[REGISTRY] = `## 案子\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', gate)
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git', ...extra }
}

async function bandText($: any): Promise<string> {
  const band = await $.ui.mount(BAND(120))
  const drawn = JSON.stringify(await band.drawn())
  await band.unmount()
  return drawn
}

test('a merged case without a tag shows the same next step in the pane and the band and never offers archive', async ($, on) => {
  const { data } = fixture(on)
  only(data, PASSED)
  data.gh = PR_MERGED
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: /PR #12 → main/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '打 tag 發版' })).toBeDefined()
  const screen = JSON.stringify(await ui.drawn())
  expect(screen).not.toContain('可歸檔')
  expect(screen).not.toContain('archive')
  expect(screen).not.toContain('合併後打 tag')
  // 「▶ 輪到你」那一句與「下一步」列是同一句
  expect((await ui.findAll({ type: 'Text', text: '打 tag 發版' })).length).toBe(2)
  await ui.unmount()
  const band = await bandText($)
  expect(band).toContain('輪到你：打 tag 發版')
  expect(band).not.toContain('歸檔')
})

test('the pane next step follows the ship stage and offers archive only once the case is done', async ($, on) => {
  const { data } = fixture(on)
  // (a) tag 已打、關卡是 release：下一步與輪到你都是「部署後按 u」，不叫你歸檔
  only(data, '- 關卡：release：v0.19.0 可上線', { tag: 'v0.19.0' })
  data.gh = PR_MERGED
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  let ui = await $.ui.mount(PANE(80))
  expect((await ui.findAll({ type: 'Text', text: '部署 v0.19.0 後按 u 確認上線' })).length).toBe(2)
  expect(JSON.stringify(await ui.drawn())).not.toContain('可歸檔')
  await ui.unmount()
  // (b) 關卡不是 release：六段全綠，下一步與輪到你都指向歸檔
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：release：v0.19.0 可上線', PASSED)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  ui = await $.ui.mount(PANE(80))
  // 完成的案子不搶「現在」，點它的列看詳情
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /✓ 完成 v0\.19\.0/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '輸入 /desk:card archive beta 歸檔' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '已合併，可歸檔：/desk:card archive beta' })).toBeDefined()
  await ui.unmount()
})

test('a tag containing an unreviewed, unmerged branch head does not mark the case shipped', async ($, on) => {
  const { data } = fixture(on)
  // 從已打 v0.19.0 的 main 剛開的分支：HEAD 被 tag 包含，但規格還沒確認、沒有 PR、沒審查
  only(data, '- 關卡：spec：待確認規格', { tag: 'v0.19.0' })
  data.gh = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  const screen = JSON.stringify(await ui.drawn())
  expect(screen).not.toContain('✓ 完成')
  expect(screen).not.toContain('已上線')
  expect(screen).not.toContain('可歸檔')
  expect(screen).not.toContain('archive beta')
  expect(await ui.find({ type: 'Text', text: '看過規格後輸入 /desk:card spec beta ok' })).toBeDefined()
  await ui.unmount()
  const band = await bandText($)
  expect(band).not.toContain('歸檔')
  expect(band).toContain('規格')
})
