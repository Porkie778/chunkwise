# Chunkwise for Windows

The desktop app is the same planner as the web version, in a [Tauri](https://tauri.app) window, with:

- **Plan files**: each plan is a `.chunkwise` file in `Documents\Chunkwise\Plans` (change it in Settings › Files & updates). Double-click one in Explorer to open it. Each window has one plan; a plan is only ever open in one window.
- **Sync switch** by the plan's name: off (the default), the plan stays on this PC; on, it's copied to your Chunkwise account and kept in step with the website and your other devices, floor by floor (the newest change to each floor wins). Settings follow the account; texture packs stay on each PC.
- **Export to a folder**: WorldEdit schematics go straight into a `config\worldedit\schematics` folder, picked from the Minecraft and launcher instances found on the PC (Prism, CurseForge, Modrinth, MultiMC, ATLauncher) or browsed for. The last one is replaced (it goes to the Recycle Bin) and `//schem load name` is copied. Floor pictures and plan backups have remembered folders too.
- **Texture packs** are copied into `Documents\Chunkwise\Packs`.
- **Updates** come from GitHub Releases: the app checks when it starts and updates itself.

## How it's built

- `web/index.html` is made from the main Chunkwise file: `python3 tools/build_desktop.py path/to/chunkwise.html`. It adds `tools/desk.js` (plan files, the sync switch, export folders, updates) and `tools/sb_sync.js` (the account), and points fonts, three.js and Supabase at the copies in `web/` so it works offline.
- `src-tauri/` is the Rust side: file commands (`src/files.rs`, with tests), windows, the `.chunkwise` file type and the updater.

## Releasing a new version

1. Rebuild `web/index.html` if the planner changed.
2. Bump `version` in `src-tauri/tauri.conf.json` (and `Cargo.toml`, `package.json`).
3. Commit to the `desktop` branch, then push a tag: `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`.

GitHub Actions builds the installer and publishes the release. Every installed copy offers the update the next time it starts. Pushes to `desktop` without a tag just check that it builds.

The release build signs updates with the key in the repository secret `TAURI_SIGNING_PRIVATE_KEY` (Settings › Secrets and variables › Actions). The matching public key is in `tauri.conf.json`. Don't lose the private key: without it, installed copies can't be updated.

The installer isn't code-signed, so Windows SmartScreen asks the first time: **More info → Run anyway**.

Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
