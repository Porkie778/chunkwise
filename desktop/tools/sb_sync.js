/* ================= accounts and sync (GitHub Pages build) =================
   Signed in, plans, settings and packs are kept in the Chunkwise Supabase project instead of this browser. The app already talks to a
   store of documents at paths (plans/<id>, plans/<id>/levels/<id>, data/users/<id>/settings…); this gives it one backed by Supabase:
   small documents are rows of the docs table, big ones (texture packs, mod pictures) files in a private bucket. Every row and file is
   locked to its owner by row-level security. Each floor is its own document, so two devices editing different floors both keep their work */
const SB = { url: 'https://cvettjrnugszffrsamcu.supabase.co', key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2ZXR0anJudWdzemZmcnNhbWN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5OTgxNzMsImV4cCI6MjEwODU3NDE3M30.F2dkMxJomT6j3vcxRe4VaMtZRlATK6v1h8_OK9opVW0',
  lib: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js', client: null, email: null, uid: null, recovering: false };
const SB_TOKEN = 'sb-cvettjrnugszffrsamcu-auth-token';
function sbLoad() {
  if (SB.client) return Promise.resolve(SB.client);
  return new Promise((res, rej) => {
    const make = () => { try { SB.client = window.supabase.createClient(SB.url, SB.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }); res(SB.client); } catch (e) { rej(e); } };
    if (window.supabase && window.supabase.createClient) { make(); return; }
    const s = document.createElement('script'); s.src = SB.lib; s.async = true; s.onload = make; s.onerror = () => rej(new Error('The sign-in service could not be reached.')); document.head.appendChild(s);
  });
}
const sbFile = p => /\/(pack-[^/]+-\d+|texatlas-\d+|customatlas-\d+)$/.test(p) || p.includes('/modtex/');
const sbParent = p => p.slice(0, p.lastIndexOf('/')), sbId = p => p.slice(p.lastIndexOf('/') + 1);
function sbErr(e) { const x = new Error((e && e.message) || 'Sync failed'); const m = String((e && (e.message || e.code)) || ''); x.code = /quota|too large|payload|413|54000/i.test(m) ? 'quota_exceeded' : 'unavailable'; return x; }
function sbDb(sb, uid) {
  const subs = new Set();
  const snapOf = (path, row, pending) => ({ id: sbId(path), exists: !!row && !row.deleted && row.data != null, data: () => (row && !row.deleted ? row.data : undefined), metadata: { hasPendingWrites: !!pending } });
  const notify = (path, row, pending) => { for (const s of subs) s(path, row, pending); };
  async function row(path) { const { data, error } = await sb.from('docs').select('path,data,deleted').eq('owner', uid).eq('path', path).maybeSingle(); if (error) throw sbErr(error); return data; }
  async function rows(coll) { const { data, error } = await sb.from('docs').select('path,data,deleted').eq('owner', uid).eq('coll', coll).eq('deleted', false); if (error) throw sbErr(error); return data || []; }
  const fkey = path => uid + '/' + path + '.json';
  const doc = path => ({
    id: sbId(path),
    async get() {
      if (sbFile(path)) { const { data, error } = await sb.storage.from('files').download(fkey(path)); if (error || !data) return snapOf(path, null); try { return snapOf(path, { data: JSON.parse(await data.text()) }); } catch { return snapOf(path, null); } }
      return snapOf(path, await row(path));
    },
    async set(data) {
      if (sbFile(path)) { const { error } = await sb.storage.from('files').upload(fkey(path), new Blob([JSON.stringify(data)], { type: 'application/json' }), { upsert: true, contentType: 'application/json' }); if (error) throw sbErr(error); return; }
      const r = { owner: uid, path, coll: sbParent(path), data, deleted: false };
      const { error } = await sb.from('docs').upsert(r); if (error) throw sbErr(error); notify(path, r, true);
    },
    async delete() {
      if (sbFile(path)) { await sb.storage.from('files').remove([fkey(path)]); return; }
      const { error } = await sb.from('docs').update({ deleted: true, data: null }).eq('owner', uid).eq('path', path); if (error) throw sbErr(error); notify(path, { path, deleted: true }, true);
    },
    onSnapshot(cb, err) {
      const s = (p, r, pending) => { if (p === path) cb(snapOf(path, r, pending)); }; subs.add(s);
      row(path).then(r => cb(snapOf(path, r))).catch(e => err && err(sbErr(e)));
      return () => subs.delete(s);
    }
  });
  const collection = path => {
    const q = {};
    const api = {
      orderBy(f, dir) { q.f = f; q.dir = dir; return api; }, limit(n) { q.n = n; return api; },
      async get() {
        let docs = (await rows(path)).map(r => snapOf(r.path, r));
        if (q.f) docs.sort((a, b) => ((Number(a.data()[q.f]) || 0) - (Number(b.data()[q.f]) || 0)) * (q.dir === 'desc' ? -1 : 1));
        if (q.n) docs = docs.slice(0, q.n); return { docs, size: docs.length, empty: !docs.length };
      },
      onSnapshot(cb, err) {
        const known = new Map();
        const emit = changes => { const docs = [...known.values()].map(r => snapOf(r.path, r)); cb({ docs, size: docs.length, empty: !docs.length, docChanges: () => changes }); };
        const s = (p, r, pending) => {
          if (sbParent(p) !== path) return;
          const had = known.get(p);
          if (!r || r.deleted) { if (!had) return; known.delete(p); emit([{ type: 'removed', doc: snapOf(p, had) }]); return; }
          known.set(p, r); emit([{ type: had ? 'modified' : 'added', doc: snapOf(p, r, pending) }]);
        };
        subs.add(s);
        rows(path).then(rs => { for (const r of rs) known.set(r.path, r); emit(rs.map(r => ({ type: 'added', doc: snapOf(r.path, r) }))); }).catch(e => err && err(sbErr(e)));
        return () => subs.delete(s);
      }
    };
    return api;
  };
  // changes made on the user's other devices; a row too big for the live feed is fetched whole
  sb.channel('docs-' + uid).on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'owner=eq.' + uid }, pl => {
    const r = pl.new; if (!r || !r.path) return;
    if ((pl.errors && pl.errors.length) || (!r.deleted && r.data == null)) { row(r.path).then(full => full && notify(r.path, full, false)).catch(() => {}); return; }
    notify(r.path, r, false);
  }).subscribe();
  return { doc, collection };
}
/* at start: signed in (or coming back from an email link), the account's store; otherwise none, and the browser keeps everything */
async function sbStart() {
  const fromLink = /access_token=|type=recovery|type=signup|error_description=/.test(location.hash) || /[?&]code=/.test(location.search);
  if (!fromLink && !localStorage.getItem(SB_TOKEN)) return null;
  const sb = await sbLoad();
  sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') { SB.recovering = true; setTimeout(openNewPassword, 1200); } });
  const { data } = await sb.auth.getSession(), s = data && data.session;
  if (fromLink) history.replaceState(null, '', location.pathname);
  if (!s || !s.user) return null;
  SB.uid = s.user.id; SB.email = s.user.email || '';
  const db = sbDb(sb, SB.uid);
  try { await sbMoveLocal(db, SB.uid); } catch {}
  return { db, user: { id: async () => SB.uid, canEdit: async () => true, can: async () => true } };
}
/* the first time an account is used in this browser, the plans saved here go into it, so nothing is left behind */
async function sbMoveLocal(db, id) {
  const flag = 'chunkwise.sb.moved.' + id; if (lsGet(flag)) return;
  const all = lsGet(LS_PLANS) || { plans: {} }, ids = Object.keys(all.plans);
  const have = new Set((await db.collection('plans').get()).docs.map(d => d.id)); let n = 0;
  for (const pid of ids) {
    if (have.has(pid)) continue;
    const p = dePlan(pid, all.plans[pid]);
    for (const lid of allLids(p)) { const L = p.levels.get(lid); if (L) await db.doc(levelPath(pid, lid)).set({ ...serLevel(L), client: 'moved', at: Date.now() }); }
    await db.doc('plans/' + pid).set({ ...serMeta(p, pid), client: 'moved' }); n++;   // not this tab's own id, or it would skip them as echoes
  }
  lsSet(flag, 1);
  if (n) setTimeout(() => toast(`${n} plan${n === 1 ? '' : 's'} from this browser moved into your account.`), 1500);
}
/* ⋯ menu: sign in, or who's signed in and sign out */
function sbMenuItem(mi) {
  return SB.uid ? mi('user', `Account · ${SB.email}`, openAccount) : mi('user', 'Sign in to sync…', openAccount);
}
function openAccount() {
  if (SB.uid) {
    openModal('Your account', [el('div', { class: 'sbbox' },
      el('p', { text: `Signed in as ${SB.email}. Your plans, settings and texture packs sync to every device you sign in on.` }),
      el('div', { class: 'exact' },
        el('button', { class: 'btn', onclick: () => { closeModal(); openNewPassword(); } }, 'Change password'),
        el('button', { class: 'btn primary', onclick: async () => { try { await flushNow(); } catch {} await SB.client.auth.signOut(); location.reload(); } }, 'Sign out')),
      el('p', { class: 'ddhint', text: 'Signed out, this browser shows the plans saved in it before you signed in.' }))]);
    return;
  }
  let mode = 'in';
  const box = el('div', { class: 'sbbox' }), email = el('input', { class: 'field', type: 'email', autocomplete: 'email', placeholder: 'Email', 'aria-label': 'Email' });
  const pw = el('input', { class: 'field', type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'aria-label': 'Password' });
  const msg = el('p', { class: 'sbmsg', role: 'status' });
  const say = (t, bad) => { msg.textContent = t; msg.classList.toggle('bad', !!bad); };
  const go = async () => {
    const e = email.value.trim(), p = pw.value;
    if (!/^\S+@\S+\.\S+$/.test(e)) { say('Type the email address for your account.', true); return; }
    if (mode !== 'reset' && p.length < 8) { say('Passwords need at least 8 characters.', true); return; }
    say('One moment…');
    try {
      const sb = await sbLoad(), back = location.origin + location.pathname;
      if (mode === 'in') { const { error } = await sb.auth.signInWithPassword({ email: e, password: p }); if (error) throw error; location.reload(); return; }
      if (mode === 'up') { const { data, error } = await sb.auth.signUp({ email: e, password: p, options: { emailRedirectTo: back } }); if (error) throw error; if (data && data.session) { location.reload(); return; } say('Check your email and click the link to confirm your account. It brings you back here, signed in.'); return; }
      const { error } = await sb.auth.resetPasswordForEmail(e, { redirectTo: back }); if (error) throw error; say('If that email has an account, a link to set a new password is on its way.');
    } catch (err) { say(/invalid login/i.test(String(err && err.message)) ? 'That email and password don’t match an account.' : (err && err.message) || 'Something went wrong. Try again.', true); }
  };
  const render = () => {
    pw.hidden = mode === 'reset'; pw.autocomplete = mode === 'up' ? 'new-password' : 'current-password';
    box.replaceChildren(
      el('p', { text: 'Sign in to keep your plans, settings and texture packs in sync across your devices. Plans already in this browser move into your account the first time.' }),
      email, pw, msg,
      el('div', { class: 'exact' }, el('button', { class: 'btn primary', onclick: go }, mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Send reset link')),
      el('div', { class: 'sblinks' },
        mode !== 'in' ? el('button', { class: 'btn ghost sm', onclick: () => { mode = 'in'; say(''); render(); } }, 'I have an account') : el('button', { class: 'btn ghost sm', onclick: () => { mode = 'up'; say(''); render(); } }, 'Create an account'),
        mode !== 'reset' ? el('button', { class: 'btn ghost sm', onclick: () => { mode = 'reset'; say(''); render(); } }, 'Forgot password?') : null));
  };
  for (const n of [email, pw]) n.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
  render(); openModal('Sign in', [box]); setTimeout(() => email.focus(), 50);
}
function openNewPassword() {
  const pw = el('input', { class: 'field', type: 'password', autocomplete: 'new-password', placeholder: 'New password', 'aria-label': 'New password' }), msg = el('p', { class: 'sbmsg', role: 'status' });
  const go = async () => {
    if (pw.value.length < 8) { msg.textContent = 'Passwords need at least 8 characters.'; msg.classList.add('bad'); return; }
    const { error } = await SB.client.auth.updateUser({ password: pw.value });
    if (error) { msg.textContent = error.message; msg.classList.add('bad'); return; }
    closeModal(); toast('Password changed.'); if (SB.recovering) location.reload();
  };
  pw.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
  openModal('Set a new password', [el('div', { class: 'sbbox' }, pw, msg, el('div', { class: 'exact' }, el('button', { class: 'btn primary', onclick: go }, 'Save password')))]);
  setTimeout(() => pw.focus(), 50);
}
