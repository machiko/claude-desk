import { expect, test } from 'claude-code/testing'
import { fixture, PANE, BAND } from './fixture'
import { tutorialPaths } from '../hooks/tutorial'
declare const console: { log: (...args: unknown[]) => void }

// 把元素樹攤平成近似終端的文字：column Box 一子一行、row Box 同行相接、Text/Button 取文字。
function flat(node: any, indent = 0): string[] {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string') return [node]
  if (node.type === 'Text') return [textOf(node)]
  if (node.type === 'Button') return [`[${node.props?.hotkey ? node.props.hotkey + ':' : ''}${textOf(node)}]`]
  const kids: any[] = node.children ?? []
  const pad = ' '.repeat(node.props?.paddingLeft ?? node.props?.paddingX ?? 0)
  const top = node.props?.marginTop ?? 0
  const lines: string[] = []
  if (node.props?.flexDirection !== 'column') {
    const parts = kids.flatMap(k => flat(k)).filter(s => s !== '')
    lines.push(pad + parts.join(' '.repeat(typeof node.props?.gap === 'number' ? node.props.gap : 0)))
  } else {
    for (const k of kids) lines.push(...flat(k).map(l => pad + l))
  }
  return [...Array(top).fill(''), ...lines]
}
const textOf = (n: any): string => typeof n === 'string' ? n : n?.type === 'Button' && n.props?.label && !(n.children?.length) ? n.props.label : (n?.children ?? []).map(textOf).join('')

// 教學模式的畫面：現在卡是教學那件，其他案子是示範（只能看）。
test('preview', async ($, on) => {
  const { data, clock } = fixture(on)
  const P = tutorialPaths('/home/u')
  data.git[P.wt] = { branch: 'feature/discount', head: 'h0' }
  data.git[P.main] = { branch: 'release/v1.0', head: 'm0' }
  await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  await clock.settle()
  for (const columns of [40, 72, 120]) {
    const band = await $.ui.mount(BAND(columns))
    console.log(`\n==== band ${columns} ====\n` + flat(await band.drawn()).join('\n'))
    await band.unmount()
    const ui = await $.ui.mount(PANE(columns))
    console.log(`\n==== pane ${columns} ====\n` + flat(await ui.drawn()).join('\n'))
    await ui.unmount()
  }
  expect(true).toBe(true)
})
