/**
 * Optional source integration, Node >= 24. This uses the checked-out official
 * patch parser/preflight/executor and local IO functions, the real Cordis event
 * dispatcher, and this plugin's recorder/API. A small filesystem/policy fixture
 * supplies service wiring; it is not a complete DSH Loader or sandbox test.
 *
 * DSH_SOURCE_DIR=<checkout> node --experimental-transform-types verify-patch-integration.mjs
 * DSH_INTEGRATION_MODULES may name an isolated directory containing current
 * dependencies (notably diff), without changing the plugin's old SDK lockfile.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = dirname(fileURLToPath(import.meta.url))
const sourceDirectory = process.env.DSH_SOURCE_DIR ?? process.argv[2]
const sourceRoot = sourceDirectory ? resolve(sourceDirectory) : undefined
if (!sourceRoot || !existsSync(join(sourceRoot, 'packages/fs/tool-fs/src/patch/index.ts'))) {
  throw new Error('Set DSH_SOURCE_DIR to an official DSH source checkout (or pass it as the first argument).')
}
const require = createRequire(import.meta.url)
const fsRequire = createRequire(require.resolve('@deepseek-ai/dsh-fs'))
const extraRequire = process.env.DSH_INTEGRATION_MODULES
  ? createRequire(join(resolve(process.env.DSH_INTEGRATION_MODULES), 'package.json')) : require
const sourceAliases = {
  '@deepseek-ai/dsh-fs-patch': 'packages/fs/fs-patch/src/index.ts',
  '@deepseek-ai/dsh-util-values': 'packages/util/values/src/index.ts',
}
const installedAliases = {
  '@deepseek-ai/dsh-fs': require.resolve('@deepseek-ai/dsh-fs'),
  '@deepseek-ai/cordis': require.resolve('@deepseek-ai/cordis'),
  '@deepseek-ai/dsh-llm': fsRequire.resolve('@deepseek-ai/dsh-llm'),
}
try { installedAliases.diff = extraRequire.resolve('diff') } catch { /* Optional source-integration dependency. */ }
const pluginSourceUrl = pathToFileURL(join(pluginRoot, 'src') + sep).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in sourceAliases) {
      return { url: pathToFileURL(join(sourceRoot, sourceAliases[specifier])).href, shortCircuit: true }
    }
    if (specifier in installedAliases) {
      return { url: pathToFileURL(installedAliases[specifier]).href, shortCircuit: true }
    }
    if (context.parentURL?.startsWith(pluginSourceUrl) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const fromSource = path => import(pathToFileURL(join(sourceRoot, path)).href)
const fromPlugin = path => import(pathToFileURL(join(pluginRoot, path)).href)
const [{ executePatch }, io, { Context }, { FsError }] = await Promise.all([
  fromSource('packages/fs/tool-fs/src/patch/index.ts'),
  fromSource('packages/fs/fs-local/src/fsio.ts'),
  import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-fs'),
])
let patchToolValue
try {
  ;({ patchToolValue } = await fromSource('packages/fs/tool-fs/src/apply-patch-output.ts'))
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_MODULE_NOT_FOUND') throw error
  throw new Error('Source integration requires the official result mapper dependency diff@^9. Install it in an isolated directory and set DSH_INTEGRATION_MODULES to that directory; no integration cases were run.', { cause: error })
}

// The default base profile mounts this real provider. Verify its admission
// contract independently from the fixture used for the disk round trips below.
const observationPolicy = await fromSource('packages/fs/fs-observation-policy/src/index.ts')
const policyContext = new Context()
const policyFiber = await policyContext.plugin(observationPolicy)
let capturedGuard
const stopGuardCapture = policyContext.on('fs/delete-intent', async (_target, _actor, next) => {
  const intent = await next()
  capturedGuard = intent
  return intent
}, { prepend: true })
const policyTarget = { targetKey: 'guard-target', displayPath: 'guard-target' }
const policyActor = { agent: { session: {} } }
const deleteIntent = () => policyContext.waterfall('fs/delete-intent', policyTarget, policyActor, () => undefined)
try {
  await assert.rejects(deleteIntent, error => error.code === 'FS_NOT_OBSERVED')
  assert.equal(capturedGuard, undefined, 'rejected admission never reaches optional capture')
  policyContext.emit('fs/observed', policyTarget, { kind: 'present', version: 'observed-v7' }, policyActor)
  const admittedGuard = await deleteIntent()
  assert.deepEqual(admittedGuard, { version: 'observed-v7' })
  assert.equal(capturedGuard, admittedGuard, 'capture returns the identical admitted version guard')
  policyContext.emit('fs/observed', policyTarget, { kind: 'absent' }, policyActor)
  await assert.rejects(deleteIntent, error => error.code === 'FS_NOT_FOUND')
} finally {
  stopGuardCapture()
  await policyFiber.dispose()
}
assert.equal(await deleteIntent(), undefined, 'unmounting the provider restores the unguarded fallback')
console.log('Official default observation policy verified: unseen/absent refused; observed version preserved.')

const tempParent = resolve(process.env.DSH_INTEGRATION_TEMP ?? tmpdir())
await mkdir(tempParent, { recursive: true })
const temporary = await mkdtemp(join(tempParent, 'file-undo-source-integration-'))
const home = join(temporary, 'home')
const workspace = join(temporary, 'workspace')
await mkdir(home)
await mkdir(workspace)
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, '.dsh')

try {
  const store = await fromPlugin('src/store.ts')
  const { installPatchRecorder } = await fromPlugin('src/patch-recorder.ts')
  const { buildApi } = await fromPlugin('src/api.ts')
  const ctx = new Context()
  const policy = { mode: 'workspace-write', workspaceRoot: workspace }
  let failDeletePath
  const fs = {
    resolve: (path, opts) => io.resolveLocalTarget(opts?.cwd ?? workspace, path),
    processPath: target => String(target.targetKey),
    stat: async target => (await io.probe(target.targetKey)) ?? undefined,
    lstat: async (path, opts) => (await io.probeNoFollow(resolve(opts?.cwd ?? workspace, path))) ?? undefined,
    readText: (target, signal) => io.readWholeText(target, signal),
    readBytes: (target, signal, maxBytes) => io.readWholeBytes(target, signal, maxBytes),
    async writeText(target, text, expected, signal, suppliedPolicy) {
      assert.equal(suppliedPolicy, policy)
      const prior = await io.probe(target.targetKey)
      if (expected?.kind === 'createIfAbsent' && prior !== null) throw new FsError('exists', 'FS_NOT_OBSERVED')
      if (expected?.kind === 'replaceIfVersion' && prior?.version !== expected.version) throw new FsError('stale', 'FS_STALE_VERSION')
      const before = prior ? await io.readTextForDiff(target.targetKey, 10 * 1024 * 1024, signal) : null
      await io.writeFileAtomic(target.targetKey, text, prior?.mode, signal, {}, {
        displayPath: target.displayPath, createIfAbsent: expected?.kind === 'createIfAbsent',
      })
      return { before, after: io.normalizeLineEndings(text), version: (await io.probe(target.targetKey)).version }
    },
    async deleteFile(target, expected, signal, suppliedPolicy) {
      assert.equal(suppliedPolicy, policy)
      if (target.targetKey === failDeletePath) throw new FsError('fixture denial', 'FS_PERMISSION_DENIED')
      const prior = await io.probe(target.targetKey)
      if (!prior || (expected && prior.version !== expected.version)) throw new FsError('stale', 'FS_STALE_VERSION')
      const before = await io.readTextForDiff(target.targetKey, 10 * 1024 * 1024, signal)
      await io.removeFile(target.targetKey, target.displayPath)
      return { before }
    },
  }
  ctx.provide('fs', fs)
  ctx.provide('workingDirectory', { ensure: async () => workspace })
  const intentCalls = []
  ctx.on('fs/delete-intent', async target => {
    intentCalls.push(target.targetKey)
    const info = await fs.stat(target)
    if (!info) throw new FsError('absent', 'FS_NOT_FOUND')
    return { version: info.version }
  })
  ctx.on('fs/write-intent', async target => {
    const info = await fs.stat(target)
    return info ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' }
  })
  const saved = []
  installPatchRecorder(ctx, async (scope, snapshot) => {
    saved.push(snapshot)
    await store.appendSnapshot(scope, snapshot)
  })
  const scope = { workspaceKey: store.workspaceKeyOf(workspace), chatKey: 'source-integration' }
  const api = buildApi(ctx, () => scope, undefined, async () => policy)
  let sequence = 0
  async function runPatch(input) {
    const exec = {
      name: 'apply_patch', callId: `call-${++sequence}`, rootCallId: `root-${sequence}`,
      token: {}, arguments: { input }, signal: new AbortController().signal,
      agent: { id: scope.chatKey, session: { header: { cwd: workspace } } },
    }
    const report = await executePatch(ctx, { mapError: error => error }, exec, { patch: input, sandboxPolicy: policy })
    let result
    try { result = { isError: false, value: patchToolValue(report), content: [] } }
    catch (error) { result = { isError: true, error, content: [] } }
    await ctx.waterfall('tools/post-execute', exec, result, () => ({ kind: 'accept' }))
    return report
  }

  const note = join(workspace, 'note.txt')
  const original = Buffer.from('\uFEFFfirst\r\nsecond\r\n', 'utf8')
  await writeFile(note, original)
  const single = await runPatch('*** Begin Patch\n*** Delete File: note.txt\n*** End Patch')
  assert.equal(single.phase, 'commit')
  assert.equal(single.outcomes[0].status, 'completed')
  assert.equal(single.outcomes[0].changes[0].before, 'first\nsecond\n')
  assert.equal(intentCalls.filter(path => path === note).length, 2, 'preflight and commit both request a delete intent')
  assert.equal(existsSync(note), false)
  const snapshot = saved.at(-1)
  assert.equal(snapshot.before, original.toString('utf8'))
  await api.apply({ id: snapshot.id, expectedCurrentHash: null })
  assert.deepEqual(await readFile(note), original)
  await api.reapply({ id: snapshot.id, expectedCurrentHash: store.sha256(original.toString('utf8')) })
  assert.equal(existsSync(note), false)

  // Real preflight supports repeated canonical targets and aliases in a patch.
  await writeFile(note, 'same\n')
  const savedBeforeRepeated = saved.length
  const repeated = await runPatch('*** Begin Patch\n*** Delete File: note.txt\n*** Add File: ./note.txt\n+same\n*** Delete File: note.txt\n*** End Patch')
  assert.equal(repeated.phase, 'commit')
  if (repeated.outcomes.some(row => row.status !== 'completed')) console.log(JSON.stringify(repeated))
  assert.deepEqual(repeated.outcomes.map(row => row.status), ['completed', 'completed', 'completed'])
  assert.equal(existsSync(note), false)
  console.log('Repeated-target source result:', JSON.stringify({
    statuses: repeated.outcomes.map(row => row.status), recordedRows: saved.length - savedBeforeRepeated,
  }))
  assert.equal(saved.length - savedBeforeRepeated, 0, 'repeated target deletions are deliberately not recorded')

  await writeFile(note, 'original\n')
  const savedBeforeRecreated = saved.length
  const recreated = await runPatch('*** Begin Patch\n*** Delete File: note.txt\n*** Add File: ./note.txt\n+new\n*** End Patch')
  assert.equal(recreated.phase, 'commit')
  assert.deepEqual(recreated.outcomes.map(row => row.status), ['completed', 'completed'])
  assert.equal(await readFile(note, 'utf8'), 'new\n')
  assert.equal(saved.length - savedBeforeRecreated, 0, 'delete then recreate is not a standalone deletion')

  // The first deletion remains completed when the second provider call fails.
  const first = join(workspace, 'first.txt')
  const second = join(workspace, 'second.txt')
  await writeFile(first, 'first\n')
  await writeFile(second, 'second\n')
  failDeletePath = second
  const savedBeforePartial = saved.length
  const partial = await runPatch('*** Begin Patch\n*** Delete File: first.txt\n*** Delete File: second.txt\n*** End Patch')
  assert.equal(partial.phase, 'commit')
  assert.deepEqual(partial.outcomes.map(row => row.status), ['completed', 'failed'])
  assert.equal(existsSync(first), false)
  assert.equal(existsSync(second), true)
  assert.equal(saved.length - savedBeforePartial, 1)
  assert.equal(saved.at(-1).filePath, first)
  console.log('verify-patch-integration: PASSED (official source executor + IO, Cordis, recorder and API; fixture policy)')
} finally {
  const cleanup = resolve(temporary)
  const rel = relative(tempParent, cleanup)
  assert(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'cleanup stays within the verified temporary parent')
  await rm(cleanup, { recursive: true, force: true })
}
