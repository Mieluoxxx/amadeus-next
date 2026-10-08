import { bakeToFiles, type BakeJob } from './emoteBakeNode.ts'

type ParentPortLike = {
  on(event: 'message', listener: (event: unknown) => void): void
  postMessage(value: unknown): void
}

const port = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort

if (!port) throw new Error('E-mote bake worker must run as an Electron utility process')

// 每个进程只烘焙一次：烘焙峰值约 150 MB，跑完由宿主结束进程，内存整体归还系统。
port.on('message', raw => {
  const job = (raw && typeof raw === 'object' && 'data' in raw ? (raw as { data: unknown }).data : raw) as BakeJob
  bakeToFiles(job)
    .then(() => port.postMessage({ type: 'done' }))
    .catch(error => port.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) }))
})

port.postMessage({ type: 'ready' })
