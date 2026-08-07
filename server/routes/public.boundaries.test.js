// A public route must not reach into an admin route.
//
// The dependency is checked statically, on the source text, because the runtime
// consequence is invisible: importing `readSetting` from admin.settings.js in a
// public handler worked perfectly well, it just meant the anonymous form and the
// authenticated panel shared a transport module and could only be reasoned about
// together.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROUTES_DIR = import.meta.dirname

const routeFiles = (prefix) =>
  readdirSync(ROUTES_DIR).filter(
    (name) => name.startsWith(prefix) && name.endsWith('.js') && !name.includes('.test.')
  )

const importSpecifiers = (source) =>
  [...source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'([^']+)'/g)].map(
    (match) => match[1]
  )

describe('public route module boundaries', () => {
  const publicFiles = routeFiles('public.')

  it('finds the public route modules', () => {
    expect(publicFiles.length).toBeGreaterThan(0)
  })

  it.each(publicFiles)('%s does not import an admin route module', (name) => {
    const source = readFileSync(join(ROUTES_DIR, name), 'utf8')
    const admin = importSpecifiers(source).filter((specifier) =>
      /(^|\/)admin\.[^/]*\.js$/.test(specifier)
    )
    expect(admin).toEqual([])
  })

  it.each(publicFiles)('%s takes settings from the application layer', (name) => {
    const source = readFileSync(join(ROUTES_DIR, name), 'utf8')
    for (const specifier of importSpecifiers(source)) {
      // Route modules import each other's transport concerns nowhere: anything
      // shared lives in application/, domain/, repositories/ or shared/.
      expect(specifier.startsWith('./')).toBe(false)
    }
  })
})
