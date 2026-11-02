import assert from 'node:assert/strict'
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
import { apply, canonicalizeToolCallStream } from '../index.js'

const PTC = [{ name: 'run_code' }]
const allowed = ['write']

async function* of(chunks) { for (const c of chunks) yield c }
async function collect(source, options) { const out = []; for await (const c of canonicalizeToolCallStream(source, options)) out.push(c); return out }

function writeCallChunks(rawArgs, { name = 'write', id = 'call_1', index = 0 } = {}) {
  // split arguments into two deltas to exercise delta accumulation
  const half = Math.max(1, Math.floor(rawArgs.length / 2))
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name, argumentsDelta: rawArgs.slice(0, half) },
    { type: 'tool-call-delta', index, id, argumentsDelta: rawArgs.slice(half) },
    { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: rawArgs } },
  ]
}

async function runGenerated(code, expected) {
  const calls = []
  const tools = { write: async (args) => { calls.push(args); return 'ok' } }
  const fn = new AsyncFunction('tools', code)
  const result = await fn(tools)
  assert.equal(result, 'ok')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], expected)
}

function transformedArgs(out) {
  const end = out.find(c => c.type === 'block-end' && c.block?.type === 'tool-call')
  assert.ok(end, 'expected a tool-call block-end in output')
  assert.equal(end.block.name, 'run_code')
  return JSON.parse(end.block.arguments)
}

// 1. Nasty content: backticks, ${}, quotes, backslashes, newlines, unicode
{
  const args = {
    file_path: '/tmp/ptc-dc-test/x.txt',
    content: 'line1\n`backtick` ${"template"} "double" \'single\' back\\slash unicode ✓\n\\s\\d invalid-js-escape-raw',
  }
  const raw = JSON.stringify(args)
  const out = await collect(of([...writeCallChunks(raw), { type: 'finish', reason: 'stop' }]), { tools: PTC, allowed })
  const { code, description } = transformedArgs(out)
  assert.equal(description, 'Call write directly')
  assert.ok(code.startsWith('{\n  return await tools.write('), code)
  await runGenerated(code, args)
  const finish = out.find(c => c.type === 'finish')
  assert.ok(!('replayState' in finish), 'replayState stripped after transform')
  console.log('1. nasty content round-trips: OK')
}

// 2. __proto__ own key (JSON.parse produces own property)
{
  const raw = JSON.stringify({ file_path: '/tmp/x', content: 'x' })
  const args = JSON.parse(raw)
  Object.defineProperty(args, '__proto__', { own: true }) // no-op guard; build properly below
  const args2 = JSON.parse('{"__proto__":{"evil":true},"file_path":"/tmp/x"}')
  assert.ok(Object.hasOwn(args2, '__proto__'))
  const raw2 = JSON.stringify(args2)
  const out = await collect(of([...writeCallChunks(raw2, { id: 'call_2' }), { type: 'finish', reason: 'stop' }]), { tools: PTC, allowed })
  const { code } = transformedArgs(out)
  await runGenerated(code, args2)
  console.log('2. __proto__ own key round-trips: OK')
}

// 3. Deep nesting (130 levels > 128 ceiling)
{
  let deep = 'leaf'
  for (let i = 0; i < 130; i += 1) deep = { n: i, next: deep }
  const args = { file_path: '/tmp/deep', content: deep }
  const raw = JSON.stringify(args)
  const out = await collect(of([...writeCallChunks(raw, { id: 'call_3' }), { type: 'finish', reason: 'stop' }]), { tools: PTC, allowed })
  const { code } = transformedArgs(out)
  assert.ok(code.includes('JSON.parse('), 'deep nesting should use JSON.parse fallback')
  await runGenerated(code, args)
  console.log('3. deep nesting round-trips: OK')
}

// 4. Disallowed tool (bash) passes through unchanged
{
  const raw = JSON.stringify({ command: 'ls' })
  const input = [...writeCallChunks(raw, { name: 'bash', id: 'call_4' }), { type: 'finish', reason: 'stop' }]
  const out = await collect(of(input), { tools: PTC, allowed })
  assert.deepEqual(out, input)
  console.log('4. disallowed tool passes through: OK')
}

// 5. Malformed JSON arguments pass through unchanged
{
  const raw = '{"file_path": oops'
  const input = [...writeCallChunks(raw, { id: 'call_5' }), { type: 'finish', reason: 'stop' }]
  const out = await collect(of(input), { tools: PTC, allowed })
  assert.deepEqual(out, input)
  console.log('5. malformed JSON passes through: OK')
}

// 6. Non-PTC tool view leaves everything untouched
{
  const raw = JSON.stringify({ file_path: '/tmp/x' })
  const input = [...writeCallChunks(raw, { id: 'call_6' }), { type: 'finish', reason: 'stop' }]
  const out = await collect(of(input), { tools: [{ name: 'write' }, { name: 'bash' }], allowed })
  assert.deepEqual(out, input)
  console.log('6. non-PTC view passes through: OK')
}

// 7. Mixed stream: text + write + finish(replayState)
{
  const raw = JSON.stringify({ file_path: '/tmp/mixed', content: 'hi' })
  const input = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Writing ' },
    { type: 'text-delta', index: 0, text: 'file.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Writing file.' } },
    ...writeCallChunks(raw, { id: 'call_7', index: 1 }),
    { type: 'finish', reason: 'stop', replayState: { response: { id: 'resp_1' } } },
  ]
  const out = await collect(of(input), { tools: PTC, allowed })
  assert.equal(out[0].type, 'block-start')
  assert.equal(out[0].index, 0)
  const end = out.find(c => c.type === 'block-end' && c.index === 1)
  assert.equal(end.block.name, 'run_code')
  const { code } = JSON.parse(end.block.arguments)
  await runGenerated(code, JSON.parse(raw))
  const finish = out.find(c => c.type === 'finish')
  assert.ok(!('replayState' in finish))
  console.log('7. mixed stream transforms only the write block: OK')
}

// 8. tools.-prefixed name resolves
{
  const raw = JSON.stringify({ file_path: '/tmp/prefixed' })
  const out = await collect(of([...writeCallChunks(raw, { name: 'tools.write', id: 'call_8' }), { type: 'finish', reason: 'stop' }]), { tools: PTC, allowed })
  const { code } = transformedArgs(out)
  assert.ok(code.includes('tools.write('))
  console.log('8. tools.-prefixed name resolves: OK')
}

// 9. Unknown tool name passes through
{
  const raw = JSON.stringify({ file_path: '/tmp/x' })
  const input = [...writeCallChunks(raw, { name: 'frobnicate', id: 'call_9' }), { type: 'finish', reason: 'stop' }]
  const out = await collect(of(input), { tools: PTC, allowed })
  assert.deepEqual(out, input)
  console.log('9. unknown name passes through: OK')
}

// 10. Delta-only stream ending at finish (no block-end) still transforms
{
  const raw = JSON.stringify({ file_path: '/tmp/delta' })
  const input = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call_10', name: 'write', argumentsDelta: raw },
    { type: 'finish', reason: 'stop' },
  ]
  const out = await collect(of(input), { tools: PTC, allowed })
  const deltas = out.filter(c => c.type === 'tool-call-delta')
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0].name, 'run_code')
  const { code } = JSON.parse(deltas[0].argumentsDelta)
  await runGenerated(code, JSON.parse(raw))
  console.log('10. delta-only finish transforms: OK')
}

// 11. Empty allowlist is a no-op
{
  const raw = JSON.stringify({ file_path: '/tmp/x' })
  const input = [...writeCallChunks(raw, { id: 'call_11' }), { type: 'finish', reason: 'stop' }]
  const out = await collect(of(input), { tools: PTC, allowed: [] })
  assert.deepEqual(out, input)
  console.log('11. empty allowlist no-op: OK')
}

// 12. Non-TypeScript runtime (experimental Python backend) passes through
{
  const raw = JSON.stringify({ file_path: '/tmp/x' })
  const input = [...writeCallChunks(raw, { id: 'call_12' }), { type: 'finish', reason: 'stop' }]
  const out = await collect(of(input), { tools: PTC, allowed, language: 'python', programFormat: 'function-body' })
  assert.deepEqual(out, input)
  console.log('12. python runtime passes through: OK')
}

// 13. TypeScript REPL/script program format passes through (no function body)
{
  const raw = JSON.stringify({ file_path: '/tmp/x' })
  const input = [...writeCallChunks(raw, { id: 'call_13' }), { type: 'finish', reason: 'stop' }]
  const out = await collect(of(input), { tools: PTC, allowed, language: 'typescript', programFormat: 'repl' })
  assert.deepEqual(out, input)
  console.log('13. repl program format passes through: OK')
}

// 14. Explicit TypeScript function body still transforms
{
  const args = { file_path: '/tmp/explicit', content: 'x' }
  const raw = JSON.stringify(args)
  const out = await collect(of([...writeCallChunks(raw, { id: 'call_14' }), { type: 'finish', reason: 'stop' }]), {
    tools: PTC, allowed, language: 'typescript', programFormat: 'function-body',
  })
  const { code } = transformedArgs(out)
  await runGenerated(code, args)
  console.log('14. explicit typescript function body transforms: OK')
}

// 15. apply() forwards the live runtime target to the stream listener
{
  const makeCtx = (runtime) => {
    const handlers = []
    return {
      on: (event, handler, opts) => { handlers.push({ event, handler, opts }); return () => {} },
      get: (name) => name === 'ptcRuntime' ? runtime : undefined,
      __stream: () => handlers.find(h => h.event === 'llm/stream').handler,
    }
  }
  const args = { file_path: '/tmp/applied', content: 'x' }
  const raw = JSON.stringify(args)
  const input = () => [...writeCallChunks(raw, { id: 'call_15' }), { type: 'finish', reason: 'stop' }]

  const pythonCtx = makeCtx({ language: 'python', programFormat: 'function-body' })
  apply(pythonCtx, { tools: ['write'] })
  const untouched = await collect(pythonCtx.__stream()({ tools: PTC }, () => of(input())), {})
  assert.deepEqual(untouched, input(), 'python runtime keeps the native call')

  const unknownCtx = makeCtx(undefined)
  apply(unknownCtx, { tools: ['write'] })
  const transformed = await collect(unknownCtx.__stream()({ tools: PTC }, () => of(input())), {})
  const { code } = transformedArgs(transformed)
  await runGenerated(code, args)
  console.log('15. apply() forwards the runtime target: OK')
}

// 16. Ambiguous tools.-qualified name never resolves; a lone member still does
{
  const raw = JSON.stringify({ command: 'npm test' })
  const input = [...writeCallChunks(raw, { name: 'tools.pwsh', id: 'call_16' }), { type: 'finish', reason: 'stop' }]
  const out = await collect(of(input), { tools: PTC, allowed: ['pwsh', 'tools.pwsh'] })
  assert.deepEqual(out, input, 'a name matching two allowlisted tools stays native')
  const member = [...writeCallChunks(raw, { name: 'tools.pwsh', id: 'call_16b' }), { type: 'finish', reason: 'stop' }]
  const { code } = transformedArgs(await collect(of(member), { tools: PTC, allowed: ['pwsh'] }))
  assert.ok(code.includes('tools.pwsh('), 'single member match resolves')
  console.log('16. ambiguous tools.-qualified name passes through: OK')
}

// 17. Non-identifier tool names use bracket access
{
  const raw = JSON.stringify({ value: true })
  const out = await collect(of([...writeCallChunks(raw, { name: 'tool-name', id: 'call_17' }), { type: 'finish', reason: 'stop' }]), {
    tools: PTC, allowed: ['tool-name'],
  })
  const { code } = transformedArgs(out)
  assert.ok(code.includes('tools["tool-name"]('), code)
  const unicode = await collect(of([...writeCallChunks(raw, { name: '工具', id: 'call_17b' }), { type: 'finish', reason: 'stop' }]), {
    tools: PTC, allowed: ['工具'],
  })
  assert.ok(transformedArgs(unicode).code.includes('tools.工具('))
  console.log('17. identifier vs bracket access: OK')
}

// 18. Untouched provider replay metadata stays authoritative
{
  const raw = JSON.stringify({ command: 'ls' })
  const input = [
    ...writeCallChunks(raw, { name: 'bash', id: 'call_18' }),
    { type: 'finish', reason: 'stop', replayState: { response: { provider: 'opaque' }, blocks: [] } },
  ]
  assert.deepEqual(await collect(of(input), { tools: PTC, allowed }), input)
  console.log('18. untouched replayState preserved: OK')
}

// 19. An incomplete candidate is flushed unchanged before a stream failure
{
  const failure = new Error('provider failed')
  const source = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: 'partial', name: 'write', argumentsDelta: '{"file_path":"partial' }
    throw failure
  }
  const observed = []
  await assert.rejects(async () => {
    for await (const chunk of canonicalizeToolCallStream(source(), { tools: PTC, allowed })) observed.push(chunk)
  }, error => error === failure)
  assert.deepEqual(observed.map(chunk => chunk.type), ['block-start', 'tool-call-delta'])
  assert.equal(observed[1].name, 'write', 'the partial native call is not rewritten')
  console.log('19. partial candidate flushed before a stream failure: OK')
}

// 20. A later unfinished call cannot restore replay state after an earlier rewrite
{
  const first = writeCallChunks(JSON.stringify({ file_path: 'one' }), { id: 'call_20a' })
  const trailing = [
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call_20b', name: 'write', argumentsDelta: '{' },
    { type: 'finish', reason: 'stop', replayState: { opaque: 'old-provider-state' } },
  ]
  const out = await collect(of([...first, ...trailing]), { tools: PTC, allowed })
  assert.equal(out.find(chunk => chunk.type === 'block-end').block.name, 'run_code')
  assert.equal(out.find(chunk => chunk.type === 'tool-call-delta' && chunk.index === 1).argumentsDelta, '{')
  assert.ok(!('replayState' in out.at(-1)), 'stale replay state is dropped')
  console.log('20. unfinished trailing call cannot restore replayState: OK')
}

// 21. A second allowlisted direct tool keeps salvage alive
{
  const args = { file_path: '/tmp/second', content: 'x' }
  const raw = JSON.stringify(args)
  const out = await collect(of([...writeCallChunks(raw, { id: 'call_21' }), { type: 'finish', reason: 'stop' }]), {
    tools: [{ name: 'run_code' }, { name: 'apply_patch' }],
    allowed: ['write', 'apply_patch'],
  })
  const { code } = transformedArgs(out)
  await runGenerated(code, args)
  console.log('21. second allowlisted direct tool keeps salvage: OK')
}

// 22. An extra declaration outside the allowlist still disables salvage
{
  const raw = JSON.stringify({ file_path: '/tmp/x' })
  const input = [...writeCallChunks(raw, { id: 'call_22' }), { type: 'finish', reason: 'stop' }]
  const out = await collect(of(input), { tools: [{ name: 'run_code' }, { name: 'apply_patch' }], allowed })
  assert.deepEqual(out, input)
  const duplicated = [...writeCallChunks(raw, { id: 'call_22b' }), { type: 'finish', reason: 'stop' }]
  assert.deepEqual(
    await collect(of(duplicated), { tools: [{ name: 'run_code' }, { name: 'run_code' }], allowed }),
    duplicated,
    'a duplicated declaration is not a PTC view',
  )
  console.log('22. unvetted extra declaration disables salvage: OK')
}

// 23. A mixed surface with an unvetted extra stays untouched
{
  const raw = JSON.stringify({ file_path: '/tmp/x' })
  const input = [...writeCallChunks(raw, { id: 'call_23' }), { type: 'finish', reason: 'stop' }]
  assert.deepEqual(await collect(of(input), { tools: [{ name: 'run_code' }, { name: 'bash' }], allowed }), input)
  console.log('23. mixed surface stays untouched: OK')
}

// 24. A declared allowlisted tool is still canonicalized, like any other extra
{
  const raw = JSON.stringify({ file_path: '/tmp/declared' })
  const out = await collect(of([...writeCallChunks(raw, { id: 'call_24' }), { type: 'finish', reason: 'stop' }]), {
    tools: [{ name: 'run_code' }, { name: 'write' }],
    allowed,
  })
  const { code } = transformedArgs(out)
  assert.ok(code.includes('tools.write('), code)
  console.log('24. declared allowlisted tool canonicalized: OK')
}

// 25. Unrestricted allowlist canonicalizes any tool, in any well-formed view
{
  const raw = JSON.stringify({ command: 'ls' })
  const direct = [...writeCallChunks(raw, { name: 'bash', id: 'call_25' }), { type: 'finish', reason: 'stop' }]
  const out = await collect(of(direct), { tools: PTC })
  assert.ok(transformedArgs(out).code.includes('tools.bash('))
  const mixed = [...writeCallChunks(raw, { name: 'bash', id: 'call_25b' }), { type: 'finish', reason: 'stop' }]
  const mixedOut = await collect(of(mixed), { tools: [{ name: 'run_code' }, { name: 'read' }] })
  assert.ok(transformedArgs(mixedOut).code.includes('tools.bash('), 'a second declared tool no longer disables salvage')
  const qualified = [...writeCallChunks(raw, { name: 'tools.bash', id: 'call_25c' }), { type: 'finish', reason: 'stop' }]
  assert.ok(transformedArgs(await collect(of(qualified), { tools: PTC })).code.includes('tools.bash('))
  console.log('25. unrestricted allowlist canonicalizes any tool: OK')
}

// 26. The transport itself is never nested back into a program
{
  const raw = JSON.stringify({ code: 'return 1', description: 'one' })
  for (const name of ['run_code', 'tools.run_code']) {
    const input = [...writeCallChunks(raw, { name, id: 'call_26' }), { type: 'finish', reason: 'stop' }]
    assert.deepEqual(await collect(of(input), { tools: PTC }), input, `${name} must not be rewritten`)
  }
  console.log('26. run_code is never rewritten: OK')
}

// 27. apply() defaults to every tool, by omission or by the '*' entry
{
  for (const config of [{}, { tools: ['*'] }]) {
    const handlers = []
    const ctx = {
      on: (event, handler) => { handlers.push({ event, handler }); return () => {} },
      get: () => undefined,
    }
    apply(ctx, config)
    const stream = handlers.find(h => h.event === 'llm/stream').handler
    const raw = JSON.stringify({ command: 'ls' })
    const source = [...writeCallChunks(raw, { name: 'bash', id: 'call_27' }), { type: 'finish', reason: 'stop' }]
    const out = await collect(stream({ tools: PTC }, () => of(source)), {})
    assert.ok(transformedArgs(out).code.includes('tools.bash('), JSON.stringify(config))
  }
  console.log('27. apply() defaults to every tool: OK')
}

console.log('\nAll 27 tests passed.')
