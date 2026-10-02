import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const $ = id => document.getElementById(id);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

/* ================= State ================= */
// state.words / state.lists mirror Firestore (users/{uid}/words, users/{uid}/lists).
// The selected list is a per-device choice and stays in localStorage.
const LIST_KEY = 'vokabelheft-currentList';
const state = { lists: [], words: [], currentList: lsGet(LIST_KEY) };

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function setCurrentList(id) { state.currentList = id; lsSet(LIST_KEY, id); }

function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function currentWords() { return state.words.filter(w => w.list === state.currentList); }

// A word counts as "Verstanden" after this many correct answers in a row
const MASTER_STREAK = 5;
function streakDots(w) {
  const n = Math.min(w.streak || 0, MASTER_STREAK);
  return `<span class="streak" title="${n} von ${MASTER_STREAK} richtig in Folge">${'●'.repeat(n)}<span class="off">${'●'.repeat(MASTER_STREAK - n)}</span></span>`;
}

/* ================= Firebase ================= */
const configured = firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('HIER');
let auth, db, user = null, unsubs = [];

function show(view) {
  for (const v of ['loadingView', 'setupView', 'authView', 'appView']) $(v).classList.toggle('hidden', v !== view);
}

if (!configured) {
  show('setupView');
} else {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // Offline cache: works without internet, syncs when back online
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  onAuthStateChanged(auth, u => {
    unsubs.forEach(f => f()); unsubs = [];
    user = u;
    state.words = []; state.lists = [];
    sync.error = null;
    if (!u) { show('authView'); return; }
    $('userEmail').textContent = u.email || '';
    show('appView');
    subscribe();
    setMode('edit');
    $('addDe').focus(); // opened from the home-screen icon (?add) → straight to "Neues Wort"
  });
}

const wordsCol = () => collection(db, 'users', user.uid, 'words');
const listsCol = () => collection(db, 'users', user.uid, 'lists');

/* ---- live sync ---- */
const sync = { words: null, lists: null, error: null };
function renderSync() {
  const el = $('syncStatus');
  const pending = sync.words?.hasPendingWrites || sync.lists?.hasPendingWrites;
  const cached = sync.words?.fromCache || sync.lists?.fromCache;
  let cls, txt;
  if (sync.error) { cls = 'error'; txt = '⚠️ ' + sync.error; }
  else if (!navigator.onLine) { cls = 'offline'; txt = '📴 Offline – wird später synchronisiert'; }
  else if (pending) { cls = 'pending'; txt = '⏳ Wird gespeichert…'; }
  else if (cached) { cls = 'pending'; txt = '⏳ Verbinde…'; }
  else { cls = 'ok'; txt = '☁️ Gespeichert'; }
  el.className = 'sync ' + cls;
  el.textContent = txt;
}
addEventListener('online', renderSync);
addEventListener('offline', renderSync);

let listsLoaded = false;
function subscribe() {
  listsLoaded = false;
  const opts = { includeMetadataChanges: true };
  unsubs.push(onSnapshot(listsCol(), opts, snap => {
    sync.lists = snap.metadata; renderSync();
    if (!snap.docChanges().length && listsLoaded) return;
    state.lists = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.created || 0) - (b.created || 0));
    // First start (server confirms there are no lists): create the default list.
    // Fixed id, so two devices doing this at once still end up with one list.
    if (!state.lists.length && !snap.metadata.fromCache) {
      write(setDoc(doc(listsCol(), 'default'), { name: 'Lektion 1', created: Date.now() }));
      return;
    }
    listsLoaded = state.lists.length > 0;
    onDataChanged();
  }, onSyncError));
  unsubs.push(onSnapshot(wordsCol(), opts, snap => {
    sync.words = snap.metadata; renderSync();
    if (!snap.docChanges().length && state.words.length) return;
    state.words = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.created || 0) - (b.created || 0));
    onDataChanged();
  }, onSyncError));
}
function onSyncError(err) {
  console.error(err);
  sync.error = err.code === 'permission-denied' ? 'Kein Zugriff (Firestore-Regeln prüfen)' : 'Sync-Fehler: ' + err.code;
  renderSync();
}
// Every write goes through here: the local cache updates instantly, the server catches up
function write(promise) {
  renderSync();
  return promise.catch(err => { console.error(err); sync.error = 'Speichern fehlgeschlagen: ' + (err.code || err.message); renderSync(); });
}

function onDataChanged() {
  if (!listsLoaded) return;
  if (!state.lists.some(l => l.id === state.currentList)) setCurrentList(state.lists[0].id);
  renderLists();
  if (mode === 'edit') {
    // Don't throw away a row the user is editing right now
    if (!editingId) renderEdit();
  } else if (mode === 'overview') renderOverview();
  else if (mode === 'practice') {
    // Keep the running round; only start one if there was nothing to practise yet
    if (!practice || !practice.order.length) startPractice();
    else renderScore();
  }
}

/* ---- data operations ---- */
function dbAddWord(w) {
  return write(setDoc(doc(wordsCol(), w.id), { de: w.de, es: w.es, list: w.list, streak: w.streak || 0, mastered: !!w.mastered, created: w.created }));
}
const dbUpdateWord = (id, patch) => write(updateDoc(doc(wordsCol(), id), patch));
const dbDeleteWord = id => write(deleteDoc(doc(wordsCol(), id)));
async function dbBatch(ops) { // ops: [(batch) => void]; Firestore allows 500 per batch
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(op => op(b));
    await write(b.commit());
  }
}

/* ================= Login ================= */
const AUTH_ERRORS = {
  'auth/invalid-credential': 'E-Mail oder Passwort ist falsch.',
  'auth/wrong-password': 'E-Mail oder Passwort ist falsch.',
  'auth/user-not-found': 'E-Mail oder Passwort ist falsch.',
  'auth/invalid-email': 'Das ist keine gültige E-Mail-Adresse.',
  'auth/email-already-in-use': 'Für diese E-Mail gibt es schon ein Konto – bitte anmelden.',
  'auth/weak-password': 'Das Passwort muss mindestens 6 Zeichen haben.',
  'auth/missing-password': 'Bitte ein Passwort eingeben.',
  'auth/network-request-failed': 'Keine Internetverbindung.',
  'auth/too-many-requests': 'Zu viele Versuche – bitte kurz warten.',
  'auth/operation-not-allowed': 'E-Mail-Anmeldung ist in Firebase noch nicht aktiviert.',
  'auth/unauthorized-domain': 'Diese Adresse ist in Firebase nicht als autorisierte Domain eingetragen.',
};
function authMsg(text, info) {
  const el = $('authMsg');
  el.textContent = text;
  el.classList.toggle('info', !!info);
  el.classList.toggle('hidden', !text);
}
const authFail = err => authMsg(AUTH_ERRORS[err.code] || 'Fehler: ' + (err.code || err.message));
$('authForm').onsubmit = e => {
  e.preventDefault();
  authMsg('');
  signInWithEmailAndPassword(auth, $('authEmail').value.trim(), $('authPass').value).catch(authFail);
};
$('signupBtn').onclick = () => {
  authMsg('');
  const email = $('authEmail').value.trim(), pass = $('authPass').value;
  if (!email || !pass) return authMsg('Gib E-Mail und ein Passwort (mind. 6 Zeichen) ein, dann „Neues Konto erstellen“.');
  createUserWithEmailAndPassword(auth, email, pass).catch(authFail);
};
$('resetBtn').onclick = () => {
  const email = $('authEmail').value.trim();
  if (!email) return authMsg('Gib zuerst oben deine E-Mail ein.');
  sendPasswordResetEmail(auth, email)
    .then(() => authMsg('E-Mail zum Zurücksetzen ist unterwegs – schau auch im Spam-Ordner.', true))
    .catch(authFail);
};
$('logoutBtn').onclick = () => signOut(auth);

/* ================= Spell check ================= */
const normalize = s => s.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
const stripChar = c => c.normalize('NFD').replace(/[̀-ͯ]/g, '');
const stripAccents = s => Array.from(s).map(stripChar).join('');
// Several correct answers can be entered as "a / b" or "a ; b"
const answersOf = es => es.split(/[\/;]/).map(normalize).filter(Boolean);

// Levenshtein with backtrace -> list of ops: same | sub | ins (missing in input) | del (extra in input)
function diff(input, target) {
  const a = Array.from(input), b = Array.from(target);
  const A = a.map(stripChar), B = b.map(stripChar);
  const n = a.length, m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) => { const r = new Array(m + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)) {
      ops.push({ t: A[i - 1] === B[j - 1] ? 'same' : 'sub', a: a[i - 1], b: b[j - 1] }); i--; j--;
    } else if (j > 0 && d[i][j] === d[i][j - 1] + 1) {
      ops.push({ t: 'ins', b: b[j - 1] }); j--;
    } else {
      ops.push({ t: 'del', a: a[i - 1] }); i--;
    }
  }
  return { dist: d[n][m], ops: ops.reverse() };
}

function check(input, es) {
  const inp = normalize(input);
  const answers = answersOf(es);
  if (!inp) return { kind: 'wrong', target: answers[0] || es, empty: true };
  if (answers.includes(inp)) return { kind: 'ok', target: inp };
  // Same letters, only accents differ
  for (const t of answers)
    if (stripAccents(t) === stripAccents(inp)) return { kind: 'almost', target: t, input: inp };
  // Small typo
  let best = null;
  for (const t of answers) {
    const r = diff(inp, t);
    if (!best || r.dist < best.dist) best = { ...r, target: t };
  }
  const limit = Array.from(best.target).length >= 7 ? 2 : 1;
  if (best.dist <= limit) return { kind: 'typo', target: best.target, input: inp, ops: best.ops };
  return { kind: 'wrong', target: answers.join(' / '), input: inp };
}

// Correct word with accent positions highlighted
function renderAccentFix(input, target) {
  const a = Array.from(input), b = Array.from(target);
  return b.map((c, i) => c !== a[i] ? `<mark class="fix">${esc(c)}</mark>` : esc(c)).join('');
}
// Input with wrong/extra letters marked, correct word with fixed/missing letters marked
function renderTypo(ops) {
  let mine = '', right = '';
  for (const o of ops) {
    if (o.t === 'same') {
      mine += esc(o.a);
      right += o.a === o.b ? esc(o.b) : `<mark class="fix">${esc(o.b)}</mark>`;
    } else if (o.t === 'sub') {
      mine += `<mark class="bad">${esc(o.a)}</mark>`;
      right += `<mark class="fix">${esc(o.b)}</mark>`;
    } else if (o.t === 'ins') {
      mine += `<mark class="miss">_</mark>`;
      right += `<mark class="fix">${esc(o.b)}</mark>`;
    } else {
      mine += `<mark class="bad">${esc(o.a)}</mark>`;
    }
  }
  return { mine, right };
}

/* ================= Lists ================= */
function renderLists() {
  const sel = $('listSelect');
  sel.innerHTML = state.lists.map(l => {
    const n = state.words.filter(w => w.list === l.id).length;
    return `<option value="${l.id}" ${l.id === state.currentList ? 'selected' : ''}>${esc(l.name)} (${n})</option>`;
  }).join('');
  $('deleteListBtn').disabled = state.lists.length <= 1;
}
$('listSelect').onchange = e => { setCurrentList(e.target.value); renderAll(); };
$('newListBtn').onclick = () => {
  $('newListBox').classList.toggle('hidden');
  $('newListName').focus();
};
function addList() {
  const name = $('newListName').value.trim();
  if (!name) return;
  const l = { id: uid(), name, created: Date.now() };
  state.lists.push(l);
  setCurrentList(l.id);
  write(setDoc(doc(listsCol(), l.id), { name: l.name, created: l.created }));
  $('newListName').value = '';
  $('newListBox').classList.add('hidden');
  renderAll();
}
$('newListSave').onclick = addList;
$('newListName').onkeydown = e => { if (e.key === 'Enter') addList(); };
$('renameListBtn').onclick = () => {
  const l = state.lists.find(l => l.id === state.currentList);
  const name = prompt('Neuer Name für die Liste:', l.name);
  if (name && name.trim()) {
    l.name = name.trim();
    write(updateDoc(doc(listsCol(), l.id), { name: l.name }));
    renderLists();
  }
};
$('deleteListBtn').onclick = () => {
  if (state.lists.length <= 1) return;
  const l = state.lists.find(l => l.id === state.currentList);
  const words = currentWords();
  if (!confirm(`Liste „${l.name}“ mit ${words.length} Wörtern löschen?`)) return;
  state.words = state.words.filter(w => w.list !== l.id);
  state.lists = state.lists.filter(x => x.id !== l.id);
  setCurrentList(state.lists[0].id);
  dbBatch([...words.map(w => b => b.delete(doc(wordsCol(), w.id))), b => b.delete(doc(listsCol(), l.id))]);
  renderAll();
};

/* ================= Accent bar ================= */
let lastInput = null;
document.addEventListener('focusin', e => {
  if (e.target.matches('input[type=text]')) lastInput = e.target;
});
'á é í ó ú ñ ü ¿ ¡'.split(' ').forEach(ch => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = ch;
  b.title = `${ch} einfügen`;
  const insert = () => {
    const el = lastInput;
    if (!el || !document.body.contains(el)) return;
    const s = el.selectionStart ?? el.value.length, en = el.selectionEnd ?? s;
    el.value = el.value.slice(0, s) + ch + el.value.slice(en);
    el.focus();
    el.setSelectionRange(s + ch.length, s + ch.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  b.onmousedown = e => e.preventDefault(); // keep focus in the input
  // On the iPhone a tap would close the keyboard, so insert on touchstart and cancel the tap
  b.addEventListener('touchstart', e => { e.preventDefault(); insert(); }, { passive: false });
  b.onclick = insert;
  $('accentBar').appendChild(b);
});

/* ================= Edit mode ================= */
let editingId = null;
let showMastered = true;

function renderEdit() {
  const all = currentWords();
  const learning = all.filter(w => !w.mastered);
  const mastered = all.filter(w => w.mastered);
  const box = $('editRows');
  if (!all.length) {
    box.innerHTML = '<div class="empty">Noch keine Vokabeln in dieser Liste – trag oben dein erstes Wort ein.</div>';
    return;
  }
  let html = learning.length
    ? learning.map((w, i) => editRow(w, i)).join('')
    : '<div class="empty">Alle Wörter dieser Liste sind verstanden! 🎉</div>';
  if (mastered.length) {
    html += `<div class="section-head" id="masteredHead">
      ${showMastered ? '▾' : '▸'} ✅ Verstanden (${mastered.length})
      <span class="given">${MASTER_STREAK}× in Folge richtig</span></div>`;
    if (showMastered) html += mastered.map((w, i) => editRow(w, i)).join('');
  }
  box.innerHTML = html;
  const ed = box.querySelector('.ed-de');
  if (ed) ed.focus();
}

function editRow(w, i) {
    if (w.id === editingId) return `
      <div class="row" data-id="${w.id}">
        <div class="num">${i + 1}</div>
        <div class="cell"><input type="text" class="ed-de" value="${esc(w.de)}"></div>
        <div class="cell es"><input type="text" class="ed-es" value="${esc(w.es)}" autocapitalize="off" spellcheck="false"></div>
        <div class="actions">
          <button class="small" data-act="save">✓</button>
          <button class="small ghost" data-act="cancel">✕</button>
        </div>
      </div>`;
    return `
      <div class="row ${w.mastered ? 'mastered' : ''}" data-id="${w.id}">
        <div class="num">${i + 1}</div>
        <div class="cell">${esc(w.de)}</div>
        <div class="cell es">${esc(w.es)}${w.mastered ? '' : `<br>${streakDots(w)}`}</div>
        <div class="actions">
          ${w.mastered ? '<button class="small ghost" data-act="unlearn" title="Zurück zu „Zu lernen“">↩</button>' : ''}
          <button class="small ghost" data-act="edit" title="Bearbeiten">✎</button>
          <button class="small ghost" data-act="del" title="Löschen">🗑</button>
        </div>
      </div>`;
}

$('editRows').addEventListener('click', e => {
  if (e.target.closest('#masteredHead')) { showMastered = !showMastered; renderEdit(); return; }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.row');
  const id = row.dataset.id;
  const act = btn.dataset.act;
  if (act === 'edit') editingId = id;
  else if (act === 'cancel') editingId = null;
  else if (act === 'del') { state.words = state.words.filter(w => w.id !== id); dbDeleteWord(id); }
  else if (act === 'unlearn') {
    const w = state.words.find(w => w.id === id);
    if (w) { w.mastered = false; w.streak = 0; dbUpdateWord(id, { mastered: false, streak: 0 }); }
  }
  else if (act === 'save') { if (!saveEdit(row)) return; }
  $('editMsg').classList.add('hidden');
  renderAll();
});
$('editRows').addEventListener('keydown', e => {
  if (!e.target.matches('.ed-de, .ed-es')) return;
  if (e.key === 'Enter') { if (saveEdit(e.target.closest('.row'))) { $('editMsg').classList.add('hidden'); renderAll(); } }
  if (e.key === 'Escape') { editingId = null; renderAll(); }
});
// Returns false (and keeps the row open) if the change would create a duplicate
function saveEdit(row) {
  const w = state.words.find(w => w.id === row.dataset.id);
  const de = row.querySelector('.ed-de').value.trim();
  const es = row.querySelector('.ed-es').value.trim();
  if (w && de && es) {
    const dup = findDuplicate(de, es, w.id);
    if (dup) { showDuplicate(dup); return false; }
    w.de = de; w.es = es;
    dbUpdateWord(w.id, { de, es });
  }
  editingId = null;
  return true;
}

// Duplicate = same German word, or a Spanish answer that already exists (in any list)
function findDuplicate(de, es, exceptId) {
  const nde = normalize(de), nes = answersOf(es);
  return state.words.find(w => w.id !== exceptId &&
    (normalize(w.de) === nde || answersOf(w.es).some(a => nes.includes(a))));
}
function showDuplicate(w) {
  const list = state.lists.find(l => l.id === w.list);
  const where = w.list === state.currentList ? 'in dieser Liste' : `in „${list ? list.name : '?'}“`;
  const box = $('editMsg');
  box.innerHTML = `⚠️ Gibt es schon ${esc(where)}: <b>${esc(w.de)}</b> – <b>${esc(w.es)}</b>`;
  box.classList.remove('hidden');
}

$('addDe').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('addEs').focus(); }
});
$('addDe').addEventListener('input', () => $('editMsg').classList.add('hidden'));
$('addEs').addEventListener('input', () => $('editMsg').classList.add('hidden'));
$('addForm').onsubmit = e => {
  e.preventDefault();
  const de = $('addDe').value.trim(), es = $('addEs').value.trim();
  if (!de) { $('addDe').focus(); return; }
  if (!es) { $('addEs').focus(); return; }
  const dup = findDuplicate(de, es);
  if (dup) { showDuplicate(dup); return; }
  const w = { id: uid(), de, es, list: state.currentList, streak: 0, mastered: false, created: Date.now() };
  state.words.push(w);
  dbAddWord(w);
  $('addDe').value = ''; $('addEs').value = '';
  renderAll();
  $('addDe').focus();
};

/* ================= Practice mode ================= */
// practice = { order: [wordIds], results: {id: result}, inputs: {id: text} }
let practice = null;

function practiceWords() {
  const set = $('practiceSet').value;
  return currentWords().filter(w => set === 'all' || (set === 'mastered') === !!w.mastered);
}
function startPractice(ids) {
  practice = { order: ids ?? practiceWords().map(w => w.id), results: {}, inputs: {}, counted: {}, newlyMastered: {} };
  renderPractice();
  focusNextOpen(-1);
}
function renderPractice() {
  if (!practice) startPractice();
  const byId = Object.fromEntries(state.words.map(w => [w.id, w]));
  practice.order = practice.order.filter(id => byId[id]);
  const box = $('practiceRows');
  if (!practice.order.length) {
    const set = $('practiceSet').value;
    const msg = !currentWords().length
      ? 'Diese Liste ist leer. Wechsle zu „Bearbeiten“ und trag Vokabeln ein.'
      : set === 'learn' ? 'Alle Wörter dieser Liste sind verstanden! 🎉 Wähle oben „Verstanden“ oder „Alle“, um sie zu wiederholen.'
      : 'Noch keine Wörter verstanden – beantworte ein Wort ' + MASTER_STREAK + '× in Folge richtig.';
    box.innerHTML = `<div class="empty">${msg}</div>`;
    renderScore();
    return;
  }
  box.innerHTML = practice.order.map((id, i) => {
    const w = byId[id], r = practice.results[id];
    const val = practice.inputs[id] ?? '';
    let fb = '';
    if (r) {
      if (r.kind === 'ok') fb = practice.newlyMastered[id]
        ? `<span class="label">✓ Richtig! 🎉 ${MASTER_STREAK}× in Folge – jetzt unter „Verstanden“</span>`
        : `<span class="label">✓ Richtig!</span>`;
      else if (r.kind === 'almost') fb = `<span class="label">Fast – Akzent beachten:</span> ${renderAccentFix(r.input, r.target)}`;
      else if (r.kind === 'typo') {
        const t = renderTypo(r.ops);
        fb = `<span class="label">Tippfehler:</span> <span class="given">${t.mine}</span> → ${t.right}`;
      } else fb = `<span class="label">${r.empty ? 'Keine Antwort.' : 'Leider falsch.'}</span> Richtig: <b>${esc(r.target)}</b>`;
    }
    return `
      <div class="row ${r ? 'res-' + r.kind : ''}" data-id="${id}">
        <div class="num">${i + 1}</div>
        <div class="cell">${esc(w.de)}<br>${w.mastered && !practice.newlyMastered[id] ? '<span class="streak">✅ verstanden</span>' : streakDots(w)}</div>
        <div class="cell es">
          <input type="text" class="answer" value="${esc(val)}" placeholder="…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next">
          ${fb ? `<div class="feedback">${fb}</div>` : ''}
        </div>
        <div class="actions"><button class="small ghost" data-act="check">Prüfen</button></div>
      </div>`;
  }).join('');
  renderScore();
}
function renderScore() {
  const c = { ok: 0, almost: 0, typo: 0, wrong: 0 };
  Object.values(practice?.results || {}).forEach(r => c[r.kind]++);
  const total = practice?.order.length || 0;
  const done = c.ok + c.almost + c.typo + c.wrong;
  $('score').innerHTML = `
    <b>${c.ok} / ${total} richtig</b>
    <span class="pill ok">✓ ${c.ok}</span>
    <span class="pill almost">Akzent ${c.almost}</span>
    <span class="pill typo">Tippfehler ${c.typo}</span>
    <span class="pill wrong">✗ ${c.wrong}</span>
    <span class="given">${done < total ? `noch ${total - done} offen` : (total ? '🎉 Fertig!' : '')}</span>`;
  $('mistakesBtn').disabled = !Object.values(practice?.results || {}).some(r => r.kind !== 'ok');
}
function checkRow(id) {
  const w = state.words.find(w => w.id === id);
  if (!w) return;
  const r = check(practice.inputs[id] ?? '', w.es);
  practice.results[id] = r;
  // Only the first answer per round counts toward the streak
  if (practice.counted[id]) return;
  practice.counted[id] = true;
  if (r.kind === 'ok') {
    w.streak = (w.streak || 0) + 1;
    if (w.streak >= MASTER_STREAK && !w.mastered) { w.mastered = true; practice.newlyMastered[id] = true; }
  } else {
    // Any mistake (also accent or typo) resets the streak and sends the word back to "Zu lernen"
    w.streak = 0;
    w.mastered = false;
  }
  dbUpdateWord(id, { streak: w.streak, mastered: !!w.mastered });
  renderLists();
}
function focusNextOpen(fromIndex) {
  const rows = [...$('practiceRows').querySelectorAll('.row')];
  const next = rows.slice(fromIndex + 1).find(r => !practice.results[r.dataset.id])
            || rows.find(r => !practice.results[r.dataset.id]);
  if (next) next.querySelector('.answer').focus();
}

$('practiceRows').addEventListener('input', e => {
  if (!e.target.matches('.answer')) return;
  const id = e.target.closest('.row').dataset.id;
  practice.inputs[id] = e.target.value;
});
$('practiceRows').addEventListener('keydown', e => {
  if (!e.target.matches('.answer') || e.key !== 'Enter') return;
  const row = e.target.closest('.row');
  const idx = practice.order.indexOf(row.dataset.id);
  checkRow(row.dataset.id);
  renderPractice();
  focusNextOpen(idx);
});
$('practiceRows').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act=check]');
  if (!btn) return;
  const row = btn.closest('.row');
  const idx = practice.order.indexOf(row.dataset.id);
  checkRow(row.dataset.id);
  renderPractice();
  focusNextOpen(idx);
});
$('restartBtn').onclick = () => startPractice();
$('practiceSet').onchange = () => startPractice();
$('shuffleBtn').onclick = () => {
  const ids = practiceWords().map(w => w.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  startPractice(ids);
};
$('mistakesBtn').onclick = () => {
  startPractice(practice.order.filter(id => practice.results[id] && practice.results[id].kind !== 'ok'));
};
$('checkAllBtn').onclick = () => {
  practice.order.forEach(id => { if (!practice.results[id]) checkRow(id); });
  renderPractice();
};

/* ================= Tabs ================= */
let mode = 'edit';
function setMode(m) {
  mode = m;
  $('tabEdit').classList.toggle('active', m === 'edit');
  $('tabPractice').classList.toggle('active', m === 'practice');
  $('tabOverview').classList.toggle('active', m === 'overview');
  $('editView').classList.toggle('hidden', m !== 'edit');
  $('practiceView').classList.toggle('hidden', m !== 'practice');
  $('overviewView').classList.toggle('hidden', m !== 'overview');
  if (m === 'practice') startPractice(); else renderAll();
}
$('tabEdit').onclick = () => setMode('edit');
$('tabPractice').onclick = () => setMode('practice');
$('tabOverview').onclick = () => setMode('overview');

/* ================= Overview (all lists, A–Z) ================= */
// Sort by the word itself, not by its article: "das Auto" goes under A
const ARTICLES = /^(der|die|das|den|dem|des|ein|eine|el|la|los|las|lo|un|una|unos|unas)\s+/i;
const sortKey = s => s.trim().replace(/^[¿¡"'(]+/, '').replace(ARTICLES, '');

function renderOverview() {
  const by = $('sortBy').value;            // 'de' or 'es'
  const other = by === 'de' ? 'es' : 'de';
  const q = stripAccents(normalize($('search').value));
  const listName = Object.fromEntries(state.lists.map(l => [l.id, l.name]));
  const words = state.words
    .filter(w => !q || stripAccents(normalize(w.de + ' ' + w.es)).includes(q))
    .sort((a, b) => sortKey(a[by]).localeCompare(sortKey(b[by]), by, { sensitivity: 'base' }));

  $('ovHeadA').textContent = by === 'de' ? '🇩🇪 Deutsch' : '🇪🇸 Spanisch';
  $('ovHeadB').textContent = by === 'de' ? '🇪🇸 Spanisch' : '🇩🇪 Deutsch';
  const mastered = state.words.filter(w => w.mastered).length;
  $('overviewCount').textContent =
    `${state.words.length} Wörter gesamt · ${mastered} verstanden` + (q ? ` · ${words.length} gefunden` : '');

  const box = $('overviewRows');
  if (!words.length) {
    box.innerHTML = `<div class="empty">${state.words.length ? 'Nichts gefunden.' : 'Noch keine Vokabeln gespeichert.'}</div>`;
    return;
  }
  let html = '', letter = '';
  words.forEach((w, i) => {
    const L = stripAccents(sortKey(w[by]).charAt(0)).toUpperCase() || '#';
    if (L !== letter) { letter = L; html += `<div class="letter">${esc(L)}</div>`; }
    html += `
      <div class="row ${w.mastered ? 'mastered' : ''}">
        <div class="num">${i + 1}</div>
        <div class="cell">${esc(w[by])}</div>
        <div class="cell es">${esc(w[other])}</div>
        <div class="meta">${esc(listName[w.list] || '')}<br>${w.mastered ? '✅ verstanden' : streakDots(w)}</div>
      </div>`;
  });
  box.innerHTML = html;
}
$('sortBy').onchange = renderOverview;
$('search').oninput = renderOverview;

/* ================= Export / Import ================= */
$('exportBtn').onclick = async () => {
  const data = { lists: state.lists, words: state.words };
  const name = `vokabelheft-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' });
  // iPhone: share sheet (save to Files, AirDrop, …); elsewhere a normal download
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Vokabelheft' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
    if (!Array.isArray(data.lists) || !Array.isArray(data.words)) throw new Error('Format');
  } catch (err) {
    alert('Die Datei konnte nicht gelesen werden.');
    return;
  }
  // Merge: lists matched by name, duplicates skipped (same rule as when typing a word)
  const ops = [];
  let added = 0, t = Date.now();
  for (const l of data.lists) {
    let mine = state.lists.find(x => x.name === l.name);
    if (!mine) {
      mine = { id: uid(), name: String(l.name), created: t++ };
      state.lists.push(mine);
      const ref = doc(listsCol(), mine.id), val = { name: mine.name, created: mine.created };
      ops.push(b => b.set(ref, val));
    }
    for (const w of data.words.filter(w => w.list === l.id)) {
      if (!w.de || !w.es) continue;
      if (findDuplicate(String(w.de), String(w.es))) continue;
      const nw = { id: uid(), de: String(w.de), es: String(w.es), list: mine.id, streak: Number(w.streak) || 0, mastered: !!w.mastered, created: t++ };
      state.words.push(nw);
      const ref = doc(wordsCol(), nw.id), val = { de: nw.de, es: nw.es, list: nw.list, streak: nw.streak, mastered: nw.mastered, created: nw.created };
      ops.push(b => b.set(ref, val));
      added++;
    }
  }
  renderAll();
  await dbBatch(ops);
  const skipped = data.words.length - added;
  alert(`${added} Vokabeln importiert.` + (skipped > 0 ? ` ${skipped} übersprungen (schon vorhanden).` : ''));
};

/* ================= Render ================= */
function renderAll() {
  if (!state.lists.length) return; // still loading
  if (!state.lists.some(l => l.id === state.currentList)) setCurrentList(state.lists[0].id);
  renderLists();
  if (mode === 'edit') renderEdit();
  else if (mode === 'overview') renderOverview();
  else startPractice();
}
