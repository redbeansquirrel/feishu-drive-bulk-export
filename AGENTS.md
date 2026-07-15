# Repository guidelines

- Keep the implementation focused on one-time Feishu Drive export and archival.
- Treat task manifests, `.url` shortcuts, downloads, reports, and archives as private user data. Never commit them.
- Do not add Cookie extraction, credential persistence, permission bypasses, or instructions to weaken Chrome security.
- Keep Base disabled unless its export path is explicitly implemented and tested.
- Treat `code 1002 / no permission` as a terminal checkpoint, not a retryable error.
- Keep the export format map in `chrome-extension/feishu-bulk-export/core.mjs` as the code source of truth; update the extension README and `docs/ARCHITECTURE.md` with format changes.
- Preserve the merge script's copy-only, add-only behavior. A clean archive requires a new empty output directory.
- After JavaScript changes, run `node --check` on `runner.js`, `background.js`, and `core.mjs`.
