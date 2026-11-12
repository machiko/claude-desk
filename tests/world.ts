// 多個測試檔共用的測試世界：讀畫面、在跑的工作桌 Agent、模擬派工啟動。改 Agent 或畫面讀法只改這裡。
import { flat, result, text } from './fixture'

/** 面板畫出來的字，去掉空白與邊框。 */
export const screen = async (ui: any) => flat(text(await ui.drawn()))

/** 一個在跑（busy）的背景 Agent；id 取名字後 8 碼。 */
export const busyAgent = (name: string, cwd: string, at = 0) => ({ id: name.slice(-8), kind: 'background', cwd, name, sessionId: `${name.slice(-8)}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: at })

/**
 * 派工啟動時，新 Agent 出現在 `claude agents` 清單。
 * keep：`all` 接在原清單後面；`others` 先拿掉同一個資料夾的舊 Agent 再接上；`none` 整份換成只有新的（cwd 用參數）。
 */
export function startsAgents(data: any, clock: any, opts: { keep: 'all' | 'others' | 'none'; cwd?: string }) {
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    const cwd = opts.keep === 'none' ? String(opts.cwd ?? '') : String(e.init?.cwd ?? '')
    const agent = { ...busyAgent(e.argv[3], cwd), id, sessionId: `${id}-0000-4000-8000-000000000000`, startedAt: clock.now() }
    const kept = opts.keep === 'all' ? data.agents : opts.keep === 'others' ? data.agents.filter((a: any) => a.cwd !== cwd) : []
    data.agents = [...kept, agent]
    return result(0, id)
  }
}

/** 一道閘門：open() 之前 wait 一直等著（模擬卡住的 docker compose ps、還沒回來的 claude --bg）。 */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const wait = new Promise<void>(resolve => { open = resolve })
  return { wait, open }
}
