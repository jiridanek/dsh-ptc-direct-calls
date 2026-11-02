# dsh-ptc-direct-calls

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) profile plugin for
PTC (Programmatic Tool Calling) sessions. It puts the escaping-prone tools on the wire as real
direct-call affordances, translates each such call into the equivalent `run_code` program, and
tells the model when to prefer that path.

## Why

In a PTC session the model's only directly callable tool is `run_code`; every other tool is
reached through the generated SDK from inside a program. Two problems follow:

1. **Escaping hell.** A model that writes file content inside a `run_code` program must encode
   that content as a JavaScript string literal. Backticks, `${...}`, backslashes, and newlines
   corrupt it; DSH's error surfaces from the TS-stripping layer, so the failure is opaque
   (deepseek-ai/deepseek-harness discussions #3925, #4699, #7618).
2. **Stray direct calls.** Models occasionally emit a model-direct call of another tool anyway.
   The executor denies it before any policy pipeline ("only `run_code` is callable directly"),
   and the model burns turns re-doing the call through a program — re-encoding the arguments in
   the process.

A prompt invitation alone cannot fix this: **a model can only call the tools its request
declares**, so a compliant model will never emit a call the PTC collapse hides. The plugin
therefore declares the tools instead of only hoping for them.

## What it does

- **Direct-call declaration** (a `systemPrompt.tools` provider): in a PTC scope the plugin adds
  the schemas of the escaping-prone tools — by default `write`, `edit`, and `bash` — to the
  request, so the model can emit a structured call with JSON arguments. The declaration is
  skipped for a native executor, whose own schemas are already declared, and is absent when the
  harness exposes no way to identify the selected executor.
- **Stream canonicalization** (global `llm/stream` waterfall): when the request declares
  `run_code` and nothing outside the allowlist (by default every tool), any other direct call with
  JSON-parseable arguments is rewritten in place into the equivalent `run_code` program:
  `{ return await tools.<name>(<arguments>) }`. The arguments are re-embedded as the model's own
  raw JSON text (JSON is a valid JS literal) with two guards: container depth beyond 128 falls
  back to `JSON.parse(JSON.stringify(raw))`, and an own `__proto__` key uses a computed-property
  literal. The model's content never passes through a model-authored string literal, and the
  nested sub-dispatch keeps full governance (schema validation, sandbox, approval). `run_code`
  itself is never rewritten — a declared call is converted before dispatch, so the PTC executor
  never sees a direct non-`run_code` call.
- **Prompt advertising** (one `system-prompt/assemble` waterfall listener): in PTC assemblies the
  plugin restates the shipped `tools:ptc-only` instruction — which otherwise promises that a
  direct call fails — and inserts a `tools:direct-calls` section that tells the model to call a
  tool directly whenever its arguments would otherwise have to be escaped into a program: file
  contents, patches, code, prompts, and any text containing backticks, `${...}`, quotes, or
  backslashes. `write` is named for whole-file creation, `edit` for targeted changes, and `bash`
  for commands whose quoting would need escaping. The text follows what is actually declared and
  allowed: the listed names, or "any tool" when `declare: ['*']`.

Unknown, malformed, or (when the allowlist is restricted) disallowed calls pass through
untouched; the host's normal `run_code`-only denial remains the backstop. The plugin adds no
tools and no permissions. Declaring schemas does cost context — the reason the default declares
three tools rather than restoring the native surface.

The stream-rewriting core is adapted from the call canonicalizer of
[dsh-ptc-plus](https://github.com/muyuanjin/dsh-ptc-plus) (MIT, Copyright (c) 2026 dsh-ptc-plus
contributors); see the header of `index.js`.

## How PTC mode is detected (0.2.x API notes)

Two harness changes since the first release shaped the current implementation; both are why the
plugin reads the assembly text instead of tool arrays:

- `ctx.tools.schemas()` no longer returns the executor's model-facing projection. Tool
  definitions are registered as before, and the executor (`native` or `ptc`) owns the projection,
  so in PTC every registered tool is still "visible" to the registry while only `run_code` is
  sent to the model.
- `system-prompt/assemble` now carries `PromptPresentation` (sections, contexts, variables) with
  **no `tools` array**; declarations are provider-owned.

The PTC executor registers the `tools:ptc-only` section and renders its text only while that
executor is selected for the assembly's scope. The plugin therefore treats a **non-empty
`tools:ptc-only` section** as the PTC marker, performs both prompt mutations in one waterfall
listener, and inserts the advertising section immediately after the restated instruction. A
native assembly (empty marker, or no marker at all) passes through by identity.

The declaration provider adds schemas only when the selected executor's model-facing projection
is exactly `run_code` (the PTC collapse). It reads the executor through the TypeScript-private
`ctx.tools.selectExecutor` and degrades to no declaration when that accessor is absent or throws,
so a native scope never receives duplicate tool names.

The stream half gates on the declared tool view: `run_code` must be present, every other declared
name must be in the allowlist, and a malformed or duplicated declaration is refused. A second
direct tool that another plugin presents therefore keeps salvage alive once the profile allowlists
it; with the default (every tool) any well-formed view is accepted. It also requires that the
live `ptcRuntime` (read optionally via `ctx.get('ptcRuntime')`) still accepts a **TypeScript
async function body**, because the canonicalizer emits a function body. A runtime reporting
another language (the experimental Python backend) or program format (REPL/script) leaves the
stream untouched; an absent runtime keeps the historical TypeScript assumption, so a runtime
mounted in a narrower scope cannot disable the plugin.

## Install

Install the directory as a local bundle with the profile's plugin manager, which writes the
profile manifest and link for you:

```
plugin_manager action=install_bundle target=/absolute/path/to/dsh-ptc-direct-calls
```

`application: applied` in the result means the change is live. The bundle carries its own
`cordis.patch.yml` row `ptc-direct-calls` with no `config`, so the schema defaults apply:
`tools: ['*']` (canonicalize every tool) and `declare: ['write','edit','bash']` (the direct-call
affordance). Editing the row's config is a profile change.

Host-side JS changes are not hot-reloaded for a bundle: restart the DSH host process to load a
changed `index.js`.

## Configuration

| Key       | Type     | Default                   | Meaning |
| --------- | -------- | ------------------------- | ------- |
| `tools`   | string[] | `['*']`                   | Tools a model-direct call may be canonicalized into the equivalent program. `'*'` means every tool; `[]` disables canonicalization; a name list restricts it. |
| `declare` | string[] | `['write','edit','bash']` | Tools whose schemas are declared in PTC requests so the model can actually emit a direct call. `'*'` declares every visible allowlisted tool (the native surface, expensive); `[]` disables the affordance and leaves the plugin as a safety net for stray calls. Bounded by `tools`. |

The plugin does not add tools, so a listed name must still be a registered tool in the deployment.
Long-running tools such as `workflow` are canonicalized by default and, when called directly,
execute under `run_code`'s wall-clock ceiling; restrict `tools` if that budget is too short for
them (discussion #5822). Keep `declare` to the escaping-prone few: every declared schema costs
context on every request.

## Package metadata

The manifest declares `engines.dsh` (the range the profile's bundle resolver checks before
loading) and ships display resources the plugin manager reads without evaluating the module:
`locale/en.json` (`meta.title`, `meta.description`) and `icon.svg`, both listed in `exports`.

## Tests

Standalone, no DSH installation required (the `@deepseek-ai/schemastery` import is stubbed by a
`module.registerHooks` resolution hook):

```sh
npm test
# or: node --import ./test/register.mjs ./test/run.mjs
```

Covers: content round-trip (backticks, `${}`, invalid JS escapes, `__proto__`, 130-level
nesting), passthrough gates (malformed JSON, native-only and mixed views, allowlisted vs unvetted
extra declarations, duplicated declarations, non-TypeScript runtime, non-function-body program
format), the unrestricted default (any tool, any well-formed view, `run_code` never rewritten),
restricted and empty allowlists, mixed streams, stale `replayState` stripping, the declaration
provider (default, one tool, wildcard, empty, native executor, missing/throwing selector,
allowlist bound), and the prompt restatement/advertising gating (default, one tool, wildcard,
empty, allowlist bound, native mode, no marker, no duplicate section).

## License

MIT — see [LICENSE](LICENSE).
