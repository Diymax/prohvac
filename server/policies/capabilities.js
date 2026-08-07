export const CAPABILITY = Object.freeze({
  DASHBOARD_READ: 'dashboard.read',
  CONTENT_READ: 'content.read',
  CONTENT_WRITE: 'content.write',
  MEDIA_READ: 'media.read',
  MEDIA_UPLOAD: 'media.upload',
  MEDIA_DELETE: 'media.delete',
  LEADS_READ: 'leads.read',
  LEADS_WRITE: 'leads.write',
  LEADS_RETRY: 'leads.retry',
  LEADS_EXPORT: 'leads.export',
  SETTINGS_MANAGE: 'settings.manage',
  SECURITY_SELF_MANAGE: 'security.self_manage',
})

export const CAPABILITY_KEYS = Object.freeze(Object.values(CAPABILITY))

const matrix = Object.freeze({
  owner: new Set(CAPABILITY_KEYS),
  admin: new Set(CAPABILITY_KEYS),
  editor: new Set([
    CAPABILITY.DASHBOARD_READ,
    CAPABILITY.CONTENT_READ,
    CAPABILITY.CONTENT_WRITE,
    CAPABILITY.MEDIA_READ,
    CAPABILITY.MEDIA_UPLOAD,
    CAPABILITY.MEDIA_DELETE,
    CAPABILITY.LEADS_READ,
    CAPABILITY.LEADS_WRITE,
    CAPABILITY.LEADS_RETRY,
    CAPABILITY.SECURITY_SELF_MANAGE,
  ]),
  viewer: new Set([
    CAPABILITY.DASHBOARD_READ,
    CAPABILITY.CONTENT_READ,
    CAPABILITY.MEDIA_READ,
    CAPABILITY.LEADS_READ,
    CAPABILITY.SECURITY_SELF_MANAGE,
  ]),
})

export const capabilitiesFor = (user, { accountActive = true } = {}) => {
  const allowed = accountActive ? matrix[user?.role] : null
  return Object.freeze(
    Object.fromEntries(CAPABILITY_KEYS.map((capability) => [capability, allowed?.has(capability) === true]))
  )
}

export const hasCapability = (user, capability, options) => {
  if (!CAPABILITY_KEYS.includes(capability)) {
    throw new TypeError(`unknown capability ${JSON.stringify(capability)}`)
  }
  return capabilitiesFor(user, options)[capability]
}
