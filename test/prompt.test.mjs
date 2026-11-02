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

// 1. PTC marker present: instruction amended and the advertising inserted after it
{
  const ctx = makeCtx(undefined)
  apply(ctx, { tools: ['write'] })
  const assemble = assembleOf(ctx)
  const out = await assemble.handler(null, { scope: 'agent1' }, async () => PTC_ASSEMBLY())
  const ptcOnly = section(out, 'tools:ptc-only')
  assert.ok(ptcOnly.text.includes('except `write`'), 'ptc-only instruction amended')
  assert.ok(ptcOnly.text.includes('a tool call naming any other tool fails.'), 'upstream wording retained')
  assert.ok(ptcOnly.text.includes('Reach every tool the SDK declares below'), 'SDK pointer retained')
  const direct = section(out, 'tools:direct-write')
  assert.ok(direct, 'advertising section inserted')
  assert.equal(direct.interpolate, false)
  assert.equal(out.sections[1].name, 'tools:direct-write', 'inserted right after the amendment')
  assert.ok(direct.text.includes('Direct file writes'), 'advertises the direct call')
  assert.ok(direct.text.includes('file_path (string, required)'), 'advertises file_path')
  assert.ok(direct.text.includes('content (string, required)'), 'advertises content')
  assert.ok(direct.text.includes('sandbox_permissions'), 'advertises sandbox_permissions')
  assert.ok(direct.text.includes('justification'), 'advertises justification')
  assert.ok(direct.text.includes('Every other tool is reachable only from inside a run_code program'))
  assert.equal(section(out, 'tools:sdk').text, 'sdk...', 'other sections untouched')
  console.log('1. PTC assembly amended + advertising inserted: OK')
}

// 2. Native assembly (executor-owned marker renders empty): identity passthrough
{
  const ctx = makeCtx(undefined)
  apply(ctx, { tools: ['write'] })
  const assemble = assembleOf(ctx)
  const native = NATIVE_ASSEMBLY()
  const out = await assemble.handler(null, { scope: 'agent2' }, async () => native)
  assert.equal(out, native, 'non-PTC assembly passed through by identity')
  assert.equal(section(out, 'tools:direct-write'), undefined, 'no advertising in native mode')
  console.log('2. native assembly untouched: OK')
}

// 3. write not in the allowlist: no amendment, no advertising
{
  const ctx = makeCtx(undefined)
  apply(ctx, { tools: ['edit'] })
  const assemble = assembleOf(ctx)
  const out = await assemble.handler(null, { scope: 'agent3' }, async () => PTC_ASSEMBLY())
  assert.equal(section(out, 'tools:ptc-only').text, PTC_ONLY_TEXT, 'shipped instruction kept')
  assert.equal(section(out, 'tools:direct-write'), undefined, 'no advertising')
  console.log('3. write not allowlisted: advertising off: OK')
}

// 4. No ptc-only section at all: untouched
{
  const ctx = makeCtx(undefined)
  apply(ctx, { tools: ['write'] })
  const assemble = assembleOf(ctx)
  const custom = { sections: [{ name: 'deployment:persona-prefix', text: 'hi' }], contexts: [], variables: {} }
  const out = await assemble.handler(null, { scope: 'agent4' }, async () => custom)
  assert.equal(out, custom, 'assembly without the PTC marker passed through by identity')
  console.log('4. assembly without PTC marker untouched: OK')
}

// 5. Another listener already inserted the advertising: amended, not duplicated
{
  const ctx = makeCtx(undefined)
  apply(ctx, { tools: ['write'] })
  const assemble = assembleOf(ctx)
  const withDirect = {
    sections: [
      { name: 'tools:ptc-only', text: PTC_ONLY_TEXT },
      { name: 'tools:direct-write', text: 'someone else' },
    ],
    contexts: [],
    variables: {},
  }
  const out = await assemble.handler(null, { scope: 'agent5' }, async () => withDirect)
  assert.equal(out.sections.filter(s => s.name === 'tools:direct-write').length, 1, 'no duplicate section')
  assert.equal(section(out, 'tools:direct-write').text, 'someone else', 'existing section left alone')
  assert.ok(section(out, 'tools:ptc-only').text.includes('except `write`'))
  console.log('5. existing advertising section not duplicated: OK')
}

// 6. Upstream wording without the marker: pinned fallback amendment
{
  const ctx = makeCtx(undefined)
  apply(ctx, { tools: ['write'] })
  const assemble = assembleOf(ctx)
  const reworded = {
    sections: [{ name: 'tools:ptc-only', text: '`run_code` is the only directly callable tool.' }],
    contexts: [],
    variables: {},
  }
  const out = await assemble.handler(null, { scope: 'agent6' }, async () => reworded)
  const text = section(out, 'tools:ptc-only').text
  assert.ok(text.includes('except `write`'), 'fallback amendment applied')
  assert.ok(text.includes('Reach every tool the SDK declares below'), 'fallback keeps the SDK pointer')
  console.log('6. reworded upstream instruction falls back: OK')
}

// 7. Both listeners are registered, the stream one globally
{
  const ctx = makeCtx(undefined)
  apply(ctx, { tools: ['write'] })
  const stream = ctx.__handlers.find(h => h.event === 'llm/stream')
  assert.ok(stream, 'llm/stream listener registered')
  assert.equal(stream.opts?.global, true, 'llm/stream listener is global')
  assert.equal(ctx.__handlers.length, 2, 'no section registration')
  console.log('7. listeners registered at the right scope: OK')
}

console.log('\nAll 7 prompt tests passed.')
