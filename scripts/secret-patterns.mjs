// Shared credential signatures for the release and source-handoff gates.
//
// The two packages have deliberately different file policies — a release must
// not contain tests, a source handoff must — but "does this file carry a live
// credential" is one question with one answer, and duplicating the patterns is
// how one gate silently stops catching what the other does.
//
// Findings are reported as `{ type, file }` only. The matched value is never
// returned, logged or printed: a gate that prints the secret it found has
// leaked it into CI logs.

export const SECRET_PATTERNS = Object.freeze([
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['telegram_bot_token', /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/],
  ['openai_style_token', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['google_api_key', /\bAIza[A-Za-z0-9_-]{30,}\b/],
  [
    'assigned_application_secret',
    /\b(?:APP_SECRET|GATE_SECRET|TELEGRAM_BOT_TOKEN|DEEPL_API_KEY)\s*=\s*["']?[A-Za-z0-9_:/+=.-]{24,}/,
  ],
])

// Tests must exercise realistically shaped credentials, and a realistically
// shaped credential is by definition indistinguishable from a real one. The
// only accepted way out is an explicit marker inside the fixture itself.
//
// This is deliberately narrower than a path allowlist: an allowlisted file
// keeps passing after someone pastes a live token into it, whereas a marker has
// to be present in the matched value. `NOT-A-REAL-TOKEN` cannot occur in a
// random base64url credential by accident.
const SYNTHETIC_MARKER = /NOT-A-REAL-(?:TOKEN|KEY|SECRET)/

/**
 * Classify a text blob without disclosing what matched.
 *
 * @param {string} text File contents.
 * @returns {string[]} Names of the credential types present, possibly empty.
 */
export const secretTypesIn = (text) =>
  SECRET_PATTERNS.filter(([, pattern]) => {
    const match = pattern.exec(text)
    return Boolean(match) && !SYNTHETIC_MARKER.test(match[0])
  }).map(([type]) => type)

/**
 * Render findings for a terminal. Only type and path — never the value.
 *
 * @param {Array<{type: string, file: string}>} findings
 * @returns {string}
 */
export const formatRedactedFindings = (findings) =>
  findings.map(({ type, file }) => `  - ${type} in ${file}`).join('\n')
