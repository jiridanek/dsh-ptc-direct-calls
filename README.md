# dsh-ptc-direct-calls

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) profile plugin for
PTC (Programmatic Tool Calling) sessions. It makes the model's `write` tool directly callable
*without* putting the native `write` schema on the wire — closing the escaping failure mode at
the one point a plugin can still see a collapsed call.

## Why

In a PTC session the model's only directly callable tool is `run_code`; every other tool is
reached through the generated SDK from inside a program. Two problems follow:

1. **Escaping hell.** A model that writes file content inside a `run_code` program must encode
   that content as a JavaScript string literal. Backticks, `${...}`, backslashes, and newlines
   corrupt it; DSH's error surfaces from the TS-stripping layer, so the failure is opaque
   (deepseek-ai/deepseek-harness discussions #3925, #4699, #7618).
2. **Stray direct calls.** Models nonetheless occasionally emit a model-direct `write` call. The
   registry denies it before any policy pipeline ("only `run_code` is callable directly"), and
   the model burns turns re-doing the call through a program — re-encoding the content into a
   string literal in the process.

This plugin attacks both:

- **Stream canonicalization** (global `llm/stream` waterfall): when the request's model-facing
  tool view is exactly `[run_code]` and the model emits a direct call of an allowlisted tool
  (default: `write`) with JSON-parseable arguments, the stream chunk is rewritten in place into
  the equivalent `run_code` program: `{ return await tools.write(<arguments>) }`. The
  arguments are re-embedded as the model's own raw JSON text (JSON is a valid JS literal) with
  two guards: container depth beyond 128 falls back to `JSON.parse(JSON.stringify(raw))`, and an
  own `__proto__` key uses a computed-property literal. The model's content never passes through
  a model-authored string literal, and the nested sub-dispatch keeps full governance (schema
  validation, sandbox, approval).
- **Prompt advertising** (one `system-prompt/assemble` waterfall listener): in PTC assemblies the
  plugin inserts the `write` exception into the shipped `tools:ptc-only` instruction — keeping the
  rest of upstream's wording — and inserts a `tools:direct-write` section right after it that
  advertises the direct call with its full current parameter list. Every other tool stays
  reachable only from inside a `run_code` program.

Unknown, disallowed, or malformed calls pass through untouched; the host's normal `run_code`-only
denial remains the backstop. The plugin adds no tools and no permissions, and costs nothing on
the wire — the `write` schema never leaves the deployment as a tool definition.

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
listener, and inserts the advertising section immediately after the amended instruction. A native
assembly (empty marker, or no marker at all) passes through by identity.

The stream half gates on the declared tool view: `run_code` must be present, every other declared
name must be in the allowlist, and a malformed or duplicated declaration is refused. A second
direct tool that another plugin presents therefore keeps salvage alive once the profile allowlists
it, while an unvetted extra (`bash`, `read`), a native-only view, or a full "both" surface leaves
the stream untouched. It also requires that the live `ptcRuntime` (read optionally via
`ctx.get('ptcRuntime')`) still accepts a **TypeScript async function body**, because the
canonicalizer emits a function body. A runtime reporting another language (the experimental
Python backend) or program format (REPL/script) leaves the stream untouched; an absent runtime
keeps the historical TypeScript assumption, so a runtime mounted in a narrower scope cannot
disable the plugin.

## Install

Install the directory as a local bundle with the profile's plugin manager, which writes the
profile manifest and link for you:

```
plugin_manager action=install_bundle target=/absolute/path/to/dsh-ptc-direct-calls
```

`application: applied` in the result means the change is live. The bundle carries its own
`cordis.patch.yml` row `ptc-direct-calls` with `config: { tools: [write] }`; editing that config is
a profile change, so leave the row's defaults unless you need a different allowlist.

Host-side JS changes are not hot-reloaded for a bundle: restart the DSH host process to load a
changed `index.js`.

## Configuration

| Key     | Type        | Default  | Meaning                                                                                     |
| ------- | ----------- | -------- | ------------------------------------------------------------------------------------------- |
| `tools` | string[]    | `[write]`| Tool names a model-direct call may be canonicalized (and, for `write`, advertised). Disable the row to turn the behavior off. |

Do **not** add long-running tools such as `workflow`: a converted call executes under
`run_code`'s wall-clock ceiling (discussion #5822). `edit` and the opt-in `apply_patch` stay
program-only; the escaping problem this plugin attacks is specific to full-file `write`.

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
nesting), passthrough gates (disallowed tool, malformed JSON, native-only and mixed views,
allowlisted vs unvetted extra declarations, duplicated declarations, unknown name, empty
allowlist, non-TypeScript runtime, non-function-body program format), mixed streams, stale
`replayState` stripping, and the prompt amendment/advertising gating (current presentation
shape, native mode, no marker, no duplicate section, reworded upstream instruction fallback).

## License

MIT — see [LICENSE](LICENSE).
