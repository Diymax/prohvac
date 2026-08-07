import { describe, expect, it } from 'vitest'

import { FRONTEND_ERROR_CODES, frontendError } from './errors.js'

describe('frontend error model', () => {
  it('covers every required public error class', () => {
    expect(FRONTEND_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'forbidden',
        'unauthorized',
        'session_expired',
        'must_change_password',
        'csrf_failed',
        'rate_limited',
        'validation_failed',
        'not_configured',
        'telegram_failed',
        'delivery_unknown',
        'payload_too_large',
        'unsupported_media_type',
        'network_error',
        'server_error',
      ])
    )
  })

  it('keeps the technical code and request ID separate from the human message', () => {
    const model = frontendError({
      code: 'csrf_mismatch',
      requestId: 'req-diagnostic-01',
    })
    expect(model).toMatchObject({
      code: 'csrf_failed',
      technicalCode: 'csrf_mismatch',
      requestId: 'req-diagnostic-01',
    })
    expect(model.message).not.toContain('csrf_mismatch')
    expect(model.message).not.toContain('req-diagnostic-01')
  })

  it('normalizes Axios network and API response errors', () => {
    expect(frontendError({ code: 'ERR_NETWORK' }).code).toBe('network_error')
    expect(
      frontendError({
        response: {
          data: { error: 'delivery_unknown' },
          headers: { 'x-request-id': 'req-telegram-01' },
        },
      })
    ).toMatchObject({ code: 'delivery_unknown', requestId: 'req-telegram-01' })
  })
})
