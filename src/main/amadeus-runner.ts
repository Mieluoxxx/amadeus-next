import { serveRunner } from './durable/remote/runner.ts'

// 由本机经 `ssh <host> ... --stdio` 启动；stdin / stdout 是帧通道，退出码只给 ssh 看。
if (process.argv.includes('--stdio')) {
  void serveRunner({ input: process.stdin, output: process.stdout }).then(() => process.exit(0))
} else {
  process.stderr.write('usage: amadeus-runner --stdio\n')
  process.exit(2)
}
