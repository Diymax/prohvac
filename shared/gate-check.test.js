// TEMPORARY: proves that a red test suite stops the deploy job.
// Removed in the immediately following commit.

import { describe, expect, it } from 'vitest'

describe('deploy gate', () => {
  it('fails on purpose so the pipeline must not ship this commit', () => {
    expect('deploy').toBe('must not happen')
  })
})
