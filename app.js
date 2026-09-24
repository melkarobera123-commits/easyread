pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const $ = s => document.querySelector(s);
const fileInput = $('#file'), drop = $('#drop'), statusEl = $('#status'), progress = $('#progress');
const reader = $('#reader'), readerWrap = $('#reader-wrap'), popup = $('#popup');
const API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const cache = new Map();
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ } }
};
let openToken = 0, lookupToken = 0, revealed = false, totalPages = 0, headingCount = 0;
let currentFileKey = '', currentRange = null, searchMatches = [], searchIndex = -1, readingStarted = 0;
let autoScrollTimer = null;
let cloudSyncTimer = null;
let auth = null, cloud = null, currentUser = null;
const seenHeadings = new Set();
const contents = $('#contents'), outlineList = $('#outline'), outlineEmpty = $('#outline-empty');
const pageNow = $('#page-now'), docMeta = $('#doc-meta');
const vocabKey = 'er-vocabulary', statsKey = 'er-stats';
const libraryDB = new Promise((resolve, reject) => {
  const request = indexedDB.open('easyread-library', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('books', { keyPath: 'key' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const pageObserver = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) pageNow.textContent = `Page ${e.target.dataset.page} of ${totalPages}`;
}, { rootMargin: '-40% 0px -55% 0px' });

const saveScroll = () => {
  if (!currentFileKey || readerWrap.hidden) return;
  const stats = store.get(statsKey, {});
  stats[currentFileKey] = { ...(stats[currentFileKey] || {}), scroll: scrollY, seconds: (stats[currentFileKey]?.seconds || 0) + Math.max(0, Math.round((Date.now() - readingStarted) / 1000)) };
  store.set(statsKey, stats); readingStarted = Date.now(); queueCloudSync();
};
addEventListener('scroll', () => { if (!readerWrap.hidden) saveScroll(); }, { passive: true });
addEventListener('beforeunload', saveScroll);

$('#search-btn').addEventListener('click', () => {
  const tools = $('#reader-tools'); tools.hidden = !tools.hidden;
  if (!tools.hidden) $('#search-input').focus();
});
$('#search-input').addEventListener('input', searchInBook);
$('#search-prev').addEventListener('click', () => moveSearch(-1));
$('#search-next').addEventListener('click', () => moveSearch(1));
$('#highlight-btn').addEventListener('click', () => {
  const selection = getSelection();
  if (!selection?.rangeCount || !selection.toString().trim()) return;
  const range = selection.getRangeAt(0).cloneRange();
  const highlights = store.get('er-highlights', []);
  highlights.push({ file: currentFileKey, text: selection.toString().trim() });
  store.set('er-highlights', highlights.slice(-500));
  if (CSS.highlights) { const existing = CSS.highlights.get('saved') || new Highlight(); existing.add(range); CSS.highlights.set('saved', existing); }
  selection.removeAllRanges();
});
$('#vocab-btn').addEventListener('click', () => togglePanel('vocab'));
$('#stats-btn').addEventListener('click', () => togglePanel('stats'));
$('#library-btn').addEventListener('click', () => togglePanel('library'));
$('#library-home-btn').addEventListener('click', () => togglePanel('library'));
$('#library-close').addEventListener('click', () => togglePanel('library', false));
$('#bookmark-btn').addEventListener('click', saveBookmark);
$('#export-btn').addEventListener('click', exportReadingData);
$('#flashcards-btn').addEventListener('click', showFlashcards);
$('#learning-close').addEventListener('click', () => togglePanel('learning', false));
$('#autoscroll-btn').addEventListener('click', () => { if (autoScrollTimer) { clearInterval(autoScrollTimer); autoScrollTimer = null; $('#autoscroll-btn').textContent = 'Auto-scroll'; } else { autoScrollTimer = setInterval(() => scrollBy({ top: 1, behavior: 'auto' }), 35); $('#autoscroll-btn').textContent = 'Stop scroll'; } });
$('#line-focus-btn').addEventListener('click', () => { document.body.classList.toggle('line-focus'); $('#line-focus-btn').textContent = document.body.classList.contains('line-focus') ? 'Full page' : 'Line focus'; });
$('#account-btn').addEventListener('click', () => togglePanel('account'));
$('#account-close').addEventListener('click', () => togglePanel('account', false));
$('#google-signin').addEventListener('click', signInWithGoogle);
$('#sync-now').addEventListener('click', syncCloud);
$('#signout').addEventListener('click', () => auth?.signOut());

if (window.firebase && window.EASYREAD_FIREBASE_CONFIG?.apiKey) {
  firebase.initializeApp(window.EASYREAD_FIREBASE_CONFIG);
  auth = firebase.auth(); cloud = firebase.firestore();
  auth.useDeviceLanguage();
  auth.onAuthStateChanged(user => { currentUser = user; updateAccount(user); if (user) syncCloud(); });
} else {
  $('#auth-status').textContent = 'Add your Firebase web configuration to enable Google sign-in.';
}
$('#focus-btn').addEventListener('click', () => document.body.classList.toggle('focus-mode'));
$('#fullscreen-btn').addEventListener('click', () => readerWrap.requestFullscreen?.());
$('#settings-btn').addEventListener('click', () => togglePanel('settings'));
$('#settings-close').addEventListener('click', () => togglePanel('settings', false));
$('#vocab-close').addEventListener('click', () => togglePanel('vocab', false));
$('#stats-close').addEventListener('click', () => togglePanel('stats', false));
$('#font-choice').addEventListener('change', e => { rootStyle('--reader-font', e.target.value === 'dyslexic' ? 'OpenDyslexic, Arial, sans-serif' : e.target.value === 'serif' ? 'Georgia, serif' : "'Literata', Georgia, serif"); });
$('#spacing').addEventListener('input', e => rootStyle('--reader-leading', e.target.value));
$('#width').addEventListener('input', e => rootStyle('--reader-width', e.target.value + 'px'));
$('#contrast').addEventListener('change', e => document.body.classList.toggle('high-contrast', e.target.checked));
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
renderLibrary();

function rootStyle(name, value) { document.documentElement.style.setProperty(name, value); }
function togglePanel(id, open = true) { const panel = $('#' + id); panel.hidden = open === false ? true : !panel.hidden; if (id === 'vocab' && !panel.hidden) renderVocabulary(); if (id === 'stats' && !panel.hidden) renderStats(); if (id === 'library' && !panel.hidden) renderLibrary(); }

function updateAccount(user) {
  $('#account-signed-out').hidden = !!user; $('#account-signed-in').hidden = !user;
  $('#account-label').textContent = user ? (user.displayName?.split(' ')[0] || 'Account') : 'Sign in';
  $('#account-avatar').hidden = !user; $('#account-photo').hidden = !user;
  if (user?.photoURL) { $('#account-avatar').src = user.photoURL; $('#account-photo').src = user.photoURL; }
  if (user) $('#account-name').textContent = user.email ? `${user.displayName || 'Signed in'} · ${user.email}` : user.displayName || 'Signed in with Google';
}
async function signInWithGoogle() {
  if (!auth) return ($('#auth-status').textContent = 'Firebase is not configured yet.');
  try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  catch (error) { $('#auth-status').textContent = error.code === 'auth/popup-blocked' ? 'Allow popups for this site, then try again.' : error.message; }
}
async function syncCloud() {
  if (!currentUser || !cloud) return;
  $('#sync-status').textContent = 'Syncing…';
  try {
    const ref = cloud.collection('users').doc(currentUser.uid), snapshot = await ref.get(), local = { vocabulary: store.get(vocabKey, []), notes: store.get('er-notes', []), highlights: store.get('er-highlights', []), bookmarks: store.get('er-bookmarks', []), stats: store.get(statsKey, {}) };
    const remote = snapshot.exists ? snapshot.data() : {}, merged = { vocabulary: mergeItems(remote.vocabulary, local.vocabulary, 'word'), notes: mergeItems(remote.notes, local.notes, 'text'), highlights: mergeItems(remote.highlights, local.highlights, 'text'), bookmarks: mergeItems(remote.bookmarks, local.bookmarks, 'scroll'), stats: { ...(remote.stats || {}), ...local.stats } };
    await ref.set(merged, { merge: true });
    store.set(vocabKey, merged.vocabulary); store.set('er-notes', merged.notes); store.set('er-highlights', merged.highlights); store.set('er-bookmarks', merged.bookmarks); store.set(statsKey, merged.stats);
    $('#sync-status').textContent = 'Synced just now.';
  } catch (error) { $('#sync-status').textContent = 'Sync failed: ' + error.message; }
}
function queueCloudSync() { if (!currentUser) return; clearTimeout(cloudSyncTimer); cloudSyncTimer = setTimeout(() => syncCloud(), 500); }
function mergeItems(remote = [], local = [], key) { const items = [...remote, ...local], seen = new Set(); return items.filter(item => { const id = item[key] || JSON.stringify(item); if (seen.has(id)) return false; seen.add(id); return true; }).slice(-500); }

async function libraryRequest(mode, action) {
  try { const db = await libraryDB; return await new Promise((resolve, reject) => { const tx = db.transaction('books', mode), request = action(tx.objectStore('books')); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); } catch { return null; }
}
async function saveBook(file) {
  await libraryRequest('readwrite', books => books.put({ key: currentFileKey, name: file.name, size: file.size, modified: file.lastModified, added: Date.now(), file }));
  renderLibrary();
}
async function getBooks() { return (await libraryRequest('readonly', books => books.getAll())) || []; }
async function renderLibrary() {
  const books = (await getBooks()).sort((a, b) => b.added - a.added), targets = [$('#library-list'), $('#library-preview')];
  targets.forEach(target => { if (target) target.replaceChildren(); });
  if (!books.length) { $('#library-list').append(el('p', 'note', 'Choose a book to start your shelf.')); $('#library-preview').append(el('p', 'note', 'Your imported books will appear here.')); return; }
  books.forEach(book => {
    const row = el('div', 'library-row'), title = el('div'), open = el('button', 'btn', 'Open'), remove = el('button', 'btn', 'Remove');
    title.append(el('strong', '', book.name.replace(/\.[^.]+$/, '')), el('small', '', new Date(book.added).toLocaleDateString()));
    open.onclick = () => { openFile(new File([book.file], book.name, { type: book.file.type, lastModified: book.modified })); togglePanel('library', false); };
    remove.onclick = async () => { await libraryRequest('readwrite', booksStore => booksStore.delete(book.key)); renderLibrary(); };
    row.append(title, open, remove); $('#library-list').append(row);
    const card = el('button', 'book-card'); card.type = 'button'; card.append(el('strong', '', book.name.replace(/\.[^.]+$/, '')), el('small', '', new Date(book.added).toLocaleDateString()), el('span', '', 'Continue reading →')); card.onclick = open.onclick; $('#library-preview').append(card);
  });
}

/* ---------- Opening files ---------- */
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (f) openFile(f);
  fileInput.value = '';
});
['dragover', 'dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault();
  drop.classList.toggle('over', ev === 'dragover');
  if (ev === 'drop' && e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
}));
$('#again').addEventListener('click', () => {
  readerWrap.hidden = true; hidePopup(); toggleContents(false); window.scrollTo({ top: 0 });
});

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'err' : '';
}

function reveal(name) {
  if (revealed) return;
  revealed = true;
  $('#file-name').textContent = name.replace(/\.[^.]+$/, '');
  readerWrap.hidden = false;
  setStatus('');
  readerWrap.scrollIntoView();
  const saved = store.get(statsKey, {})[currentFileKey]?.scroll;
  if (saved) setTimeout(() => scrollTo({ top: saved, behavior: 'smooth' }), 80);
}

async function openFile(file) {
  const my = ++openToken, name = file.name.toLowerCase();
  currentFileKey = file.name + ':' + file.size + ':' + file.lastModified;
  readingStarted = Date.now();
  revealed = false; hidePopup(); reader.textContent = ''; progress.textContent = ''; resetOutline();
  try {
    setStatus('Opening ' + file.name + '…');
    if (name.endsWith('.pdf')) await readPdf(file, my);
    else if (name.endsWith('.docx')) await readDocx(file);
    else if (name.endsWith('.epub')) await readEpub(file);
    else if (/\.(png|jpe?g)$/i.test(name)) await readImage(file);
    else if (name.endsWith('.txt')) addParagraphs((await file.text()).split(/\n\s*\n/));
    else return setStatus('Use a PDF, DOCX, EPUB, TXT or image file.', true);
    if (my !== openToken) return;
    if (!reader.textContent.trim()) return setStatus('No text found. This file may be scanned images.', true);
    reveal(file.name);
    progress.textContent = '';
    showMeta();
    saveBook(file);
  } catch (e) {
    console.error(e);
    setStatus('Could not read this file. Try another one.', true);
  }
}

/* ---------- Building the reading view ---------- */
function addParagraphs(list) { addBlocks(list.map(text => ({ text })), 0); }

// blocks: [{ text, heading? }]. page 0 means the file has no pages (Word, text).
function addBlocks(blocks, page) {
  const sec = document.createElement('section');
  if (page) {
    sec.className = 'page'; sec.id = 'p' + page; sec.dataset.page = page;
    sec.append(el('div', 'page-mark', 'Page ' + page));
  }
  for (const b of blocks) {
    const text = b.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (b.heading) {
      const key = text.toLowerCase();
      if (seenHeadings.has(key)) continue;          // repeated on many pages: a running header
      seenHeadings.add(key);
      const h = el('h2', '', text);
      h.id = 'h' + (++headingCount);
      sec.append(h);
      outlineAdd(text, h.id, page);
    } else {
      sec.append(el('p', '', text));
    }
  }
  if (sec.children.length > (page ? 1 : 0)) { reader.append(sec); if (page) pageObserver.observe(sec); }
}

function outlineAdd(title, id, page) {
  if (outlineList.children.length >= 300) return;
  const li = document.createElement('li'), btn = el('button', '');
  btn.type = 'button'; btn.dataset.id = id;
  btn.append(el('span', 't', title));
  if (page) btn.append(el('span', 'pg', page));
  li.append(btn); outlineList.append(li);
  outlineEmpty.hidden = true;
}

function resetOutline() {
  outlineList.replaceChildren(); seenHeadings.clear(); headingCount = 0; totalPages = 0;
  outlineEmpty.hidden = false; pageNow.textContent = ''; docMeta.textContent = '';
  pageObserver.disconnect(); toggleContents(false);
}

function showMeta() {
  const words = [...reader.querySelectorAll('p, h2')].reduce((n, e) => n + (e.textContent.match(/\S+/g) || []).length, 0);
  docMeta.textContent = (totalPages ? totalPages + ' pages, ' : '') + words.toLocaleString() + ' words';
}

function toggleContents(open) {
  const on = open === undefined ? !contents.classList.contains('open') : open;
  contents.classList.toggle('open', on);
  $('#contents-btn').setAttribute('aria-expanded', on);
}

$('#contents-btn').addEventListener('click', () => toggleContents());
$('#contents-close').addEventListener('click', () => toggleContents(false));
outlineList.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.getElementById(btn.dataset.id).scrollIntoView({ behavior: 'smooth', block: 'start' });
  toggleContents(false);
});
$('#jump').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  let n = Math.min(parseInt(e.target.value, 10) || 1, totalPages || 1), target;
  while (n > 0 && !(target = document.getElementById('p' + n))) n--;   // nearest page that is loaded
  if (target) { target.scrollIntoView({ behavior: 'smooth' }); toggleContents(false); }
});

async function readDocx(file) {
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  addParagraphs(value.split(/\n\s*\n/));
}

async function readEpub(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const container = new DOMParser().parseFromString(await zip.file('META-INF/container.xml').async('text'), 'application/xml');
  const rootfile = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!rootfile) throw new Error('Invalid EPUB');
  const base = rootfile.includes('/') ? rootfile.slice(0, rootfile.lastIndexOf('/') + 1) : '';
  const opf = new DOMParser().parseFromString(await zip.file(rootfile).async('text'), 'application/xml');
  const items = new Map([...opf.querySelectorAll('manifest item')].map(item => [item.id, item.getAttribute('href')]));
  for (const ref of opf.querySelectorAll('spine itemref')) {
    const href = items.get(ref.getAttribute('idref'));
    const entry = href && zip.file(base + decodeURIComponent(href));
    if (!entry) continue;
    const doc = new DOMParser().parseFromString(await entry.async('text'), 'text/html');
    const text = doc.body?.textContent || '';
    if (text.trim()) addParagraphs(text.split(/\n\s*\n/));
  }
}

async function readImage(file) {
  setStatus('Reading image text…');
  const result = await Tesseract.recognize(file, 'eng', { logger: m => { if (m.status === 'recognizing text') progress.textContent = Math.round((m.progress || 0) * 100) + '%'; } });
  addParagraphs(result.data.text.split(/\n\s*\n/));
}

function searchInBook() {
  const query = $('#search-input').value.trim().toLowerCase();
  searchMatches = []; searchIndex = -1;
  if (CSS.highlights) CSS.highlights.delete('search');
  if (query) {
    const walker = document.createTreeWalker(reader, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, text = node.data.toLowerCase(); let from = 0, at;
      while ((at = text.indexOf(query, from)) >= 0) { const range = new Range(); range.setStart(node, at); range.setEnd(node, at + query.length); searchMatches.push(range); from = at + query.length; }
    }
    if (CSS.highlights) CSS.highlights.set('search', new Highlight(...searchMatches));
    if (searchMatches.length) moveSearch(1);
  }
  $('#search-count').textContent = query ? searchMatches.length + ' result' + (searchMatches.length === 1 ? '' : 's') : '';
}
function moveSearch(direction) {
  if (!searchMatches.length) return;
  searchIndex = (searchIndex + direction + searchMatches.length) % searchMatches.length;
  searchMatches[searchIndex].startContainer.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderVocabulary() {
  const list = $('#vocab-list'), words = store.get(vocabKey, []); list.replaceChildren();
  if (!words.length) return list.append(el('p', 'note', 'Saved words will appear here.'));
  words.forEach(item => { const row = el('div', 'vocab-row'); row.append(el('strong', '', item.word), el('span', '', item.definition || '')); const b = el('button', 'btn', 'Remove'); b.onclick = () => { store.set(vocabKey, words.filter(w => w.word !== item.word)); renderVocabulary(); }; row.append(b); list.append(row); });
}
function renderStats() {
  const stats = Object.values(store.get(statsKey, {})), seconds = stats.reduce((n, s) => n + (s.seconds || 0), 0);
  $('#stats-content').innerHTML = `<p><strong>${Math.round(seconds / 60)}</strong> minutes read</p><p><strong>${store.get(vocabKey, []).length}</strong> saved words</p><p>Progress is stored privately in this browser.</p>`;
}

function saveBookmark() {
  if (!currentFileKey || readerWrap.hidden) return;
  const bookmarks = store.get('er-bookmarks', []);
  bookmarks.unshift({ file: currentFileKey, name: $('#file-name').textContent, scroll: scrollY, created: Date.now() });
  store.set('er-bookmarks', bookmarks.slice(0, 100));
  $('#bookmark-btn').textContent = 'Bookmarked';
}
function exportReadingData() {
  const data = { vocabulary: store.get(vocabKey, []), notes: store.get('er-notes', []), highlights: store.get('er-highlights', []), bookmarks: store.get('er-bookmarks', []) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = 'easyread-notes.json'; link.click(); URL.revokeObjectURL(link.href);
}

function saveWord(word, definition) {
  const words = store.get(vocabKey, []);
  if (!words.some(item => item.word === word)) words.unshift({ word, definition });
  store.set(vocabKey, words.slice(0, 300));
  queueCloudSync();
}
function speakWord(word) { if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(word)); }
async function translateWord(word, target = 'es') {
  const language = $('#translation-language')?.value || target;
  const res = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(word) + '&langpair=en|' + language);
  const data = await res.json(); return data.responseData?.translatedText || 'Translation unavailable';
}

function showFlashcards() {
  togglePanel('learning'); $('#learning-title').textContent = 'Vocabulary flashcards'; const target = $('#learning-content'), words = store.get(vocabKey, []); target.replaceChildren();
  if (!words.length) return target.append(el('p', 'note', 'Save words while reading to build flashcards.'));
  words.slice(0, 20).forEach(item => { const card = el('button', 'flashcard'); card.type = 'button'; card.append(el('strong', '', item.word), el('span', '', 'Tap to reveal')); card.onclick = () => { card.replaceChildren(el('strong', '', item.word), el('span', '', item.definition || 'No definition saved')); }; target.append(card); });
}

async function readPdf(file, my) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  totalPages = pdf.numPages;
  const weight = new Map();               // font size -> amount of text, to find the body size
  let carry = '';
  for (let n = 1; n <= pdf.numPages; n++) {
    if (my !== openToken) return;
    const { items } = await (await pdf.getPage(n)).getTextContent();
    const lines = [];
    let lastY = null;
    for (const it of items) {
      if (!it.str) continue;
      const y = it.transform[5], size = Math.abs(it.transform[3]) || it.height || 0;
      if (lastY === null || Math.abs(y - lastY) > 2) lines.push({ y, t: '', size: 0 });
      const l = lines[lines.length - 1];
      l.t += it.str; l.size = Math.max(l.size, size);
      lastY = y;
    }
    lines.forEach(l => { const k = Math.round(l.size); weight.set(k, (weight.get(k) || 0) + l.t.length); });
    const top = [...weight].sort((a, b) => b[1] - a[1])[0];
    const bodySize = top ? top[0] : 0;

    const gaps = lines.slice(1).map((l, i) => lines[i].y - l.y).filter(g => g > 0).sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)] || 12;
    const blocks = [];
    let text = carry;
    const flush = () => { if (text.trim()) blocks.push({ text }); text = ''; };
    lines.forEach((l, i) => {
      const t = l.t.trim();
      if (!t) return;
      const gapBreak = i && lines[i - 1].y - l.y > med * 1.5;
      // Clearly larger, short, and not a sentence: treat as a heading.
      const heading = bodySize > 0 && l.size >= bodySize * 1.25 && t.length <= 90 && !/[.,;]$/.test(t);
      if (heading) {
        flush();
        const last = blocks[blocks.length - 1];
        if (last && last.heading && !gapBreak) last.text += ' ' + t; else blocks.push({ text: t, heading: true });
        return;
      }
      if (gapBreak) flush();
      text = /[a-z]-$/i.test(text) ? text.slice(0, -1) + t : text + ' ' + t;
    });
    if (/[.!?”"’)]\s*$/.test(text)) { flush(); carry = ''; } else carry = text;
    addBlocks(blocks, n);
    if (reader.firstChild) reveal(file.name);
    progress.textContent = n < pdf.numPages ? `Loading page ${n} of ${pdf.numPages}…` : '';
  }
  if (carry) addBlocks([{ text: carry }], pdf.numPages);
}

/* ---------- Tap a word ---------- */
document.addEventListener('click', e => {
  if (e.target.closest('#popup')) return;
  const hit = e.target.closest('.readable') && wordAt(e.clientX, e.clientY);
  hit ? showWord(hit) : hidePopup();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { hidePopup(); toggleContents(false); } });

function wordAt(x, y) {
  let node, off;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    node = p && p.offsetNode; off = p && p.offset;
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    node = r && r.startContainer; off = r && r.startOffset;
  }
  if (!node || node.nodeType !== 3) return null;
  const s = node.data, ch = /[A-Za-z’']/;
  let a = off, b = off;
  while (a > 0 && ch.test(s[a - 1])) a--;
  while (b < s.length && ch.test(s[b])) b++;
  const word = s.slice(a, b).replace(/^['’]+|['’]+$/g, '').toLowerCase();
  if (!word) return null;
  const range = document.createRange();
  range.setStart(node, a); range.setEnd(node, b);
  const onWord = [...range.getClientRects()].some(r =>
    x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2);
  return onWord ? { word, range } : null;
}

async function showWord({ word, range }) {
  const my = ++lookupToken;
  currentRange = range;
  if (window.CSS && CSS.highlights) CSS.highlights.set('picked', new Highlight(range));
  popup.hidden = false;
  popup.replaceChildren(closeBtn(), el('h2', '', word), el('p', 'note', 'Looking up…'));
  place(range);
  const result = await define(word);
  if (my !== lookupToken) return;
  render(result, word);
  place(range);
}

function hidePopup() {
  lookupToken++;
  popup.hidden = true;
  if (window.CSS && CSS.highlights) CSS.highlights.delete('picked');
}

function place(range) {
  if (matchMedia('(max-width: 640px)').matches) { popup.style.left = popup.style.top = ''; return; }
  const r = range.getBoundingClientRect(), w = popup.offsetWidth;
  popup.style.left = Math.max(12, Math.min(scrollX + r.left, scrollX + innerWidth - w - 12)) + 'px';
  popup.style.top = scrollY + r.bottom + 10 + 'px';
}

/* ---------- Dictionary ---------- */
function candidates(word) {
  const c = [word];
  const add = x => { if (x.length > 2 && !c.includes(x)) c.push(x); };
  const w = word.replace(/['’]s$/, '');
  add(w);
  if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
  if (/es$/.test(w)) add(w.slice(0, -2));
  if (/s$/.test(w)) add(w.slice(0, -1));
  if (/ly$/.test(w)) add(w.slice(0, -2));
  const stem = w.replace(/(ing|ed)$/, '');
  if (stem !== w) {
    add(stem); add(stem + 'e');
    if (/(.)\1$/.test(stem)) add(stem.slice(0, -1));
  }
  return c;
}

/* Three free dictionaries are asked at the same time; the first answer wins. */
async function get(url) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 7000);
  try { return await fetch(url, { signal: ctl.signal }); } finally { clearTimeout(t); }
}

async function fromDictionaryApi(w) {
  const res = await get('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.status);
  const e = (await res.json())[0];
  return { entry: {
    word: e.word,
    phonetic: e.phonetic || (e.phonetics.find(p => p.text) || {}).text,
    meanings: e.meanings.slice(0, 3).map(m => ({
      partOfSpeech: m.partOfSpeech, definition: m.definitions[0].definition, example: m.definitions[0].example
    }))
  } };
}

async function fromWiktionary(w) {
  const res = await get('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(w));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.status);
  const list = (await res.json()).en;
  if (!list) return null;
  const text = h => new DOMParser().parseFromString(h, 'text/html').body.textContent.trim();
  const meanings = list.slice(0, 3).map(m => {
    const d = m.definitions[0];
    return { partOfSpeech: m.partOfSpeech.toLowerCase(), definition: text(d.definition),
      example: d.examples && d.examples[0] ? text(d.examples[0]) : '' };
  }).filter(m => m.definition);
  return meanings.length ? { entry: { word: w, meanings } } : null;
}

async function fromDatamuse(w) {
  const res = await get('https://api.datamuse.com/words?md=d&max=1&sp=' + encodeURIComponent(w));
  if (!res.ok) throw new Error(res.status);
  const hit = (await res.json())[0];
  if (!hit || hit.word !== w || !hit.defs) return null;
  const names = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: 'word' };
  const meanings = hit.defs.slice(0, 3).map(d => {
    const [p, ...t] = d.split('\t');
    return { partOfSpeech: names[p] || p, definition: t.join(' ') };
  });
  return { entry: { word: w, meanings } };
}

const SOURCES = [fromDictionaryApi, fromWiktionary, fromDatamuse];

async function lookup(w) {
  let reached = false;
  const ask = src => src(w).then(
    r => { reached = true; return r || Promise.reject(); },
    () => Promise.reject()
  );
  try { return { result: await Promise.any(SOURCES.map(ask)), reached: true }; }
  catch { return { result: null, reached }; }
}

async function define(word) {
  if (cache.has(word)) return cache.get(word);
  let reached = false;
  for (const w of candidates(word).slice(0, 4)) {
    const r = await lookup(w);
    reached = reached || r.reached;
    if (r.result) { cache.set(word, r.result); return r.result; }
  }
  return reached ? { missing: true } : { offline: true };
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function closeBtn() {
  const b = el('button', 'close', '×');
  b.type = 'button'; b.setAttribute('aria-label', 'Close');
  b.addEventListener('click', hidePopup);
  return b;
}

function render(result, asked) {
  const kids = [closeBtn()];
  if (result.offline) {
    kids.push(el('h2', '', asked), el('p', 'note', 'Cannot reach any dictionary right now. Check your internet, then tap the word again.'));
  } else if (result.missing) {
    kids.push(el('h2', '', asked), el('p', 'note', 'No meaning found. Try tapping a nearby word.'));
  } else {
    const e = result.entry;
    kids.push(el('h2', '', e.word));
    const actions = el('div', 'word-actions');
    const save = el('button', 'btn', 'Save'); save.onclick = () => { saveWord(e.word, e.meanings[0]?.definition); save.textContent = 'Saved'; };
    const speak = el('button', 'btn', 'Listen'); speak.onclick = () => speakWord(e.word);
    const translate = el('button', 'btn', 'Translate'); translate.onclick = async () => { translate.textContent = '…'; translate.title = await translateWord(e.word); translate.textContent = translate.title; };
    const note = el('button', 'btn', 'Note'); note.onclick = () => { const text = prompt('Add a note for “' + e.word + '”'); if (text?.trim()) { const notes = store.get('er-notes', []); notes.unshift({ file: currentFileKey, word: e.word, text: text.trim() }); store.set('er-notes', notes.slice(0, 300)); queueCloudSync(); note.textContent = 'Noted'; } };
    actions.append(save, speak, translate, note); kids.push(actions);
    if (e.phonetic) kids.push(el('p', 'ph', e.phonetic));
    e.meanings.forEach(m => {
      kids.push(el('p', 'pos', m.partOfSpeech), el('p', 'def', m.definition));
      if (m.example) kids.push(el('p', 'ex', '“' + m.example + '”'));
    });
    if (e.word.toLowerCase() !== asked) kids.push(el('p', 'note', `Showing the meaning of “${e.word}”.`));
  }
  popup.replaceChildren(...kids);
}
