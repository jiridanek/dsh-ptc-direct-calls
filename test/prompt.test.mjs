import assert from 'node:assert/strict'
import { apply } from '../index.js'

const PTC_ONLY_TEXT = '`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.'
const VISIBLE = [{ name: 'write' }, { name: 'edit' }, { name: 'bash' }, { name: 'read' }]

// Current dsh 0.2.x PromptPresentation: sections/contexts/variables only — tool
// declarations are provider-owned and no longer reach the waterfall.
const PTC_ASSEMBLY = () => ({
  sections: [
    { name: 'tools:ptc-only', text: PTC_ONLY_TEXT },
    { name: 'tools:sdk', text: 'sdk...' },
  ],
  contexts: [],
  variables: {},
})

const NATIVE_ASSEMBLY = () => ({
  sections: [
    { name: 'tools:ptc-only', text: '' },
    { name: 'tool:write', text: 'Read an existing file before overwriting it with write.' },
  ],
  contexts: [],
  variables: {},
})

function makeCtx(runtime) {
  const handlers = []
  let toolsProvider
  const ctx = {
    on: (event, handler, opts) => { handlers.push({ event, handler, opts }); return () => {} },
    get: (name) => name === 'ptcRuntime' ? runtime : undefined,
    systemPrompt: {
      tools: (provider) => { toolsProvider = provider; return () => {} },
    },
    tools: { definitions: () => VISIBLE },
    __handlers: handlers,
    __toolsProvider: () => toolsProvider,
  }
  return ctx
}

function assembleOf(ctx) {
  const assemble = ctx.__handlers.find(h => h.event === 'system-prompt/assemble')
  assert.ok(assemble, 'assemble listener registered')
  return assemble
}

function section(out, name) {
  return out.sections.find(s => s.name === name)
}

// 1. Default declaration: write, edit, and bash are the advertised affordance
{
  const ctx = makeCtx(undefined)
  apply(ctx, {})
  const out = await assembleOf(ctx).handler(null, { scope: 'agent1' }, async () => PTC_ASSEMBLY())
  const ptcOnly = section(out, 'tools:ptc-only')
  assert.ok(ptcOnly.text.includes('`write`, `edit`, and `bash` may also be called directly'), ptcOnly.text)
  assert.ok(!ptcOnly.text.includes('Any tool'), 'no claim beyond the declared set')
  assert.ok(ptcOnly.text.includes('Reach every tool the SDK declares below'), 'SDK pointer retained')
  const direct = section(out, 'tools:direct-calls')
  assert.ok(direct, 'advertising section inserted')
  assert.equal(direct.interpolate, false)
  assert.equal(out.sections[1].name, 'tools:direct-calls', 'inserted right after the amendment')
  assert.ok(direct.text.includes('call `write` directly'), 'names write')
  assert.ok(direct.text.includes('`edit` directly'), 'names edit')
  assert.ok(direct.text.includes('`bash` directly'), 'names bash')
  assert.ok(direct.text.includes('backticks'), 'names escaping-sensitive text')
  assert.ok(direct.text.includes('${...}'), 'names template interpolation')
  assert.equal(section(out, 'tools:sdk').text, 'sdk...', 'other sections untouched')
  assert.equal(typeof ctx.__toolsProvider(), 'function', 'declaration provider registered')
  console.log('1. default declaration advertised: OK')
}

// 2. A one-tool declaration names only that tool
{
  const ctx = makeCtx(undefined)
  apply(ctx, { declare: ['edit'] })
  const out = await assembleOf(ctx).handler(null, { scope: 'agent2' }, async () => PTC_ASSEMBLY())
  const text = section(out, 'tools:direct-calls').text
  assert.ok(text.includes('call `edit` directly'), text)
  assert.ok(!text.includes('`write`'), 'write not advertised')
  assert.ok(!text.includes('`bash`'), 'bash not advertised')
  console.log('2. one-tool declaration: OK')
}

// 3. declare ['*'] advertises every tool
{
  const ctx = makeCtx(undefined)
  apply(ctx, { declare: ['*'] })
  const out = await assembleOf(ctx).handler(null, { scope: 'agent3' }, async () => PTC_ASSEMBLY())
  assert.ok(section(out, 'tools:ptc-only').text.includes('Any tool may also be called directly'))
  assert.ok(section(out, 'tools:direct-calls').text.includes('any tool directly'))
  console.log('3. wildcard declaration: OK')
}

// 4. An empty declaration disables advertising (safety-net mode)
{
  const ctx = makeCtx(undefined)
  apply(ctx, { declare: [] })
  const assembly = PTC_ASSEMBLY()
  const out = await assembleOf(ctx).handler(null, { scope: 'agent4' }, async () => assembly)
  assert.equal(out, assembly, 'assembly passed through by identity')
  assert.deepEqual(ctx.__toolsProvider()({ scope: 'agent4' }), { schemas: [] }, 'provider declares nothing')
  console.log('4. empty declaration disables advertising: OK')
}

// 5. The allowlist bounds the declaration
{
  const ctx = makeCtx(undefined)
  apply(ctx, { tools: ['write'] })
  const out = await assembleOf(ctx).handler(null, { scope: 'agent5' }, async () => PTC_ASSEMBLY())
  const text = section(out, 'tools:direct-calls').text
  assert.ok(text.includes('call `write` directly'), text)
  assert.ok(!text.includes('`bash`') && !text.includes('`edit`'), 'only the allowlisted tool is named')
  console.log('5. allowlist bounds the declaration: OK')
}

// 6. Empty allowlist: nothing is advertised and the shipped instruction stands
{
  const ctx = makeCtx(undefined)
  apply(ctx, { tools: [] })
  const assembly = PTC_ASSEMBLY()
  const out = await assembleOf(ctx).handler(null, { scope: 'agent6' }, async () => assembly)
  assert.equal(out, assembly, 'assembly passed through by identity')
  console.log('6. empty allowlist advertises nothing: OK')
}

// 7. Native assembly (executor-owned marker renders empty): identity passthrough
{
  const ctx = makeCtx(undefined)
  apply(ctx, {})
  const native = NATIVE_ASSEMBLY()
  const out = await assembleOf(ctx).handler(null, { scope: 'agent7' }, async () => native)
  assert.equal(out, native, 'non-PTC assembly passed through by identity')
  assert.equal(section(out, 'tools:direct-calls'), undefined, 'no advertising in native mode')
  console.log('7. native assembly untouched: OK')
}

// 8. No ptc-only section at all: untouched
{
  const ctx = makeCtx(undefined)
  apply(ctx, {})
  const custom = { sections: [{ name: 'deployment:persona-prefix', text: 'hi' }], contexts: [], variables: {} }
  const out = await assembleOf(ctx).handler(null, { scope: 'agent8' }, async () => custom)
  assert.equal(out, custom, 'assembly without the PTC marker passed through by identity')
  console.log('8. assembly without PTC marker untouched: OK')
}

// 9. Another listener already inserted the advertising: restated, not duplicated
{
  const ctx = makeCtx(undefined)
  apply(ctx, {})
  const withDirect = {
    sections: [
      { name: 'tools:ptc-only', text: PTC_ONLY_TEXT },
      { name: 'tools:direct-calls', text: 'someone else' },
    ],
    contexts: [],
    variables: {},
  }
  const out = await assembleOf(ctx).handler(null, { scope: 'agent9' }, async () => withDirect)
  assert.equal(out.sections.filter(s => s.name === 'tools:direct-calls').length, 1, 'no duplicate section')
  assert.equal(section(out, 'tools:direct-calls').text, 'someone else', 'existing section left alone')
  assert.ok(section(out, 'tools:ptc-only').text.includes('`write`, `edit`, and `bash`'))
  console.log('9. existing advertising section not duplicated: OK')
}

// 10. Event listeners are scope-wide, the stream one global
{
  const ctx = makeCtx(undefined)
  apply(ctx, {})
  const stream = ctx.__handlers.find(h => h.event === 'llm/stream')
  assert.ok(stream, 'llm/stream listener registered')
  assert.equal(stream.opts?.global, true, 'llm/stream listener is global')
  assert.equal(ctx.__handlers.length, 2, 'no section registration')
  console.log('10. listeners registered at the right scope: OK')
}

console.log('\nAll 10 prompt tests passed.')
