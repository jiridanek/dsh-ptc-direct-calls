import assert from 'node:assert/strict'
import { apply } from '../index.js'

const PTC_ONLY_TEXT = '`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.'
const PTC_ASSEMBLY = () => ({
  tools: [{ name: 'run_code' }],
  sections: [
    { name: 'tools:ptc-only', order: 800, text: PTC_ONLY_TEXT },
    { name: 'tools:sdk', order: 900, text: 'sdk...' },
  ],
  contexts: [],
  variables: {},
})

function makeCtx(schemas) {
  const handlers = []
  let registeredSection
  const ctx = {
    on: (event, handler, opts) => { handlers.push({ event, handler, opts }); return () => {} },
    systemPrompt: {
      section: (reg) => { registeredSection = reg; return () => {} },
      getSectionOrder: () => 1200,
    },
    tools: { schemas: () => schemas },
    __handlers: handlers,
    __section: () => registeredSection,
  }
  return ctx
}


// 1. write allowlisted: section registered, renders for a PTC scope, amendment applied
{
  const ctx = makeCtx([{ name: 'run_code' }])
  apply(ctx, { tools: ['write'] })
  const section = ctx.__section()
  assert.ok(section, 'section registered')
  assert.equal(section.name, 'tools:direct-write')
  assert.equal(section.order, 1200)
  const text = section.text({ scope: 'agent1' })
  assert.ok(text.includes('Direct file writes'), 'section renders in PTC view')
  assert.ok(text.includes('file_path (string, required)'), 'advertises file_path')
  assert.ok(text.includes('content (string, required)'), 'advertises content')
  assert.ok(text.includes('sandbox_permissions'), 'advertises sandbox_permissions')
  assert.ok(text.includes('justification'), 'advertises justification')
  assert.ok(text.includes('Every other tool is reachable only from inside a run_code program'))
  const assemble = ctx.__handlers.find(h => h.event === 'system-prompt/assemble')
  assert.ok(assemble, 'assemble listener registered')
  const out = await assemble.handler(null, { scope: 'agent1' }, async () => PTC_ASSEMBLY())
  const ptcOnly = out.sections.find(s => s.name === 'tools:ptc-only')
  assert.ok(ptcOnly.text.includes('except `write`'), 'ptc-only instruction amended')
  assert.ok(!ptcOnly.text.includes('a tool call naming any other tool fails.'), 'old absolute wording replaced')
  assert.equal(out.sections.find(s => s.name === 'tools:sdk').text, 'sdk...', 'other sections untouched')
  const global = await assemble.handler(null, {}, async () => PTC_ASSEMBLY())
  assert.ok(!global.sections.find(s => s.name === 'tools:ptc-only').text.includes('except `write`'), 'no-scope assembly untouched')
  console.log('1. PTC assembly amended + section rendered: OK')
}

// 2. non-PTC view (both): no amendment, section silent
{
  const ctx = makeCtx([{ name: 'write' }, { name: 'run_code' }])
  apply(ctx, { tools: ['write'] })
  const assemble = ctx.__handlers.find(h => h.event === 'system-prompt/assemble')
  const bothAssembly = {
    tools: [{ name: 'write' }, { name: 'run_code' }],
    sections: [{ name: 'tools:ptc-only', order: 800, text: '' }],
    contexts: [],
    variables: {},
  }
  const out = await assemble.handler(null, { scope: 'agent2' }, async () => bothAssembly)
  assert.equal(out, bothAssembly, 'non-PTC assembly passed through by identity')
  assert.equal(ctx.__section().text({ scope: 'agent2' }), '', 'section silent in non-PTC view')
  console.log('2. non-PTC view untouched: OK')
}

// 3. write not in allowlist: no section, no amendment
{
  const ctx = makeCtx([{ name: 'run_code' }])
  apply(ctx, { tools: ['edit'] })
  assert.equal(ctx.__section(), undefined, 'no section registered')
  const assemble = ctx.__handlers.find(h => h.event === 'system-prompt/assemble')
  const out = await assemble.handler(null, { scope: 'agent3' }, async () => PTC_ASSEMBLY())
  assert.equal(out.sections.find(s => s.name === 'tools:ptc-only').text, PTC_ONLY_TEXT, 'shipped instruction kept')
  console.log('3. write not allowlisted: advertising off: OK')
}

console.log('\nAll 3 prompt tests passed.')
