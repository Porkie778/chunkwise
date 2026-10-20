# Chunkwise

Plan Minecraft bases floor by floor on a block grid, check them in 3D, and export them for WorldEdit or Create. The whole app is one file, `index.html`, with no build step.

## Put it on GitHub Pages

1. Create a repository and upload `index.html` to the root of the `main` branch.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**, pick `main` and `/ (root)`, then **Save**.
4. After a minute or two the site is live at `https://<your-username>.github.io/<repository>/`.

GitHub Pages sites are public, even when the repository is private. Publishing from a private repository needs GitHub Pro or a paid plan.

## How this version stores things

- Plans, settings, snapshots and textures are saved in the browser you use. Use **⋯ → Export plan (.json)** and **Import plan** to move a plan to another device or browser.
- Blocks use built-in look-alike textures. To use real textures, open **Blocks → Textures** and load your own resource pack (.zip). It stays in that browser.
- Mod blocks: **Settings → Blocks → Add mod (.jar)** reads a mod's blocks and textures into the plan. They're kept in that browser and travel inside exported plan files.
- Don't commit Minecraft's textures or other game files to this repository. The Minecraft EULA doesn't allow redistributing them.
- Three.js (for 3D) and the fonts load from cdnjs and Google Fonts, so the first visit needs an internet connection. Packs, mods and exports work offline.

Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
