import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const envFile = path.resolve(__dirname, '../../src/config/env.ts')
const sourceRequire = createRequire(envFile)

describe('standard dependency resolution from support source', () => {
  it('finds installed packages and Node types without test aliases', () => {
    expect(sourceRequire.resolve('dotenv')).toBeTruthy()
    expect(sourceRequire.resolve('@types/node/package.json')).toBeTruthy()
  })

  it('type-checks env.ts through the original service configuration', () => {
    const configPath = path.resolve(__dirname, '../../tsconfig.json')
    const raw = ts.readConfigFile(configPath, ts.sys.readFile)
    expect(raw.error).toBeUndefined()
    const config = ts.parseJsonConfigFileContent(
      raw.config,
      ts.sys,
      path.dirname(configPath)
    )
    const program = ts.createProgram(config.fileNames, {
      ...config.options,
      noEmit: true,
    })
    const source = program.getSourceFile(envFile)
    expect(source).toBeDefined()
    expect(program.getSemanticDiagnostics(source)).toEqual([])
  })
})
