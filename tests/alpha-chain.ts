// 只看 Alpha 的流程測試共用：派工、Agent 做完、檢查、按鍵（verify-trust、approve-twice）。
import { CARD_A, REGISTRY, result } from './fixture'

export const ROOT = '/home/u/wt/alpha'
export const PREFIX = `case-${CARD_A}-`
/** 跑過幾次完成檢查（`sh -c <指令>`）。 */
export const sh = (data: any): number => data.processCalls.filter((c: any) => c.argv[0] === 'sh').length

/** 只看 Alpha：卡片沒有待決策、沒有別的 Agent；每次派工都換一個背景 agent，跑到 finish() 才結束。 */
export function alphaOnly(data: any, clock: any) {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |`
  data.git[ROOT] = { branch: 'feature/alpha', head: 'h1' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.agents = []
  let n = 0
  data.launch = async (e: any) => {
    n++
    const id = `a000000${n}`
    data.agents = [{ id, kind: 'background', cwd: ROOT, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
}

export function helpers($: any, data: any, clock: any) {
  const step = async () => { await clock.advance(2500); await clock.settle() }
  return {
    step,
    refresh: async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() },
    finish: async () => {
      data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
      await $.command.run({ command: 'desk', args: 'refresh' } as any)
      await clock.settle(); await step(); await step(); await step()
    },
    verify: async () => { await $.command.run({ command: 'desk', args: 'verify Alpha' } as any); await clock.settle(); await step(); await step() },
    prompt: (i: number) => String(data.launches[i].argv[data.launches[i].argv.length - 1]),
    setGate: (g: string) => { data.files[CARD_A] = data.files[CARD_A]!.replace(/- 關卡：.*$/m, `- 關卡：${g}`) },
    setCheck: (cmd: string) => { data.files[CARD_A] = data.files[CARD_A]!.replace(/- 驗證：.*$/m, `- 驗證：\`${cmd}\``) },
    /** 面板上按兩次 g（派工要按兩次確認）。 */
    pressGo: async (ui: any) => {
      await ui.press({ key: `${PREFIX}continue` }); await clock.settle()
      await ui.press({ key: `${PREFIX}continue` }); await clock.settle()
    },
  }
}
