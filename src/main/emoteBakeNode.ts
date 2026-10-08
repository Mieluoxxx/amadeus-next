import { open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createInflate } from 'node:zlib'
import { BAKER_VERSION, bakeModel } from '../shared/emote/bake.ts'

export type BakeJob = { folder: string; model: string; psb: string; meta: string }
export type Baker = { version: string; bake(job: BakeJob): Promise<void> }

async function* inflate(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* Readable.from(chunks, { objectMode: false }).pipe(createInflate())
}

/** 在当前进程内烘焙：worker 与测试共用这一实现。 */
export async function bakeToFiles(job: BakeJob): Promise<void> {
  const output = await open(job.psb, 'w')
  let meta
  try {
    meta = await bakeModel({
      model: job.model,
      read: file => readFile(path.resolve(job.folder, file)),
      inflate,
      write: async bytes => {
        for (let done = 0; done < bytes.length;) done += (await output.write(bytes, done)).bytesWritten
      },
    })
  } finally { await output.close() }
  await writeFile(job.meta, JSON.stringify(meta))
}

export const nodeBaker: Baker = { version: BAKER_VERSION, bake: bakeToFiles }
