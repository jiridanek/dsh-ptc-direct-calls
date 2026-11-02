/** Sequential runner: node --import ./test/register.mjs ./test/run.mjs */
await import('./stream.test.mjs')
console.log('')
await import('./prompt.test.mjs')
console.log('')
await import('./declare.test.mjs')
