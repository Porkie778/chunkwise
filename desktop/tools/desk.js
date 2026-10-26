/* ================= the desktop app (Tauri) =================
   Plans are .chunkwise files in a folder (Documents\Chunkwise\Plans by default), packs are files in a Packs folder, and anything else the
   planner keeps (snapshots, mod pictures) goes in the app's data folder. The planner already talks to a store of documents at paths
   (plans/<id>, plans/<id>/levels/<id>…); deskDb is that store, made of files. A plan whose sync switch is on is also copied to Supabase,
   and changes from the account (the website, a phone) are merged in floor by floor: the newest change to each floor wins */
const DESK = { inv: (c, a) => window.__TAURI__.core.invoke(c, a), cfg: null, dirs: null, ready: null, db: null, sb: null, pending: new Set(), start: window.__DESK_START || {} };
const DESK_CFG = 'chunkwise.desk.cfg';
const deskJoin = (...a) => a.filter(Boolean).join('\\').replace(/[\\/]+/g, '\\');
const deskSame = (a, b) => String(a || '').toLowerCase().replace(/\//g, '\\') === String(b || '').toLowerCase().replace(/\//g, '\\');
const deskBase = p => String(p).split(/[\\/]/).pop();
function deskReady() {
  return DESK.ready || (DESK.ready = (async () => {
    DESK.dirs = await DESK.inv('dirs');
    const root = deskJoin(DESK.dirs.documents || DESK.dirs.home, 'Chunkwise'), saved = lsGet(DESK_CFG) || {};
    DESK.cfg = { plansDir: deskJoin(root, 'Plans'), packsDir: deskJoin(root, 'Packs'), exportDirs: {}, recent: [], ...saved };
    DESK.cfg.exportDirs = { ...(saved.exportDirs || {}) }; DESK.cfg.recent = Array.isArray(saved.recent) ? saved.recent.slice(0, 20) : [];
    return DESK.cfg;
  })());
}
const deskSaveCfg = () => lsSet(DESK_CFG, DESK.cfg);
const deskDataPath = path => deskJoin(DESK.dirs.appData, 'store', ...path.split('/').map(s => s.replace(/[^\w.\-]/g, '_'))) + '.json';
async function deskB64(blob) {
  const u = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  return String(u).slice(String(u).indexOf(',') + 1);
}
/* ---------- the store ---------- */
function deskDb() {
  const inv = DESK.inv, P = new Map(), subs = new Set();
  const snapOf = (path, data, pending) => ({ id: path.slice(path.lastIndexOf('/') + 1), exists: data != null, data: () => (data == null ? undefined : data), metadata: { hasPendingWrites: !!pending } });
  const notify = (path, data, pending) => { for (const s of subs) s(path, data, pending); };
  const parse = path => { const s = path.split('/'); if (s[0] !== 'plans' || !s[1]) return { other: true }; if (s.length === 2) return { pid: s[1], meta: true }; if (s.length === 4 && s[2] === 'levels') return { pid: s[1], lid: s[3] }; return { other: true }; };
  // the plans in the folder, and plan files opened from elsewhere
  let listed = null;
  const list = () => listed || (listed = (async () => {
    await deskReady();
    for (const r of await inv('list_plans', { dir: DESK.cfg.plansDir }).catch(() => [])) if (r.id && !P.has(r.id)) P.set(r.id, { path: r.path, meta: r.meta || {}, sync: !!r.sync, levels: null });
    for (const path of DESK.cfg.recent) { if ([...P.values()].some(e => deskSame(e.path, path))) continue; await addFile(path, true).catch(() => {}); }
  })());
  async function addFile(path, quiet) {
    const t = await inv('read_text', { path }); if (!t) throw new Error('missing');
    const f = JSON.parse(t); if (!f || typeof f.id !== 'string' || !f.meta) throw new Error('not a plan');
    const had = [...P.entries()].find(([, e]) => deskSame(e.path, path)); if (had) return had[0];
    let id = f.id; if (P.has(id)) { id = uid('p'); f.id = id; }   // a copy of a plan already here: kept apart
    P.set(id, { path, meta: f.meta, sync: !!f.sync, levels: new Map(Object.entries(f.levels || {})) });
    if (!quiet) notify('plans/' + id, f.meta, false);
    return id;
  }
  async function load(pid) {
    const e = P.get(pid); if (!e) return null; if (e.levels) return e;
    const t = await inv('read_text', { path: e.path }).catch(() => null); let f = {}; try { f = JSON.parse(t || '{}'); } catch {}
    e.levels = new Map(Object.entries(f.levels || {})); if (f.meta) e.meta = f.meta; e.sync = !!f.sync; return e;
  }
  // a plan's file is written whole, once per burst of changes (all the floors a save touches go in one write)
  async function write(pid) {
    const e = P.get(pid); if (!e) return; await load(pid);
    const want = deskJoin(DESK.cfg.plansDir, safeFile(e.meta && e.meta.name) + '.chunkwise');
    if (!e.path) e.path = await freePath(want);
    else if (deskSame(e.path.slice(0, e.path.lastIndexOf('\\')), DESK.cfg.plansDir) && !deskSame(deskBase(e.path), deskBase(want))) {   // renamed: the file follows, if the name is free
      const to = await freePath(want); if (!deskSame(to, e.path)) { try { await inv('rename', { from: e.path, to }); e.path = to; } catch {} }
    }
    await inv('write_text', { path: e.path, text: JSON.stringify({ format: 'chunkwise-plan', v: 1, id: pid, sync: !!e.sync, meta: e.meta, levels: Object.fromEntries(e.levels) }) });
  }
  const safeFile = n => String(n || 'Plan').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').replace(/[. ]+$/, '').trim().slice(0, 80) || 'Plan';
  async function freePath(want) {
    const taken = p => [...P.values()].some(e => deskSame(e.path, p));
    let p = want, n = 2; while (taken(p) || await inv('exists', { path: p })) p = want.replace(/\.chunkwise$/, ` (${n++}).chunkwise`); return p;
  }
  const queued = new Map();
  function save(pid) {
    if (queued.has(pid)) return queued.get(pid);
    const pr = new Promise(r => setTimeout(r, 0)).then(() => { queued.delete(pid); return write(pid); }).catch(err => { console.error(err); toast('This plan could not be saved to its file. Check the plans folder in Settings.'); });
    queued.set(pid, pr); DESK.pending.add(pr); pr.finally(() => DESK.pending.delete(pr)); return pr;
  }
  // the account's copy: written alongside, never waited for
  const cloud = (pid, fn) => { const e = P.get(pid); if (e && e.sync && DESK.sb) Promise.resolve().then(fn).catch(() => {}); };
  const doc = path => {
    const k = parse(path);
    if (path.startsWith('data/users/') && DESK.sb) return DESK.sb.doc(path);   // settings: the account's
    return {
      id: path.slice(path.lastIndexOf('/') + 1),
      async get() {
        if (k.other) { const t = await inv('read_text', { path: deskDataPath(path) }).catch(() => null); let d = null; try { d = t ? JSON.parse(t) : null; } catch {} return snapOf(path, d); }
        await list(); const e = k.meta ? P.get(k.pid) : await load(k.pid);
        return snapOf(path, !e ? null : k.meta ? e.meta : e.levels.get(k.lid) || null);
      },
      async set(data) {
        if (k.other) { await inv('write_text', { path: deskDataPath(path), text: JSON.stringify(data) }); return; }
        await list(); let e = P.get(k.pid);
        if (!e) { e = { path: null, meta: k.meta ? data : {}, sync: false, levels: new Map() }; P.set(k.pid, e); }
        await load(k.pid);
        if (k.meta) e.meta = data; else e.levels.set(k.lid, data);
        notify(path, data, true); save(k.pid);
        cloud(k.pid, () => DESK.sb.doc(path).set(data));
      },
      async delete() {
        if (k.other) { await inv('remove', { path: deskDataPath(path), toTrash: false }); return; }
        await list(); const e = P.get(k.pid); if (!e) return;
        if (k.meta) {   // the plan itself: its file goes to the Recycle Bin
          cloud(k.pid, () => DESK.sb.doc(path).delete());
          P.delete(k.pid); if (e.path) await inv('remove', { path: e.path, toTrash: true }).catch(() => {});
          DESK.cfg.recent = DESK.cfg.recent.filter(p => !deskSame(p, e.path)); deskSaveCfg(); notify(path, null, true); return;
        }
        await load(k.pid); e.levels.delete(k.lid); notify(path, null, true); save(k.pid);
        cloud(k.pid, () => DESK.sb.doc(path).delete());
      },
      onSnapshot(cb, err) { const s = (p, d, pend) => { if (p === path) cb(snapOf(path, d, pend)); }; subs.add(s); this.get().then(sn => cb(sn)).catch(x => err && err(x)); return () => subs.delete(s); }
    };
  };
  const collection = path => {
    const q = {}, s = path.split('/'), isPlans = path === 'plans', lvPid = s.length === 3 && s[0] === 'plans' && s[2] === 'levels' ? s[1] : null;
    const rows = async () => {
      if (isPlans) { await list(); return [...P.entries()].map(([id, e]) => [path + '/' + id, e.meta]); }
      if (lvPid) { await list(); const e = await load(lvPid); return e ? [...e.levels.entries()].map(([lid, d]) => [path + '/' + lid, d]) : []; }
      const dir = deskDataPath(path + '/x'), folder = dir.slice(0, dir.lastIndexOf('\\')), out = [];
      for (const f of await inv('list_dir', { dir: folder, ext: '.json' }).catch(() => [])) { const t = await inv('read_text', { path: f.path }).catch(() => null); try { out.push([path + '/' + f.name.replace(/\.json$/, ''), JSON.parse(t)]); } catch {} }
      return out;
    };
    const api = {
      orderBy(f, dir) { q.f = f; q.dir = dir; return api; }, limit(n) { q.n = n; return api; },
      async get() {
        let docs = (await rows()).map(([p, d]) => snapOf(p, d));
        if (q.f) docs.sort((a, b) => ((Number(a.data()[q.f]) || 0) - (Number(b.data()[q.f]) || 0)) * (q.dir === 'desc' ? -1 : 1));
        if (q.n) docs = docs.slice(0, q.n); return { docs, size: docs.length, empty: !docs.length };
      },
      onSnapshot(cb, err) {
        const known = new Map();
        const emit = ch => { const docs = [...known].map(([p, d]) => snapOf(p, d)); cb({ docs, size: docs.length, empty: !docs.length, docChanges: () => ch }); };
        const sub = (p, d, pend) => {
          if (p.slice(0, p.lastIndexOf('/')) !== path) return;
          const had = known.has(p);
          if (d == null) { if (!had) return; const old = known.get(p); known.delete(p); emit([{ type: 'removed', doc: snapOf(p, old) }]); return; }
          known.set(p, d); emit([{ type: had ? 'modified' : 'added', doc: snapOf(p, d, pend) }]);
        };
        subs.add(sub);
        rows().then(rs => { for (const [p, d] of rs) known.set(p, d); emit(rs.map(([p, d]) => ({ type: 'added', doc: snapOf(p, d) }))); }).catch(x => err && err(x));
        return () => subs.delete(sub);
      }
    };
    return api;
  };
  /* ---- sync with the account, for the plans whose switch is on ---- */
  const at = d => Number(d && (d.at || d.updatedAt)) || 0;
  async function pushAll(pid) {
    const e = await load(pid); if (!e || !DESK.sb) return;
    for (const [lid, d] of e.levels) await DESK.sb.doc(`plans/${pid}/levels/${lid}`).set(d);
    await DESK.sb.doc('plans/' + pid).set(e.meta);
  }
  // remote → here: a floor (or the plan's record) newer than ours replaces ours; ours, if newer, goes up
  async function merge(pid, remoteMeta) {
    const e = await load(pid); if (!e) return;
    const rl = await DESK.sb.collection(`plans/${pid}/levels`).get(); let changed = false;
    for (const d of rl.docs) {
      const lid = d.id, r = d.data(), mine = e.levels.get(lid);
      if (!mine || at(r) > at(mine)) { e.levels.set(lid, r); notify(`plans/${pid}/levels/${lid}`, r, false); changed = true; }
      else if (at(mine) > at(r)) DESK.sb.doc(`plans/${pid}/levels/${lid}`).set(mine).catch(() => {});
    }
    const remoteIds = new Set(rl.docs.map(d => d.id));
    for (const [lid, d] of e.levels) if (!remoteIds.has(lid)) DESK.sb.doc(`plans/${pid}/levels/${lid}`).set(d).catch(() => {});
    if (remoteMeta && at(remoteMeta) > at(e.meta)) { e.meta = remoteMeta; notify('plans/' + pid, remoteMeta, false); changed = true; }
    else if (!remoteMeta || at(e.meta) > at(remoteMeta)) DESK.sb.doc('plans/' + pid).set(e.meta).catch(() => {});
    if (changed) save(pid);
  }
  // live: what the account's other devices change
  const watching = new Set();
  function watch(pid) {
    if (!DESK.sb || watching.has(pid)) return; watching.add(pid);
    DESK.sb.collection(`plans/${pid}/levels`).onSnapshot(sn => {
      const e = P.get(pid); if (!e || !e.sync || !e.levels) return;
      for (const ch of sn.docChanges()) {
        const d = ch.doc.data(); if (ch.type === 'removed' || !d || d.client === store.client) continue;
        const mine = e.levels.get(ch.doc.id); if (mine && at(mine) >= at(d)) continue;
        e.levels.set(ch.doc.id, d); notify(`plans/${pid}/levels/${ch.doc.id}`, d, false); save(pid);
      }
    }, () => {});
  }
  async function cloudStart() {
    if (!DESK.sb) return;
    await list();
    let remote; try { remote = (await DESK.sb.collection('plans').get()).docs; } catch (x) { console.warn('cloud list', x); return; }
    for (const d of remote) {
      const pid = d.id, r = d.data(), e = P.get(pid);
      if (!e) {   // a synced plan made somewhere else: it gets a file here too
        const levels = new Map(); try { for (const l of (await DESK.sb.collection(`plans/${pid}/levels`).get()).docs) levels.set(l.id, l.data()); } catch {}
        P.set(pid, { path: null, meta: r, sync: true, levels }); save(pid); notify('plans/' + pid, r, false); watch(pid); continue;
      }
      if (e.sync) { await merge(pid, r).catch(x => console.warn('cloud merge', x)); watch(pid); }
    }
    for (const [pid, e] of P) if (e.sync && !remote.some(d => d.id === pid)) pushAll(pid).then(() => watch(pid)).catch(() => {});
    DESK.sb.collection('plans').onSnapshot(sn => {
      for (const ch of sn.docChanges()) {
        const d = ch.doc.data(), pid = ch.doc.id, e = P.get(pid); if (ch.type === 'removed' || !d || d.client === store.client) continue;
        if (!e) { P.set(pid, { path: null, meta: d, sync: true, levels: new Map() }); save(pid); notify('plans/' + pid, d, false); watch(pid); continue; }
        if (e.sync && at(d) > at(e.meta)) { e.meta = d; notify('plans/' + pid, d, false); save(pid); }
      }
    }, () => {});
  }
  const api = { doc, collection, list, addFile, save, load, P, pushAll, watch, cloudStart, flush: () => Promise.all([...DESK.pending]) };
  return api;
}
/* ---------- start-up ---------- */
async function deskStart() {
  await deskReady();
  // signed in before? the account is there for synced plans and settings
  if (localStorage.getItem(SB_TOKEN)) {
    try { const sb = await sbLoad(), { data } = await sb.auth.getSession(), s = data && data.session; if (s && s.user) { SB.uid = s.user.id; SB.email = s.user.email || ''; DESK.sb = sbDb(sb, SB.uid); } } catch {}
  }
  const db = DESK.db = deskDb();
  await db.list();
  // synced plans catch up with the account before anything opens, so a floor changed on another device is never overwritten by the old copy here
  if (DESK.sb) { const done = db.cloudStart().catch(x => console.warn('cloud', x)); await Promise.race([done, new Promise(r => setTimeout(r, 8000))]); }
  // which plan this window opens: the file it was opened with, the plan it was asked for, or the last one, if no other window has it
  let want = DESK.start.plan || null;
  if (DESK.start.file) { try { want = await db.addFile(DESK.start.file); deskRemember(DESK.start.file); } catch { toast('That file isn’t a Chunkwise plan, or it can’t be read.'); } }
  const free = async id => id && db.P.has(id) && !(await DESK.inv('claim_plan', { pid: id }));
  if (!(await free(want))) { want = null; if (!DESK.start.fresh && await free(prefs.lastPlan)) want = prefs.lastPlan; }
  if (!want && !DESK.start.fresh) for (const [id] of [...db.P].sort((a, b) => (Number(b[1].meta.updatedAt) || 0) - (Number(a[1].meta.updatedAt) || 0))) if (await free(id)) { want = id; break; }
  DESK.want = want; if (want) prefs.lastPlan = want;
  deskHooks();
  return { db, user: { id: async () => SB.uid || null, canEdit: async () => true, can: async () => true } };
}
function deskRemember(path) {
  if (!path || deskSame(path.slice(0, path.lastIndexOf('\\')), DESK.cfg.plansDir)) return;
  DESK.cfg.recent = [path, ...DESK.cfg.recent.filter(p => !deskSame(p, path))].slice(0, 20); deskSaveCfg();
}
/* before a plan opens in this window, it's claimed, so it's never open in two windows at once */
async function deskClaim(pid) {
  const other = await DESK.inv('claim_plan', { pid }).catch(() => null);
  if (other) { toast('That plan is open in another window.'); return false; }
  return true;
}
function deskHooks() {
  // closing the window: everything is saved first
  try { window.__TAURI__.webviewWindow.getCurrentWebviewWindow().listen('desk-close', async () => { try { await flushNow(); await DESK.db.flush(); } catch {} DESK.inv('close_now'); }); } catch {}
  // the window's title is the plan's name
  setInterval(() => { const t = plan ? `${plan.name} — Chunkwise` : 'Chunkwise'; if (t !== DESK.title) { DESK.title = t; DESK.inv('set_title', { title: t }).catch(() => {}); } deskSyncSwitch(); }, 1000);
  setTimeout(deskCheckUpdate, 6000);
  // asked to sync a plan before signing in: once signed in, it's switched on
  const after = sessionStorage.getItem('desk.syncAfter');
  if (after && DESK.sb) { sessionStorage.removeItem('desk.syncAfter'); const go = () => { if (plan && plan.id === after) deskToggleSync(true); else setTimeout(go, 500); }; setTimeout(go, 1500); }
}
/* ---------- the sync switch, by the plan's name ---------- */
function deskSyncSwitch() {
  const host = document.querySelector('#planBtn'); if (!host || !plan) return;
  let sw = document.getElementById('deskSync');
  const e = DESK.db && DESK.db.P.get(plan.id), on = !!(e && e.sync);
  if (!sw) {
    sw = el('label', { class: 'desksync', id: 'deskSync' }, el('input', { type: 'checkbox', role: 'switch' }), el('span', { class: 'dsk' }), el('b'));
    sw.querySelector('input').addEventListener('change', ev => { ev.preventDefault(); deskToggleSync(ev.target.checked); });
    host.after(sw);
  }
  const inp = sw.querySelector('input'); if (inp.checked !== on) inp.checked = on;
  sw.querySelector('b').textContent = on ? 'Synced' : 'Local';
  sw.title = on ? `This plan is copied to your account${SB.email ? ' (' + SB.email + ')' : ''} and kept in step with your other devices. Turn off to keep it on this PC only.` : 'This plan is only on this PC. Turn on to copy it to your account and sync it with your other devices.';
}
async function deskToggleSync(on) {
  const pid = plan && plan.id, e = pid && DESK.db.P.get(pid); if (!e) return;
  if (on) {
    if (!DESK.sb) { sessionStorage.setItem('desk.syncAfter', pid); deskSyncSwitch(); openAccount(); toast('Sign in to sync this plan.'); return; }
    await flushNow(); await DESK.db.flush();
    e.sync = true; await DESK.db.save(pid);
    try { await DESK.db.pushAll(pid); DESK.db.watch(pid); toast(`“${plan.name}” is synced with your account.`); } catch { toast('Couldn’t reach your account just now. The plan syncs when you’re back online.'); }
    deskSyncSwitch(); return;
  }
  deskSyncSwitch();
  openModal('Stop syncing this plan?', [el('div', { class: 'sbbox' },
    el('p', { text: `“${plan.name}” will be kept on this PC only. What should happen to the copy in your account?` }),
    el('div', { class: 'exact' },
      el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      el('button', { class: 'btn', onclick: async () => { closeModal(); e.sync = false; await DESK.db.save(pid); deskSyncSwitch(); toast('Local only. The copy in your account stays, but stops updating.'); } }, 'Keep the online copy'),
      el('button', { class: 'btn primary', onclick: async () => { closeModal(); e.sync = false; await DESK.db.save(pid); deskSyncSwitch();
        try { await DESK.db.load(pid); for (const lid of (e.levels || new Map()).keys()) await DESK.sb.doc(`plans/${pid}/levels/${lid}`).delete(); await DESK.sb.doc('plans/' + pid).delete(); toast('Local only, and removed from your account.'); } catch { toast('Couldn’t reach your account to remove the copy.'); } } }, 'Delete the online copy')))]);
}
/* ---------- plan menu: windows and files ---------- */
async function deskOpenFile() {
  const path = await window.__TAURI__.dialog.open({ multiple: false, directory: false, filters: [{ name: 'Chunkwise plan', extensions: ['chunkwise'] }], defaultPath: DESK.cfg.plansDir });
  if (!path) return;
  try { const pid = await DESK.db.addFile(String(path)); deskRemember(String(path)); if (await deskClaim(pid)) switchPlan(pid); } catch { toast('That file isn’t a Chunkwise plan, or it can’t be read.'); }
}
async function deskSaveCopy() {
  if (!plan) return; await flushNow(); await DESK.db.flush();
  const e = DESK.db.P.get(plan.id); if (!e) return;
  const path = await window.__TAURI__.dialog.save({ defaultPath: deskJoin(DESK.cfg.plansDir, `${plan.name} copy.chunkwise`), filters: [{ name: 'Chunkwise plan', extensions: ['chunkwise'] }] });
  if (!path) return;
  await DESK.inv('write_text', { path: String(path), text: JSON.stringify({ format: 'chunkwise-plan', v: 1, id: uid('p'), sync: false, meta: { ...e.meta, name: e.meta.name + ' copy' }, levels: Object.fromEntries(e.levels || []) }) });
  toast(`Saved a copy as ${deskBase(path)}.`);
}
function deskMenuItems() {
  const mi = (ic, text, fn) => el('button', { class: 'mi', onclick: () => { closePopover(); fn(); } }, icon(ic), text);
  const e = plan && DESK.db && DESK.db.P.get(plan.id);
  return [el('div', { class: 'msep' }), el('div', { class: 'mlabel', text: 'Desktop' }),
    mi('plus', 'New window', () => DESK.inv('new_window', { start: { fresh: false } })),
    mi('upload', 'Open a plan file…', deskOpenFile),
    plan && mi('download', 'Save a copy as…', deskSaveCopy),
    e && e.path && mi('search', 'Show the file in Explorer', () => DESK.inv('reveal', { path: e.path }))].filter(Boolean);
}
/* ---------- saving files: a Save dialog, or straight into a remembered folder ---------- */
const DESK_KINDS = { worldedit: ['WorldEdit schematics', 'schem'], png: ['Floor pictures', 'png'], json: ['Plan backups', 'json'] };
async function deskSaveAs(filename, data) {
  const ext = filename.split('.').pop(), path = await window.__TAURI__.dialog.save({ defaultPath: deskJoin(DESK.cfg.lastSaveDir || DESK.dirs.documents, filename), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (!path) return null;
  const blob = data instanceof Blob ? data : new Blob([data]);
  await DESK.inv('write_bytes', { path: String(path), b64: await deskB64(blob), replace: true });
  DESK.cfg.lastSaveDir = String(path).slice(0, String(path).lastIndexOf('\\')); deskSaveCfg();
  return String(path);
}
async function deskSaveTo(kind, filename, data) {
  const dir = DESK.cfg.exportDirs[kind]; if (!dir) { toast('Pick a folder first.'); return null; }
  const path = deskJoin(dir, filename);
  await DESK.inv('write_bytes', { path, b64: await deskB64(data instanceof Blob ? data : new Blob([data])), replace: true });
  return path;
}
/* the Minecraft folders on this PC, for the WorldEdit folder list */
let DESK_INST = null;
const deskInstances = () => DESK_INST || (DESK_INST = DESK.inv('find_instances').catch(() => []));
function deskFolderRow(kind, rr) {
  const cur = DESK.cfg.exportDirs[kind] || '', sel = el('select', { class: 'pick', 'aria-label': `${DESK_KINDS[kind][0]} folder` });
  const fill = async () => {
    const opts = [];
    if (kind === 'worldedit') for (const i of await deskInstances()) opts.push([deskJoin(i.path, 'config', 'worldedit', 'schematics'), `${i.name} · ${i.launcher}`]);
    if (cur && !opts.some(o => deskSame(o[0], cur))) opts.unshift([cur, cur]);
    sel.replaceChildren(el('option', { value: '', text: cur ? '' : 'Choose a folder…', disabled: true, selected: !cur ? true : null, hidden: cur ? true : null }),
      ...opts.map(([v, n]) => el('option', { value: v, text: n, selected: deskSame(v, cur) ? true : null })), el('option', { value: '#browse', text: 'Browse…' }));
  };
  sel.addEventListener('change', async () => {
    let v = sel.value;
    if (v === '#browse') { v = await window.__TAURI__.dialog.open({ directory: true, defaultPath: cur || DESK.dirs.documents }); if (!v) { fill(); return; } }
    DESK.cfg.exportDirs[kind] = String(v); deskSaveCfg(); rr();
  });
  fill();
  return el('div', { class: 'exrow' }, el('span', { class: 'qhead', text: 'Folder' }), el('div', { class: 'deskfolder' }, sel,
    cur ? el('button', { class: 'ib sm', title: 'Show the folder in Explorer', 'aria-label': 'Show the folder', onclick: () => DESK.inv('reveal', { path: cur }) }, icon('search')) : null),
    cur ? el('p', { class: 'exnote deskpath', text: cur }) : null);
}
/* WorldEdit: the .schem itself into the schematics folder, replacing the last one, and the load command copied */
async function deskSaveWE(scope, name, dig, btn) {
  const ex = collectExport(scope, dig); if (!ex.bb) return;
  const label = [...btn.childNodes]; btn.disabled = true; btn.replaceChildren('Saving…');
  try {
    const file = await gzipBytes(spongeNbt(ex)), path = await deskSaveTo('worldedit', name + '.schem', new Blob([file]));
    if (!path) return;
    const cmd = `//schem load ${name}`; const ok = await copyText(cmd);
    toast(`Saved ${name}.schem to the schematics folder.${ok ? ` ${cmd} is copied.` : ''}`);
  } catch (e) { toast(e && e.message === 'size' ? 'The build is too large for one WorldEdit file. Try exporting one floor at a time.' : 'The schematic couldn’t be saved there. Check the folder.'); }
  finally { btn.disabled = false; btn.replaceChildren(...label); }
}
/* Settings › Files */
function deskFilesRows() {
  const rr = () => renderSettings();
  const dirRow = (key, title, desc) => setRow(title, desc, el('div', { class: 'deskfolder' }, el('code', { class: 'deskpath', text: DESK.cfg[key] }),
    el('button', { class: 'btn sm', onclick: async () => { const v = await window.__TAURI__.dialog.open({ directory: true, defaultPath: DESK.cfg[key] }); if (v) deskMoveDir(key, String(v)); } }, 'Change…'),
    el('button', { class: 'ib sm', title: 'Show in Explorer', 'aria-label': 'Show in Explorer', onclick: () => DESK.inv('reveal', { path: DESK.cfg[key] }) }, icon('search'))));
  return [
    dirRow('plansDir', 'Plans folder', 'Each plan is a .chunkwise file here. Double-click one in Explorer to open it.'),
    dirRow('packsDir', 'Texture packs folder', 'Packs you add are copied here, with the textures Chunkwise made from them.'),
    setRow('Version', 'Updates come from GitHub. Chunkwise checks when it starts.', el('div', { class: 'deskfolder' }, el('code', { text: DESK.dirs.version }), el('button', { class: 'btn sm', onclick: () => deskCheckUpdate(true) }, 'Check for updates'))),
  ];
}
async function deskMoveDir(key, to) {
  const from = DESK.cfg[key]; if (deskSame(from, to)) return;
  const what = key === 'plansDir' ? 'plans' : 'packs', ext = key === 'plansDir' ? '.chunkwise' : '';
  const files = await DESK.inv('list_dir', { dir: from, ext }).catch(() => []);
  const apply = async move => {
    closeModal(); await flushNow(); await DESK.db.flush();
    if (move) for (const f of files) { const dest = deskJoin(to, f.name); try { await DESK.inv('rename', { from: f.path, to: dest }); } catch {} }
    DESK.cfg[key] = to; deskSaveCfg();
    if (move && key === 'plansDir') for (const e of DESK.db.P.values()) if (e.path && deskSame(e.path.slice(0, e.path.lastIndexOf('\\')), from)) e.path = deskJoin(to, deskBase(e.path));
    renderSettings(); toast(move ? `Moved ${files.length} ${what} to the new folder.` : `New ${what} go in the new folder.`);
    if (!move && key === 'plansDir') location.reload();
  };
  if (!files.length) { apply(false); return; }
  openModal(`Move your ${what}?`, [el('div', { class: 'sbbox' }, el('p', { text: `There ${files.length === 1 ? 'is 1 file' : `are ${files.length} files`} in the old folder. Move ${files.length === 1 ? 'it' : 'them'} to ${to}?` }),
    el('div', { class: 'exact' }, el('button', { class: 'btn', onclick: closeModal }, 'Cancel'), el('button', { class: 'btn', onclick: () => apply(false) }, 'Leave them'), el('button', { class: 'btn primary', onclick: () => apply(true) }, 'Move them')))]);
}
/* ---------- updates, from GitHub Releases ---------- */
async function deskCheckUpdate(asked) {
  const U = window.__TAURI__ && window.__TAURI__.updater; if (!U) { if (asked) toast('Updates aren’t available in this build.'); return; }
  let up; try { up = await U.check(); } catch (e) { if (asked) toast('Couldn’t check for updates just now.'); return; }
  if (!up) { if (asked) toast(`Chunkwise ${DESK.dirs.version} is the newest version.`); return; }
  openModal(`Chunkwise ${up.version} is ready`, [el('div', { class: 'sbbox' }, up.body ? el('p', { text: up.body }) : null,
    el('p', { text: 'It downloads, installs and restarts. Your plans are saved first.' }),
    el('div', { class: 'exact' }, el('button', { class: 'btn', onclick: closeModal }, 'Later'), el('button', { class: 'btn primary', onclick: async ev => {
      const b = ev.currentTarget; b.disabled = true; b.textContent = 'Downloading…';
      try { await flushNow(); await DESK.db.flush(); let got = 0, total = 0;
        await up.downloadAndInstall(e => { if (e.event === 'Started') total = e.data.contentLength || 0; else if (e.event === 'Progress') { got += e.data.chunkLength || 0; if (total) b.textContent = `Downloading… ${Math.round(100 * got / total)}%`; } });
        await window.__TAURI__.process.relaunch();
      } catch { b.disabled = false; b.textContent = 'Update and restart'; toast('The update couldn’t be installed. Try again later.'); }
    } }, 'Update and restart')))]);
}
