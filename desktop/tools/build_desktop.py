"""Builds the desktop app's page (desktop/web/index.html) from the main Chunkwise file.
   python3 desktop/tools/build_desktop.py path/to/chunkwise.html
The main file is the same one the web and Claude versions are made from; this swaps its storage for plan files on disk (desk.js), adds the
account code (sb_sync.js) for synced plans, and points fonts, three.js and Supabase at the copies bundled in desktop/web."""
import sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(sys.argv[1], encoding='utf-8').read()
s = src
def rep(a, b, n=1):
    global s
    c = s.count(a)
    if c != n: sys.exit(f'count {c} (wanted {n}) for: {a[:90]!r}')
    s = s.replace(a, b)

# 1. everything bundled: fonts, the 3D engine and the sign-in library work offline
rep('<link rel="preconnect" href="https://fonts.googleapis.com">\n', '')
rep('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n', '')
i = s.index('<link rel="stylesheet" href="https://fonts.googleapis.com/'); j = s.index('>', i) + 1
s = s[:i] + '<link rel="stylesheet" href="fonts.css">' + s[j:]
rep("s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';", "s.src = 'vendor/three.min.js';")

# 2. the account code from the web build, with the bundled library; signing in or out saves first
SB = open(os.path.join(HERE, 'sb_sync.js'), encoding='utf-8').read()
SB = SB.replace("lib: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'", "lib: 'vendor/supabase.js'")
SB = SB.replace("location.reload()", "deskReload()")
SB = SB.replace("Signed in as ${SB.email}. Your plans, settings and texture packs sync to every device you sign in on.", "Signed in as ${SB.email}. Plans with their sync switch on, and your settings, follow you to every device you sign in on. Texture packs stay on this PC.")
SB = SB.replace("Sign in to keep your plans, settings and texture packs in sync across your devices. Plans already in this browser move into your account the first time.", "Sign in to sync plans with your other devices. Each plan stays on this PC only until you turn its sync switch on.")
SB = SB.replace("Signed out, this browser shows the plans saved in it before you signed in.", "Signed out, synced plans stay on this PC as they are.")
DESK = open(os.path.join(HERE, 'desk.js'), encoding='utf-8').read()
DESK += """
async function deskReload() { try { await flushNow(); await DESK.db.flush(); } catch {} location.reload(); }
"""
rep("async function boot() {", SB + "\n" + DESK + "\nasync function boot() {")

# 3. start-up: plan files instead of the browser; settings follow the account, packs don't
rep("""  const hasClaude = window.claude && typeof window.claude.use === 'function';
  if (hasClaude) window.claude.use('downloads').then(d => { store.downloads = d; }).catch(() => {});
  let db = null, user = null;
  if (hasClaude) { try { [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]); } catch { db = null; } }
""", """  let db = null, user = null;
  try { const a = await deskStart(); db = a.db; user = a.user; } catch (e) { console.error(e); toast('The plans folder couldn’t be read, so this session saves inside the app only.'); }
""")
rep("if (user) user.id().then(id => { if (id) { startSettingsSync(db, id); startPackSync(db, id); } }).catch(() => {});",
    "if (user) user.id().then(id => { if (id) startSettingsSync(db, id); }).catch(() => {});")
# a plan opens in one window only; a window with nothing it may open starts a new plan
rep("async function openDbPlan(entry) {\n", "async function openDbPlan(entry) {\n  if (!(await deskClaim(entry.id))) { if (!plan) startNewPlan('My base'); return; }\n")
rep("function loadPlanInto(p, opts = {}) {\n", "function loadPlanInto(p, opts = {}) {\n  DESK.inv('claim_plan', { pid: p.id }).catch(() => {});\n")
# the first plan this window opens: the one deskStart chose (no free plan: a new one)
rep("      else { const e = store.plans.find(p => p.id === prefs.lastPlan) || store.plans[0]; openDbPlan(e); }",
    "      else { const e = DESK.want ? store.plans.find(p => p.id === DESK.want) : null; if (e) openDbPlan(e); else startNewPlan('My base'); }")

# 4. files: a Save dialog, or a remembered folder
rep("""async function offerFile(filename, data, fallback) {
  const dl = store.downloads;
  if (!dl) { fallback(); return; }
  try { await dl.save({ filename, data }); }
  catch (e) { const c = e && e.code; if (c === 'declined') return; if (c === 'rate_limited') { toast('A save prompt is already open.'); return; } fallback(); }
}""", """async function offerFile(filename, data, fallback) {
  const kind = DESK.target; DESK.target = null;
  try { const p = kind ? await deskSaveTo(kind, filename, data) : await deskSaveAs(filename, data); if (p) toast(`Saved ${deskBase(p)}${kind ? ' to the ' + DESK_KINDS[kind][0].toLowerCase() + ' folder' : ''}.`); }
  catch (e) { console.error(e); fallback(); }
}""")
# the Export window: WorldEdit straight into a schematics folder; pictures and plan files to a folder or anywhere
rep("const dlBtn = el('button', { class: 'btn primary', disabled: ex.bb ? null : true, onclick: () => runExport(kind, scope, name, dlBtn, dig) }, icon('download'), kind === 'litematica' ? 'Download .litematic' : 'Download .zip');",
    "const weDesk = kind === 'worldedit', dlBtn = el('button', { class: 'btn primary', disabled: ex.bb && (!weDesk || DESK.cfg.exportDirs.worldedit) ? null : true, onclick: () => weDesk ? deskSaveWE(scope, name, dig, dlBtn) : runExport(kind, scope, name, dlBtn, dig) }, icon('download'), kind === 'litematica' ? 'Save .litematic…' : 'Save to folder');")
rep("      el('div', { class: 'exact' }, dlBtn),\n      kind === 'worldedit' ? weCmdRows(name, dig) : null,",
    "      kind === 'worldedit' ? deskFolderRow('worldedit', renderPanel) : null,\n      el('div', { class: 'exact' }, kind === 'worldedit' ? el('button', { class: 'btn', disabled: ex.bb ? null : true, onclick: () => runExport(kind, scope, name, dlBtn, dig) }, 'Save as .zip…') : null, dlBtn),\n      kind === 'worldedit' ? weCmdRows(name, dig) : null,")
rep("el('button', { class: 'btn primary', onclick: exportJSON }, icon('download'), 'Download .json'))",
    "el('button', { class: 'btn', onclick: exportJSON }, 'Save as…'), el('button', { class: 'btn primary', disabled: DESK.cfg.exportDirs.json ? null : true, onclick: () => { DESK.target = 'json'; exportJSON(); } }, icon('download'), 'Save to folder')), deskFolderRow('json', renderPanel)")
rep("el('div', { class: 'exact' }, el('button', { class: 'btn primary', disabled: bb ? null : true, onclick: exportPNG }, icon('download'), 'Download .png')),",
    "deskFolderRow('png', renderPanel), el('div', { class: 'exact' }, el('button', { class: 'btn', disabled: bb ? null : true, onclick: exportPNG }, 'Save as…'), el('button', { class: 'btn primary', disabled: bb && DESK.cfg.exportDirs.png ? null : true, onclick: () => { DESK.target = 'png'; exportPNG(); } }, icon('download'), 'Save to folder')),")

# 5. texture packs are files in the packs folder, the original zip copied alongside
rep("async function savePackRec(id, rec) { try { await idbPut(packRecKey(id), rec); return true; } catch { return lsSet('chunkwise.packrec.' + id, rec); } }",
    "const deskPackPath = id => deskJoin(DESK.cfg.packsDir, 'textures', id + '.json');\nasync function savePackRec(id, rec) { try { await deskReady(); await DESK.inv('write_text', { path: deskPackPath(id), text: JSON.stringify(rec) }); return true; } catch { return false; } }")
rep("async function loadPackRec(id) { try { const v = await idbGet(packRecKey(id)); if (v) return v; } catch {} return lsGet('chunkwise.packrec.' + id); }",
    "async function loadPackRec(id) { try { await deskReady(); const t = await DESK.inv('read_text', { path: deskPackPath(id) }); if (t) return JSON.parse(t); } catch {} return null; }")
rep("function dropPackRec(id) { idbDel(packRecKey(id)).catch(() => {}); try { localStorage.removeItem('chunkwise.packrec.' + id); } catch {} }",
    "function dropPackRec(id) { deskReady().then(() => DESK.inv('remove', { path: deskPackPath(id), toTrash: true })).catch(() => {}); }")
rep("  let u8, files; try { u8 = new Uint8Array(await file.arrayBuffer()); files = zipIndex(u8); } catch { toast('That file is not a .zip resource pack.'); return; }",
    "  let u8, files; try { u8 = new Uint8Array(await file.arrayBuffer()); files = zipIndex(u8); } catch { toast('That file is not a .zip resource pack.'); return; }\n  deskReady().then(async () => DESK.inv('write_bytes', { path: deskJoin(DESK.cfg.packsDir, file.name.replace(/[<>:\"/\\\\|?*]+/g, '')), b64: await deskB64(new Blob([u8])), replace: true })).catch(() => {});")
rep("const pack = { db: null, uid: null, ready: false, list: [], used: 0, localDone: null };", "const pack = { db: null, uid: null, ready: false, list: [], used: 0, localDone: null, desk: true };")

# 6. menus and Settings
rep("    plan && el('button', { class: 'mi', onclick: () => { closePopover(); openExportModal(); } }, icon('download'), 'Export…'),",
    "    plan && el('button', { class: 'mi', onclick: () => { closePopover(); openExportModal(); } }, icon('download'), 'Export…'),\n    ...deskMenuItems(),")
rep("    mi('focus', 'Take the tour', startTour),", "    mi('focus', 'Take the tour', startTour),\n    sbMenuItem(mi),")
rep("const SET_CATS = [\n", "const SET_CATS = [\n  ['files', 'Files & updates', 'download', 'Where plans and texture packs are kept on this PC, and the app’s version.', 'desk'],\n")
rep("function settingsRows(cat) {\n", "function settingsRows(cat) {\n  if (cat === 'files') return deskFilesRows();\n")
rep("const ICONS = {", "const ICONS = {\n  user: '<circle cx=\"10\" cy=\"7\" r=\"3.2\"/><path d=\"M3.8 16.5c.9-3 3.4-4.6 6.2-4.6s5.3 1.6 6.2 4.6\"/>',")
CSS = """
.sbbox{display:grid;gap:10px;width:min(380px,calc(100vw - 64px))}.sbbox p{margin:0;font-size:13px;line-height:1.45}.sbmsg{min-height:1em;color:var(--ink-2)}.sbmsg.bad{color:var(--danger)}.sblinks{display:flex;justify-content:space-between;gap:8px}
.desksync{order:2;display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 10px 0 6px;margin-left:4px;border:1px solid var(--line);border-radius:999px;cursor:pointer;font-size:12px;font-weight:700;color:var(--ink-2);user-select:none;flex:none}
.desksync input{position:absolute;opacity:0;width:0;height:0}.desksync .dsk{position:relative;width:28px;height:16px;border-radius:999px;background:var(--line);transition:background .15s}
.desksync .dsk::after{content:'';position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:var(--panel);box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .15s}
.desksync input:checked+.dsk{background:var(--accent)}.desksync input:checked+.dsk::after{left:14px}.desksync input:focus-visible+.dsk{outline:2px solid var(--accent);outline-offset:2px}
.deskfolder{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}.deskfolder select{flex:1;min-width:0;max-width:100%}.deskpath{font:500 11.5px var(--f-mono);color:var(--ink-2);word-break:break-all}
"""
rep(".msep{height:1px;background:var(--line);margin:5px 4px}", ".msep{height:1px;background:var(--line);margin:5px 4px}" + CSS)
assert "window.claude.use('db')" not in s and 'deskStart()' in s
out = os.path.join(HERE, '..', 'web', 'index.html')
head = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
cut = s.index('</style>') + len('</style>')
open(out, 'w', encoding='utf-8').write(head + s[:cut] + '\n</head>\n<body>\n' + s[cut:].lstrip('\n') + '\n</body>\n</html>\n')
print('ok', len(s))
