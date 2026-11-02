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
 * call of any other tool with JSON-parseable arguments, the stream chunk is
 * rewritten in place into the equivalent `run_code` program:
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
 * no tools and no permissions. Declaring schemas does cost context, which is
 * why the default declares the three escaping-prone tools rather than the
 * whole native surface.
 *
 * Direct-call declaration: a model can only call the tools its request
 * declares, so a prompt invitation alone cannot produce a direct call. In a
 * PTC scope the plugin adds the schemas of the escaping-prone tools (default
 * `write`, `edit`, `bash`) to the request through a `systemPrompt.tools`
 * provider; each such call is then canonicalized by the stream half before
 * dispatch. The declaration is skipped for a native executor, whose own
 * schemas are already declared.
 *
 * Prompt advertising: in a PTC session the plugin (a) rewrites the shipped
 * `tools:ptc-only` instruction so it stops claiming that a direct call fails,
 * and (b) inserts a `tools:direct-calls` section right after it that tells the
 * model to call a tool directly whenever its arguments would otherwise have to
 * be escaped into a program — file contents, patches, code, and any text with
 * backticks, `${...}`, quotes, or backslashes. `write`, `edit`, and `bash` are
 * named explicitly, but the rule is general. The advertising follows the effective
 * allowlist: "any tool" when the plugin is unrestricted, or the listed names.
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
 * `llm` gates activation on the core LLM service whose global `llm/stream`
 * waterfall is observed; `systemPrompt` and `tools` are required because the
 * declaration provider reads the executor projection and visible schemas.
 * `ptcRuntime` is read optionally at stream time.
 */
export const inject = ['llm', 'systemPrompt', 'tools']

/** The allowlist entry that means "every tool". */
const ALL_TOOLS = '*'

const DEFAULT_DECLARED = ['write', 'edit', 'bash']

/** Plugin config. */
export const Config = z.object({
  /**
   * Tool names a model-direct call may be canonicalized into the equivalent
   * `run_code` program. The default `['*']` allows every tool; list real names
   * to restrict, or use `[]` to disable canonicalization. A listed name is also
   * the only declaration another plugin may add to the wire view without
   * disabling salvage. Long-running tools execute under `run_code`'s wall-clock
   * ceiling, so list them out if that budget is too short for them.
   */
  tools: z.array(z.string()).default([ALL_TOOLS]).description(
    "Tools that may be called directly and translated into run_code. Default ['*'] allows every tool.",
  ),
  /**
   * Tools whose schemas are added to a PTC request so the model can actually
   * emit a direct call. Models only call declared tools, so this is the
   * affordance the prompt advertises; the stream rewrite then turns each call
   * into the equivalent program. `['*']` declares every visible allowlisted
   * tool (the native surface, expensive); `[]` disables the affordance and
   * leaves the plugin as a safety net for stray calls.
   */
  declare: z.array(z.string()).default(DEFAULT_DECLARED).description(
    "Tools declared to the model in PTC requests so direct calls are emittable. Default ['write','edit','bash']; '*' declares every visible allowlisted tool; [] disables it.",
  ),
})

const RUN_CODE_NAME = 'run_code'
const MAX_DIRECT_LITERAL_DEPTH = 128
const PTC_ONLY_SECTION_NAME = 'tools:ptc-only'
const DIRECT_CALLS_SECTION_NAME = 'tools:direct-calls'

/** Human-readable list for prompt text: "a", "a and b", or "a, b, and c". */
function listedTools(allowed) {
  const names = [...allowed].map(name => `\`${name}\``)
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`
}

/** The subject of a direct-call sentence: every tool, or the allowlisted names. */
function directCallSubject(names) {
  return names === undefined ? 'any tool' : listedTools(names)
}

/** Sentence-initial form of the subject. */
function directCallSubjectSentence(names) {
  const subject = directCallSubject(names)
  return subject.charAt(0).toUpperCase() + subject.slice(1)
}

/** Named escaping cases; only the ones actually declared are advertised. */
const DIRECT_CALL_EXAMPLES = [
  ['write', 'to create or fully replace a file'],
  ['edit', 'for a targeted change'],
  ['bash', 'for a command whose quoting you would otherwise have to escape inside a program'],
]

/** The concrete examples, naming only the tools that are actually declared. */
function directCallExamples(names) {
  const permitted = DIRECT_CALL_EXAMPLES.filter(([name]) => names === undefined || names.has(name))
  if (permitted.length === 0) return ''
  const parts = permitted.map(([name, purpose], index) =>
    `${index === 0 ? 'call ' : ''}\`${name}\` directly ${purpose}`)
  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`
  return `In particular, ${list}. `
}

/**
 * The replacement for the shipped `tools:ptc-only` instruction. The shipped
 * text promises that a direct call of any other tool fails; that is no longer
 * true for the tools this plugin translates, so the whole instruction is
 * restated while keeping the SDK pointer that follows it.
 */
function amendedPtcOnlyText(names) {
  return `\`${RUN_CODE_NAME}\` is the tool for multi-step work. `
    + `${directCallSubjectSentence(names)} may also be called directly: a direct call is `
    + `transparently translated into the equivalent \`${RUN_CODE_NAME}\` program `
    + '(see Direct tool calls below). Reach every tool the SDK declares below from inside a program, '
    + 'or call one directly when that keeps its arguments readable.'
}

/**
 * The inserted advertising section: why escaping is a non-issue, when a direct
 * call beats a program, and the boundary (multi-step work stays in a program).
 * The tools' own parameters are already typed in the SDK section, so they are
 * not repeated here.
 */
function directCallsText(names) {
  return `Direct tool calls: you may call ${directCallSubject(names)} directly instead of writing `
    + 'a `run_code` program for one invocation. A direct call is translated mechanically into the '
    + 'equivalent program, with its arguments carried as JSON — they never pass through a JavaScript '
    + 'string literal. Prefer a direct call whenever the arguments would be painful to escape in a '
    + 'program: file contents, patches, code, prompts, or any text containing backticks, `${...}`, '
    + 'quotes, or backslashes. '
    + directCallExamples(names)
    + 'A translated call is equivalent to the same call inside a program: argument validation, '
    + 'sandbox, and approvals still apply. Use `run_code` for multi-step work and for tools whose '
    + 'arguments are simple.'
}

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
 * duplicated declaration leaves the stream untouched. An unrestricted
 * allowlist governs every name, so it accepts any well-formed view.
 */
function acceptsTransportView(tools, allowed) {
  if (!Array.isArray(tools) || tools.length === 0) return false
  const names = tools.map(tool => tool?.name)
  if (names.includes(undefined) || new Set(names).size !== names.length) return false
  if (!names.includes(RUN_CODE_NAME)) return false
  return names.every(name => name === RUN_CODE_NAME || allowed === undefined || allowed.has(name))
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
 * Resolve one emitted call name to the program binding it names without
 * guessing. `tools.`-qualified names map to their member; an explicit
 * allowlist that contains both spellings as distinct tools never resolves an
 * ambiguous name. `run_code` never resolves — it is the transport, not a
 * binding — so an unrestricted allowlist cannot produce a program that calls
 * `run_code` from inside itself.
 */
function resolveAllowedName(name, allowed) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  const qualified = name.startsWith('tools.') ? name.slice('tools.'.length) : undefined
  const member = qualified !== undefined && qualified.length > 0 && !qualified.includes('.')
    ? qualified
    : undefined
  if (allowed === undefined) {
    const resolved = member ?? name
    return resolved === RUN_CODE_NAME ? undefined : resolved
  }
  const matches = new Set()
  if (allowed.has(name)) matches.add(name)
  if (member !== undefined && allowed.has(member)) matches.add(member)
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
  const allowed = options.allowed === undefined ? undefined
    : options.allowed instanceof Set ? options.allowed : new Set(options.allowed)
  if ((allowed !== undefined && allowed.size === 0)
    || !acceptsTransportView(options.tools, allowed)
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
 * Restate the shipped `tools:ptc-only` instruction and insert the advertising
 * section after it. Non-PTC assemblies pass through untouched.
 */
function advertiseDirectCalls(assembly, names) {
  if (!presentsPtc(assembly)) return assembly
  const index = assembly.sections.findIndex(section => section.name === PTC_ONLY_SECTION_NAME)
  if (index < 0) return assembly
  const sections = assembly.sections.map(section => (
    section.name === PTC_ONLY_SECTION_NAME
      ? { ...section, text: amendedPtcOnlyText(names) }
      : section
  ))
  if (sections.some(section => section.name === DIRECT_CALLS_SECTION_NAME)) {
    return { ...assembly, sections }
  }
  sections.splice(index + 1, 0, {
    name: DIRECT_CALLS_SECTION_NAME,
    text: directCallsText(names),
    interpolate: false,
  })
  return { ...assembly, sections }
}

/**
 * Whether the executor selected for this assembly is the PTC collapse. The
 * model-facing projection is the only public evidence: a PTC executor describes
 * exactly `run_code`, while a native executor describes its visible tools.
 * `selectExecutor` is TypeScript-private; a harness that drops it degrades to
 * "no direct-call declaration" instead of breaking the plugin.
 */
function ptcSelected(ctx, context) {
  try {
    const select = ctx.tools.selectExecutor
    if (typeof select !== 'function') return false
    const executor = select.call(ctx.tools, context?.scope)
    const definitions = ctx.tools.definitions(context?.scope, context?.toolSet)
    const schemas = executor.describe(definitions)?.schemas
    return Array.isArray(schemas) && schemas.length === 1 && schemas[0]?.name === RUN_CODE_NAME
  } catch {
    return false
  }
}

/**
 * The declared names that this assembly can actually offer: the configured
 * declaration intersect the allowlist and the tools visible in this step.
 * `undefined` keeps the unrestricted "any tool" wording.
 */
function effectiveDeclared(ctx, context, declared, allowed) {
  if (declared === undefined && allowed === undefined) return undefined
  let visible
  try {
    visible = new Set(ctx.tools.definitions(context?.scope, context?.toolSet).map(definition => definition.name))
  } catch {
    visible = undefined
  }
  const names = declared === undefined ? allowed : declared
  return new Set([...names].filter(name => (
    (allowed === undefined || allowed.has(name))
    && (visible === undefined || visible.has(name))
  )))
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
 * Observe the global LLM stream and canonicalize direct calls, declare the
 * escaping-prone tools in PTC requests, and advertise them in PTC prompts.
 * @param ctx - the mounting context.
 * @param config - the optional allowlist and declaration; omitted uses defaults.
 */
export function apply(ctx, config) {
  const configured = config.tools ?? [ALL_TOOLS]
  const allowed = configured.includes(ALL_TOOLS) ? undefined : new Set(configured)
  const declaredConfig = config.declare ?? DEFAULT_DECLARED
  const declared = declaredConfig.includes(ALL_TOOLS) ? undefined : new Set(declaredConfig)
  const isAllowed = name => allowed === undefined || allowed.has(name)
  const isDeclared = name => declared === undefined || declared.has(name)
  const hasDeclaration = declared === undefined || declared.size > 0

  ctx.on('llm/stream', (options, next) => canonicalizeToolCallStream(next(), {
    tools: options?.tools,
    allowed,
    ...runtimeTarget(ctx),
  }), { global: true })

  // Models only call declared tools: put the escaping-prone ones on the wire so
  // a direct call is an affordance, not a hope. The stream rewrite above turns
  // each such call into the equivalent program before dispatch.
  ctx.systemPrompt.tools((context) => {
    if (!hasDeclaration || !ptcSelected(ctx, context)) return { schemas: [] }
    try {
      const schemas = ctx.tools.schemas(context?.scope, context?.toolSet)
        .filter(schema => isDeclared(schema.name) && isAllowed(schema.name))
      return { schemas }
    } catch {
      return { schemas: [] }
    }
  })

  ctx.on('system-prompt/assemble', (assembly, context, next) => (
    next().then(assembled => {
      if (!hasDeclaration) return assembled
      const names = effectiveDeclared(ctx, context, declared, allowed)
      if (names !== undefined && names.size === 0) return assembled
      return advertiseDirectCalls(assembled, names)
    })
  ))
}
