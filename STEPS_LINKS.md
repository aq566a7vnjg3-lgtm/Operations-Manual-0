# URL links and step bodies (2026-11-07)

Local implementation only. Production deployment requires user approval.

- HTTP/HTTPS URLs in overview, required items, step titles/bodies and notices become escaped links with `target=_blank` and `rel=noopener noreferrer`.
- Each step has a required title and optional multiline body. Existing `steps` string arrays remain titles; new `stepBodies` arrays store corresponding bodies. Legacy records need no database migration.
- Removing a step moves its images to reference images and decrements later image step numbers. History rendering supports both formats.
- Authentication, persistence paths, image storage and existing permission checks are unchanged.
- Do not edit with an older client after deployment: reload open editor tabs before saving to avoid dropping the new body field.

Verification:
- `npm test`: 40 passed.
- `scripts/ui-steps.mjs`: legacy editing, saving/reloading, history, JSON export/import, safe URL rendering, inert HTML, deletion and desktop/mobile layout passed.
- `scripts/ui-images.mjs`: lazy loading, cache, uploads, zoom and desktop/mobile controls passed.
- Browser tests use local Edge/Chromium and mobile viewport emulation, not physical iOS devices.
- Production/Render testing is pending approval and deployment.
