import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { TargetPool, sshConnector } from '../src/main/durable/remote/pool.ts'
import { parseTargets, sshArguments, targetsFromEnv } from '../src/main/durable/remote/targets.ts'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 假 ssh：丢掉选项和主机名，把远程命令交给本机 sh，HOME 指向一个临时目录充当"远程家目录"。
 * 远程命令原样经过 sh 解析，所以部署脚本、引号与 `sh -lc` 的启动方式都按真实路径走一遍。
 */
function fakeSsh(base) {
  const remoteHome = path.join(base, 'remote-home')
  mkdirSync(path.join(remoteHome, 'work'), { recursive: true })
  const ssh = path.join(base, 'ssh')
  writeFileSync(ssh, `#!/bin/sh
n=$#; i=0; line=''
for arg in "$@"; do
  i=$((i + 1))
  if [ $i -lt $n ]; then line="$line$arg|"; else command=$arg; fi
done
echo "$line" >> "${base}/args.log"
HOME="${remoteHome}" exec sh -c "$command"
`)
  chmodSync(ssh, 0o755)
  // 远程只有 node：runner 的入口是 TypeScript，Node 22.18+ 默认去类型，用一个 .mjs 包一层代替打包产物。
  const runnerFile = path.join(base, 'amadeus-runner.mjs')
  writeFileSync(runnerFile, `import ${JSON.stringify(path.join(project, 'src/main/amadeus-runner.ts'))}\n`)
  return { ssh, runnerFile, remoteHome }
}

test('the ssh connector deploys the runner by content hash once and serves an env over ssh', async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'amadeus-ssh-')))
  const { ssh, runnerFile, remoteHome } = fakeSsh(base)
  const pool = new TargetPool({
    targets: [{ name: 'dev', ssh: "ssh -p 2222 -o 'User=me' devbox", workspace: '~/work', node: process.execPath }],
    connector: sshConnector({ runnerFile, ssh }),
    log: () => {},
  })
  try {
    const check = await pool.checkDir('dev', undefined)
    assert.deepEqual(check, { ok: true, path: path.join(remoteHome, 'work') })
    const env = await pool.env('dev', check.path)
    const result = await env.exec('echo "$HOME" && pwd', undefined, ctx)
    assert.equal(result.ok, true)
    assert.equal((await env.writeFile('hello.txt', 'hi from remote', ctx)).ok, true)
    assert.equal(readFileSync(path.join(remoteHome, 'work', 'hello.txt'), 'utf8'), 'hi from remote')
    const deployed = readdirSync(path.join(remoteHome, '.amadeus', 'runner'))
    assert.equal(deployed.length, 1)
    assert.match(deployed[0], /^[0-9a-f]{16}\.mjs$/)
    assert.equal(readFileSync(path.join(remoteHome, '.amadeus', 'runner', deployed[0]), 'utf8'), readFileSync(runnerFile, 'utf8'))
    // 我们的选项在前（ssh 对同一选项取第一次出现的值），用户的选项与主机原样跟在后面，部署与启动各一次。
    const ours = '-T|-o|BatchMode=yes|-o|ConnectTimeout=10|-o|ServerAliveInterval=15|-o|ServerAliveCountMax=3|'
    assert.deepEqual(readFileSync(path.join(base, 'args.log'), 'utf8').trim().split('\n'), [`${ours}-p|2222|-o|User=me|devbox|`, `${ours}-p|2222|-o|User=me|devbox|`])
  } finally {
    pool.close()
    rmSync(base, { recursive: true, force: true })
  }
})

test('a failing ssh surfaces its stderr in the offline reason', async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'amadeus-ssh-')))
  const ssh = path.join(base, 'ssh')
  writeFileSync(ssh, '#!/bin/sh\necho "ssh: Could not resolve hostname nowhere" >&2\nexit 255\n')
  chmodSync(ssh, 0o755)
  writeFileSync(path.join(base, 'runner.mjs'), '')
  const pool = new TargetPool({ targets: [{ name: 'gone', ssh: 'nowhere', workspace: '~', node: 'node' }], connector: sshConnector({ runnerFile: path.join(base, 'runner.mjs'), ssh }), log: () => {} })
  try {
    const check = await pool.checkDir('gone', undefined)
    assert.equal(check.ok, false)
    assert.equal(check.reason, 'offline')
    assert.match(check.detail, /Could not resolve hostname nowhere/)
    assert.ok(pool.offlineSince('gone') !== undefined)
  } finally {
    pool.close()
    rmSync(base, { recursive: true, force: true })
  }
})

test('the worker reads targets from the environment and skips bad entries', () => {
  const env = targets => ({ AMADEUS_REMOTE_TARGETS: JSON.stringify(targets) })
  assert.deepEqual(targetsFromEnv({}, () => {}), [])
  const logged = []
  assert.deepEqual(targetsFromEnv({ AMADEUS_REMOTE_TARGETS: '{not json' }, message => logged.push(message)), [])
  assert.equal(logged.length, 1)
  logged.length = 0
  assert.deepEqual(targetsFromEnv(env([
    { name: 'dev-box', ssh: 'dev-box', workspace: '~/work' },
    { name: 'gpu', host: 'A800', node: '/opt/node/bin/node' },
    { name: 'bad name', ssh: 'x' },
    { name: 'evil', ssh: '-oProxyCommand=sh' },
    { name: 'quoted', ssh: 'q', node: 'node; rm -rf ~' },
    { name: 'dev-box', ssh: 'other' },
  ]), message => logged.push(message)), [
    { name: 'dev-box', ssh: 'dev-box', workspace: '~/work', node: 'node' },
    { name: 'gpu', ssh: 'A800', workspace: '~', node: '/opt/node/bin/node' },
  ], 'the early host field still reads as an ssh command')
  assert.equal(logged.length, 4)
  assert.deepEqual(parseTargets('mini').errors, ['remote_targets must be a list'])
})

test('an ssh command splits into ssh arguments that end with the host', () => {
  const args = command => {
    const parsed = sshArguments(command)
    return parsed.ok ? [parsed.args, parsed.destination] : parsed.error
  }
  assert.deepEqual(args('mini'), [['mini'], 'mini'])
  assert.deepEqual(args('ssh -p 2222 me@10.0.0.5'), [['-p', '2222', 'me@10.0.0.5'], 'me@10.0.0.5'])
  assert.deepEqual(args('/usr/bin/ssh -p2222 -4 -J jump me@host'), [['-p2222', '-4', '-J', 'jump', 'me@host'], 'me@host'])
  assert.deepEqual(args(`ssh -i "~/my keys/id" -o 'ProxyJump=a b' host`), [['-i', '~/my keys/id', '-o', 'ProxyJump=a b', 'host'], 'host'])
  assert.deepEqual(args('ssh -tv -- host'), [['-tv', 'host'], 'host'])
  assert.match(args('ssh host uptime'), /must end with the host/)
  assert.match(args('ssh -N host'), /-N does not open a session/)
  assert.match(args('ssh -W localhost:22 jump'), /-W does not open a session/)
  assert.match(args('ssh -p'), /-p needs a value/)
  assert.match(args('ssh -p 22'), /needs a host/)
  assert.match(args('ssh "host'), /unclosed quote/)
  // 不经过 shell：$() 与分号只是普通字符，留在一个参数里。
  assert.deepEqual(args('ssh -o "LocalCommand=$(id)" h'), [['-o', 'LocalCommand=$(id)', 'h'], 'h'])
})
