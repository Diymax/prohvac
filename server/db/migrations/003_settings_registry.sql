-- Canonicalize settings whose admin/runtime names or value shapes diverged.
--
-- Conflict rule for DeepL is deterministic: an existing canonical row wins.
-- Otherwise the complete legacy row is moved byte-for-byte, preserving its
-- encryption metadata and audit attribution. The legacy name is then removed
-- so future reads have exactly one source of truth.
INSERT OR IGNORE INTO settings (
  key, value, is_secret, value_ct, value_iv, value_tag, preview, updated_at, updated_by
)
SELECT
  'translation.deepl.key',
  value,
  is_secret,
  value_ct,
  value_iv,
  value_tag,
  preview,
  updated_at,
  updated_by
FROM settings
WHERE key = 'deepl.api_key';

DELETE FROM settings WHERE key = 'deepl.api_key';

-- The old admin UI stored one scalar provider per language. Runtime consumes
-- ordered arrays; "none" is the intentional disabled state [].
--
-- Existing arrays are preserved. Unknown legacy scalar values are wrapped in
-- an array rather than silently replaced; runtime validation will report the
-- invalid provider and use its safe default.
UPDATE settings
SET value = CASE
  WHEN json_valid(value) AND json_type(value) = 'object' THEN json_object(
    'en', json(
      CASE json_type(value, '$.en')
        WHEN 'array' THEN json_extract(value, '$.en')
        WHEN 'text' THEN
          CASE json_extract(value, '$.en')
            WHEN 'none' THEN '[]'
            ELSE json_array(json_extract(value, '$.en'))
          END
        ELSE '["deepl"]'
      END
    ),
    'uz', json(
      CASE json_type(value, '$.uz')
        WHEN 'array' THEN json_extract(value, '$.uz')
        WHEN 'text' THEN
          CASE json_extract(value, '$.uz')
            WHEN 'none' THEN '[]'
            ELSE json_array(json_extract(value, '$.uz'))
          END
        ELSE '["deepl","mymemory"]'
      END
    ),
    'tr', json(
      CASE json_type(value, '$.tr')
        WHEN 'array' THEN json_extract(value, '$.tr')
        WHEN 'text' THEN
          CASE json_extract(value, '$.tr')
            WHEN 'none' THEN '[]'
            ELSE json_array(json_extract(value, '$.tr'))
          END
        ELSE '["deepl"]'
      END
    ),
    'ar', json(
      CASE json_type(value, '$.ar')
        WHEN 'array' THEN json_extract(value, '$.ar')
        WHEN 'text' THEN
          CASE json_extract(value, '$.ar')
            WHEN 'none' THEN '[]'
            ELSE json_array(json_extract(value, '$.ar'))
          END
        ELSE '["deepl"]'
      END
    )
  )
  ELSE value
END
WHERE key = 'translation.routing' AND is_secret = 0;
