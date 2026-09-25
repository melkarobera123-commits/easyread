pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const $ = s => document.querySelector(s);
const fileInput = $('#file'), drop = $('#drop'), statusEl = $('#status'), progress = $('#progress');
const reader = $('#reader'), readerWrap = $('#reader-wrap'), popup = $('#popup');
const API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const cache = new Map();
const dictionaryCacheKey = 'er-dictionary-cache';
let dictionaryAbort = null;
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ } }
};
let openToken = 0, lookupToken = 0, revealed = false, totalPages = 0, headingCount = 0;
let currentFileKey = '', currentDocumentTitle = '', currentRange = null, searchMatches = [], searchIndex = -1, readingStarted = 0;
let autoScrollTimer = null;
let cloudSyncTimer = null;
let bookProgressTimer = null;
let auth = null, cloud = null, currentUser = null;
let activePdf = null, pdfVisualMode = false, pdfCurrentPage = 1, pdfScale = 1.25, pdfFrames = [];
let syncConflictCount = 0;
let scrollSaveFrame = null;
let lastScrollSave = 0;
const panelFocusReturn = new Map();
const seenHeadings = new Set();
const contents = $('#contents'), outlineList = $('#outline'), outlineEmpty = $('#outline-empty');
const pageNow = $('#page-now'), docMeta = $('#doc-meta');
const vocabKey = 'er-vocabulary', statsKey = 'er-stats';
const syncMetaKey = 'er-sync-meta';
const libraryDB = new Promise((resolve, reject) => {
  const request = indexedDB.open('easyread-library', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('books', { keyPath: 'key' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const pageObserver = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) pageNow.textContent = `Page ${e.target.dataset.page} of ${totalPages}`;
}, { rootMargin: '-40% 0px -55% 0px' });

const saveScroll = (force = false) => {
  if (!currentFileKey || readerWrap.hidden) return;
  const now = Date.now();
  if (!force && now - lastScrollSave < 1000) return;
  lastScrollSave = now;
  const stats = store.get(statsKey, {});
  const previous = stats[currentFileKey] || {}, elapsed = Math.max(0, Math.round((Date.now() - readingStarted) / 1000)), today = new Date().toISOString().slice(0, 10);
  stats[currentFileKey] = { ...previous, day: today, scroll: scrollY, seconds: (previous.seconds || 0) + elapsed, days: { ...(previous.days || {}), [today]: (previous.days?.[today] || 0) + elapsed } };
  store.set(statsKey, stats); readingStarted = Date.now(); queueCloudSync();
  clearTimeout(bookProgressTimer);
  bookProgressTimer = setTimeout(async () => { const book = await libraryRequest('readonly', books => books.get(currentFileKey)); if (book) await libraryRequest('readwrite', books => books.put({ ...book, opened: Date.now(), progress: Math.min(100, Math.max(0, Math.round((scrollY / Math.max(document.documentElement.scrollHeight - innerHeight, 1)) * 100)))})); }, 800);
};
addEventListener('scroll', () => {
  if (readerWrap.hidden || scrollSaveFrame) return;
  scrollSaveFrame = requestAnimationFrame(() => { scrollSaveFrame = null; saveScroll(); });
}, { passive: true });
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
  const offsets = getRangeOffsets(reader, range);
  const highlights = store.get('er-highlights', []);
  highlights.push({ file: currentFileKey, text: selection.toString().trim(), ...offsets });
  store.set('er-highlights', highlights.slice(-500));
  if (CSS.highlights) { const existing = CSS.highlights.get('saved') || new Highlight(); existing.add(range); CSS.highlights.set('saved', existing); }
  selection.removeAllRanges();
});
$('#vocab-btn').addEventListener('click', () => togglePanel('vocab'));
$('#stats-btn').addEventListener('click', () => togglePanel('stats'));
$('#saved-btn').addEventListener('click', () => { renderSavedItems(); toggleContents(true); });
$('#library-btn').addEventListener('click', () => togglePanel('library'));
$('#library-home-btn').addEventListener('click', () => togglePanel('library'));
$('#library-close').addEventListener('click', () => togglePanel('library', false));
$('#library-sort').addEventListener('change', renderLibrary);
$('#library-search').addEventListener('input', renderLibrary);
$('#library-filter').addEventListener('change', renderLibrary);
$('#home-library-sort').addEventListener('change', event => { $('#library-sort').value = event.target.value; renderLibrary(); });
$('#bookmark-btn').addEventListener('click', saveBookmark);
$('#export-btn').addEventListener('click', exportReadingData);
$('#flashcards-btn').addEventListener('click', showFlashcards);
$('#speak-page-btn').addEventListener('click', speakCurrentPage);
$('#stop-speech-btn').addEventListener('click', () => speechSynthesis.cancel());
$('#learning-close').addEventListener('click', () => togglePanel('learning', false));
$('#autoscroll-btn').addEventListener('click', () => { if (autoScrollTimer) { clearInterval(autoScrollTimer); autoScrollTimer = null; $('#autoscroll-btn').textContent = 'Auto-scroll'; } else { autoScrollTimer = setInterval(() => scrollBy({ top: 1, behavior: 'auto' }), 35); $('#autoscroll-btn').textContent = 'Stop scroll'; } });
$('#line-focus-btn').addEventListener('click', () => { document.body.classList.toggle('line-focus'); $('#line-focus-btn').textContent = document.body.classList.contains('line-focus') ? 'Full page' : 'Line focus'; });
$('#pdf-mode-btn').addEventListener('click', togglePdfMode);
$('#pdf-prev').addEventListener('click', () => goToPdfPage(pdfCurrentPage - 1));
$('#pdf-next').addEventListener('click', () => goToPdfPage(pdfCurrentPage + 1));
$('#pdf-zoom-out').addEventListener('click', () => changePdfZoom(-.15));
$('#pdf-zoom-in').addEventListener('click', () => changePdfZoom(.15));
$('#pdf-fullscreen').addEventListener('click', () => $('#pdf-pages').requestFullscreen?.());
$('#account-btn').addEventListener('click', () => togglePanel('account'));
$('#account-close').addEventListener('click', () => togglePanel('account', false));
$('#google-signin').addEventListener('click', signInWithGoogle);
$('#sync-now').addEventListener('click', syncCloud);
$('#signout').addEventListener('click', () => auth?.signOut());
$('#welcome-signin-btn').addEventListener('click', () => { store.set('er-welcome-seen', true); $('#welcome-signin').hidden = true; togglePanel('account'); });
$('#welcome-dismiss').addEventListener('click', () => { store.set('er-welcome-seen', true); $('#welcome-signin').hidden = true; });
$('#contact-link').addEventListener('click', event => { event.preventDefault(); togglePanel('contact'); });
$('#contact-close').addEventListener('click', () => togglePanel('contact', false));
$('#privacy-link').addEventListener('click', () => togglePanel('privacy'));
$('#privacy-close').addEventListener('click', () => togglePanel('privacy', false));
$('#shortcuts-link').addEventListener('click', () => togglePanel('shortcuts'));
$('#shortcuts-close').addEventListener('click', () => togglePanel('shortcuts', false));
$('#export-all').addEventListener('click', exportAllData);
$('#delete-all').addEventListener('click', deleteAllLocalData);
$('#onboarding-start').addEventListener('click', () => { store.set('er-onboarding-done', true); $('#onboarding').hidden = true; goToUpload(); });
$('#contact-send').addEventListener('click', () => {
  const email = window.EASYREAD_DEVELOPER_EMAIL, message = $('#contact-message').value.trim();
  if (!email) return ($('#contact-status').textContent = 'Set EASYREAD_DEVELOPER_EMAIL in firebase-config.js first.');
  location.href = `mailto:${email}?subject=EasyRead feedback&body=${encodeURIComponent(message || 'I have feedback about EasyRead.')}`;
});
const contact = window.EASYREAD_CONTACT || {};
const setContact = (id, labelId, value, href) => { const link = $('#' + id), label = $('#' + labelId); if (!value) { link.classList.add('unavailable'); link.removeAttribute('href'); } else { link.href = href; label.textContent = value; } };
setContact('contact-telegram', 'contact-telegram-label', contact.telegram, 'https://t.me/' + String(contact.telegram).replace(/^@/, ''));
setContact('contact-phone', 'contact-phone-label', contact.phone, 'tel:' + contact.phone);
setContact('contact-email', 'contact-email-label', contact.email, 'mailto:' + contact.email);
if (!store.get('er-welcome-seen', false)) $('#welcome-signin').hidden = false;
if (!store.get('er-onboarding-done', false)) setTimeout(() => { $('#onboarding').hidden = false; }, 450);
$('.brand').addEventListener('click', event => { event.preventDefault(); setView('about'); });
const aboutControls = ['about-nav', 'sidebar-about', 'mobile-about'];
const readerControls = ['reader-nav', 'sidebar-reader', 'mobile-reader'];
aboutControls.forEach(id => $('#' + id).addEventListener('click', () => setView('about')));
readerControls.forEach(id => $('#' + id).addEventListener('click', () => {
  if (readerWrap.hidden) return goToUpload();
  setView('reader');
}));
['sidebar-library', 'mobile-library'].forEach(id => $('#' + id).addEventListener('click', () => togglePanel('library')));
['sidebar-account', 'mobile-account'].forEach(id => $('#' + id).addEventListener('click', () => togglePanel('account')));
$('#sidebar-theme').addEventListener('click', () => $('#theme').click());
addEventListener('online', updateNetworkStatus);
addEventListener('offline', updateNetworkStatus);
updateNetworkStatus();

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
const readerPreferences = store.get('er-reader-preferences', {});
function applyReaderPreferences() {
  const font = readerPreferences.font || 'literata';
  $('#font-choice').value = font; $('#spacing').value = readerPreferences.spacing || '1.9'; $('#width').value = readerPreferences.width || '780'; $('#contrast').checked = !!readerPreferences.contrast; $('#reading-goal').value = readerPreferences.goal || '0'; $('#source-language').value = readerPreferences.sourceLanguage || 'en'; $('#translation-language').value = readerPreferences.translationLanguage || 'am'; $('#speech-rate').value = readerPreferences.speechRate || '1'; $('#speech-rate-value').value = Number($('#speech-rate').value).toFixed(1) + 'x';
  rootStyle('--reader-font', font === 'dyslexic' ? 'OpenDyslexic, Arial, sans-serif' : font === 'serif' ? 'Georgia, serif' : "'Literata', Georgia, serif");
  rootStyle('--reader-leading', $('#spacing').value); rootStyle('--reader-width', $('#width').value + 'px'); document.body.classList.toggle('high-contrast', $('#contrast').checked);
}
function saveReaderPreferences(patch) { Object.assign(readerPreferences, patch); store.set('er-reader-preferences', readerPreferences); applyReaderPreferences(); }
applyReaderPreferences();
$('#font-choice').addEventListener('change', e => saveReaderPreferences({ font: e.target.value }));
$('#spacing').addEventListener('input', e => saveReaderPreferences({ spacing: e.target.value }));
$('#width').addEventListener('input', e => saveReaderPreferences({ width: e.target.value }));
$('#contrast').addEventListener('change', e => saveReaderPreferences({ contrast: e.target.checked }));
$('#reading-goal').addEventListener('change', e => saveReaderPreferences({ goal: e.target.value }));
$('#source-language').addEventListener('change', e => saveReaderPreferences({ sourceLanguage: e.target.value }));
$('#translation-language').addEventListener('change', e => saveReaderPreferences({ translationLanguage: e.target.value }));
$('#speech-rate').addEventListener('input', e => saveReaderPreferences({ speechRate: e.target.value }));
$('#speech-voice').addEventListener('change', e => saveReaderPreferences({ speechVoice: e.target.value }));
function populateVoices() {
  if (!('speechSynthesis' in window)) return;
  const select = $('#speech-voice'), saved = readerPreferences.speechVoice || ''; select.replaceChildren(new Option('Browser default', ''));
  speechSynthesis.getVoices().forEach((voice, index) => select.add(new Option(`${voice.name} (${voice.lang})`, String(index))));
  select.value = saved;
}
if ('speechSynthesis' in window) { speechSynthesis.addEventListener('voiceschanged', populateVoices); populateVoices(); }
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
renderLibrary();

function rootStyle(name, value) { document.documentElement.style.setProperty(name, value); }
function togglePanel(id, open = true) {
  const panel = $('#' + id), wasOpen = !panel.hidden, shouldOpen = open === false ? false : panel.hidden;
  if (shouldOpen) {
    panelFocusReturn.set(id, document.activeElement); panel.hidden = false;
    requestAnimationFrame(() => panel.querySelector('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus());
  } else {
    panel.hidden = true;
    const trigger = panelFocusReturn.get(id); if (wasOpen && trigger?.isConnected) trigger.focus();
  }
  if (id === 'vocab' && !panel.hidden) renderVocabulary(); if (id === 'stats' && !panel.hidden) renderStats(); if (id === 'library' && !panel.hidden) renderLibrary();
}
function updateNetworkStatus() {
  const banner = $('#network-status'); banner.hidden = navigator.onLine;
  banner.textContent = navigator.onLine ? '' : 'You are offline. Changes will sync automatically when you reconnect.';
  if (!navigator.onLine) showToast('Offline mode on. Your changes are safe here.');
  if (currentUser) updateSyncMeta();
}
let toastTimer = null;
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 3200); }
function setView(view) {
  document.body.dataset.view = view;
  [...aboutControls].forEach(id => $('#' + id)?.classList.toggle('active', view === 'about'));
  [...readerControls].forEach(id => $('#' + id)?.classList.toggle('active', view === 'reader'));
  if (view === 'reader') readerWrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); else scrollTo({ top: 0, behavior: 'smooth' });
}
function goToUpload() {
  setView('about');
  setStatus('Choose a book to open the Reader.');
  requestAnimationFrame(() => { drop.scrollIntoView({ behavior: 'smooth', block: 'center' }); drop.focus({ preventScroll: true }); drop.classList.add('guide-focus'); setTimeout(() => drop.classList.remove('guide-focus'), 1100); });
}

drop.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault(); fileInput.click();
});

function updateAccount(user) {
  $('#account-signed-out').hidden = !!user; $('#account-signed-in').hidden = !user;
  const label = user ? (user.displayName?.split(' ')[0] || 'Account') : 'Sign in';
  $('#account-label').textContent = label; $('#sidebar-account-label').textContent = label; $('#sidebar-account-meta').textContent = user ? (user.email || 'Google account') : 'Sync your reading';
  $('#account-avatar').hidden = !user; $('#account-photo').hidden = !user;
  $('#sidebar-avatar').src = user?.photoURL || '';
  if (user?.photoURL) { $('#account-avatar').src = user.photoURL; $('#account-photo').src = user.photoURL; }
  if (user) { $('#account-name').textContent = user.displayName || 'Signed in with Google'; $('#account-email').textContent = user.email || ''; updateSyncMeta(); }
}
async function signInWithGoogle() {
  if (!auth) return ($('#auth-status').textContent = 'Firebase is not configured yet.');
  try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  catch (error) { $('#auth-status').textContent = error.code === 'auth/popup-blocked' ? 'Allow popups for this site, then try again.' : error.message; }
}
async function syncCloud() {
  if (!currentUser || !cloud) return;
  if (!navigator.onLine) { queueSyncState('offline'); showToast('Saved locally. Sync will resume when you are online.'); return; }
  $('#sync-label').textContent = 'Syncing…';
  try {
    const ref = cloud.collection('users').doc(currentUser.uid), snapshot = await ref.get(), local = { vocabulary: store.get(vocabKey, []), notes: store.get('er-notes', []), highlights: store.get('er-highlights', []), bookmarks: store.get('er-bookmarks', []), stats: store.get(statsKey, {}) };
    syncConflictCount = 0;
    const remote = snapshot.exists ? snapshot.data() : {}, merged = { vocabulary: mergeItems(remote.vocabulary, local.vocabulary, 'word'), notes: mergeItems(remote.notes, local.notes, 'text'), highlights: mergeItems(remote.highlights, local.highlights, 'text'), bookmarks: mergeItems(remote.bookmarks, local.bookmarks, 'scroll'), stats: { ...(remote.stats || {}), ...local.stats } };
    await ref.set(merged, { merge: true });
    store.set(vocabKey, merged.vocabulary); store.set('er-notes', merged.notes); store.set('er-highlights', merged.highlights); store.set('er-bookmarks', merged.bookmarks); store.set(statsKey, merged.stats);
    store.set(syncMetaKey, { lastSynced: Date.now(), pending: false, conflicts: syncConflictCount });
    $('#sync-label').textContent = 'Synced just now'; updateSyncMeta(); showToast('Your reading history is synced.');
  } catch (error) { queueSyncState('error', error.message); showToast('Sync needs attention. Your local data is safe.'); }
}
function queueCloudSync() { if (!currentUser) return; store.set(syncMetaKey, { ...store.get(syncMetaKey, {}), pending: true }); updateSyncMeta(); clearTimeout(cloudSyncTimer); cloudSyncTimer = setTimeout(() => syncCloud(), 500); }
function queueSyncState(state, message = '') { store.set(syncMetaKey, { ...store.get(syncMetaKey, {}), pending: true, state, message }); updateSyncMeta(); }
function updateSyncMeta() { const meta = store.get(syncMetaKey, {}); if ($('#last-synced')) $('#last-synced').textContent = meta.lastSynced ? 'Last synced ' + new Date(meta.lastSynced).toLocaleString() : 'No cloud sync completed yet.'; if ($('#pending-sync')) $('#pending-sync').textContent = meta.pending ? 'Pending local changes will sync automatically.' : ''; if ($('#sync-conflicts')) $('#sync-conflicts').textContent = meta.conflicts ? `${meta.conflicts} conflict${meta.conflicts === 1 ? '' : 's'} kept as separate items.` : ''; if ($('#sync-label') && meta.state === 'offline') $('#sync-label').textContent = 'Offline'; if ($('#sync-label') && meta.state === 'error') $('#sync-label').textContent = 'Sync needs attention'; }
addEventListener('online', () => { if (currentUser) syncCloud(); });
function mergeItems(remote = [], local = [], key) { const output = [], seen = new Map(); for (const item of [...remote, ...local]) { const id = item[key] || JSON.stringify(item); const previous = seen.get(id); if (!previous) { seen.set(id, item); output.push(item); } else if (JSON.stringify(previous) !== JSON.stringify(item)) { syncConflictCount++; output.push({ ...item, _conflict: true }); } } return output.slice(-500); }

async function libraryRequest(mode, action) {
  try { const db = await libraryDB; return await new Promise((resolve, reject) => { const tx = db.transaction('books', mode), request = action(tx.objectStore('books')); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); } catch { return null; }
}
async function saveBook(file) {
  const previous = await libraryRequest('readonly', books => books.get(currentFileKey));
  await libraryRequest('readwrite', books => books.put({ ...(previous || {}), key: currentFileKey, name: file.name, title: currentDocumentTitle || file.name.replace(/\.[^.]+$/, ''), type: file.name.split('.').pop().toLowerCase(), size: file.size, modified: file.lastModified, added: previous?.added || Date.now(), opened: Date.now(), progress: previous?.progress || 0, favorite: previous?.favorite || false, file }));
  renderLibrary();
}
async function updateBook(key, patch) { const book = await libraryRequest('readonly', books => books.get(key)); if (book) { await libraryRequest('readwrite', books => books.put({ ...book, ...patch })); renderLibrary(); } }
async function getBooks() { return (await libraryRequest('readonly', books => books.getAll())) || []; }
async function renderLibrary() {
  let books = await getBooks(); const sort = $('#library-sort')?.value || $('#home-library-sort')?.value || 'recent', query = $('#library-search')?.value.trim().toLowerCase() || '', filter = $('#library-filter')?.value || 'all';
  books = books.filter(book => {
    const type = book.type || '';
    const matchesType = filter === 'all' || (filter === 'favorite' ? book.favorite : filter === 'image' ? /png|jpe?g/.test(type) : type === filter);
    return matchesType && (!query || (book.title || book.name || '').toLowerCase().includes(query));
  });
  books.sort((a, b) => sort === 'title' ? (a.title || a.name).localeCompare(b.title || b.name) : sort === 'progress' ? (b.progress || 0) - (a.progress || 0) : (b.opened || b.added) - (a.opened || a.added));
  const targets = [$('#library-list'), $('#library-favorites'), $('#library-preview')]; targets.forEach(target => target?.replaceChildren());
  if (!books.length) { $('#library-list')?.append(el('p', 'note', 'Choose a book to start your shelf.')); $('#library-preview')?.append(el('p', 'note', 'Your imported books will appear here.')); return; }
  const favorites = books.filter(book => book.favorite), recent = books.slice(0, 6);
  if (!favorites.length) $('#library-favorites')?.append(el('p', 'note', 'Favorite books will appear here.'));
  favorites.forEach(book => $('#library-favorites')?.append(bookRow(book)));
  recent.forEach(book => $('#library-list')?.append(bookRow(book)));
  recent.slice(0, 4).forEach(book => $('#library-preview')?.append(bookCard(book)));
}
function bookCover(book) { const cover = el('span', 'book-cover ' + (book.type || 'file')); cover.append(el('small', '', (book.type || 'file').toUpperCase()), el('strong', '', (book.title || book.name).slice(0, 26))); return cover; }
function bookProgress(book) { const wrap = el('span', 'book-progress'), bar = el('span'); bar.style.width = Math.min(100, Math.max(0, book.progress || 0)) + '%'; wrap.append(bar); return wrap; }
function bookRow(book) { const row = el('div', 'library-row'), info = el('div', 'library-row-info'), actions = el('div', 'library-row-actions'), open = el('button', 'btn', 'Open'), rename = el('button', 'icon-btn', '✎'), favorite = el('button', 'icon-btn', book.favorite ? '★' : '☆'), remove = el('button', 'icon-btn', '×'); info.append(bookCover(book), el('span', 'library-row-copy', (book.title || book.name).replace(/\.[^.]+$/, '')), bookProgress(book)); open.onclick = () => { openFile(new File([book.file], book.name, { type: book.file.type, lastModified: book.modified })); togglePanel('library', false); }; rename.title = 'Rename book'; rename.onclick = () => { const title = prompt('Book title', book.title || book.name); if (title?.trim()) updateBook(book.key, { title: title.trim() }); }; favorite.title = 'Toggle favorite'; favorite.onclick = () => updateBook(book.key, { favorite: !book.favorite }); remove.title = 'Remove book'; remove.onclick = async () => { if (!confirm(`Remove “${book.title || book.name}” from this device?`)) return; await libraryRequest('readwrite', booksStore => booksStore.delete(book.key)); renderLibrary(); showToast('Book removed from this device.'); }; actions.append(open, rename, favorite, remove); row.append(info, actions); return row; }
function bookCard(book) { const card = el('article', 'book-card'), open = el('button', 'book-open'); open.type = 'button'; open.append(bookCover(book), el('strong', '', (book.title || book.name).replace(/\.[^.]+$/, '')), bookProgress(book), el('small', '', Math.round(book.progress || 0) + '% complete')); open.onclick = () => openFile(new File([book.file], book.name, { type: book.file.type, lastModified: book.modified })); const favorite = el('button', 'icon-btn book-favorite', book.favorite ? '★' : '☆'); favorite.onclick = () => updateBook(book.key, { favorite: !book.favorite }); card.append(open, favorite); return card; }

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
  readerWrap.hidden = true; hidePopup(); toggleContents(false); setView('about');
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
  setView('reader');
  setStatus('');
  readerWrap.scrollIntoView();
  const saved = store.get(statsKey, {})[currentFileKey]?.scroll;
  if (saved) setTimeout(() => scrollTo({ top: saved, behavior: 'smooth' }), 80);
}

async function openFile(file) {
  const my = ++openToken, name = file.name.toLowerCase();
  currentFileKey = file.name + ':' + file.size + ':' + file.lastModified;
  currentDocumentTitle = file.name.replace(/\.[^.]+$/, '');
  readingStarted = Date.now();
  revealed = false; activePdf = null; pdfVisualMode = false; pdfCurrentPage = 1; pdfScale = 1.25; pdfFrames = []; $('#loading-skeleton').hidden = false; $('#pdf-pages').replaceChildren(); $('#pdf-thumbs').replaceChildren(); $('#pdf-pages').hidden = true; $('#pdf-thumbs').hidden = true; $('#pdf-controls').hidden = true; $('#reader').hidden = false; $('#pdf-mode-btn').hidden = true; hidePopup(); reader.textContent = ''; progress.textContent = ''; resetOutline();
  try {
    setStatus('Opening ' + file.name + '…');
    if (name.endsWith('.pdf')) await readPdf(file, my);
    else if (name.endsWith('.docx')) await readDocx(file);
    else if (name.endsWith('.pptx')) await readPptx(file);
    else if (name.endsWith('.epub')) await readEpub(file);
    else if (/\.(png|jpe?g)$/i.test(name)) await readImage(file);
    else if (name.endsWith('.txt')) addParagraphs((await file.text()).split(/\n\s*\n/));
    else return setStatus('Use a PDF, DOCX, PPTX, EPUB, TXT or image file.', true);
    if (my !== openToken) return;
    if (!reader.textContent.trim()) return setStatus('No text found. This file may be scanned images.', true);
    reveal(file.name);
    restoreHighlights();
    $('#loading-skeleton').hidden = true;
    progress.textContent = '';
    showMeta();
    saveBook(file);
  } catch (e) {
    console.error(e);
    $('#loading-skeleton').hidden = true;
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

async function readPptx(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer()), slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => parseInt(a.match(/slide(\d+)/)[1], 10) - parseInt(b.match(/slide(\d+)/)[1], 10));
  totalPages = slides.length;
  for (let index = 0; index < slides.length; index++) {
    const xml = new DOMParser().parseFromString(await zip.file(slides[index]).async('text'), 'application/xml');
    const text = [...xml.getElementsByTagName('a:t')].map(node => node.textContent).join(' ').replace(/\s+/g, ' ').trim();
    if (text) addBlocks([{ text: 'Slide ' + (index + 1), heading: true }, { text }], index + 1);
  }
}

async function readEpub(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const container = new DOMParser().parseFromString(await zip.file('META-INF/container.xml').async('text'), 'application/xml');
  const rootfile = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!rootfile) throw new Error('Invalid EPUB');
  const base = rootfile.includes('/') ? rootfile.slice(0, rootfile.lastIndexOf('/') + 1) : '';
  const opf = new DOMParser().parseFromString(await zip.file(rootfile).async('text'), 'application/xml');
  const titleNode = opf.getElementsByTagNameNS('*', 'title')[0];
  if (titleNode?.textContent.trim()) currentDocumentTitle = titleNode.textContent.trim();
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
    for (const source of [reader, $('#pdf-pages')]) {
      const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode, text = node.data.toLowerCase(); let from = 0, at;
        while ((at = text.indexOf(query, from)) >= 0) { const range = new Range(); range.setStart(node, at); range.setEnd(node, at + query.length); searchMatches.push(range); from = at + query.length; }
      }
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
  const stats = Object.values(store.get(statsKey, {})), seconds = stats.reduce((n, item) => n + (item.seconds || 0), 0), allDays = new Set(), today = new Date().toISOString().slice(0, 10);
  stats.forEach(item => Object.keys(item.days || (item.day ? { [item.day]: true } : {})).forEach(day => allDays.add(day)));
  const todaySeconds = stats.reduce((n, item) => n + (item.days?.[today] || 0), 0), goal = Number(readerPreferences.goal || 0), goalText = goal ? `${Math.min(goal, Math.floor(todaySeconds / 60))}/${goal}` : `${Math.floor(todaySeconds / 60)}`;
  $('#stats-content').innerHTML = `<div class="stats-grid"><p><strong>${Math.round(seconds / 60)}</strong><small>minutes read</small></p><p><strong>${store.get(vocabKey, []).length}</strong><small>saved words</small></p><p><strong>${allDays.size}</strong><small>reading days</small></p></div><div class="reading-goal"><span>Today</span><strong>${goalText} min</strong>${goal ? `<div><i style="width:${Math.min(100, todaySeconds / 60 / goal * 100)}%"></i></div>` : ''}</div><p class="note">Your progress stays private in this browser and syncs only when you choose Google sync.</p>`;
}
function renderSavedItems() {
  const bookmarks = store.get('er-bookmarks', []).filter(item => item.file === currentFileKey), notes = store.get('er-notes', []).filter(item => item.file === currentFileKey), highlights = store.get('er-highlights', []).filter(item => item.file === currentFileKey);
  const bookmarkList = $('#bookmark-list'), savedList = $('#saved-list'); bookmarkList.replaceChildren(); savedList.replaceChildren();
  if (!bookmarks.length) bookmarkList.append(el('p', 'note', 'No bookmarks yet.'));
  bookmarks.slice(0, 20).forEach(bookmark => { const button = el('button', 'saved-item', bookmark.name || 'Reading position'); button.append(el('small', '', new Date(bookmark.created).toLocaleDateString())); button.onclick = () => { scrollTo({ top: bookmark.scroll, behavior: 'smooth' }); toggleContents(false); }; bookmarkList.append(button); });
  const items = [...notes.map(note => ({ label: note.word + ': ' + note.text, type: 'Note' })), ...highlights.map(highlight => ({ label: highlight.text, type: 'Highlight' }))];
  if (!items.length) savedList.append(el('p', 'note', 'Notes and highlights will appear here.'));
  items.slice(0, 30).forEach(item => { const row = el('div', 'saved-item static'); row.append(el('small', '', item.type), el('span', '', item.label)); savedList.append(row); });
}

function getRangeOffsets(root, range) {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return {};
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node, offset = 0, start = null, end = null;
  while ((node = walker.nextNode())) { if (node === range.startContainer) start = offset + range.startOffset; if (node === range.endContainer) { end = offset + range.endOffset; break; } offset += node.data.length; }
  return Number.isInteger(start) && Number.isInteger(end) ? { start, end } : {};
}
function rangeFromOffsets(root, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node, offset = 0, startNode, endNode, startOffset, endOffset;
  while ((node = walker.nextNode())) {
    const next = offset + node.data.length;
    if (!startNode && start >= offset && start <= next) { startNode = node; startOffset = start - offset; }
    if (end >= offset && end <= next) { endNode = node; endOffset = end - offset; break; }
    offset = next;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange(); range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset); return range;
}
function restoreHighlights() {
  if (!CSS.highlights || !currentFileKey) return;
  const ranges = store.get('er-highlights', []).filter(item => item.file === currentFileKey).map(item => rangeFromOffsets(reader, item.start, item.end)).filter(Boolean);
  if (ranges.length) CSS.highlights.set('saved', new Highlight(...ranges)); else CSS.highlights.delete('saved');
}

function saveBookmark() {
  if (!currentFileKey || readerWrap.hidden) return;
  const bookmarks = store.get('er-bookmarks', []);
  bookmarks.unshift({ file: currentFileKey, name: $('#file-name').textContent, scroll: scrollY, created: Date.now() });
  store.set('er-bookmarks', bookmarks.slice(0, 100));
  queueCloudSync();
  $('#bookmark-btn').textContent = 'Bookmarked';
  showToast('Bookmark saved.');
}
function exportReadingData() {
  const data = { vocabulary: store.get(vocabKey, []), notes: store.get('er-notes', []), highlights: store.get('er-highlights', []), bookmarks: store.get('er-bookmarks', []) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = 'easyread-notes.json'; link.click(); URL.revokeObjectURL(link.href);
  showToast('Your reading notes were exported.');
}

async function exportAllData() {
  const books = await getBooks();
  const data = { exportedAt: new Date().toISOString(), vocabulary: store.get(vocabKey, []), notes: store.get('er-notes', []), highlights: store.get('er-highlights', []), bookmarks: store.get('er-bookmarks', []), stats: store.get(statsKey, {}), books: books.map(book => ({ key: book.key, name: book.name, title: book.title, type: book.type, progress: book.progress, favorite: book.favorite })) };
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); link.download = 'easyread-private-data.json'; link.click(); URL.revokeObjectURL(link.href); $('#privacy-status').textContent = 'Export created.'; showToast('All available reading data was exported.');
}
async function deleteAllLocalData() {
  if (!confirm('Delete local books, notes, vocabulary, highlights, bookmarks, and progress? This cannot be undone.')) return;
  Object.keys(localStorage).filter(key => key.startsWith('er-')).forEach(key => localStorage.removeItem(key)); await new Promise(resolve => { const request = indexedDB.deleteDatabase('easyread-library'); request.onsuccess = request.onerror = request.onblocked = resolve; });
  $('#privacy-status').textContent = 'Local data deleted. Reload to start fresh.'; showToast('Local data deleted.');
}

function saveWord(word, definition) {
  const words = store.get(vocabKey, []);
  if (!words.some(item => item.word === word)) words.unshift({ word, definition });
  store.set(vocabKey, words.slice(0, 300));
  queueCloudSync();
  showToast('Word saved to your vocabulary.');
}
function speakText(text) {
  if (!('speechSynthesis' in window)) return false;
  const utterance = new SpeechSynthesisUtterance(text), voiceIndex = readerPreferences.speechVoice;
  utterance.rate = Number(readerPreferences.speechRate || 1);
  if (voiceIndex !== undefined && voiceIndex !== '') utterance.voice = speechSynthesis.getVoices()[Number(voiceIndex)] || null;
  speechSynthesis.cancel(); speechSynthesis.speak(utterance); return true;
}
function speakWord(word) { if (!speakText(word)) showToast('Text-to-speech is not available in this browser.'); }
function speakCurrentPage() { const source = reader.querySelector('.page:not([hidden])') || reader; const text = [...source.querySelectorAll('p, h2')].map(node => node.textContent).join(' '); if (!text) return showToast('Open a readable document first.'); if (speakText(text)) showToast('Reading aloud.'); else showToast('Text-to-speech is not available in this browser.'); }
async function translateWord(word, target = 'es') {
  const language = $('#translation-language')?.value || target;
  const source = $('#source-language')?.value || 'en';
  if (source === language) return word;
  const res = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(word) + '&langpair=' + source + '|' + language);
  if (!res.ok) throw new Error('Translation unavailable');
  const data = await res.json(); return data.responseData?.translatedText || 'Translation unavailable';
}

function showFlashcards() {
  togglePanel('learning'); $('#learning-title').textContent = 'Vocabulary flashcards'; const target = $('#learning-content'), words = store.get(vocabKey, []); target.replaceChildren();
  if (!words.length) return target.append(el('p', 'note', 'Save words while reading to build flashcards.'));
  words.slice(0, 20).forEach(item => { const card = el('button', 'flashcard'); card.type = 'button'; card.append(el('strong', '', item.word), el('span', '', 'Tap to reveal')); card.onclick = () => { card.replaceChildren(el('strong', '', item.word), el('span', '', item.definition || 'No definition saved')); }; target.append(card); });
}

async function readPdf(file, my) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  activePdf = pdf; pdfVisualMode = true; pdfCurrentPage = 1; pdfScale = 1; $('#pdf-mode-btn').hidden = false; $('#pdf-mode-btn').textContent = 'Text view'; $('#pdf-controls').hidden = false; $('#pdf-thumbs').hidden = false; $('#pdf-pages').hidden = false; $('#reader').hidden = true; updatePdfLabel(); renderPdfPages(pdf);
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

async function renderPdfPages(pdf) {
  const pages = $('#pdf-pages'), thumbs = $('#pdf-thumbs'); pages.replaceChildren(); thumbs.replaceChildren(); pdfFrames = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number), viewport = page.getViewport({ scale: Math.min(1.35, (innerWidth - 48) / page.getViewport({ scale: 1 }).width) });
    const frame = el('figure', 'pdf-page readable'), canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height; frame.dataset.page = number; frame.append(canvas);
    const textLayer = el('div', 'textLayer'); frame.append(textLayer, el('figcaption', '', 'Page ' + number)); pages.append(frame);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    try {
      const textContent = await page.getTextContent();
      const task = pdfjsLib.renderTextLayer({ textContent, container: textLayer, viewport, textDivs: [] });
      if (task?.promise) await task.promise;
    } catch (error) { console.warn('PDF text layer unavailable', error); }
    const thumb = document.createElement('canvas'), thumbButton = el('button', 'pdf-thumb'); thumbButton.type = 'button'; thumb.width = 72; thumb.height = Math.round(72 * viewport.height / viewport.width); thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height); thumbButton.append(thumb, el('span', '', String(number))); thumbButton.onclick = () => goToPdfPage(number); thumbs.append(thumbButton); pdfFrames.push(frame);
  }
}
function togglePdfMode() {
  if (!activePdf) return;
  pdfVisualMode = !pdfVisualMode; $('#pdf-pages').hidden = !pdfVisualMode; $('#pdf-thumbs').hidden = !pdfVisualMode; $('#pdf-controls').hidden = !pdfVisualMode; $('#reader').hidden = pdfVisualMode; $('#pdf-mode-btn').textContent = pdfVisualMode ? 'Text view' : 'Page view';
}
function updatePdfLabel() { $('#pdf-page-label').textContent = `Page ${pdfCurrentPage} of ${activePdf?.numPages || 0}`; }
function goToPdfPage(number) { if (!activePdf || !pdfFrames.length) return; pdfCurrentPage = Math.min(activePdf.numPages, Math.max(1, number)); pdfFrames[pdfCurrentPage - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' }); updatePdfLabel(); }
function changePdfZoom(amount) { pdfScale = Math.min(1.8, Math.max(.75, pdfScale + amount)); $('#pdf-pages').style.setProperty('--pdf-zoom', pdfScale); }

/* ---------- Tap a word ---------- */
document.addEventListener('click', e => {
  if (e.target.closest('#popup')) return;
  const hit = e.target.closest('.readable') && wordAtUniversal(e.clientX, e.clientY);
  hit ? showWord(hit) : hidePopup();
});
document.addEventListener('keydown', e => {
  const openDialog = [...document.querySelectorAll('[role="dialog"]')].find(panel => !panel.hidden);
  if (e.key === 'Tab' && openDialog) {
    const focusable = [...openDialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]')];
    if (focusable.length) {
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  if (e.key === 'Escape') { hidePopup(); toggleContents(false); ['settings', 'vocab', 'stats', 'library', 'learning', 'account', 'privacy', 'shortcuts', 'contact'].forEach(id => togglePanel(id, false)); }
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === '/') { e.preventDefault(); if (!readerWrap.hidden) { setView('reader'); $('#reader-tools').hidden = false; $('#search-input').focus(); } }
  if (e.key.toLowerCase() === 'f' && !readerWrap.hidden) { document.body.classList.toggle('focus-mode'); $('#focus-btn').textContent = document.body.classList.contains('focus-mode') ? 'Exit focus' : 'Focus'; }
  if (e.key.toLowerCase() === 't') $('#theme').click();
  if (e.key === '?') togglePanel('shortcuts');
});

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

function wordAtUniversal(x, y) {
  const caret = document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : document.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode || caret?.startContainer, offset = caret?.offset ?? caret?.startOffset;
  if (!node || node.nodeType !== Node.TEXT_NODE || offset === undefined) return null;
  const text = node.data, letter = /[\p{L}\p{M}\p{N}'\u2019\u2010-\u2015-]/u;
  let start = offset, end = offset;
  while (start > 0 && letter.test(text[start - 1])) start--;
  while (end < text.length && letter.test(text[end])) end++;
  const word = text.slice(start, end).replace(/^['\u2019-]+|['\u2019-]+$/g, '').toLocaleLowerCase();
  if (!word) return null;
  const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end);
  return [...range.getClientRects()].some(rect => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) ? { word, range } : null;
}

async function showWord({ word, range }) {
  const my = ++lookupToken;
  dictionaryAbort?.abort(); dictionaryAbort = new AbortController();
  currentRange = range;
  if (window.CSS && CSS.highlights) CSS.highlights.set('picked', new Highlight(range));
  popup.hidden = false;
  popup.replaceChildren(closeBtn(), el('h2', '', word), el('p', 'note', 'Looking up…'));
  place(range);
  try {
    const result = await defineRich(word, dictionaryAbort.signal);
    if (my !== lookupToken) return;
    renderRich(result, word);
    place(range);
  } catch (error) {
    if (error.name !== 'AbortError' && my === lookupToken) { renderRich({ offline: true }, word); place(range); }
  }
}

function hidePopup() {
  lookupToken++;
  dictionaryAbort?.abort(); dictionaryAbort = null;
  popup.hidden = true;
  if (window.CSS && CSS.highlights) CSS.highlights.delete('picked');
}

function place(range) {
  if (matchMedia('(max-width: 640px)').matches) { popup.style.left = popup.style.top = ''; return; }
  const r = range.getBoundingClientRect(), w = popup.offsetWidth;
  popup.style.left = Math.max(12, Math.min(scrollX + r.left, scrollX + innerWidth - w - 12)) + 'px';
  popup.style.top = Math.max(scrollY + 12, Math.min(scrollY + r.bottom + 10, scrollY + innerHeight - popup.offsetHeight - 12)) + 'px';
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

/* Rich dictionary: cached locally and resilient across three free sources. */
function dictionaryText(value = '') { return new DOMParser().parseFromString(String(value), 'text/html').body.textContent.replace(/\s+/g, ' ').trim(); }
function dictionaryUnique(items = []) { return [...new Set(items.filter(Boolean).map(value => String(value).trim()).filter(Boolean))]; }
function dictionaryCandidates(word) {
  const forms = [word], add = value => { if (value.length > 1 && !forms.includes(value)) forms.push(value); };
  const base = word.replace(/'s$/, ''); add(base);
  if (/ies$/.test(base)) add(base.slice(0, -3) + 'y');
  if (/ves$/.test(base)) { add(base.slice(0, -3) + 'f'); add(base.slice(0, -3) + 'fe'); }
  if (/es$/.test(base)) { add(base.slice(0, -2)); add(base.slice(0, -1)); }
  if (/s$/.test(base)) add(base.slice(0, -1));
  if (/ier$/.test(base)) add(base.slice(0, -3) + 'y');
  const stem = base.replace(/(ing|ed|er|est)$/, '');
  if (stem !== base && stem.length > 1) { add(stem); add(stem + 'e'); if (/(.)\1$/.test(stem)) add(stem.slice(0, -1)); }
  return forms.slice(0, 7);
}
function readDictionaryCache(word) {
  const record = store.get(dictionaryCacheKey, {})[word];
  return record?.result && Date.now() - record.savedAt < 1000 * 60 * 60 * 24 * 90 ? { ...record.result, cached: true } : null;
}
function writeDictionaryCache(word, result) {
  const records = store.get(dictionaryCacheKey, {}); records[word] = { savedAt: Date.now(), result };
  store.set(dictionaryCacheKey, Object.fromEntries(Object.entries(records).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, 500)));
}
async function dictionaryGet(url, signal) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5500), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  try { return await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } }); }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}
async function richFromDictionaryApi(word, signal) {
  const response = await dictionaryGet(API + encodeURIComponent(word), signal);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(response.status);
  const entries = await response.json(), first = entries[0];
  const meanings = entries.flatMap(entry => entry.meanings || []).flatMap(group => (group.definitions || []).slice(0, 4).map(definition => ({
    partOfSpeech: group.partOfSpeech || 'meaning', definition: dictionaryText(definition.definition), example: dictionaryText(definition.example || ''),
    synonyms: dictionaryUnique([...(group.synonyms || []), ...(definition.synonyms || [])]), antonyms: dictionaryUnique([...(group.antonyms || []), ...(definition.antonyms || [])])
  }))).filter(item => item.definition).slice(0, 8);
  return meanings.length ? { word: first.word || word, phonetic: first.phonetic || (first.phonetics || []).find(item => item.text)?.text || '', audio: (first.phonetics || []).find(item => item.audio)?.audio || '', meanings, synonyms: dictionaryUnique(meanings.flatMap(item => item.synonyms)).slice(0, 12), antonyms: dictionaryUnique(meanings.flatMap(item => item.antonyms)).slice(0, 12), source: 'Free Dictionary API', sourceUrl: first.sourceUrls?.[0] || '' } : null;
}
async function richFromWiktionary(word, signal) {
  const response = await dictionaryGet('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(word), signal);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(response.status);
  const groups = (await response.json()).en || [];
  const meanings = groups.flatMap(group => (group.definitions || []).slice(0, 3).map(definition => ({ partOfSpeech: (group.partOfSpeech || 'meaning').toLowerCase(), definition: dictionaryText(definition.definition), example: dictionaryText(definition.examples?.[0] || '') }))).filter(item => item.definition).slice(0, 8);
  return meanings.length ? { word, meanings, etymology: dictionaryText(groups.find(group => group.etymology)?.etymology || ''), source: 'Wiktionary', sourceUrl: 'https://en.wiktionary.org/wiki/' + encodeURIComponent(word) } : null;
}
async function richFromDatamuse(word, signal) {
  const [definitionsResponse, synonymsResponse] = await Promise.all([dictionaryGet('https://api.datamuse.com/words?md=d&max=1&sp=' + encodeURIComponent(word), signal), dictionaryGet('https://api.datamuse.com/words?rel_syn=' + encodeURIComponent(word) + '&max=12', signal)]);
  if (!definitionsResponse.ok) throw new Error(definitionsResponse.status);
  const hit = (await definitionsResponse.json())[0];
  if (!hit?.defs) return null;
  const names = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: 'word' };
  const meanings = hit.defs.slice(0, 8).map(item => { const [part, ...definition] = item.split('\t'); return { partOfSpeech: names[part] || part, definition: dictionaryText(definition.join(' ')), example: '' }; });
  const synonyms = synonymsResponse.ok ? dictionaryUnique((await synonymsResponse.json()).map(item => item.word)) : [];
  return { word: hit.word || word, meanings, synonyms, source: 'Datamuse', sourceUrl: 'https://www.datamuse.com/api/' };
}
async function defineRich(word, signal) {
  if (cache.has('rich:' + word)) return cache.get('rich:' + word);
  const stored = readDictionaryCache(word); if (stored) { cache.set('rich:' + word, stored); return stored; }
  let reached = false;
  for (const form of dictionaryCandidates(word)) {
    const responses = await Promise.allSettled([richFromDictionaryApi(form, signal), richFromWiktionary(form, signal), richFromDatamuse(form, signal)]);
    if (signal?.aborted) throw new DOMException('Lookup cancelled', 'AbortError');
    reached = reached || responses.some(response => response.status === 'fulfilled');
    const entries = responses.filter(response => response.status === 'fulfilled' && response.value).map(response => response.value);
    if (entries.length) {
      const entry = entries.sort((a, b) => (b.meanings?.length || 0) - (a.meanings?.length || 0))[0];
      const result = { entry, asked: word }; cache.set('rich:' + word, result); writeDictionaryCache(word, result); return result;
    }
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

function speakDictionaryEntry(entry) {
  if (entry.audio) { const audio = new Audio(entry.audio); audio.play().catch(() => speakWord(entry.word)); }
  else speakWord(entry.word);
}
function dictionaryRelated(label, words) {
  if (!words?.length) return null;
  const row = el('div', 'dictionary-related'), title = el('span', '', label), values = el('span', 'dictionary-chips');
  words.slice(0, 10).forEach(word => values.append(el('span', 'dictionary-chip', word)));
  row.append(title, values); return row;
}
function renderRich(result, asked) {
  const kids = [closeBtn()];
  if (result.offline) {
    kids.push(el('h2', '', asked), el('p', 'note', 'No dictionary source is reachable right now. Previously opened words remain available offline.'));
  } else if (result.missing) {
    kids.push(el('h2', '', asked), el('p', 'note', 'No definition was found. Try the singular form, a nearby word, or check the spelling.'));
  } else {
    const entry = result.entry;
    kids.push(el('h2', '', entry.word));
    const actions = el('div', 'word-actions'), translation = el('p', 'dictionary-translation');
    const save = el('button', 'btn', 'Save'); save.onclick = () => { saveWord(entry.word, entry.meanings[0]?.definition); save.textContent = 'Saved'; };
    const listen = el('button', 'btn', 'Listen'); listen.onclick = () => speakDictionaryEntry(entry);
    const translate = el('button', 'btn', 'Translate'); translate.onclick = async () => { translate.disabled = true; translate.textContent = 'Translating'; try { translation.textContent = await translateWord(entry.word); } catch { translation.textContent = 'Translation is unavailable right now.'; } finally { translate.disabled = false; translate.textContent = 'Translate'; } };
    const copy = el('button', 'btn', 'Copy'); copy.onclick = async () => { const text = `${entry.word}: ${entry.meanings.map(item => item.definition).join(' ')}`; try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; } catch { showToast('Copy is not available in this browser.'); } };
    const note = el('button', 'btn', 'Note'); note.onclick = () => { const text = prompt('Add a note for ' + entry.word); if (text?.trim()) { const notes = store.get('er-notes', []); notes.unshift({ file: currentFileKey, word: entry.word, text: text.trim(), ...getRangeOffsets(reader, currentRange) }); store.set('er-notes', notes.slice(0, 300)); queueCloudSync(); note.textContent = 'Noted'; } };
    actions.append(save, listen, translate, copy, note); kids.push(actions, translation);
    if (entry.phonetic) kids.push(el('p', 'ph', entry.phonetic));
    entry.meanings.forEach((meaning, index) => {
      kids.push(el('p', 'pos', `${index + 1}. ${meaning.partOfSpeech}`), el('p', 'def', meaning.definition));
      if (meaning.example) kids.push(el('p', 'ex', 'Example: ' + meaning.example));
    });
    const synonyms = dictionaryRelated('Synonyms', entry.synonyms), antonyms = dictionaryRelated('Antonyms', entry.antonyms);
    if (synonyms) kids.push(synonyms); if (antonyms) kids.push(antonyms);
    if (entry.etymology) { kids.push(el('p', 'dictionary-label', 'Word history'), el('p', 'note dictionary-etymology', entry.etymology)); }
    const details = [];
    if (entry.sourceUrl) { const link = el('a', 'dictionary-source', entry.source || 'Dictionary source'); link.href = entry.sourceUrl; link.target = '_blank'; link.rel = 'noreferrer'; details.push(link); }
    else if (entry.source) details.push(el('span', 'dictionary-source', entry.source));
    if (result.cached) details.push(el('span', 'dictionary-cache', 'Available offline'));
    if (details.length) { const footer = el('p', 'dictionary-footer'); footer.append(...details); kids.push(footer); }
    if (entry.word.toLowerCase() !== asked) kids.push(el('p', 'note', 'Showing the base form of ' + entry.word + '.'));
  }
  popup.replaceChildren(...kids);
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
