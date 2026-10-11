// 启动埋点默认关闭，打开后每个里程碑只打一次、以进程起点为零点，便于前后对比启动顺序调整的收益。
const enabled = process.env.AMADEUS_BOOT_PROFILE === '1'
const seen = new Set<string>()

export function bootMark(name: string): void {
  if (!enabled || seen.has(name)) return
  seen.add(name)
  console.info(`__AMADEUS_BOOT__ ${JSON.stringify({ mark: name, ms: Math.round(process.uptime() * 1000) })}`)
}
