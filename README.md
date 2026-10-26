# Chunkwise

Plan Minecraft bases floor by floor on a block grid, check them in 3D, and export them for Litematica or WorldEdit. The whole app is one file, `index.html`, with no build step.

## Put it on GitHub Pages

1. Create a repository and upload `index.html` to the root of the `main` branch.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**, pick `main` and `/ (root)`, then **Save**.
4. After a minute or two the site is live at `https://<your-username>.github.io/<repository>/`.

GitHub Pages sites are public, even when the repository is private. Publishing from a private repository needs GitHub Pro or a paid plan.

## How this version stores things

- Signed out, plans, settings, snapshots and textures are saved in the browser you use. Use **⋯ → Import plan (.json)** and Export to move a plan by hand.
- Signed in (**⋯ → Sign in to sync**, email and password), they're kept in the Chunkwise Supabase project and sync live between your devices. Each floor saves on its own, so edits to different floors on two devices both survive. Texture packs and mod pictures go in a private storage bucket; every row and file is readable only by its owner. Plans already in a browser move into the account the first time you sign in there.
- Blocks use built-in look-alike textures. To use real textures, open **Blocks → Textures** and load your own resource pack (.zip). It stays in that browser.
- Mod blocks: **Settings → Blocks → Add mod (.jar)** reads a mod's blocks and textures into the plan. They're kept in that browser and travel inside exported plan files.
- Don't commit Minecraft's textures or other game files to this repository. The Minecraft EULA doesn't allow redistributing them.
- Three.js (for 3D) and the fonts load from cdnjs and Google Fonts, so the first visit needs an internet connection. Packs, mods and exports work offline.

Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
