import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// Vitest strips types instead of checking them, so a suite goes green against
// a `src/` that does not compile — that shipped twice (see CLAUDE.md, "`yarn
// test` type-checks first"). The `test` script gates on tsc as well, but this
// hook is what covers the ways a suite actually gets re-run day to day:
// `yarn test:run`, `vitest run <path>`, the IDE runner.
//
// It checks `tsconfig.test.json` (src + tests), so a test asserting against an
// API production no longer exposes fails here instead of silently reading
// `undefined` at runtime.
//
// Incremental: the first run pays a full check, later ones reuse .tsbuildinfo
// and cost about a second. `SKIP_TYPECHECK=1` bypasses it.

// vite-node may load this as ESM, where `__dirname` is not defined — walk up
// from whichever anchor we have until the gate config turns up.
const findRoot = (start: string): string => {
  let dir = start
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, 'tsconfig.test.json'))) return dir
    dir = dirname(dir)
  }
  throw new Error(`tsconfig.test.json not found above ${start}`)
}

export default function setup(): void {
  if (process.env.SKIP_TYPECHECK === '1') return

  const root = findRoot(
    typeof __dirname === 'undefined' ? process.cwd() : __dirname
  )
  const cache = resolve(root, 'node_modules/.cache')
  mkdirSync(cache, { recursive: true })

  const started = Date.now()
  try {
    execFileSync(
      process.execPath,
      [
        resolve(root, 'node_modules/typescript/bin/tsc'),
        '-p',
        resolve(root, 'tsconfig.test.json'),
        '--noEmit',
        '--incremental',
        '--tsBuildInfoFile',
        resolve(cache, 'vitest-typecheck.tsbuildinfo'),
      ],
      { cwd: root, stdio: 'inherit' }
    )
  } catch {
    throw new Error(
      'Type-check failed — fix the tsc errors above. SKIP_TYPECHECK=1 bypasses this gate.'
    )
  }
  console.log(`✓ typecheck clean (${Date.now() - started}ms)`)
}
