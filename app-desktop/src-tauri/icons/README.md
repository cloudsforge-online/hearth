# App icons

Generated from the Hearth logo — run once from `app-desktop/`:

```bash
npm run icons        # tauri icon ../web/assets/logo.svg
```

This produces `32x32.png`, `128x128.png`, `icon.icns`, `icon.ico`, etc., which
`tauri.conf.json` references. They're git-ignored (build artifacts); regenerate
them on any machine.
