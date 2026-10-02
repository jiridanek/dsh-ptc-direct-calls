/** Sequential runner: node --import ./test/register.mjs ./test/run.mjs */
await import('./stream.test.mjs')
console.log('')
await import('./prompt.test.mjs')
