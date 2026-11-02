import assert from 'node:assert/strict'
import { apply } from '../index.js'

const PTC_ONLY_TEXT = '`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.'

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
  const ctx = {
    on: (event, handler, opts) => { handlers.push({ event, handler, opts }); return () => {} },
    get: (name) => name === 'ptcRuntime' ? runtime : undefined,
    __handlers: handlers,
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

// 1. Unrestricted (no tools config): any tool is advertised, write/edit named
{
  const ctx = makeCtx(undefined)
  apply(ctx, {})
  const assemble = assembleOf(ctx)
  const out = await assemble.handler(null, { scope: 'agent1' }, async () => PTC_ASSEMBLY())
  const ptcOnly = section(out, 'tools:ptc-only')
  assert.ok(ptcOnly.text.includes('Any tool may also be called directly'), ptcOnly.text)
  assert.ok(!ptcOnly.text.includes('a tool call naming any other tool fails'), 'false claim removed')
  assert.ok(ptcOnly.text.includes('Reach every tool the SDK declares below'), 'SDK pointer retained')
  const direct = section(out, 'tools:direct-calls')
  assert.ok(direct, 'advertising section inserted')
  assert.equal(direct.interpolate, false)
  assert.equal(out.sections[1].name, 'tools:direct-calls', 'inserted right after the amendment')
  assert.ok(direct.text.includes('Direct tool calls'), 'advertises direct calls')
  assert.ok(direct.text.includes('any tool directly'), 'unrestricted subject')
  assert.ok(direct.text.includes('backticks'), 'names escaping-sensitive text')
  assert.ok(direct.text.includes('${...}'), 'names template interpolation')
  assert.ok(direct.text.includes('call `write` directly'), 'names write')
  assert.ok(direct.text.includes('`edit` directly'), 'names edit')
  assert.ok(direct.text.includes('`bash` directly'), 'names bash')
  assert.ok(direct.text.includes('argument validation, sandbox, and approvals still apply'))
  assert.equal(section(out, 'tools:sdk').text, 'sdk...', 'other sections untouched')
  console.log('1. unrestricted advertising: OK')
}

// 2. Restricted allowlist: text names exactly the permitted tools
{
  const ctx = makeCtx(undefined)
  apply(ctx, { tools: ['edit'] })
  const direct = section(await assembleOf(ctx).handler(null, { scope: 'agent2' }, async () => PTC_ASSEMBLY()), 'tools:direct-calls')
  assert.ok(direct.text.includes('call `edit` directly'), direct.text)
  assert.ok(!direct.text.includes('`write`'), 'write not advertised')
  assert.ok(!direct.text.includes('`bash`'), 'bash not advertised')
  assert.ok(!direct.text.includes('any tool'), 'no unrestricted claim')
  console.log('2. restricted allowlist advertising: OK')
}

// 3. Several allowlisted tools are listed readably
{
  const ctx = makeCtx(undefined)
  apply(ctx, { tools: ['write', 'edit', 'bash'] })
  const out = await assembleOf(ctx).handler(null, { scope: 'agent3' }, async () => PTC_ASSEMBLY())
  assert.ok(section(out, 'tools:ptc-only').text.includes('`write`, `edit`, and `bash` may also be called directly'))
  const direct = section(out, 'tools:direct-calls').text
  for (const name of ['write', 'edit', 'bash']) assert.ok(direct.includes(`\`${name}\``), name)
  console.log('3. multiple allowlisted tools listed: OK')
}

// 4. Empty allowlist: nothing is advertised and the shipped instruction stands
{
  const ctx = makeCtx(undefined)
  apply(ctx, { tools: [] })
  const assemble = assembleOf(ctx)
  const assembly = PTC_ASSEMBLY()
  const out = await assemble.handler(null, { scope: 'agent4' }, async () => assembly)
  assert.equal(out, assembly, 'assembly passed through by identity')
  console.log('4. empty allowlist advertises nothing: OK')
}

// 5. Native assembly (executor-owned marker renders empty): identity passthrough
{
  const ctx = makeCtx(undefined)
  apply(ctx, {})
  const native = NATIVE_ASSEMBLY()
  const out = await assembleOf(ctx).handler(null, { scope: 'agent5' }, async () => native)
  assert.equal(out, native, 'non-PTC assembly passed through by identity')
  assert.equal(section(out, 'tools:direct-calls'), undefined, 'no advertising in native mode')
  console.log('5. native assembly untouched: OK')
}

// 6. No ptc-only section at all: untouched
{
  const ctx = makeCtx(undefined)
  apply(ctx, {})
  const custom = { sections: [{ name: 'deployment:persona-prefix', text: 'hi' }], contexts: [], variables: {} }
  const out = await assembleOf(ctx).handler(null, { scope: 'agent6' }, async () => custom)
  assert.equal(out, custom, 'assembly without the PTC marker passed through by identity')
  console.log('6. assembly without PTC marker untouched: OK')
}

// 7. Another listener already inserted the advertising: restated, not duplicated
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
  const out = await assembleOf(ctx).handler(null, { scope: 'agent7' }, async () => withDirect)
  assert.equal(out.sections.filter(s => s.name === 'tools:direct-calls').length, 1, 'no duplicate section')
  assert.equal(section(out, 'tools:direct-calls').text, 'someone else', 'existing section left alone')
  assert.ok(section(out, 'tools:ptc-only').text.includes('Any tool'))
  console.log('7. existing advertising section not duplicated: OK')
}

// 8. Both listeners are registered, the stream one globally
{
  const ctx = makeCtx(undefined)
  apply(ctx, {})
  const stream = ctx.__handlers.find(h => h.event === 'llm/stream')
  assert.ok(stream, 'llm/stream listener registered')
  assert.equal(stream.opts?.global, true, 'llm/stream listener is global')
  assert.equal(ctx.__handlers.length, 2, 'no section registration')
  console.log('8. listeners registered at the right scope: OK')
}

console.log('\nAll 8 prompt tests passed.')
