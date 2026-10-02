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
- **Prompt advertising** (system-prompt sections): in PTC assemblies the plugin rewrites the
  shipped `tools:ptc-only` instruction to carve out the `write` exception instead of
  contradicting it, and renders a `tools:direct-write` section in the write slot advertising the
  direct call with its full parameter list. Every other tool stays reachable only from inside a
  `run_code` program.

Unknown, disallowed, or malformed calls pass through untouched; the host's normal `run_code`-only
denial remains the backstop. The plugin adds no tools and no permissions, and costs nothing on
the wire — the `write` schema never leaves the deployment as a tool definition.

The stream-rewriting core is adapted from the call canonicalizer of
[dsh-ptc-plus](https://github.com/muyuanjin/dsh-ptc-plus) (MIT, Copyright (c) 2026 dsh-ptc-plus
contributors); see the header of `index.js`.

## Install

Install the directory as a local bundle into a profile (the directory must persist; the profile
links it):

```sh
# profile dir, e.g. ~/.dsh/profiles/web
cp -r <this-repo> ~/.dsh/profiles/<profile>/bundles/ptc-direct-calls
```

then in the profile's `package.json` add the dependency and bundle registration:

```json
{
  "dependencies": {
    "dsh-ptc-direct-calls": "link:./bundles/ptc-direct-calls"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-ptc-direct-calls"]
    }
  }
}
```

(or install it with your profile's plugin manager; the bundle carries its own `cordis.patch.yml`
row `ptc-direct-calls` with `config: { tools: [write] }`).

Host-side JS changes are not hot-reloaded; restart the DSH host process to load a changed module.

## Configuration

| Key     | Type        | Default  | Meaning                                                                                     |
| ------- | ----------- | -------- | ------------------------------------------------------------------------------------------- |
| `tools` | string[]    | `[write]`| Tool names a model-direct call may be canonicalized (and, for `write`, advertised). Disable the row to turn the behavior off. |

Do **not** add long-running tools such as `workflow`: a converted call executes under
`run_code`'s wall-clock ceiling (discussion #5822).

## Tests

Standalone, no DSH installation required (the `@deepseek-ai/schemastery` import is stubbed by a
module-resolution hook):

```sh
node --import ./test/register.mjs ./test/run.mjs
```

Covers: content round-trip (backticks, `${}`, invalid JS escapes, `__proto__`, 130-level
nesting), passthrough gates (disallowed tool, malformed JSON, non-PTC view, unknown name, empty
allowlist), mixed streams, stale `replayState` stripping, and the prompt amendment/section
gating.

## License

MIT — see [LICENSE](LICENSE).
