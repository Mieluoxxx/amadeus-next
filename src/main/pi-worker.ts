export type ParentPortLike = {
  on(event: 'message', listener: (event: unknown) => void): void
  postMessage(value: unknown): void
}

const port = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort

if (!port) throw new Error('Pi worker must run as an Electron utility process')

const { startDurableWorker } = await import('./durable/worker.ts')
startDurableWorker(port)
