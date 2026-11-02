/**
 * dsh-ptc-direct-calls
 *
 * In a PTC session the model's only directly callable tool is `run_code`; every
 * other tool is reached through the generated SDK from inside a program. Models
 * nonetheless occasionally emit a model-direct call of a native tool (e.g.
 * `write`) — the deployment rejects it before the policy pipeline, and the
 * model then burns turns re-doing the call through a program, re-encoding its
 * content as a JS string literal in the process (the escaping failure mode
 * documented in DSH discussions #3925 / #4699 / #7618).
 *
 * This plugin closes that gap at the one point a plugin can still see the
 * call: the global `llm/stream` waterfall. When the request declares
 * `run_code` and nothing outside the configured allowlist — a second direct
 * tool another plugin presents therefore does not disable salvage, while an
 * unvetted extra keeps the stream untouched — and the model emits a direct
 * call whose name uniquely resolves against that allowlist (default: `write`)
 * with JSON-parseable arguments, the stream chunk is rewritten in place into
 * the equivalent `run_code` program:
 *
 *     { return await tools.write(<arguments>) }
 *
 * The arguments are re-embedded as the model's own raw JSON text (JSON is a
 * valid JS literal), with two guards: container depth beyond a ceiling falls
 * back to `JSON.parse(JSON.stringify(raw))`, and an own `__proto__` key uses a
 * computed-property literal so the object's prototype can never be assigned.
 * The model's content therefore never passes through a model-authored string
 * literal; schema validation and all governance (sandbox, approval, policy
 * waterfalls) still apply to the nested sub-dispatch inside `run_code`.
 *
 * That program is a TypeScript async function body, so canonicalization runs
 * only while the active `ptcRuntime` still accepts that shape. A runtime that
 * reports another language (e.g. the experimental Python backend) or another
 * program format (REPL/script) is left untouched: the host's `run_code`-only
 * denial remains the backstop, exactly as when the plugin is absent. A runtime
 * provided in a narrower scope than this plugin is not visible here; absence
 * therefore keeps the historical TypeScript function-body assumption.
 *
 * Calls that do not meet every condition pass through untouched, and the
 * host's normal `run_code`-only denial remains the backstop. The plugin adds
 * no tools and no permissions; its wire cost is zero.
 *
 * Prompt advertising: in a PTC session the plugin (a) rewrites the shipped
 * `tools:ptc-only` instruction so it carves out the `write` exception instead
 * of contradicting it, and (b) inserts a `tools:direct-write` section right
 * after it, advertising the direct call with its full parameter list — the
 * file content travels as a JSON argument, so there is no escaping. Every
 * other tool stays reachable only from inside a `run_code` program. The
 * advertising is active only while `write` is in the allowlist.
 *
 * Since dsh 0.2.x an assembly waterfall carries `PromptPresentation` (text
 * only): tool declarations are provider-owned and `tools.schemas()` reports
 * registered definitions rather than the executor's model-facing projection.
 * PTC mode is therefore detected the only way that survives both splits — by
 * the resolved text of the executor-owned `tools:ptc-only` section, which is
 * non-empty exactly while the PTC executor is selected for that assembly's
 * scope. Both prompt mutations happen inside one `system-prompt/assemble`
 * listener, so no section registration can disagree with the amendment.
 *
 * The stream-rewriting core is adapted (MIT) from the call canonicalizer of
 * dsh-ptc-plus (https://github.com/muyuanjin/dsh-ptc-plus), Copyright (c) 2026
 * dsh-ptc-plus contributors; see the LICENSE of that project for terms.
 *
 * @module dsh-ptc-direct-calls
 */

import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'ptc-direct-calls'

/**
 * `llm` is injected so activation waits for the core LLM service whose global
 * `llm/stream` waterfall is observed. The prompt half needs no injection: it
 * observes the `system-prompt/assemble` event, and `ptcRuntime` is read
 * optionally at stream time.
 */
export const inject = ['llm']

/** Plugin config. */
export const Config = z.object({
  /**
   * Tool names a model-direct call may be canonicalized into the equivalent
   * `run_code` program. The list is fixed at mount; disable the row to turn
   * the behavior off. Do not add long-running tools such as `workflow`: a
   * converted call executes under `run_code`'s wall-clock ceiling.
   */
  tools: z.array(z.string()).required(),
})

const RUN_CODE_NAME = 'run_code'
const MAX_DIRECT_LITERAL_DEPTH = 128
const PTC_ONLY_SECTION_NAME = 'tools:ptc-only'
const DIRECT_WRITE_SECTION_NAME = 'tools:direct-write'

/** The marker sentence the shipped instruction keeps across dsh minor versions. */
const PTC_ONLY_MARKER = 'is the only tool you can call directly'

/**
 * Fallback amendment used when the shipped wording no longer contains
 * {@link PTC_ONLY_MARKER}. Kept as close to the shipped instruction as possible
 * so the rule's authority and the SDK pointer survive the amendment.
 */
const PTC_ONLY_INSTRUCTION_WITH_DIRECT_WRITE =
  '`run_code` is the only tool you can call directly, except `write`: a direct `write` call is ' +
  'transparently translated into the equivalent `run_code` program (see Direct file writes below). ' +
  'A tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.'

/**
 * Full advertising of the direct `write` call: behavior, why escaping is a
 * non-issue, the complete parameter list (mirroring the current `write`
 * schema, including the sandbox-escalation fields), and the boundaries —
 * every other tool stays inside a `run_code` program.
 */
const DIRECT_WRITE_SECTION_TEXT =
  'Direct file writes: you may also call `write` directly — a direct `write` call is transparently ' +
  'translated into the equivalent run_code program, and the file content is carried as a JSON argument ' +
  'the harness embeds into the program mechanically, so it never has to be escaped into a JavaScript ' +
  'string literal. Prefer a direct `write` call over a program that calls tools.write(...) whenever you ' +
  'create or fully replace a file; it removes every escaping worry.\n' +
  'Parameters of the direct `write` call:\n' +
  '- file_path (string, required): path to write, resolved by the filesystem backend; relative paths resolve against the session working directory. Provide `file_path` before `content` in the arguments.\n' +
  '- content (string, required): full UTF-8 text content to write; creates the file or fully replaces an existing one. Empty content is valid and writes an empty file.\n' +
  '- sandbox_permissions (optional; present only when the deployment confines filesystem access, and then one of the deployment\'s escalation modes): the narrowest wider sandbox mode for a one-shot retry of the exact operation the sandbox just denied; the retry asks the user for approval.\n' +
  '- justification (string, required with sandbox_permissions): one sentence for the user explaining why this exact file operation needs the wider access. Use the language of the user\'s current request.\n' +
  'The result is a short confirmation with the resolved path and whether the file was created or updated; file content is not echoed back. ' +
  'Read an existing file before overwriting it, and reach edit (or apply_patch, when the deployment mounts it) from inside a run_code program for targeted changes. ' +
  'Every other tool is reachable only from inside a run_code program.'

function parseArguments(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

function jsonValuesEqual(left, right) {
  const pending = [[left, right]]
  while (pending.length > 0) {
    const [currentLeft, currentRight] = pending.pop()
    if (Object.is(currentLeft, currentRight)) continue
    if (currentLeft === null || currentRight === null
      || typeof currentLeft !== 'object' || typeof currentRight !== 'object'
      || Array.isArray(currentLeft) !== Array.isArray(currentRight)) return false
    const leftKeys = Object.keys(currentLeft)
    const rightKeys = Object.keys(currentRight)
    if (leftKeys.length !== rightKeys.length
      || leftKeys.some(key => !Object.hasOwn(currentRight, key))) return false
    for (const key of leftKeys) pending.push([currentLeft[key], currentRight[key]])
  }
  return true
}

function containsOwnProto(value) {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object') continue
    if (!Array.isArray(current) && Object.hasOwn(current, '__proto__')) return true
    for (const child of Object.values(current)) pending.push(child)
  }
  return false
}

function jsonContainerDepth(value) {
  let maximum = 0
  const pending = [{ value, depth: 0 }]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current.value === null || typeof current.value !== 'object') continue
    const depth = current.depth + 1
    if (depth > maximum) maximum = depth
    for (const child of Object.values(current.value)) pending.push({ value: child, depth })
  }
  return maximum
}

function numberLiteral(value) {
  if (Object.is(value, -0)) return '-0'
  if (value === Infinity) return '1e400'
  if (value === -Infinity) return '-1e400'
  return JSON.stringify(value)
}

/** A JSON-safe object literal with computed `__proto__` keys. */
function safeJsonLiteral(value) {
  const output = []
  const pending = [{ kind: 'value', value }]
  while (pending.length > 0) {
    const item = pending.pop()
    if (item.kind === 'text') {
      output.push(item.value)
      continue
    }
    const current = item.value
    if (current === null) output.push('null')
    else if (typeof current === 'string') output.push(JSON.stringify(current))
    else if (typeof current === 'boolean') output.push(String(current))
    else if (typeof current === 'number') output.push(numberLiteral(current))
    else if (Array.isArray(current)) {
      output.push('[')
      pending.push({ kind: 'text', value: ']' })
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (index < current.length - 1) pending.push({ kind: 'text', value: ',' })
        pending.push({ kind: 'value', value: current[index] })
      }
    } else {
      const keys = Object.keys(current)
      output.push('{')
      pending.push({ kind: 'text', value: '}' })
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]
        if (index < keys.length - 1) pending.push({ kind: 'text', value: ',' })
        pending.push({ kind: 'value', value: current[key] })
        pending.push({
          kind: 'text',
          value: `${key === '__proto__' ? `[${JSON.stringify(key)}]` : JSON.stringify(key)}:`,
        })
      }
    }
  }
  return output.join('')
}

function isIdentifierName(name) {
  return /^(?:[$_]|\p{ID_Start})(?:[$_\u200C\u200D]|\p{ID_Continue})*$/u.test(name)
}

function toolMemberCode(name) {
  return isIdentifierName(name) ? `tools.${name}` : `tools[${JSON.stringify(name)}]`
}

/**
 * The program body for one canonicalized call. The argument code is the
 * model's raw JSON text whenever it is a safe, bounded literal; deep nesting
 * re-encodes through `JSON.parse` and an own `__proto__` key forces the
 * computed-property literal.
 */
function nativeCallCode(name, rawArgs, parsedArgs) {
  const argumentCode = jsonContainerDepth(parsedArgs) > MAX_DIRECT_LITERAL_DEPTH
    ? `JSON.parse(${JSON.stringify(rawArgs)})`
    : containsOwnProto(parsedArgs) ? safeJsonLiteral(parsedArgs) : rawArgs
  return `{\n  return await ${toolMemberCode(name)}(${argumentCode})\n}`
}

/**
 * The request presents a PTC transport view: `run_code` is declared, and every
 * other declared name is a tool the allowlist already governs. A second direct
 * tool another plugin presents therefore keeps salvage alive instead of
 * disabling it, while an unvetted extra (`bash`, `read`) or a malformed,
 * duplicated declaration leaves the stream untouched.
 */
function acceptsTransportView(tools, allowed) {
  if (!Array.isArray(tools) || tools.length === 0) return false
  const names = tools.map(tool => tool?.name)
  if (names.includes(undefined) || new Set(names).size !== names.length) return false
  if (!names.includes(RUN_CODE_NAME)) return false
  return names.every(name => name === RUN_CODE_NAME || allowed.has(name))
}

/**
 * Whether the active runtime accepts the TypeScript async function body this
 * plugin emits. Omitted options mean "unknown, keep the historical shape".
 */
function acceptsProgramTarget(options) {
  if (options.language !== undefined && options.language !== 'typescript') return false
  if (options.programFormat !== undefined && options.programFormat !== 'function-body') return false
  return true
}

/**
 * Resolve one emitted call name against the fixed allowlist without guessing.
 * A plain name and its `tools.`-prefixed form are different tools, so a name
 * that matches both is ambiguous and never resolves — the same refusal the
 * adapted canonicalizer applies to a schema-proven Map.
 */
function resolveAllowedName(name, allowed) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  const matches = new Set()
  if (allowed.has(name)) matches.add(name)
  if (name.startsWith('tools.')) {
    const member = name.slice('tools.'.length)
    if (member.length > 0 && !member.includes('.') && allowed.has(member)) matches.add(member)
  }
  return matches.size === 1 ? matches.values().next().value : undefined
}

function extractCall(chunks, index) {
  let name
  let id
  let deltaArgs = ''
  let finalArgs
  let deltaIndex = -1
  let invalidId = false
  let inconsistent = false
  let complete = false
  for (let position = 0; position < chunks.length; position += 1) {
    const chunk = chunks[position]
    if (chunk.index !== index) continue
    if (chunk.type === 'tool-call-delta') {
      if (chunk.id === undefined) invalidId = true
      else if (chunk.id !== '') {
        if (id !== undefined && id !== chunk.id) inconsistent = true
        else id = chunk.id
      }
      if (typeof chunk.name === 'string' && chunk.name.length > 0) {
        if (name !== undefined && name !== chunk.name) inconsistent = true
        else name = chunk.name
      }
      if (typeof chunk.argumentsDelta !== 'string') inconsistent = true
      else deltaArgs += chunk.argumentsDelta
      if (deltaIndex < 0) deltaIndex = position
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      const block = chunk.block
      complete = true
      if (typeof block.id !== 'string' || block.id.length === 0) invalidId = true
      else if (id !== undefined && id !== block.id) inconsistent = true
      else id ??= block.id
      if (name !== undefined && name !== block.name) inconsistent = true
      else name ??= block.name
      if (typeof block.arguments !== 'string') inconsistent = true
      else if (finalArgs !== undefined && finalArgs !== block.arguments) inconsistent = true
      else finalArgs = block.arguments
    }
  }
  let args = deltaArgs
  if (finalArgs !== undefined) {
    if (deltaArgs.length > 0) {
      const streamed = parseArguments(deltaArgs)
      const finalized = parseArguments(finalArgs)
      if (!streamed.ok || !finalized.ok || !jsonValuesEqual(streamed.value, finalized.value)) {
        inconsistent = true
      }
    }
    args = finalArgs
  }
  return { name, id, args, deltaIndex, invalidId, inconsistent, complete }
}

function transformedChunks(chunks, replacements) {
  const byIndex = new Map(replacements.map(replacement => [replacement.index, replacement]))
  const emitted = new Set()
  return chunks.flatMap(chunk => {
    if (chunk.type === 'finish') {
      const { replayState: _replayState, ...finish } = chunk
      return [finish]
    }
    const replacement = byIndex.get(chunk.index)
    if (replacement === undefined) return [chunk]
    if (chunk.type === 'block-start') return [{ ...chunk, blockType: 'tool-call' }]
    if (chunk.type === 'tool-call-delta') {
      if (emitted.has(chunk.index)) return []
      emitted.add(chunk.index)
      return [{
        ...chunk,
        name: RUN_CODE_NAME,
        argumentsDelta: replacement.arguments,
      }]
    }
    if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      return [{
        ...chunk,
        block: {
          type: 'tool-call',
          id: replacement.id,
          name: RUN_CODE_NAME,
          arguments: replacement.arguments,
        },
      }]
    }
    return [chunk]
  })
}

function transformCandidate(chunks, index, allowed, allowDeltaOnly) {
  const call = extractCall(chunks, index)
  const nativeName = resolveAllowedName(call.name, allowed)
  if ((!call.complete && !allowDeltaOnly) || nativeName === undefined
    || call.id === undefined || call.invalidId
    || call.inconsistent || call.deltaIndex < 0) return undefined
  const parsed = parseArguments(call.args)
  if (!parsed.ok) return undefined
  const argumentsValue = JSON.stringify({
    code: nativeCallCode(nativeName, call.args, parsed.value),
    description: `Call ${nativeName} directly`,
  })
  return { index, id: call.id, arguments: argumentsValue }
}

function transformCandidates(chunks, indices, allowed, allowDeltaOnly = false) {
  const replacements = [...indices].map(index => transformCandidate(
    chunks, index, allowed, allowDeltaOnly,
  ))
    .filter(replacement => replacement !== undefined)
  return replacements.length === 0 ? undefined : transformedChunks(chunks, replacements)
}

/**
 * Normalize model-emitted allowlisted native calls into the code-only direct
 * tool projection without guessing. Unknown, disallowed, or malformed calls
 * pass through unchanged for the host to diagnose.
 */
export async function* canonicalizeToolCallStream(source, options = {}) {
  const allowed = options.allowed instanceof Set
    ? options.allowed
    : new Set(Array.isArray(options.allowed) ? options.allowed : [])
  if (allowed.size === 0 || !acceptsTransportView(options.tools, allowed)
    || !acceptsProgramTarget(options)) {
    yield* source
    return
  }
  const passthrough = new Set()
  const open = new Set()
  let pending = []
  let changed = false
  try {
    for await (const chunk of source) {
      if (pending.length > 0) {
        pending.push(chunk)
        if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') open.add(chunk.index)
        if (chunk.type === 'tool-call-delta'
          && resolveAllowedName(chunk.name, allowed) !== undefined) open.add(chunk.index)
        if (chunk.type === 'tool-call-delta' && open.size === 1 && open.has(chunk.index)
          && typeof chunk.name === 'string'
          && resolveAllowedName(chunk.name, allowed) === undefined) {
          yield* pending
          pending = []
          passthrough.add(chunk.index)
          open.clear()
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          open.delete(chunk.index)
          if (open.size > 0) continue
          const indices = new Set(pending
            .filter(item => item.type === 'tool-call-delta' || item.type === 'block-end')
            .map(item => item.index))
          const transformed = transformCandidates(pending, indices, allowed)
          if (transformed === undefined) yield* pending
          else {
            changed = true
            yield* transformed
          }
          pending = []
        } else if (chunk.type === 'finish') {
          const indices = new Set(pending
            .filter(item => item.type === 'tool-call-delta' || item.type === 'block-end')
            .map(item => item.index))
          const transformed = transformCandidates(pending, indices, allowed, true)
          if (transformed !== undefined) {
            changed = true
            yield* transformed
          } else if (changed && Object.hasOwn(chunk, 'replayState')) {
            const { replayState: _replayState, ...finish } = chunk
            pending[pending.length - 1] = finish
            yield* pending
          } else {
            yield* pending
          }
          pending = []
          open.clear()
        }
        continue
      }
      if (passthrough.has(chunk.index)) {
        yield chunk
        if (chunk.type === 'block-end') passthrough.delete(chunk.index)
        continue
      }
      if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
        open.add(chunk.index)
        pending = [chunk]
      } else if (chunk.type === 'tool-call-delta'
        && resolveAllowedName(chunk.name, allowed) !== undefined) {
        open.add(chunk.index)
        pending = [chunk]
      } else if (changed && chunk.type === 'finish') {
        // Provider replay metadata describes the original response and
        // becomes stale once at least one block was canonicalized.
        const { replayState: _replayState, ...finish } = chunk
        yield finish
      } else {
        yield chunk
      }
    }
  } catch (error) {
    yield* pending
    throw error
  }
  yield* pending
}

/**
 * Insert the `write` exception into the shipped instruction without replacing
 * the rest of its wording. Upstream text that no longer contains the marker
 * falls back to the pinned amendment.
 */
function amendedPtcOnlyText(text) {
  const at = text.indexOf(PTC_ONLY_MARKER)
  if (at < 0) return PTC_ONLY_INSTRUCTION_WITH_DIRECT_WRITE
  const end = at + PTC_ONLY_MARKER.length
  return `${text.slice(0, end)}, except \`write\`: a direct \`write\` call is transparently `
    + `translated into the equivalent \`${RUN_CODE_NAME}\` program (see Direct file writes below)`
    + text.slice(end)
}

/**
 * Whether one assembly presents the PTC transport. The PTC executor owns the
 * `tools:ptc-only` section, and its text stays non-empty exactly while that
 * executor is selected for the assembly's scope — the marker that survives the
 * 0.2.x split of tool declarations out of `PromptPresentation`.
 */
function presentsPtc(assembly) {
  return Array.isArray(assembly?.sections)
    && assembly.sections.some(section => (
      section?.name === PTC_ONLY_SECTION_NAME
      && typeof section.text === 'string'
      && section.text.length > 0
    ))
}

/**
 * Amend the shipped `tools:ptc-only` section and insert the advertising
 * section after it. Non-PTC assemblies pass through untouched.
 */
function advertiseDirectWrite(assembly, advertise) {
  if (!advertise || !presentsPtc(assembly)) return assembly
  const index = assembly.sections.findIndex(section => section.name === PTC_ONLY_SECTION_NAME)
  if (index < 0) return assembly
  const sections = assembly.sections.map(section => (
    section.name === PTC_ONLY_SECTION_NAME
      ? { ...section, text: amendedPtcOnlyText(section.text) }
      : section
  ))
  if (sections.some(section => section.name === DIRECT_WRITE_SECTION_NAME)) {
    return { ...assembly, sections }
  }
  sections.splice(index + 1, 0, {
    name: DIRECT_WRITE_SECTION_NAME,
    text: DIRECT_WRITE_SECTION_TEXT,
    interpolate: false,
  })
  return { ...assembly, sections }
}

/**
 * The active runtime's program target, read lazily so mounting order does not
 * matter. A runtime in a narrower scope than this plugin is not visible here;
 * returning an empty target keeps the historical TypeScript assumption.
 */
function runtimeTarget(ctx) {
  let runtime
  try {
    runtime = ctx.get('ptcRuntime')
  } catch {
    return { language: 'unavailable' }
  }
  if (runtime === undefined) return {}
  try {
    return { language: runtime.language, programFormat: runtime.programFormat }
  } catch {
    return { language: 'unavailable' }
  }
}

/**
 * Observe the global LLM stream and canonicalize allowlisted direct calls,
 * and advertise the direct `write` call in PTC prompt assemblies.
 * @param ctx - the mounting context.
 * @param config - the allowlist of tool names.
 */
export function apply(ctx, config) {
  const allowed = new Set(config.tools)
  const advertiseWrite = allowed.has('write')
  ctx.on('llm/stream', (options, next) => canonicalizeToolCallStream(next(), {
    tools: options?.tools,
    allowed,
    ...runtimeTarget(ctx),
  }), { global: true })
  ctx.on('system-prompt/assemble', (assembly, _context, next) => (
    next().then(assembled => advertiseDirectWrite(assembled, advertiseWrite))
  ))
}
