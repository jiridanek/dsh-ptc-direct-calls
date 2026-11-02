import assert from 'node:assert/strict'
import { apply } from '../index.js'

const VISIBLE = ['write', 'edit', 'bash', 'read']
const PTC_EXECUTOR = { describe: () => ({ schemas: [{ name: 'run_code' }] }) }
const NATIVE_EXECUTOR = { describe: () => ({ schemas: [{ name: 'write' }, { name: 'bash' }] }) }

function makeCtx({ executor, selectExecutor } = {}) {
  let provider
  const definitions = VISIBLE.map(name => ({ name }))
  const schemas = VISIBLE.map(name => ({
    name,
    description: name,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  }))
  const ctx = {
    on: () => () => {},
    get: () => undefined,
    systemPrompt: { tools: (value) => { provider = value; return () => {} } },
    tools: {
      ...selectExecutor === undefined
        ? { selectExecutor: () => executor }
        : { selectExecutor },
      definitions: () => definitions,
      schemas: () => schemas,
    },
  }
  return { ctx, provider: () => provider }
}

function declaredNames(provider, context = { scope: 'agent' }) {
  return provider(context).schemas.map(schema => schema.name)
}

// 1. PTC executor: the escaping-prone default is declared, nothing else
{
  const { ctx, provider } = makeCtx({ executor: PTC_EXECUTOR })
  apply(ctx, {})
  assert.deepEqual(declaredNames(provider()), ['write', 'edit', 'bash'])
  console.log('1. PTC default declares write, edit, bash: OK')
}

// 2. A one-tool declaration
{
  const { ctx, provider } = makeCtx({ executor: PTC_EXECUTOR })
  apply(ctx, { declare: ['write'] })
  assert.deepEqual(declaredNames(provider()), ['write'])
  console.log('2. one-tool declaration: OK')
}

// 3. declare ['*'] puts every visible allowlisted tool on the wire
{
  const { ctx, provider } = makeCtx({ executor: PTC_EXECUTOR })
  apply(ctx, { declare: ['*'] })
  assert.deepEqual(declaredNames(provider()), VISIBLE)
  console.log('3. wildcard declaration: OK')
}

// 4. An empty declaration leaves the plugin as a safety net
{
  const { ctx, provider } = makeCtx({ executor: PTC_EXECUTOR })
  apply(ctx, { declare: [] })
  assert.deepEqual(declaredNames(provider()), [])
  console.log('4. empty declaration declares nothing: OK')
}

// 5. A native executor already declares its tools; adding duplicates would corrupt the request
{
  const { ctx, provider } = makeCtx({ executor: NATIVE_EXECUTOR })
  apply(ctx, {})
  assert.deepEqual(declaredNames(provider()), [])
  console.log('5. native executor gets no additions: OK')
}

// 6. A harness without the private selector degrades to no declaration
{
  const { ctx, provider } = makeCtx({ selectExecutor: undefined })
  apply(ctx, {})
  assert.deepEqual(declaredNames(provider()), [])
  console.log('6. missing selector degrades safely: OK')
}

// 7. A selector that throws degrades safely
{
  const { ctx, provider } = makeCtx({
    selectExecutor: () => { throw new Error('unavailable') },
  })
  apply(ctx, {})
  assert.deepEqual(declaredNames(provider()), [])
  console.log('7. throwing selector degrades safely: OK')
}

// 8. The allowlist bounds the declaration
{
  const { ctx, provider } = makeCtx({ executor: PTC_EXECUTOR })
  apply(ctx, { tools: ['write'] })
  assert.deepEqual(declaredNames(provider()), ['write'])
  console.log('8. allowlist bounds the declaration: OK')
}

console.log('\nAll 8 declaration tests passed.')
