import { describe, expect, it } from 'vitest'

import { CAPABILITY, CAPABILITY_KEYS, capabilitiesFor, hasCapability } from './capabilities.js'

describe('role capability matrix', () => {
  it.each([
    ['owner', true, true, true],
    ['admin', true, true, true],
    ['editor', true, false, false],
    ['viewer', false, false, false],
  ])('%s write/export/settings access', (role, contentWrite, leadsExport, settingsManage) => {
    const capabilities = capabilitiesFor({ role })
    expect(capabilities[CAPABILITY.CONTENT_WRITE]).toBe(contentWrite)
    expect(capabilities[CAPABILITY.LEADS_EXPORT]).toBe(leadsExport)
    expect(capabilities[CAPABILITY.SETTINGS_MANAGE]).toBe(settingsManage)
    expect(Object.keys(capabilities)).toEqual(CAPABILITY_KEYS)
  })

  it('keeps read access for viewer but denies all capabilities before activation', () => {
    expect(hasCapability({ role: 'viewer' }, CAPABILITY.LEADS_READ)).toBe(true)
    expect(
      Object.values(capabilitiesFor({ role: 'owner' }, { accountActive: false }))
    ).toEqual(CAPABILITY_KEYS.map(() => false))
  })

  it('fails closed for an unknown role or capability', () => {
    expect(Object.values(capabilitiesFor({ role: 'unknown' })).every((value) => !value)).toBe(true)
    expect(() => hasCapability({ role: 'owner' }, 'root.everything')).toThrow(
      'unknown capability'
    )
  })
})
