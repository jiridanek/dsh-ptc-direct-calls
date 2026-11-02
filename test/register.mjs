/**
 * Module-resolution hook for the standalone suite: `@deepseek-ai/schemastery`
 * is provided by the dsh installation at runtime, so the test process stubs it
 * instead of installing dependencies.
 *
 * Uses the synchronous `module.registerHooks()` API (Node >= 22.15 / 24) rather
 * than the deprecated `module.register()`.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/schemastery') {
      return { url: new URL('./stub.mjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
