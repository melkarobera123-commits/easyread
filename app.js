const $ = selector => document.querySelector(selector);
const byId = id => document.getElementById(id);
const local = {
  get(key, fallback = null) { try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
};
const loadedScripts = new Map();
let pdfjsLib = null, pdfLibraryPromise = null;
const sources = {
  mammoth: './vendor/mammoth.browser.min.js',
  zip: './vendor/jszip.min.js',
  ocr: 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js',
  firebaseApp: 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  firebaseAuth: 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  firebaseStore: 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  firebaseStorage: 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage-compat.js',
  purifier: './vendor/purify.min.js'
};
function loadScript(url) {
  if (loadedScripts.has(url)) return loadedScripts.get(url);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = url; script.async = true;
    script.onload = resolve; script.onerror = () => { loadedScripts.delete(url); reject(new Error('Could not load a required reader component. Check your internet and try again.')); };
    document.head.append(script);
  });
  loadedScripts.set(url, promise); return promise;
}
function loadLibrary(name) { return loadScript(sources[name]); }
function loadPdfLibrary() {
  if (!pdfLibraryPromise) pdfLibraryPromise = import('./pdfjs/pdf.mjs').then(library => {
    pdfjsLib = library;
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.mjs', document.baseURI).href;
    return pdfjsLib;
  }).catch(error => { pdfLibraryPromise = null; throw new Error(`Could not load the local PDF reader: ${error.message}`); });
  return pdfLibraryPromise;
}

const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('easyread-library-v2', 1);
  request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'key' }); if (!db.objectStoreNames.contains('definitions')) db.createObjectStore('definitions', { keyPath: 'word' }); };
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
function dbRequest(store, mode, action) { return dbPromise.then(db => new Promise((resolve, reject) => { const tx = db.transaction(store, mode), request = action(tx.objectStore(store)); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); })); }
const getBook = key => dbRequest('books', 'readonly', store => store.get(key));
const getBooks = () => dbRequest('books', 'readonly', store => store.getAll());
const putBook = book => dbRequest('books', 'readwrite', store => store.put(book));
const getDefinition = word => dbRequest('definitions', 'readonly', store => store.get(word));
const putDefinition = value => dbRequest('definitions', 'readwrite', store => store.put(value));

const fileInput = byId('file'), drop = byId('drop'), reader = byId('reader'), readerWrap = byId('reader-wrap');
const pdfPages = byId('pdf-pages'), pdfThumbs = byId('pdf-thumbs'), popup = byId('popup');
const STORE_KEYS = { vocabulary: 'er-vocabulary', notes: 'er-notes', highlights: 'er-highlights', bookmarks: 'er-bookmarks', stats: 'er-stats' };
let activeBook = null, activePdf = null, pdfMode = true, documentPageMode = false, zoom = 1, pageCount = 0, lookupController = null, toastTimer, saveTimer, auth = null, firestore = null, storage = null, user = null, installPromptEvent = null;
let pageObserver = null, thumbObserver = null, activePage = 1, pdfTextPromise = null, pdfSearchMatches = [], pdfSearchIndex = -1, searchToken = 0, firebaseInitPromise = null, cloudSyncTimer = null;
let popupReturnFocus = null;
let activeImageWords = [], activeImageElement = null, activeImageUrl = null;
let positionFrame = 0, positionWriteTimer = null, searchDebounceTimer = null;
let activeDictionaryRange = null;
let aiExplainUnavailable = false;
let activeNoteWord = '';
let pdfPreviewsVisible = local.get('er-pdf-previews', false) === true;
let readerTimerInterval = null, readerTimerStart = 0, readerTimerSeconds = 0, readerTimerGoal = 0, readerTimerDay = '', readerTimerRunning = false, readerTimerRecordedSeconds = 0, readerTimerBookKey = null, timerResumeOnVisible = false;
const pdfRenderPromises = new Map();

function toast(message) { const node = byId('toast'); node.textContent = message; node.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 2800); }
function status(message, error = false) { const node = byId('status'); node.textContent = message; node.classList.toggle('err', error); }
function safeText(parent, tag, text, className = '') { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text; parent.append(node); return node; }
function closeOverlayPanels(except='') {
  for (const id of ['library','contents','settings','vocab','stats','privacy','shortcuts','notes-panel']) {
    if (id === except) continue;
    const panel = byId(id);
    if (!panel) continue;
    if (id === 'contents') panel.classList.remove('open');
    else panel.hidden = true;
  }
  byId('contents-btn')?.setAttribute('aria-expanded','false');
  byId('settings-btn')?.setAttribute('aria-expanded','false');
  const libraryBackdrop=byId('library-backdrop');
  if(libraryBackdrop) libraryBackdrop.hidden=true;
}

function setView(view) {
  closeOverlayPanels();
  document.body.dataset.view = view;
  updateDocumentTitle();
  for (const id of ['about-nav','sidebar-about','mobile-about']) byId(id)?.classList.toggle('active', view === 'about');
  for (const id of ['reader-nav','sidebar-reader','mobile-reader']) byId(id)?.classList.toggle('active', view === 'reader');
  if (view === 'reader') readerWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else scrollTo({ top: 0, behavior: 'smooth' });
}

const EASYREAD_ROUTES = new Set(['home', 'library', 'reader', 'notes']);
function routeFromLocation() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const route = path === '/' || path === '/index.html' ? 'home' : path.slice(1);
  return EASYREAD_ROUTES.has(route) ? route : 'home';
}
function navigateToRoute(route, replace = false) {
  if (!EASYREAD_ROUTES.has(route)) route = 'home';
  const path = route === 'home' ? '/home' : '/' + route;
  if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState']({ easyReadRoute: route }, '', path);
  renderRoute(route, replace);
}
function renderRoute(route, replace = false) {
  if (!EASYREAD_ROUTES.has(route)) route = 'home';
  if (route === 'reader' && readerWrap.hidden) {
    route = 'home';
    if (replace) history.replaceState({ easyReadRoute: route }, '', '/home');
    else history.replaceState({ easyReadRoute: route }, '', '/home');
    status('Choose a book to open the Reader.');
  }
  document.body.dataset.route = route;
  byId('library')?.classList.toggle('route-page', route === 'library');
  byId('notes-panel')?.classList.toggle('route-page', route === 'notes');
  byId('library')?.setAttribute('hidden', '');
  byId('notes-panel')?.setAttribute('hidden', '');
  if (route === 'library') {
    setView('about');
    document.body.dataset.route = route;
    showPanel('library', true);
  } else if (route === 'notes') {
    setView('about');
    document.body.dataset.route = route;
    showPanel('notes-panel', true);
    renderMyNotes();
  } else {
    hidePanels();
    setView(route === 'reader' ? 'reader' : 'about');
    document.body.dataset.route = route;
  }
  for (const id of ['about-nav','sidebar-about','mobile-about']) byId(id)?.classList.toggle('active', route === 'home');
  for (const id of ['reader-nav','sidebar-reader','mobile-reader']) byId(id)?.classList.toggle('active', route === 'reader');
  for (const id of ['sidebar-library','mobile-library']) byId(id)?.classList.toggle('active', route === 'library');
  for (const id of ['sidebar-notes','mobile-notes']) byId(id)?.classList.toggle('active', route === 'notes');
  if (route !== 'reader') scrollTo({ top: 0, behavior: 'auto' });
}
function goToUpload() { navigateToRoute('home'); status('Choose a book to open the Reader.'); requestAnimationFrame(() => { drop.scrollIntoView({ behavior: 'smooth', block: 'center' }); drop.focus({ preventScroll: true }); drop.classList.add('guide-focus'); setTimeout(() => drop.classList.remove('guide-focus'), 900); }); }
function closeDictionaryPanel(){const panel=byId('dictionary-panel');if(panel)panel.hidden=true;byId('dictionary-btn')?.setAttribute('aria-expanded','false');}
function showPanel(id, open) { const panel = byId(id); if (!panel) return; closeDictionaryPanel();panel.hidden = open === undefined ? !panel.hidden : !open; if (!panel.hidden) { closeOtherPanels(id); markPanelOpened(id); } if (id === 'library') { const backdrop=byId('library-backdrop'); if(backdrop) backdrop.hidden=panel.hidden; } if (id === 'library' && !panel.hidden) renderLibraryPanel(); if (id === 'vocab' && !panel.hidden) renderVocabulary(); if (id === 'stats' && !panel.hidden) renderStats(); if (id === 'learning' && !panel.hidden) renderLearning(); if (id === 'notes-panel' && !panel.hidden) renderMyNotes(); if (id === 'privacy' && !panel.hidden) renderPrivacyState(); }
function hidePanels() { document.querySelectorAll('.panel, .contents').forEach(panel => { panel.hidden = true; panel.classList.remove('open'); }); const toolsSheet = byId('tools-sheet'); if (toolsSheet) toolsSheet.hidden = true; }

function initNavigation() {
  document.querySelectorAll('.brand, .sidebar-brand').forEach(brand => brand.addEventListener('click', event => { event.preventDefault(); navigateToRoute('home'); }));
  for (const id of ['about-nav','sidebar-about','mobile-about']) byId(id)?.addEventListener('click', () => navigateToRoute('home'));
  for (const id of ['reader-nav','sidebar-reader','mobile-reader']) byId(id)?.addEventListener('click', () => readerWrap.hidden ? goToUpload() : navigateToRoute('reader'));
  for (const id of ['sidebar-library','mobile-library','library-btn','library-home-btn']) byId(id)?.addEventListener('click', event => {
    event.stopPropagation();
    navigateToRoute('library');
  });
  for (const id of ['sidebar-notes','mobile-notes']) byId(id)?.addEventListener('click', () => navigateToRoute('notes'));
  window.addEventListener('popstate', () => renderRoute(routeFromLocation(), true));
  navigateToRoute(routeFromLocation(), true);
  byId('library-backdrop')?.addEventListener('click',()=>showPanel('library',false));
document.addEventListener('pointerdown', event => {
  const library = byId('library');
  if (!library || library.hidden || document.body.dataset.route === 'library') return;
  if (event.target.closest('#library')) return;
  library.hidden = true;
}, true);
  for (const id of ['sidebar-account','mobile-account','account-btn']) byId(id)?.addEventListener('click', openAccount);
  byId('saved-btn')?.addEventListener('click',()=>showPanel('vocab'));
  byId('notes-btn')?.addEventListener('click',()=>{showPanel('notes-panel');renderMyNotes();});
  byId('notes-search')?.addEventListener('input',renderMyNotes);
  for(const id of ['contents-notes-link','vocab-notes-link'])byId(id)?.addEventListener('click',()=>{showPanel('notes-panel');renderMyNotes();});
  const fullDocumentButton = byId('full-document-btn');
  const readerIsFullscreen = () => Boolean(document.fullscreenElement && [readerWrap, pdfPages].includes(document.fullscreenElement));
  const syncFullDocumentButton = () => {
    if (!fullDocumentButton) return;
    const active = readerIsFullscreen();
    // Use a compact exit icon while active; the accessible label still explains the action.
    fullDocumentButton.textContent = active ? '↙' : '⛶ Full document';
    fullDocumentButton.setAttribute('aria-label', active ? 'Exit full document view' : 'Enter full document view');
    fullDocumentButton.setAttribute('title', active ? 'Exit full document view' : 'Enter full document view');
    fullDocumentButton.setAttribute('aria-pressed', String(active));
  };
  fullDocumentButton?.addEventListener('click',async()=>{
    try {
      if (readerIsFullscreen()) {
        await document.exitFullscreen();
        return;
      }
      readerWrap.hidden=false;
      if(activePdf){
        await setPdfMode(true);
        pdfPages.hidden=false;
        if(typeof pdfPages.requestFullscreen!=='function') throw new Error('Fullscreen API unavailable');
        await pdfPages.requestFullscreen();
      } else {
        setDocumentPageMode(false);
        reader.hidden=false;
        if(typeof readerWrap.requestFullscreen!=='function') throw new Error('Fullscreen API unavailable');
        await readerWrap.requestFullscreen();
      }
    } catch(error) {
      console.error('Full-screen document view failed',error);
      toast('Could not open full-screen document view. Try the browser’s fullscreen permission or press Esc to exit.');
    } finally { syncFullDocumentButton(); }
  });
  document.addEventListener('fullscreenchange', syncFullDocumentButton);
  syncFullDocumentButton();
  for (const [id, panel] of [['settings-btn','settings'],['vocab-btn','vocab'],['stats-btn','stats'],['flashcards-btn','learning'],['sidebar-flashcards','learning'],['contact-link','contact'],['privacy-link','privacy'],['shortcuts-link','shortcuts']]) byId(id)?.addEventListener('click', event => { if (id === 'contact-link') event.preventDefault(); showPanel(panel); });
  byId('contents-btn')?.addEventListener('click',()=>{const panel=byId('contents'),open=!panel.classList.contains('open');if(open){closeOtherPanels('contents');markPanelOpened('contents');}panel.hidden=false;panel.classList.toggle('open',open);byId('contents-btn').setAttribute('aria-expanded',String(open));if(open){renderContents();renderSavedItems();}});
  document.querySelectorAll('[id$="-close"]').forEach(button => button.addEventListener('click', () => { const panel = button.closest('aside'); if (panel) showPanel(panel.id, false); if (panel?.id === 'contents') panel.classList.remove('open'); }));
  document.addEventListener('click',event=>{if(!byId('dictionary-panel').hidden&&!event.target.closest('#dictionary-panel,#dictionary-btn'))closeDictionaryPanel();});
  byId('again')?.addEventListener('click', () => { pauseReadingTimer(); readerWrap.hidden = true; navigateToRoute('home'); hidePopup(); });
}


// ---------- Supported file types (also used by the mobile file picker) ----------
const TEXT_EXTS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'text'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const SUPPORTED_EXTS = ['pdf', 'docx', 'pptx', 'epub', 'html', 'rtf', 'odt', 'odp', ...TEXT_EXTS, ...IMAGE_EXTS];
const MIME_TO_EXT = {
  'application/pdf': 'pdf', 'application/epub+zip': 'epub', 'application/rtf': 'rtf', 'text/rtf': 'rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt', 'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/msword': 'doc', 'application/vnd.ms-powerpoint': 'ppt',
  'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'text/tab-separated-values': 'tsv', 'text/html': 'html', 'application/xhtml+xml': 'html',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp'
};
function detectExt(file) {
  const fromName = (file.name.includes('.') ? file.name.split('.').pop() : '').toLowerCase();
  const normalized = fromName === 'htm' || fromName === 'xhtml' ? 'html' : fromName === 'jfif' ? 'jpg' : fromName;
  if (SUPPORTED_EXTS.includes(normalized) || ['doc', 'ppt', 'xls'].includes(normalized)) return normalized;
  // Phones often hand over files with no useful name; fall back to the MIME type.
  return MIME_TO_EXT[String(file.type || '').toLowerCase()] || '';
}
// Notes and logs often use single line breaks only; treat them as paragraphs so pages stay readable.
function spreadLines(text) {
  const value = String(text || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  return /\n[ \t]*\n/.test(value) ? value : value.replace(/\n/g, '\n\n');
}
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script,style,noscript,template,svg,nav,iframe').forEach(node => node.remove());
  const blocks = [...doc.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,tr,dd,dt,figcaption')]
    .filter(node => !node.querySelector('p,li,blockquote,pre,tr'))
    .map(node => node.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return blocks.length ? blocks.join('\n\n') : (doc.body.textContent || '');
}
function rtfToText(rtf) {
  const src = String(rtf || '');
  const skipGroups = /^\\(?:\*\\)?(?:fonttbl|colortbl|stylesheet|info|pict|object|header|footer|themedata|colorschememapping|latentstyles|datastore|generator|listtable|listoverridetable|rsidtbl|xmlnstbl|mmathPr|fldinst)/;
  let out = '', skipDepth = 0, depth = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      depth++;
      if (!skipDepth && skipGroups.test(src.slice(i + 1, i + 40))) skipDepth = depth;
    } else if (ch === '}') {
      if (skipDepth && depth === skipDepth) skipDepth = 0;
      depth--;
    } else if (ch === '\\') {
      const next = src[i + 1];
      if (next === "'") { const hex = src.slice(i + 2, i + 4); if (!skipDepth) out += new TextDecoder('windows-1252').decode(Uint8Array.of(parseInt(hex, 16) || 63)); i += 3; }
      else if (next === '\\' || next === '{' || next === '}') { if (!skipDepth) out += next; i++; }
      else {
        const word = /^\\([a-z]+)(-?\d+)? ?/i.exec(src.slice(i, i + 40));
        if (!word) { i++; continue; }
        if (!skipDepth) {
          if (word[1] === 'par' || word[1] === 'sect' || word[1] === 'page') out += '\n\n';
          else if (word[1] === 'line' || word[1] === 'tab') out += ' ';
          else if (word[1] === 'u' && word[2] !== undefined) { const code = Number(word[2]); out += String.fromCharCode(code < 0 ? code + 65536 : code); if (src[i + word[0].length] === '?') i++; }
        }
        i += word[0].length - 1;
      }
    } else if (!skipDepth && ch !== '\r' && ch !== '\n') out += ch;
  }
  return out.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
}
async function parseOpenDocument(file, ext) {
  await loadLibrary('zip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entry = zip.file('content.xml');
  if (!entry) throw new Error('This OpenDocument file has no readable content.');
  const xml = new DOMParser().parseFromString(await entry.async('text'), 'application/xml');
  const paragraphs = root => [...root.getElementsByTagName('*')].filter(node => node.nodeName === 'text:p' || node.nodeName === 'text:h').map(node => node.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const slides = [...xml.getElementsByTagName('draw:page')];
  if (ext === 'odp' && slides.length) {
    pageCount = slides.length;
    slides.forEach((slide, index) => {
      const section = document.createElement('section'); section.className = 'page'; section.dataset.page = String(index + 1);
      safeText(section, 'div', `Slide ${index + 1}`, 'page-mark');
      const text = paragraphs(slide).join('\n\n'); if (text) appendTextNodes(section, text);
      reader.append(section);
    });
    return;
  }
  appendTextPages(paragraphs(xml).join('\n\n'));
}

async function openFile(file) {
  if (!file) return;
  if (activeImageUrl) URL.revokeObjectURL(activeImageUrl);
  activeImageUrl = null;
  activeImageElement = null;
  activeImageWords = [];
  const ext = detectExt(file);
  if (ext === 'doc' || ext === 'ppt' || ext === 'xls') return status('Old Office files (.doc, .ppt, .xls) cannot be read here. Save or export the file as DOCX, PPTX or PDF and open that.', true);
  if (!ext) return status('This file type is not supported. Choose a PDF, Word, PowerPoint, EPUB, text, HTML, RTF, OpenDocument or image file.', true);
  if (file.size > 150 * 1024 * 1024) return status('This file is larger than 150 MB. Try a smaller copy.', true);
  hidePopup(); reader.replaceChildren(); pdfPages.replaceChildren(); pdfThumbs.replaceChildren();
  pageObserver?.disconnect(); thumbObserver?.disconnect();
  pageObserver=null; thumbObserver=null;
  activePdf = null; pdfTextPromise = null; pdfRenderPromises.clear(); pdfMode = true; documentPageMode = false; byId('pdf-toolbar').hidden = true; byId('pdf-controls').hidden = true; pageCount = 0;
  byId('loading-skeleton').hidden = false; readerWrap.hidden = false; navigateToRoute('reader'); if(byId('document-page-toggle')){byId('document-page-toggle').setAttribute('aria-pressed','false');byId('document-page-toggle').textContent='Split pages';} status(`Preparing ${file.name}…`);
  const key = `${file.name}:${file.size}:${file.lastModified}`;
  activeBook = await getBook(key).catch(() => null) || { key, name: file.name, title: file.name.replace(/\.[^.]+$/, ''), file, type: ext, added: Date.now(), favorite: false, progress: 0 };
  const rememberedPosition = local.get(`er-position:${key}`);
  if (rememberedPosition && rememberedPosition.savedAt > (activeBook.position?.savedAt || 0)) activeBook.position = rememberedPosition;
  activeBook.file = file; activeBook.opened = Date.now(); activeBook.type = ext; updateDocumentTitle();
  try {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => false);
    if (ext === 'pdf') await parsePdf(file);
    else if (ext === 'docx') await parseDocx(file);
    else if (ext === 'pptx') await parsePptx(file);
    else if (ext === 'epub') await parseEpub(file);
    else if (TEXT_EXTS.includes(ext)) appendTextPages(spreadLines(await file.text()));
    else if (ext === 'html') appendTextPages(spreadLines(htmlToText(await file.text())));
    else if (ext === 'rtf') appendTextPages(spreadLines(rtfToText(await file.text())));
    else if (ext === 'odt' || ext === 'odp') await parseOpenDocument(file, ext);
    else await parseImage(file);
    if (!reader.textContent.trim() && ext !== 'pdf') throw new Error('No readable text was found in this file.');
    activeBook.words = wordCount(reader.textContent); await putBook(activeBook); byId('file-name').textContent = activeBook.title; updateDocMeta(); renderLibrary();
    byId('loading-skeleton').hidden = true; status(''); if (activeBook.position) restorePosition(); byId('reader-page-jump').max=String(Math.max(1,pageCount)); byId('reader-page-jump').value=String(activeBook.position?.page||1); syncPageCounter(Number(activeBook.position?.page)||1); byId('text-view-controls').hidden=Boolean(activePdf&&pdfMode); updateDocumentPageControls(); readerTimerBookKey=activeBook.key;readerTimerRecordedSeconds=elapsedReadingSeconds();startReadingTimer(); toast('Book opened. Your reading position will be saved here.');
  } catch (error) { console.error(error); byId('loading-skeleton').hidden = true; status(error.message || 'Could not open this file. It may be damaged or password-protected.', true); }
}
function wordCount(text) { return (text.match(/\S+/g) || []).length; }
function updateDocMeta() { byId('doc-meta').textContent = `${pageCount ? `${pageCount} ${pageCount === 1 ? 'page' : 'pages'} · ` : ''}${(activeBook.words || 0).toLocaleString()} words`;byId('jump').max=String(Math.max(1,pageCount)); }
function appendTextPages(text) { const blocks = String(text).split(/\n\s*\n/).map(part => part.trim()).filter(Boolean); const chunks = []; for (let i = 0; i < blocks.length; i += 20) chunks.push(blocks.slice(i, i + 20)); chunks.forEach((chunk, index) => { const section = document.createElement('section'); section.className = 'page'; section.dataset.page = String(index + 1); safeText(section, 'div', `Section ${index + 1}`, 'page-mark'); chunk.forEach(paragraph => safeText(section, 'p', tidyLeaders(paragraph))); reader.append(section); }); pageCount = chunks.length; }
async function parseDocx(file) { await loadLibrary('mammoth'); const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() }); appendTextPages(result.value); }
async function parsePptx(file) { await loadLibrary('zip'); const zip = await JSZip.loadAsync(await file.arrayBuffer()); const names = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b) => Number(a.match(/slide(\d+)/)[1])-Number(b.match(/slide(\d+)/)[1])); pageCount = names.length; for (let i=0;i<names.length;i++) { const xml = new DOMParser().parseFromString(await zip.file(names[i]).async('text'),'application/xml'); const text = [...xml.getElementsByTagName('a:t')].map(node => node.textContent).join(' ').trim(); const section = document.createElement('section'); section.className='page'; section.dataset.page=String(i+1); safeText(section,'div',`Slide ${i+1}`,'page-mark'); if(text) safeText(section,'p',text); reader.append(section); if(i%12===11) await new Promise(requestAnimationFrame); } }
async function parseEpub(file) { await loadLibrary('zip'); const zip=await JSZip.loadAsync(await file.arrayBuffer()); const container=new DOMParser().parseFromString(await zip.file('META-INF/container.xml').async('text'),'application/xml'); const root=container.querySelector('rootfile')?.getAttribute('full-path'); if(!root) throw new Error('This EPUB has an invalid package file.'); const opf=new DOMParser().parseFromString(await zip.file(root).async('text'),'application/xml'); const title=opf.getElementsByTagNameNS('*','title')[0]?.textContent.trim(); if(title) activeBook.title=title; const base=root.includes('/')?root.slice(0,root.lastIndexOf('/')+1):''; const items=new Map([...opf.querySelectorAll('manifest item')].map(item=>[item.id,item.getAttribute('href')])); let index=0; for(const ref of opf.querySelectorAll('spine itemref')) { const path=items.get(ref.getAttribute('idref')); const entry=path&&zip.file(base+decodeURIComponent(path)); if(!entry) continue; const doc=new DOMParser().parseFromString(await entry.async('text'),'text/html'); const text=doc.body?.textContent||''; if(text.trim()){ const section=document.createElement('section'); section.className='page'; section.dataset.page=String(++index); appendTextNodes(section,text); reader.append(section); } if(index%8===0) await new Promise(requestAnimationFrame); } pageCount=index; }
function appendTextNodes(section,text) { const paragraphs=String(text).split(/\n\s*\n/).map(value=>value.replace(/\s+/g,' ').trim()).filter(Boolean); paragraphs.forEach(value=>safeText(section,'p',value)); }
async function parseImage(file) {
  await loadLibrary('ocr');
  status('Reading image text…');
  const worker = await Tesseract.createWorker('eng');
  try {
    const result = await worker.recognize(file, {
      logger: message => {
        if (message.status === 'recognizing text') status(`Reading image text… ${Math.round(message.progress * 100)}%`);
      }
    });
    activeImageWords = (result.data.words || []).map(item => {
      const text = String(item.text || '').replace(/^[-'’]+|[-'’]+$/g, '').toLowerCase();
      const box = item.bbox || {};
      return {
        word: text,
        x0: Number(box.x0), y0: Number(box.y0),
        x1: Number(box.x1), y1: Number(box.y1)
      };
    }).filter(item => item.word && /[\p{L}\p{M}]/u.test(item.word)
      && Number.isFinite(item.x0) && Number.isFinite(item.y0)
      && item.x1 > item.x0 && item.y1 > item.y0);

    activeImageUrl = URL.createObjectURL(file);
    const figure = document.createElement('figure');
    figure.className = 'image-readable-page readable';
    const image = document.createElement('img');
    image.className = 'image-readable-photo';
    image.src = activeImageUrl;
    image.alt = `Photo of text from ${file.name}. Tap a word in the photo to look it up.`;
    image.draggable = false;
    activeImageElement = image;
    figure.append(image);
    reader.append(figure);

    // Keep recognized text available for reading and selection below the photo.
    appendTextPages(result.data.text);
    if (!activeImageWords.length) status('Photo opened, but no tappable words were detected. Try a clearer, sharper photo.');
  } finally {
    await worker.terminate();
  }
}

async function parsePdf(file) {
  await loadPdfLibrary();
  let pdf; try { pdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise; } catch { throw new Error('Could not open this PDF. It may be damaged or password-protected.'); }
  activePdf=pdf; pageCount=pdf.numPages; zoom=1; pdfPages.hidden=false; pdfThumbs.hidden=!pdfPreviewsVisible; byId('pdf-toolbar').hidden=false; byId('pdf-controls').hidden=false; byId('pdf-mode-btn').textContent='Text view';byId('jump').max=String(pageCount);byId('pdf-preview-toggle').textContent=pdfPreviewsVisible?'Hide previews':'Show previews';byId('pdf-preview-toggle').setAttribute('aria-pressed',String(pdfPreviewsVisible));reader.hidden=true;
  pageObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{ if(entry.isIntersecting){ const page=Number(entry.target.dataset.page); renderPdfPage(page).catch(console.error); } else if(Math.abs(Number(entry.target.dataset.page)-activePage)>1) releasePdfPage(entry.target); }),{rootMargin:'30% 0px'});
  thumbObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{ if(entry.isIntersecting) renderThumbnail(Number(entry.target.dataset.page)); }),{rootMargin:'0px 240px'});
  const pageFragment=document.createDocumentFragment();
  const thumbFragment=document.createDocumentFragment();
  const frames=[];
  const thumbs=[];
  for(let number=1;number<=pdf.numPages;number++){
    const frame=document.createElement('figure');
    frame.className='pdf-page readable';
    frame.dataset.page=String(number);
    const canvas=document.createElement('canvas');
    canvas.setAttribute('aria-label',`PDF page ${number}`);
    const textLayer=document.createElement('div');
    textLayer.className='textLayer';
    frame.append(canvas,textLayer,safeText(document.createElement('div'),'span',`Page ${number}`,'pdf-caption'));
    pageFragment.append(frame);
    frames.push(frame);

    const thumbButton=document.createElement('button');
    thumbButton.className='pdf-thumb';
    thumbButton.type='button';
    thumbButton.dataset.page=String(number);
    thumbButton.setAttribute('aria-label',`Go to page ${number}`);
    safeText(thumbButton,'span',String(number));
    thumbFragment.append(thumbButton);
    thumbs.push(thumbButton);

    if(number%250===0) await new Promise(requestAnimationFrame);
  }
  pdfPages.append(pageFragment);
  pdfThumbs.append(thumbFragment);
  for(const frame of frames) pageObserver.observe(frame);
  for(const thumb of thumbs) thumbObserver.observe(thumb);
  pageCount=pdf.numPages;syncPageCounter(1);
}
pdfThumbs.addEventListener('click',event=>{
  const thumb=event.target.closest('.pdf-thumb');
  if(thumb) goPdfPage(Number(thumb.dataset.page));
});
async function buildPdfTextView(){
  if(!activePdf)return;
  if(pdfTextPromise)return pdfTextPromise;
  pdfTextPromise=(async()=>{reader.replaceChildren();for(let number=1;number<=activePdf.numPages;number++){const page=await activePdf.getPage(number),content=await page.getTextContent(),section=document.createElement('section');section.className='page readable';section.dataset.page=String(number);safeText(section,'div',`Page ${number}`,'page-mark');const lines=[];let line='';for(const item of content.items){if(!item||typeof item.str!=='string')continue;const value=item.str.trim();if(value)line+=(line?' ':'')+value;if(item.hasEOL&&line){lines.push(line);line='';}}if(line)lines.push(line);const textLines=lines.length?lines:[content.items.map(item=>item?.str||'').join(' ').trim()];for(const value of textLines){if(value)safeText(section,'p',tidyLeaders(value));}reader.append(section);if(number%8===0)await new Promise(requestAnimationFrame);}return true;})();
  try{return await pdfTextPromise;}catch(error){pdfTextPromise=null;throw error;}
}
function pageScale(page) { const base=page.getViewport({scale:1}); const fit=Math.min((pdfPages.clientWidth-36)/base.width,1.5); return Math.max(.3,fit*zoom); }
async function renderPdfPage(number) {
  const pdf=activePdf, frame=pdfPages.querySelector(`[data-page="${number}"]`);
  if(!pdf||!frame||frame.dataset.rendered==='yes') return;
  if(pdfRenderPromises.has(frame)) return pdfRenderPromises.get(frame);
  const task=drawPdfPage(pdf,number,frame);
  pdfRenderPromises.set(frame,task);
  let rendered=false;
  try { await task; frame.dataset.rendered='yes'; rendered=true; }
  finally { pdfRenderPromises.delete(frame); }
  if(rendered&&frame.dataset.releaseAfterRender==='yes') { releasePdfPage(frame); pageObserver?.unobserve(frame); pageObserver?.observe(frame); }
}
async function buildFallbackPdfTextLayer(page, layer, viewport) {
  const textContent = await page.getTextContent({
    includeMarkedContent: true,
    disableNormalization: true
  });
  const fragment = document.createDocumentFragment();

  for (const item of textContent.items) {
    if (!item.str) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.max(Math.hypot(tx[2], tx[3]), 1);
    const span = document.createElement('span');
    span.textContent = item.str;
    span.style.position = 'absolute';
    span.style.left = `${tx[4]}px`;
    span.style.top = `${tx[5] - fontHeight}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.lineHeight = '1';
    span.style.fontFamily = 'sans-serif';
    span.style.whiteSpace = 'pre';
    span.style.color = 'transparent';
    span.style.cursor = 'text';
    span.style.userSelect = 'text';
    span.style.webkitUserSelect = 'text';
    span.style.transformOrigin = '0 0';
    span.dataset.pdfWidth = String(item.width || 0);
    fragment.append(span);
  }

  layer.append(fragment);

  for (const span of layer.querySelectorAll('span')) {
    const renderedWidth = span.getBoundingClientRect().width;
    const targetWidth = Number(span.dataset.pdfWidth || 0) * viewport.scale;
    if (renderedWidth > 0 && targetWidth > 0) {
      span.style.transform = `scaleX(${Math.max(.01, targetWidth / renderedWidth)})`;
    }
  }
}

function pdfPointInQuad(x, y, quad) {
  let sign = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i], b = quad[(i + 1) % quad.length];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(cross) < 0.01) continue;
    const current = Math.sign(cross);
    if (!sign) sign = current;
    else if (current !== sign) return false;
  }
  return true;
}

function pdfItemQuad(viewport, item) {
  const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const width = Number(item.width || 0) * viewport.scale;
  const aLen = Math.max(Math.hypot(tx[0], tx[1]), 1);
  const dLen = Math.max(Math.hypot(tx[2], tx[3]), 1);
  const ux = { x: tx[0] / aLen, y: tx[1] / aLen };
  const uy = { x: tx[2] / dLen, y: tx[3] / dLen };
  const origin = { x: tx[4], y: tx[5] };
  const height = dLen;
  return [
    origin,
    { x: origin.x + ux.x * width, y: origin.y + ux.y * width },
    { x: origin.x + ux.x * width + uy.x * height, y: origin.y + ux.y * width + uy.y * height },
    { x: origin.x + uy.x * height, y: origin.y + uy.y * height }
  ];
}

async function buildPdfGeometryIndex(page, frame, viewport) {
  const content = await page.getTextContent({
    includeMarkedContent: true,
    disableNormalization: true
  });
  frame._pdfViewportWidth = viewport.width;
  frame._pdfWordBoxes = buildPdfWordBoxes(content, viewport);
  const layer = frame.querySelector('.textLayer');
  const spans = [...layer.querySelectorAll('span:not(.markedContent)')].filter(span => span.firstChild?.nodeType === Node.TEXT_NODE);
  const items = content.items.filter(item => typeof item?.str === 'string' && item.str);
  const index = [];
  let spanIndex = 0;

  for (const item of items) {
    let span = spans[spanIndex];
    while (span && span.textContent !== item.str && spanIndex + 1 < spans.length) {
      span = spans[++spanIndex];
    }
    if (!span) break;
    const quad = pdfItemQuad(viewport, item);
    index.push({ item, quad, span });
    spanIndex++;
  }
  frame._pdfGeometryIndex = index;
}

const pdfMeasureCtx = document.createElement('canvas').getContext('2d');
let activePdfWordMarker = null;

// Builds one exact box per word straight from PDF coordinates, so taps do not
// depend on how the browser lays out the invisible text-layer spans.
function buildPdfWordBoxes(content, viewport) {
  const boxes = [];
  const wordPattern = /[-'’\p{L}\p{M}]+/gu;
  for (const item of content.items) {
    const text = item?.str;
    if (typeof text !== 'string' || !text.trim() || !item.transform) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const aLen = Math.hypot(tx[0], tx[1]);
    const dLen = Math.hypot(tx[2], tx[3]);
    const width = Number(item.width || 0) * viewport.scale;
    if (aLen < 0.01 || dLen < 0.01 || width <= 0) continue;
    const ux = { x: tx[0] / aLen, y: tx[1] / aLen };
    const uy = { x: tx[2] / dLen, y: tx[3] / dLen };
    const style = content.styles?.[item.fontName] || {};
    let total = 0;
    if (!style.vertical) {
      pdfMeasureCtx.font = `100px ${style.fontFamily || 'sans-serif'}`;
      total = pdfMeasureCtx.measureText(text).width;
    }
    const at = index => total > 0
      ? pdfMeasureCtx.measureText(text.slice(0, index)).width / total * width
      : index / text.length * width;

    wordPattern.lastIndex = 0;
    let match;
    while ((match = wordPattern.exec(text))) {
      const word = match[0].replace(/^[-'’]+|[-'’]+$/g, '').toLowerCase();
      if (!word) continue;
      boxes.push({
        word,
        ox: tx[4], oy: tx[5], ux, uy, h: dLen,
        t0: at(match.index), t1: at(match.index + match[0].length)
      });
    }
  }
  return boxes;
}

function clearPdfWordMarker() {
  activePdfWordMarker?.remove();
  activePdfWordMarker = null;
}

function pdfWordHitAt(frame, x, y) {
  const boxes = frame._pdfWordBoxes;
  const canvas = frame.querySelector('canvas');
  if (!boxes?.length || !canvas) return null;
  const canvasRect = canvas.getBoundingClientRect();
  if (!canvasRect.width) return null;
  const ratio = (frame._pdfViewportWidth || canvasRect.width) / canvasRect.width;
  const px = (x - canvasRect.left) * ratio;
  const py = (y - canvasRect.top) * ratio;

  let best = null;
  let bestScore = Infinity;
  for (const box of boxes) {
    const dx = px - box.ox, dy = py - box.oy;
    const t = dx * box.ux.x + dy * box.ux.y;
    const s = dx * box.uy.x + dy * box.uy.y;   // positive = above the baseline
    const dt = t < box.t0 ? box.t0 - t : t > box.t1 ? t - box.t1 : 0;
    const low = -0.28 * box.h, high = box.h;
    const ds = s < low ? low - s : s > high ? s - high : 0;
    const dist = Math.hypot(dt, ds);
    // Small touch allowance so a fingertip just beside a word still picks it.
    const tolerance = Math.min(Math.max(7 * ratio, 0.3 * box.h), 14 * ratio);
    if (dist > tolerance) continue;
    const score = dist + 0.01 * Math.abs(s - 0.35 * box.h);
    if (score < bestScore) { bestScore = score; best = box; }
  }
  if (!best) return null;

  const layer = frame.querySelector('.textLayer');
  if (!layer) return null;
  clearPdfWordMarker();
  const top = best.h, bottom = 0.28 * best.h;
  const marker = document.createElement('div');
  marker.className = 'pdf-word-hit';
  marker.style.cssText =
    `position:absolute;left:0;top:0;pointer-events:none;z-index:0;` +
    `width:${best.t1 - best.t0}px;height:${top + bottom}px;transform-origin:0 0;` +
    `transform:matrix(${best.ux.x},${best.ux.y},${-best.uy.x},${-best.uy.y},` +
    `${best.ox + best.ux.x * best.t0 + best.uy.x * top},` +
    `${best.oy + best.ux.y * best.t0 + best.uy.y * top})`;
  layer.append(marker);
  activePdfWordMarker = marker;
  const range = document.createRange();
  range.selectNode(marker);
  return { word: best.word, range };
}

function buildPdfWordIndex(frame) {
  const layer = frame.querySelector('.textLayer');
  if (!layer) {
    frame._pdfWordIndex = [];
    return;
  }

  const words = [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const wordPattern = /[-'’\p{L}\p{M}]+/gu;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.data.trim() || node.parentElement?.closest('.endOfContent')) continue;

    wordPattern.lastIndex = 0;
    let match;
    while ((match = wordPattern.exec(node.data))) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);

      const rects = [...range.getClientRects()].filter(rect =>
        rect.width > 0 && rect.height > 0
      );
      if (!rects.length) continue;

      words.push({
        word: match[0].replace(/^[-'’]+|[-'’]+$/g, '').toLowerCase(),
        range: range.cloneRange()
      });
    }
  }

  frame._pdfWordIndex = words;
}

async function drawPdfPage(pdf,number,frame) {
  const page=await pdf.getPage(number),
    scale=pageScale(page),
    viewport=page.getViewport({scale}),
    desiredDpr=Math.min(devicePixelRatio||1,2),
    pixelBudget=12_000_000,
    dpr=Math.min(desiredDpr,Math.max(.5,Math.sqrt(pixelBudget/(viewport.width*viewport.height)))),
    canvas=frame.querySelector('canvas'),
    context=canvas.getContext('2d',{alpha:false});

  canvas.width=Math.round(viewport.width*dpr);
  canvas.height=Math.round(viewport.height*dpr);
  canvas.style.width=`${viewport.width}px`;
  canvas.style.height=`${viewport.height}px`;
  frame.style.minHeight=`${viewport.height+48}px`;

  const renderViewport=page.getViewport({scale:scale*dpr});
  await page.render({canvasContext:context,viewport:renderViewport}).promise;

  const layer=frame.querySelector('.textLayer');
  unregisterPdfSelectionLayer(layer);
  layer.replaceChildren();
  // Align the selectable layer to the canvas's actual screen geometry.
  const frameRect = frame.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const frameStyle = getComputedStyle(frame);
  const borderLeft = parseFloat(frameStyle.borderLeftWidth) || 0;
  const borderTop = parseFloat(frameStyle.borderTopWidth) || 0;
  layer.style.inset = 'auto';
  layer.style.left = `${canvasRect.left - frameRect.left - borderLeft}px`;
  layer.style.top = `${canvasRect.top - frameRect.top - borderTop}px`;
  layer.style.width = `${canvasRect.width}px`;
  layer.style.height = `${canvasRect.height}px`;
  layer.style.setProperty('--total-scale-factor',String(scale));
  layer.style.setProperty('--scale-factor',String(scale));

  try {
    const textContentSource=page.streamTextContent({
      includeMarkedContent:true,
      disableNormalization:true
    });
    const textLayer=new pdfjsLib.TextLayer({
      textContentSource,
      container:layer,
      viewport
    });
    await textLayer.render();
    // PDF.js sizes the layer with CSS round(); older browsers ignore that and collapse it to zero width. Pin it to the canvas.
    layer.style.width = `${canvasRect.width}px`;
    layer.style.height = `${canvasRect.height}px`;

    if (!layer.querySelector('span')) {
      await buildFallbackPdfTextLayer(page,layer,viewport);
    }
  } catch(error) {
    console.warn('PDF.js text layer failed, using selectable fallback',error);
    layer.replaceChildren();
    try {
      await buildFallbackPdfTextLayer(page,layer,viewport);
    } catch(fallbackError) {
      console.warn('PDF fallback text layer failed',fallbackError);
    }
  }

  await buildPdfGeometryIndex(page, frame, viewport).catch(error => console.warn('PDF geometry index unavailable', error));
  registerPdfSelectionLayer(layer);
}
function releasePdfPage(frame) { if(pdfRenderPromises.has(frame)){frame.dataset.releaseAfterRender='yes';return;} if(frame.dataset.rendered!=='yes') return; const canvas=frame.querySelector('canvas'), layer=frame.querySelector('.textLayer'); unregisterPdfSelectionLayer(layer); canvas.width=0; canvas.height=0; layer.replaceChildren(); frame.dataset.rendered=''; delete frame.dataset.releaseAfterRender; }
async function renderThumbnail(number) { const button=pdfThumbs.querySelector(`[data-page="${number}"]`); if(!button||button.dataset.rendered) return; try { const page=await activePdf.getPage(number), viewport=page.getViewport({scale:.11}), canvas=document.createElement('canvas'); canvas.width=viewport.width*2; canvas.height=viewport.height*2; canvas.style.width='56px'; await page.render({canvasContext:canvas.getContext('2d'),viewport:page.getViewport({scale:.22})}).promise; button.prepend(canvas); button.dataset.rendered='yes'; } catch {} }
function syncPageCounter(page=activePage){const input=byId('reader-page-jump');if(input)input.value=String(page);const total=byId('reader-page-total');if(total)total.textContent=pageCount?`of ${pageCount}`:'';}
function goPdfPage(number) { const page=Math.min(pageCount,Math.max(1,Number(number)||1)),target=pdfPages.querySelector(`[data-page="${page}"]`);if(!target)return;activePage=page;byId('pdf-page-label').textContent=`Page ${page} of ${pageCount}`;syncPageCounter(page);target.scrollIntoView({behavior:'smooth',block:'start'}); }
async function setPdfMode(visual) {
  closeDictionaryPanel();
  pdfMode=visual;
  reader.classList.toggle('pdf-text-reader', !visual);
  pdfPages.hidden=!visual;
  pdfThumbs.hidden=!visual||!pdfPreviewsVisible;
  byId('pdf-controls').hidden=!visual;
  reader.hidden=visual;
  byId('pdf-mode-btn').textContent=visual?'Text view':'Page view';
  if(byId('reader-page-jump')) byId('reader-page-jump').value=String(activePage||1);
  if(byId('text-view-controls')) byId('text-view-controls').hidden=visual;
  if(!visual&&activePdf){
    try { await buildPdfTextView(); }
    catch { toast('Could not prepare the text view.'); }
  }
  updateDocumentPageControls();
}
function scalePdf(amount) { zoom=Math.min(2.4,Math.max(.65,zoom+amount)); pdfPages.querySelectorAll('.pdf-page[data-rendered="yes"]').forEach(releasePdfPage); pdfPages.querySelectorAll('.pdf-page').forEach(frame=>{ if(pageObserver) pageObserver.unobserve(frame); pageObserver?.observe(frame); }); }

// Re-render the original PDF pages when entering or leaving fullscreen. The page canvas
// must be laid out at the new available width, rather than stretching a previously rendered
// canvas or switching to the extracted-text reading view.
document.addEventListener('fullscreenchange', () => {
  if (!activePdf || !pdfPages) return;
  if (document.fullscreenElement && document.fullscreenElement !== pdfPages) return;
  requestAnimationFrame(() => {
    const frames = [...pdfPages.querySelectorAll('.pdf-page')];
    for (const frame of frames) {
      releasePdfPage(frame);
      frame.style.minHeight = '';
      pageObserver?.unobserve(frame);
      pageObserver?.observe(frame);
    }
    const current = pdfPages.querySelector(`[data-page="${activePage}"]`);
    if (current) renderPdfPage(activePage).catch(console.error);
  });
});

const pdfSelectionLayers = new Map();

function unregisterPdfSelectionLayer(layer) {
  if (!layer) return;
  const end = pdfSelectionLayers.get(layer);
  pdfSelectionLayers.delete(layer);
  end?.remove();
  layer.classList.remove('selecting');
}

function registerPdfSelectionLayer(layer) {
  if (!layer) return;
  unregisterPdfSelectionLayer(layer);
  const end = document.createElement('div');
  end.className = 'endOfContent';
  layer.append(end);
  pdfSelectionLayers.set(layer, end);

  if (!layer.dataset.selectionBound) {
    layer.dataset.selectionBound = 'yes';

    layer.addEventListener('copy', event => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
      event.clipboardData?.setData('text/plain', selection.toString().normalize());
      event.preventDefault();
    });
  }
}

document.addEventListener('selectionchange', () => {
  const selection = document.getSelection();
  pdfSelectionLayers.forEach((end, layer) => {
    const active = Boolean(
      selection &&
      !selection.isCollapsed &&
      selection.rangeCount &&
      [...Array(selection.rangeCount)].some((_, index) => {
        try { return selection.getRangeAt(index).intersectsNode(layer); }
        catch { return false; }
      })
    );
    layer.classList.toggle('selecting', active);
  });
});

function pdfTextNodeAtPoint(x, y) {
  const point = document.caretPositionFromPoint?.(x, y);
  if (point?.offsetNode?.nodeType === Node.TEXT_NODE) {
    return { node: point.offsetNode, index: point.offset || 0 };
  }
  const range = document.caretRangeFromPoint?.(x, y);
  if (range?.startContainer?.nodeType === Node.TEXT_NODE) {
    return { node: range.startContainer, index: range.startOffset || 0 };
  }
  return null;
}

function wordRangeAtNode(node, x, y, caretIndex = null) {
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.data.trim()) return null;
  const text = node.data;
  const wordPattern = /[-'’\p{L}\p{M}]+/gu;
  const words = [];
  let match;
  while ((match = wordPattern.exec(text))) {
    const range = document.createRange();
    range.setStart(node, match.index);
    range.setEnd(node, match.index + match[0].length);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    words.push({ word: match[0], range, start: match.index, end: match.index + match[0].length, rects });
    for (const rect of rects) {
      if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 3 && y <= rect.bottom + 3) {
        return { word: match[0].replace(/^[-'’]+|[-'’]+$/g, '').toLowerCase(), range };
      }
    }
  }
  // Mobile browser caret APIs sometimes report the closest insertion point
  // just outside a glyph's rectangle. If so, use its character offset, but
  // only when the tap is still on that same rendered text line.
  if (Number.isInteger(caretIndex)) {
    const candidates = words.filter(item => caretIndex >= item.start - 1 && caretIndex <= item.end + 1);
    for (const item of candidates) {
      if (!item.rects.length) continue;
      const nearLine = item.rects.some(rect => y >= rect.top - 7 && y <= rect.bottom + 7);
      if (nearLine) return { word: item.word.replace(/^[-'’]+|[-'’]+$/g, '').toLowerCase(), range: item.range };
    }
  }
  return null;
}
function wordAt(x, y) {
  // In the full-document PDF text view, hit-test the actual rendered text.
  // This uses browser layout coordinates after responsive resizing, so a
  // narrow/mobile layout cannot shift the selected word away from the tap.
  if (!reader.hidden && reader.classList.contains('pdf-text-reader')) {
    const textTarget = document.elementsFromPoint(x, y).find(element =>
      element.closest?.('#reader .page.readable p, #reader .page.readable')
    );
    if (textTarget) {
      const caret = pdfTextNodeAtPoint(x, y);
      if (caret?.node && reader.contains(caret.node)) {
        const exact = wordRangeAtNode(caret.node, x, y, caret.index);
        if (exact?.word) return exact;
      }
      // Do not fall through to PDF-page coordinate guesses in text view.
      return null;
    }
  }

  // Map the touch point on a photo to Tesseract's original OCR word boxes.
  // Strict bounds avoid selecting a neighboring word when tapping whitespace.
  if (activeImageElement?.isConnected && activeImageWords.length) {
    const rect = activeImageElement.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0
      && x >= rect.left && x <= rect.right
      && y >= rect.top && y <= rect.bottom) {
      const imageX = (x - rect.left) * activeImageElement.naturalWidth / rect.width;
      const imageY = (y - rect.top) * activeImageElement.naturalHeight / rect.height;
      let best = null;
      let bestArea = Infinity;
      for (const item of activeImageWords) {
        if (imageX < item.x0 || imageX > item.x1 || imageY < item.y0 || imageY > item.y1) continue;
        const area = (item.x1 - item.x0) * (item.y1 - item.y0);
        if (area < bestArea) { best = item; bestArea = area; }
      }
      return best ? { word: best.word, range: null } : null;
    }
  }

  const page = [...pdfPages.querySelectorAll('.pdf-page')].find(candidate => {
    const rect = candidate.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  });

  // Prefer the actual text under the pointer. This prevents a nearby PDF
  // geometry box from winning when the user taps the next word or a space.
  const elements = document.elementsFromPoint(x, y);
  const span = elements.find(element =>
    element.matches?.('.pdf-page .textLayer span:not(.markedContent)')
  );
  if (span?.firstChild?.nodeType === Node.TEXT_NODE) {
    const exact = wordRangeAtNode(span.firstChild, x, y);
    if (exact?.word) return exact;
  }

  const caret = pdfTextNodeAtPoint(x, y);
  if (caret?.node) {
    const exact = wordRangeAtNode(caret.node, x, y);
    if (exact?.word) return exact;
  }

  // Use PDF-coordinate hit testing only as a fallback for text whose browser
  // text-layer geometry cannot be resolved at the touched point.
  if (page) return pdfWordHitAt(page, x, y);
  return null;
}

let pdfTapStart = null;
let suppressPdfClick = false;

function handleReadableTap(event, options = {}) {
  if (event.target.closest('button,a,input,select,textarea,#popup,.pdf-thumb')) return;
  const readable = event.target.closest('.readable');
  if (!readable) return;
  const selection = getSelection();
  // In text view, mobile browsers can create a temporary word selection on a
  // single tap. Prefer the tapped word unless the user is actively selecting text.
  if (selection && !selection.isCollapsed && !options.singleTapTextView) return;
  const hit = wordAt(event.clientX, event.clientY);
  if (hit) {
    if (options.singleTapTextView && selection && !selection.isCollapsed) selection.removeAllRanges();
    showWord(hit);
  } else hidePopup();
}

// Handle a single touch/pen tap directly in extracted-text view before the browser's
// synthetic click or automatic word selection can make the first tap appear ignored.
let textViewTapStart = null;
reader.addEventListener('pointerdown', event => {
  if (reader.hidden || !reader.classList.contains('pdf-text-reader')) return;
  if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
  if (event.target.closest('button,a,input,select,textarea,#popup')) return;
  textViewTapStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
}, { passive: true });
reader.addEventListener('pointerup', event => {
  if (!textViewTapStart || event.pointerId !== textViewTapStart.pointerId) return;
  const distance = Math.hypot(event.clientX - textViewTapStart.x, event.clientY - textViewTapStart.y);
  textViewTapStart = null;
  if (distance > 12 || reader.hidden || !reader.classList.contains('pdf-text-reader')) return;
  if (!event.target.closest('#reader .page.readable')) return;
  suppressPdfClick = true;
  handleReadableTap(event, { singleTapTextView: true });
  setTimeout(() => { suppressPdfClick = false; }, 350);
}, { passive: true });
reader.addEventListener('pointercancel', () => { textViewTapStart = null; }, { passive: true });

pdfPages.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
  if (event.target.closest('button,a,input,select,textarea,#popup,.pdf-thumb')) return;
  pdfTapStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
}, { passive: true });

pdfPages.addEventListener('pointerup', event => {
  if (!pdfTapStart || event.pointerId !== pdfTapStart.pointerId) return;
  const distance = Math.hypot(event.clientX - pdfTapStart.x, event.clientY - pdfTapStart.y);
  pdfTapStart = null;
  if (distance > 12) return;
  const readable = event.target.closest('.readable');
  if (!readable) return;
  const selection = getSelection();
  if (selection && !selection.isCollapsed) return;
  suppressPdfClick = true;
  handleReadableTap(event);
  setTimeout(() => { suppressPdfClick = false; }, 350);
}, { passive: true });

pdfPages.addEventListener('pointercancel', () => { pdfTapStart = null; }, { passive: true });

document.addEventListener('click', event => {
  if (suppressPdfClick && event.target.closest('.pdf-page')) return;
  handleReadableTap(event);
});
document.addEventListener('dblclick',event=>{if(event.target.closest('button,a,input,select,textarea,#popup,.pdf-thumb'))return;const readable=event.target.closest('.readable'),selection=getSelection();if(!readable||!selection||selection.isCollapsed)return;const selected=selection.toString().trim().match(/^[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*$/u);if(selected)showWord({word:selected[0].toLowerCase(),range:selection.getRangeAt(0).cloneRange()});});
function popupShell(word,message){popup.replaceChildren();const close=safeText(popup,'button','×','close');close.type='button';close.setAttribute('aria-label','Close definition');close.addEventListener('click',hidePopup);const heading=safeText(popup,'h2',word);heading.id='popup-word';popup.setAttribute('aria-labelledby','popup-word');if(message)safeText(popup,'p',message,'note');}
async function showWord(hit,options={}){const word=String(hit.word||'').trim().toLowerCase();if(!word)return;lookupController?.abort();lookupController=new AbortController();popupReturnFocus=options.returnFocus||document.activeElement;const range=hit.range||null;activeDictionaryRange=range?range.cloneRange():null;if(range&&CSS.highlights)CSS.highlights.set('picked',new Highlight(range));popup.hidden=false;popupShell(word,'Looking up…');placePopup(range);if(options.focus)popup.querySelector('.close')?.focus();try{const result=await define(word,lookupController.signal),clean={...result,meanings:result.meanings.map(item=>({...item,definition:plainDefinition(item.definition),example:plainDefinition(item.example)}))};renderDefinition(clean,word);popup.setAttribute('aria-labelledby','popup-word');popup.querySelector('h2').id='popup-word';popup.querySelector('.close')?.setAttribute('aria-label','Close definition');placePopup(range);if(options.focus)popup.querySelector('.close')?.focus();}catch(error){if(error.name==='AbortError')return;popupShell(word,error.message||'Could not load this definition.');placePopup(range);if(options.focus)popup.querySelector('.close')?.focus();}}
function submitDictionaryQuery(event){event.preventDefault();const input=byId('dictionary-query'),word=input.value.trim().toLowerCase();if(!/^[a-z][a-z'-]{0,59}$/.test(word)){input.setCustomValidity('Enter one English word using letters, apostrophes, or hyphens.');input.reportValidity();return;}input.setCustomValidity('');showWord({word,range:null},{focus:true,returnFocus:input});}
function hidePopup(){clearPdfWordMarker();lookupController?.abort();popup.hidden=true;activeDictionaryRange=null;if(CSS.highlights)CSS.highlights.delete('picked');const target=popupReturnFocus;popupReturnFocus=null;if(target&&target!==document.body&&target.isConnected)target.focus({preventScroll:true});}
function placePopup(range){
  const fullscreenLayer=popup.dataset.fullscreenLayer==='true';
  const mobile=matchMedia('(max-width: 640px)').matches;
  const host=fullscreenLayer?popup.parentElement:null;
  const hostRect=host?.getBoundingClientRect();
  const viewportWidth=fullscreenLayer&&hostRect?hostRect.width:innerWidth;
  const viewportHeight=fullscreenLayer&&hostRect?hostRect.height:innerHeight;
  const originX=fullscreenLayer&&hostRect?hostRect.left:0;
  const originY=fullscreenLayer&&hostRect?hostRect.top:0;
  popup.style.position=fullscreenLayer?'absolute':'fixed';
  popup.style.right='auto';popup.style.bottom='auto';popup.style.transform='none';
  popup.style.left='10px';popup.style.top='10px';
  popup.classList.toggle('dictionary-search-popup',!range);
  if(!range){
    popup.style.left=mobile?'10px':'50%';
    popup.style.top=mobile?'12px':'18vh';
    popup.style.transform=mobile?'none':'translateX(-50%)';
    popup.style.right=mobile?'10px':'auto';
    return;
  }
  popup.classList.remove('dictionary-search-popup');
  const rect=range.getBoundingClientRect();
  const width=Math.min(popup.offsetWidth||350,viewportWidth-20);
  const height=Math.min(popup.offsetHeight||180,viewportHeight-20);
  const gap=10,edge=mobile?10:12;
  const x=Math.max(edge,Math.min(rect.left-originX,viewportWidth-width-edge));
  const below=rect.bottom-originY+gap,above=rect.top-originY-height-gap;
  let y=below;
  if(below+height>viewportHeight-edge&&above>=edge)y=above;
  else if(below+height>viewportHeight-edge)y=Math.max(edge,viewportHeight-height-edge);
  popup.style.left=`${x}px`;
  popup.style.top=`${Math.max(edge,Math.min(y,viewportHeight-height-edge))}px`;
}
function plainDefinition(value){let text=String(value||'');for(let attempt=0;attempt<2;attempt++){const parsed=new DOMParser().parseFromString(text,'text/html');parsed.querySelectorAll('script,style,template').forEach(node=>node.remove());const next=parsed.body.textContent||'';if(next===text)break;text=next;}return text.replace(/\s+/g,' ').trim();}
const FALLBACK_DEFINITIONS = {
  ominous: { word: 'ominous', phonetic: '/ˈɒmɪnəs/', meanings: [{ partOfSpeech: 'adjective', definition: 'giving the impression that something bad or unpleasant is going to happen.', example: 'The sky looked ominous before the storm.' }] },
  gentle: { word: 'gentle', phonetic: '/ˈdʒentəl/', meanings: [{ partOfSpeech: 'adjective', definition: 'mild, calm, and not harsh or severe.', example: 'She used a gentle tone with the children.' }] },
  read: { word: 'read', phonetic: '/riːd/', meanings: [{ partOfSpeech: 'verb', definition: 'look at and understand the meaning of written or printed words or symbols.', example: 'I read a chapter before bed.' }] },
  calm: { word: 'calm', phonetic: '/kɑːm/', meanings: [{ partOfSpeech: 'adjective', definition: 'not showing or feeling nervousness, anger, or anxiety.', example: 'He remained calm during the debate.' }] }
};

// ---------- Network helpers: every request gets a timeout so the UI never hangs on a weak connection ----------
function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const outer = options.signal;
  const onAbort = () => controller.abort();
  if (outer) { if (outer.aborted) controller.abort(); else outer.addEventListener('abort', onAbort, { once: true }); }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).catch(error => {
    if (timedOut && !(outer && outer.aborted)) throw new Error('The connection is slow right now. Please try again.');
    throw error;
  }).finally(() => { clearTimeout(timer); outer?.removeEventListener('abort', onAbort); });
}
const definitionMemory = new Map();
const translationMemory = new Map();
async function define(word,signal){
  const stem=String(word||'').trim().toLowerCase().replace(/\s+/g,'_');
  if(definitionMemory.has(stem))return {...definitionMemory.get(stem),cached:true};
  const cached=await getDefinition(stem).catch(()=>null);
  const cachedResult=cached?.result||cached;
  if(cachedResult?.meanings?.length){definitionMemory.set(stem,cachedResult);return {...cachedResult,cached:true};}
  if(signal?.aborted)throw new DOMException('Lookup cancelled.','AbortError');
  try {
    if(!navigator.onLine)throw new Error('offline');
    const response=await fetchWithTimeout('/api/definition?word='+encodeURIComponent(stem),{signal,headers:{accept:'application/json'}},7000);
    if(response.ok){
      const result=await response.json();
      definitionMemory.set(stem,result);
      putDefinition({word:stem,result}).catch(()=>{});
      return result;
    }
    if(response.status!==404)throw new Error('Dictionary lookup is temporarily unavailable.');
  } catch(error) {
    if(error.name==='AbortError')throw error;
    if(/slow/.test(error.message||'')&&!FALLBACK_DEFINITIONS[stem])throw error;
    const fallback=FALLBACK_DEFINITIONS[stem];
    if(fallback){await putDefinition({word:stem,result:{...fallback,source:'Built-in'}}).catch(()=>{});return {...fallback,source:'Built-in'};}
    throw new Error('You are offline and this word has not been cached yet. Connect once to add it to your offline dictionary.');
  }
  const fallback=FALLBACK_DEFINITIONS[stem];
  if(fallback){const result={...fallback,source:'Built-in'};await putDefinition({word:stem,result}).catch(()=>{});return result;}
  throw new Error(`No definition found for “${stem.replace(/_/g,' ')}”. Try checking the spelling or search another word.`);
}
// ---------- Optional AI "Explain simply" (Gemini via /api/explain; the key stays on the server) ----------
const aiExplainCache = new Map();
function sentenceAroundRange(range) {
  try {
    if (!range) return '';
    const start = range.startContainer;
    const element = start.nodeType === Node.TEXT_NODE ? start.parentElement : start;
    const block = element?.closest?.('p,li,blockquote,h1,h2,h3,.page,.pdf-page') || element;
    if (!block) return '';
    const before = document.createRange();
    before.setStart(block, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const full = block.textContent.replace(/\s+/g, ' ');
    const at = Math.min(before.toString().replace(/\s+/g, ' ').length, full.length);
    let from = Math.max(full.lastIndexOf('. ', at), full.lastIndexOf('? ', at), full.lastIndexOf('! ', at));
    from = from < 0 ? Math.max(0, at - 150) : from + 2;
    const tails = ['. ', '? ', '! '].map(mark => full.indexOf(mark, at)).filter(index => index >= 0);
    const to = tails.length ? Math.min(...tails) + 1 : Math.min(full.length, at + 150);
    return full.slice(Math.max(from, at - 220), Math.min(to, at + 220)).trim();
  } catch { return ''; }
}
async function fetchAiExplanation(word, context, signal) {
  const key = word + '|' + context;
  if (aiExplainCache.has(key)) return aiExplainCache.get(key);
  const response = await fetchWithTimeout('/api/explain?word=' + encodeURIComponent(word) + '&context=' + encodeURIComponent(context), { signal }, 12000);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) { const error = new Error(data.error || 'AI explain is unavailable right now.'); error.notConfigured = Boolean(data.notConfigured); throw error; }
  aiExplainCache.set(key, data.explanation);
  return data.explanation;
}
function renderDefinition(result,asked){
  popup.replaceChildren();
  const close=safeText(popup,'button','×','close');
  close.type='button';
  close.setAttribute('aria-label','Close definition');
  close.addEventListener('click',hidePopup);
  const heading=safeText(popup,'h2',result.word);
  heading.id='popup-word';
  popup.setAttribute('aria-labelledby','popup-word');
  const translationResult=document.createElement('div');
  translationResult.className='translation-result';
  translationResult.hidden=true;
  translationResult.setAttribute('role','status');
  translationResult.setAttribute('aria-live','polite');
  popup.append(translationResult);
  if(result.phonetic)safeText(popup,'p',result.phonetic,'ph');
  if(result.source)safeText(popup,'span',result.cached?'Cached · '+result.source:result.source,'dictionary-source');
  const explained=document.createElement('div');
  explained.className='ai-explain';
  explained.hidden=true;
  explained.setAttribute('role','status');
  explained.setAttribute('aria-live','polite');
  const actions=document.createElement('div');
  actions.className='word-actions';
  const button=(label,handler)=>{
    const control=document.createElement('button');
    control.className='btn';
    control.type='button';
    control.textContent=label;
    control.addEventListener('click',handler);
    actions.append(control);
    return control;
  };
  button('Save',event=>{
    const values=local.get('er-vocabulary',[]);
    const target=String(result.word||'').trim().toLowerCase();if(!values.some(item=>String(item.word||'').trim().toLowerCase()===target)){const tombstones=local.get('er-vocabulary-deleted',{}),created=Math.max(Date.now(),Number(tombstones[target]||0)+1);values.unshift({word:result.word,definition:plainDefinition(result.meanings[0]?.definition),created});}
    local.set('er-vocabulary',values);
    queueCloudSync();
    renderVocabulary();
    event.currentTarget.textContent='Saved';
    toast('Word saved to your vocabulary.');
  });
  button('Listen',()=>playWordAudio(result));
  button('AI Translate',async event=>{
    const control=event.currentTarget;
    const originalLabel=control.textContent;
    control.disabled=true;
    control.textContent='Translating…';
    translationResult.hidden=false;
    translationResult.textContent='Translating into '+byId('translation-language').selectedOptions[0].text+'…';
    try{
      const language=byId('translation-language').value,word=String(result.word||'').toLowerCase(),cacheKey=word+'|'+language;
      const saved=local.get('er-translations',{});
      let value=translationMemory.get(cacheKey)||saved[cacheKey]||'';
      if(!value&&!navigator.onLine)throw new Error('Connect to the internet to translate. Words you translated before still work offline.');
      if(!value){
        try{
          const response=await fetchWithTimeout('/api/explain?mode=translate&text='+encodeURIComponent(word)+'&targetLanguage='+encodeURIComponent(language),{signal:lookupController?.signal},7000);
          if(response.ok){const data=await response.json().catch(()=>({}));value=String(data.translation||data.explanation||'').trim();}
        }catch(error){if(error.name==='AbortError')throw error;}
        if(!value){
          // AI not set up, busy or slow: fall back to the free translator.
          const fallback=await fetchWithTimeout('https://api.mymemory.translated.net/get?q='+encodeURIComponent(word)+'&langpair=en|'+language,{signal:lookupController?.signal},5000);
          if(!fallback.ok)throw new Error('Translation is unavailable right now. Please try again.');
          value=plainDefinition((await fallback.json()).responseData?.translatedText);
        }
        if(!value)throw new Error('No translation was returned.');
        translationMemory.set(cacheKey,value);
        const store=local.get('er-translations',{});store[cacheKey]=value;const keys=Object.keys(store);if(keys.length>300)delete store[keys[0]];local.set('er-translations',store);
      }
      translationResult.textContent=value;
      control.textContent='Translate again';
    }catch(error){
      if(error.name==='AbortError')return;
      translationResult.textContent=error.message||'AI translation is temporarily unavailable.';
      control.textContent='Try again';
    }finally{
      control.disabled=false;
      setTimeout(()=>{if(control.isConnected)control.textContent=originalLabel;},2200);
    }
  });
  if(!aiExplainUnavailable){
    const aiButton=button('Explain simply',async event=>{
      const control=event.currentTarget;
      if(!navigator.onLine){explained.hidden=false;explained.textContent='Connect to the internet to use Explain simply.';return;}
      control.disabled=true;control.textContent='Thinking…';
      explained.hidden=false;explained.replaceChildren();safeText(explained,'p','Thinking…','ai-explain-text');
      try{
        const text=await fetchAiExplanation(result.word,sentenceAroundRange(activeDictionaryRange),lookupController?.signal);
        explained.replaceChildren();
        safeText(explained,'p',text,'ai-explain-text');
        safeText(explained,'small','AI-generated by Gemini. It can make mistakes, so check the dictionary meaning below.','ai-explain-note');
        control.textContent='Explain again';
      }catch(error){
        if(error.name==='AbortError')return;
        explained.replaceChildren();
        if(error.notConfigured){aiExplainUnavailable=true;control.remove();explained.hidden=true;return;}
        safeText(explained,'p',error.message||'AI explain is unavailable right now.','ai-explain-text');
        control.textContent='Explain simply';
      }finally{control.disabled=false;}
    });
    aiButton.classList.add('ai-explain-btn');
  }
  button('Note',()=>openNoteEditor(result.word));
  popup.append(actions);
  popup.append(explained);
  result.meanings.forEach(item=>{
    safeText(popup,'p',item.partOfSpeech,'pos');
    safeText(popup,'p',plainDefinition(item.definition),'def');
    const example=plainDefinition(item.example);
    if(example)safeText(popup,'p','“'+example+'”','ex');
  });
  const synonyms=[...(result.synonyms||[])].map(plainDefinition).filter(Boolean).filter((value,index,array)=>array.indexOf(value)===index);
  const antonyms=[...(result.antonyms||[])].map(plainDefinition).filter(Boolean).filter((value,index,array)=>array.indexOf(value)===index);
  const wordnetSynonyms=[...new Set((result.meanings||[]).flatMap(item=>item.synonyms||[]).map(plainDefinition).filter(Boolean))];
  const allSynonyms=[...new Set([...synonyms,...wordnetSynonyms].filter(value=>value.toLowerCase()!==result.word.toLowerCase()))].slice(0,10);
  if(allSynonyms.length)safeText(popup,'p','Synonyms: '+allSynonyms.join(', '),'dictionary-related');
  if(antonyms.length)safeText(popup,'p','Antonyms: '+antonyms.join(', '),'dictionary-related');
  if(result.forms?.length)safeText(popup,'p','Forms: '+result.forms.join(', '),'note');
  if(result.word!==asked)safeText(popup,'p','Showing the base form “'+result.word+'”.','note');
}
function openNoteEditor(word){activeNoteWord=word;byId('note-word').textContent=`For “${word}”`;byId('note-editor-text').value='';byId('note-dialog').showModal();byId('note-editor-text').focus();}
function newSavedItemId(){return Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);}
function savedItemLegacyKey(item,kind){return 'legacy:'+JSON.stringify([kind,Number(item.created)||0,String(item.book||''),String(item.word||''),String(item.text||'')]);}
function savedItemTombstoneKeys(item,kind){const keys=[savedItemLegacyKey(item,kind)];if(item.id)keys.push('id:'+kind+':'+item.id);return keys;}
function saveNote(event){event.preventDefault();const text=byId('note-editor-text').value.trim();if(!text)return;const notes=local.get('er-notes',[]);notes.unshift({id:newSavedItemId(),word:activeNoteWord,text,book:activeBook?.key,bookName:activeBook?.title||activeBook?.name||'',created:Date.now()});local.set('er-notes',notes);queueCloudSync();byId('note-dialog').close();renderMyNotes();renderSavedItems();toast('Note saved.');}
async function renderLibraryPanel(){
  const list=byId('library-list'),favorites=byId('library-favorites');
  if(!list||!favorites)return;
  list.replaceChildren();favorites.replaceChildren();
  const favOnly=local.get('er-library-favorites-only',false)===true;
  const search=(byId('library-search')?.value||'').trim().toLowerCase(),filter=byId('library-filter')?.value||'all',sort=byId('library-sort')?.value||'recent';
  const all=await getBooks();
  const totalFavorites=all.filter(book=>book.favorite).length;
  byId('library-view-all')?.setAttribute('aria-pressed',String(!favOnly));
  byId('library-view-fav')?.setAttribute('aria-pressed',String(favOnly));
  const count=byId('library-fav-count');if(count)count.textContent=String(totalFavorites);
  const books=all.filter(book=>{const ext=String(book.type||book.name?.split('.').pop()||'').toLowerCase(),matchesType=filter==='all'||(filter==='image'?IMAGE_EXTS.includes(ext):ext===filter),matchesFavorite=!favOnly||book.favorite,matchesText=`${book.title||''} ${book.name||''}`.toLowerCase().includes(search);return matchesType&&matchesFavorite&&matchesText;});
  books.sort((a,b)=>sort==='title'?(a.title||a.name).localeCompare(b.title||b.name):sort==='progress'?(b.progress||0)-(a.progress||0):(b.opened||0)-(a.opened||0));
  const favoriteBooks=books.filter(book=>book.favorite),otherBooks=favOnly?[]:books.filter(book=>!book.favorite);
  const favoriteTitle=byId('library-fav-title'),recentTitle=byId('library-recent-title'),hint=byId('library-fav-hint');
  if(favoriteTitle)favoriteTitle.hidden=!favoriteBooks.length;
  if(recentTitle){recentTitle.hidden=!otherBooks.length;recentTitle.textContent=favoriteBooks.length?'Other books':'Your books';}
  if(hint)hint.hidden=!(all.length&&!totalFavorites&&!favOnly);
  if(!books.length){safeText(list,'p',favOnly&&!totalFavorites?'No favorites yet. Tap the star on any book to add it.':(search||filter!=='all'||favOnly)?'No books match these filters.':'Your books will appear here after you open one.','note');return;}
  const createRow=book=>{
    const title=book.title||book.name;
    const row=document.createElement('article');row.className='library-row'+(book.favorite?' is-favorite':'');
    const star=document.createElement('button');star.type='button';star.className='library-star';star.textContent=book.favorite?'\u2605':'\u2606';star.setAttribute('aria-pressed',String(Boolean(book.favorite)));star.setAttribute('aria-label',(book.favorite?'Remove from favorites: ':'Add to favorites: ')+title);star.title=book.favorite?'Remove from favorites':'Add to favorites';
    star.onclick=async()=>{book.favorite=!book.favorite;await putBook(book);renderLibraryPanel();renderLibrary();};
    const details=document.createElement('div');details.className='library-book-details';safeText(details,'strong',title);safeText(details,'small',`${String(book.type||'').toUpperCase()} \u00b7 ${Math.round(book.progress||0)}% read`,'note');
    const progress=document.createElement('progress');progress.className='library-progress';progress.max=100;progress.value=book.progress||0;progress.setAttribute('aria-label','Reading progress');
    const actions=document.createElement('div');actions.className='library-book-actions';
    const open=safeText(actions,'button','Continue','btn library-continue');open.type='button';open.onclick=()=>openFile(book.file);
    const rename=safeText(actions,'button','Rename','btn');rename.type='button';rename.setAttribute('aria-label',`Rename ${title}`);
    rename.onclick=async()=>{const value=prompt('Book title',title);if(value?.trim()){book.title=value.trim();await putBook(book);renderLibraryPanel();renderLibrary();}};
    row.append(star,details,progress,actions);return row;
  };
  favoriteBooks.forEach(book=>favorites.append(createRow(book)));
  otherBooks.forEach(book=>list.append(createRow(book)));
}
function removeSavedWord(word){const target=String(word||'').trim().toLowerCase();if(!target)return;const values=local.get('er-vocabulary',[]);const next=values.filter(item=>String(item.word||'').trim().toLowerCase()!==target);if(next.length===values.length)return;const tombstones=local.get('er-vocabulary-deleted',{});tombstones[target]=Math.max(Date.now(),Number(tombstones[target]||0)+1);local.set('er-vocabulary-deleted',tombstones);local.set('er-vocabulary',next);queueCloudSync();renderVocabulary();renderSavedItems();const saveButton=popup.querySelector('.word-actions button');if(saveButton){saveButton.textContent='Save word';saveButton.setAttribute('aria-pressed','false');}toast(`“${word}” removed from your saved words.`);}
function renderVocabulary(){const list=byId('vocab-list');list.replaceChildren();const values=local.get('er-vocabulary',[]);if(!values.length)return safeText(list,'p','Saved words will appear here.','note');values.forEach(item=>{const row=document.createElement('div');row.className='vocab-row';const info=document.createElement('div');info.className='vocab-info';safeText(info,'strong',item.word);safeText(info,'p',item.definition||'');const remove=document.createElement('button');remove.type='button';remove.className='vocab-remove';remove.textContent='Remove';remove.setAttribute('aria-label',`Remove ${item.word} from saved words`);remove.addEventListener('click',()=>removeSavedWord(item.word));row.append(info,remove);list.append(row);});}
function renderSavedItems(){const bookmarks=local.get('er-bookmarks',[]),b=byId('bookmark-list'),s=byId('saved-list');if(!b||!s)return;b.replaceChildren();s.replaceChildren();if(!bookmarks.length)safeText(b,'p','No bookmarks yet.','note');bookmarks.forEach((item,index)=>{const row=document.createElement('div');row.className='saved-bookmark-row';const label=(item.name||item.bookName||'Bookmark')+(item.page?' · Page '+item.page:'');const button=safeText(row,'button',label,'saved-item');button.onclick=()=>{if(item.page&&activePdf)goPdfPage(item.page);else if(item.page)goToReaderPage(item.page);else scrollTo({top:item.scroll||0,behavior:'smooth'});};const remove=safeText(row,'button','Delete','vocab-remove');remove.type='button';remove.setAttribute('aria-label','Delete bookmark');remove.onclick=()=>{const current=local.get('er-bookmarks',[]);const removed=current[index];if(!removed)return;const deleted=local.get('er-deleted-bookmarks',{});deleted[removed.id||savedItemLegacyKey(removed,'bookmark')]=Date.now();local.set('er-deleted-bookmarks',deleted);current.splice(index,1);local.set('er-bookmarks',current);queueCloudSync();renderSavedItems();toast('Bookmark deleted.');};row.append(button,remove);b.append(row);});safeText(s,'p','Notes and highlights are managed in My notes & highlights.','note');renderMyNotes();}
function renderMyNotes(){
  const list=byId('my-notes-list');
  if(!list)return;
  list.replaceChildren();
  const query=(byId('notes-search')?.value||'').trim().toLowerCase();
  const notes=local.get('er-notes',[]).map((item,index)=>({...item,kind:'note',index}));
  const highlights=local.get('er-highlights',[]).map((item,index)=>({...item,kind:'highlight',index}));
  const items=[...notes,...highlights]
    .filter(item=>(String(item.word||'')+' '+String(item.text||'')+' '+String(item.book||'')).toLowerCase().includes(query))
    .sort((a,b)=>a.kind.localeCompare(b.kind)||(b.created||0)-(a.created||0));
  if(!items.length){
    safeText(list,'p',query?'No notes match your search.':'Your saved notes and highlights will appear here.','note');
    return;
  }
  let renderedKind='';
  items.forEach(item=>{
    if(renderedKind!==item.kind){renderedKind=item.kind;safeText(list,'h3',item.kind==='note'?'Notes':'Highlights','saved-note-group-title');}
    const row=document.createElement('article');
    row.className='saved-note-row';
    const content=document.createElement('div');
    content.className='saved-note-content';
    if(item.book){content.tabIndex=0;content.setAttribute('role','button');content.setAttribute('aria-label','Open source book for this '+item.kind);const openSource=async()=>{const book=await getBook(item.book).catch(()=>null);if(book?.file)openFile(book.file);else toast('The original book is not available in this browser library.');};content.addEventListener('click',openSource);content.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openSource();}});}
    safeText(content,'strong',item.word?'Note for '+item.word:(item.kind==='highlight'?'Highlight':'Note'));
    safeText(content,'p',item.text||item.word||'Saved item','saved-note-text');
    safeText(content,'small',(item.kind==='highlight'?'Highlight':'Note')+(item.bookName||item.book?' · '+(item.bookName||item.book):'')+(item.created?' · '+new Date(item.created).toLocaleDateString():''));
    const actions=document.createElement('div');
    actions.className='saved-note-actions';
    if(item.kind==='note'){
      const edit=safeText(actions,'button','Edit','btn');
      edit.type='button';
      edit.addEventListener('click',()=>{
        const updated=prompt('Edit your note',item.text||'');
        if(updated===null)return;
        const text=updated.trim();
        if(!text){toast('A note cannot be empty.');return;}
        const current=local.get('er-notes',[]);
        if(!current[item.index])return;
        const previous=current[item.index],tombstones=local.get('er-deleted-saved-items',{});
        if(!previous.id)tombstones[savedItemLegacyKey(previous,'note')]=Date.now();
        current[item.index]={...previous,id:previous.id||newSavedItemId(),text,updated:Date.now()};
        local.set('er-deleted-saved-items',tombstones);
        local.set('er-notes',current);
        queueCloudSync();renderMyNotes();renderSavedItems();toast('Note updated.');
      });
    }
    const remove=safeText(actions,'button','Delete','btn');
    remove.type='button';
    remove.classList.add('saved-note-delete');
    remove.setAttribute('aria-label','Delete '+(item.kind==='highlight'?'highlight':'note'));
    remove.addEventListener('click',()=>openSavedItemDeleteDialog(item));
    row.append(content,actions);
    list.append(row);
  });
}
function openSavedItemDeleteDialog(item){
  const dialog=byId('delete-item-dialog');
  if(!dialog)return;
  dialog.dataset.kind=item.kind;
  dialog.dataset.index=String(item.index);
  const isNote=item.kind==='note';
  byId('delete-item-title').textContent=isNote?'Delete this note?':'Delete this highlight?';
  byId('delete-item-message').textContent=isNote
    ?'This note will be removed from your saved notes. This action cannot be undone.'
    :'This highlight will be removed from your saved items. This action cannot be undone.';
  byId('delete-item-confirm').textContent=isNote?'Delete note':'Delete highlight';
  dialog.showModal();
}
function confirmDeleteSavedItem(){
  const dialog=byId('delete-item-dialog');
  if(!dialog)return;
  const kind=dialog.dataset.kind,index=Number(dialog.dataset.index);
  if(!['note','highlight'].includes(kind)||!Number.isInteger(index)||index<0)return;
  const key=kind==='note'?'er-notes':'er-highlights';
  const current=local.get(key,[]);
  const deleted=current[index];
  if(!deleted)return;
  const tombstones=local.get('er-deleted-saved-items',{});
  for(const tombstoneKey of savedItemTombstoneKeys(deleted,kind))tombstones[tombstoneKey]=Date.now();
  local.set('er-deleted-saved-items',tombstones);
  current.splice(index,1);
  local.set(key,current);
  dialog.close();
  queueCloudSync();
  renderMyNotes();
  renderSavedItems();
  toast(kind==='note'?'Note deleted.':'Highlight deleted.');
}
function updateDocumentPageControls(){
  const toggle=byId('document-page-toggle'),label=byId('document-page-label'),prev=byId('document-page-prev'),next=byId('document-page-next');
  if(!toggle||activePdf)return;
  const total=Math.max(1,pageCount),page=Math.min(total,Math.max(1,activePage||1));syncPageCounter(page);
  toggle.textContent=documentPageMode?'Continuous':'Split pages';
  toggle.setAttribute('aria-pressed',String(documentPageMode));
  if(label)label.textContent=`Page ${page} of ${total}`;
  if(prev)prev.disabled=!documentPageMode||page<=1;
  if(next)next.disabled=!documentPageMode||page>=total;
}
function setDocumentPageMode(enabled){
  if(activePdf||!pageCount)return;
  documentPageMode=Boolean(enabled);
  const pages=[...reader.querySelectorAll('.page')];
  if(documentPageMode){
    activePage=Math.min(pages.length,Math.max(1,activePage||1));
    pages.forEach(item=>{item.hidden=Number(item.dataset.page)!==activePage;});
    reader.classList.add('document-page-reader');
    reader.scrollIntoView({behavior:'smooth',block:'start'});
  }else{
    pages.forEach(item=>{item.hidden=false;});
    reader.classList.remove('document-page-reader');
  }
  updateDocumentPageControls();
  byId('reader-page-jump').value=String(activePage);
}
function goToReaderPage(value){
  const page=Math.min(pageCount,Math.max(1,Number(value)||1)),container=activePdf&&pdfMode?pdfPages:reader,target=container.querySelector(`[data-page="${page}"]`);
  if(!target)return false;
  activePage=page;
  if(activePdf){
    byId('pdf-page-label').textContent=`Page ${page} of ${pageCount}`;
  }else if(documentPageMode){
    reader.querySelectorAll('.page').forEach(item=>{item.hidden=Number(item.dataset.page)!==page;});
    updateDocumentPageControls();
  }
  target.scrollIntoView({behavior:'smooth',block:'start'});
  if(byId('reader-page-jump'))byId('reader-page-jump').value=String(page);
  return true;
}
function goToRequestedPage(event){event?.preventDefault();const input=byId('jump'),requested=Number.parseInt(input.value,10);if(!Number.isInteger(requested)||requested<1||requested>pageCount){input.setCustomValidity(`Enter a page from 1 to ${pageCount}.`);input.reportValidity();return;}input.setCustomValidity('');input.value=String(requested);goToReaderPage(requested);}
async function renderContents(){const outline=byId('outline'),empty=byId('outline-empty');outline.replaceChildren();if(!pageCount){empty.textContent='Open a book to see its contents.';empty.hidden=false;return;}let found=false;if(activePdf){try{const entries=await activePdf.getOutline();const appendEntries=async(items,list)=>{for(const entry of items||[]){const item=document.createElement('li'),button=safeText(item,'button',entry.title||'Untitled section','saved-item');button.type='button';try{const dest=typeof entry.dest==='string'?await activePdf.getDestination(entry.dest):entry.dest;if(Array.isArray(dest)&&dest[0]){const index=Number.isInteger(dest[0])?dest[0]:await activePdf.getPageIndex(dest[0]),page=index+1;button.addEventListener('click',()=>goToReaderPage(page));button.setAttribute('aria-label',`${entry.title||'Section'}, page ${page}`);}else{button.disabled=true;}}catch{button.disabled=true;}list.append(item);if(entry.items?.length){const nested=document.createElement('ol');item.append(nested);await appendEntries(entry.items,nested);}}};if(entries?.length){await appendEntries(entries,outline);found=outline.childElementCount>0;}}catch(error){console.warn('Could not read PDF outline',error);}}
  if(!found){const sections=activePdf?Array.from({length:pageCount},(_,index)=>({page:index+1,title:`Page ${index+1}`})):Array.from(reader.querySelectorAll('.page'),(section,index)=>({page:Number(section.dataset.page)||index+1,title:section.querySelector('.page-mark')?.textContent||`Page ${index+1}`}));for(const section of sections){const item=document.createElement('li'),button=safeText(item,'button',section.title,'saved-item');button.type='button';button.addEventListener('click',()=>goToReaderPage(section.page));outline.append(item);}empty.textContent=activePdf?'No chapter outline was found. Choose a page:':'Sections in this book';}
  empty.hidden=found;
}
function renderStats(){
  const stats=local.get('er-stats',{}),seconds=Object.values(stats).reduce((sum,item)=>sum+(Number(item.seconds)||0),0);
  const node=byId('stats-content');if(!node)return;node.replaceChildren();
  const summary=document.createElement('div');summary.className='progress-summary-grid';
  const metric=(value,label)=>{const card=document.createElement('div');card.className='progress-metric';safeText(card,'strong',String(value));safeText(card,'span',label);summary.append(card);};
  metric(Math.round(seconds/60),'minutes read');metric(local.get('er-vocabulary',[]).length,'saved words');metric(local.get('er-flashcards',[]).length,'custom flashcards');node.append(summary);
  const heading=safeText(node,'h3','Your reading shelf','progress-list-heading'),list=document.createElement('div');list.className='progress-book-list';node.append(heading,list);
  getBooks().then(books=>{if(!node.isConnected)return;list.replaceChildren();if(!books.length){safeText(list,'p','Open a book to start tracking your reading progress.','note');return;}
    books.sort((a,b)=>(Number(b.opened)||0)-(Number(a.opened)||0));
    books.forEach(book=>{const row=document.createElement('div');row.className='progress-book-row';const top=document.createElement('div');top.className='progress-book-top';safeText(top,'strong',book.title||book.name||'Untitled book');const percent=Math.max(0,Math.min(100,Math.round(Number(book.progress)||0)));safeText(top,'span',percent+'%');const bar=document.createElement('progress');bar.className='progress-book-bar';bar.max=100;bar.value=percent;bar.setAttribute('aria-label','Reading progress for '+(book.title||book.name||'book'));const page=Number(book.position?.page)||0;row.append(top,bar,safeText(row,'small',page?'Last position: page '+page:(percent>=100?'Completed':'Keep going at your own pace'),'note'));const open=safeText(row,'button','Open book','progress-open-book');open.type='button';open.addEventListener('click',async()=>{const saved=await getBook(book.key).catch(()=>null);if(saved?.file)openFile(saved.file);else toast('This book is not available in the current browser.');});list.append(row);});
  }).catch(()=>safeText(list,'p','Could not load your saved book progress.','note'));
}
function renderLearning(){
  const root=byId('learning-content');if(!root)return;root.replaceChildren();const custom=local.get('er-flashcards',[]),vocabulary=local.get('er-vocabulary',[]);
  const vocabCards=vocabulary.filter(item=>item.word&&item.definition).map(item=>({id:'vocab:'+String(item.word).toLowerCase(),front:'What does “'+item.word+'” mean?',back:item.definition,source:'vocabulary'})),cards=[...custom,...vocabCards];
  const intro=document.createElement('p');intro.className='note';intro.textContent='Create your own cards or review saved vocabulary. Your cards are saved in this browser.';root.append(intro);
  const form=document.createElement('form');form.className='flashcard-create-form';form.innerHTML='<h3>Create a flashcard</h3><label>Question or term<input name="front" maxlength="300" required placeholder="e.g. What is bioavailability?"></label><label>Answer or definition<textarea name="back" maxlength="500" rows="2" required placeholder="Write a short answer"></textarea></label><button class="btn" type="submit">Add flashcard</button>';
  form.addEventListener('submit',event=>{event.preventDefault();const data=new FormData(form),front=String(data.get('front')||'').trim(),back=String(data.get('back')||'').trim();if(!front||!back)return;const next=local.get('er-flashcards',[]);next.push({id:'card-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7),front,back,createdAt:Date.now(),known:0,reviewed:0});local.set('er-flashcards',next);toast('Flashcard saved.');renderLearning();});root.append(form);
  const section=document.createElement('section');section.className='flashcard-review-section';safeText(section,'h3','Review cards · '+cards.length);
  if(!cards.length){safeText(section,'p','Save a word in the reader or create your first flashcard above.','note');root.append(section);return;}
  const indexKey='er-flashcard-index',index=((Number(local.get(indexKey,0))%cards.length)+cards.length)%cards.length,card=cards[index];
  const face=document.createElement('button');face.type='button';face.className='flashcard-face';face.setAttribute('aria-label','Reveal flashcard answer');face.innerHTML='<span class="flashcard-kicker">QUESTION</span><span class="flashcard-face-text"></span><span class="flashcard-tap-hint">Tap to reveal answer</span>';face.querySelector('.flashcard-face-text').textContent=card.front;
  let flipped=false;face.addEventListener('click',()=>{flipped=!flipped;face.classList.toggle('is-flipped',flipped);face.querySelector('.flashcard-kicker').textContent=flipped?'ANSWER':'QUESTION';face.querySelector('.flashcard-face-text').textContent=flipped?card.back:card.front;face.querySelector('.flashcard-tap-hint').textContent=flipped?'Tap to see question':'Tap to reveal answer';face.setAttribute('aria-label',flipped?'Show flashcard question':'Reveal flashcard answer');});section.append(face);safeText(section,'p','Card '+(index+1)+' of '+cards.length,'flashcard-counter');
  const actions=document.createElement('div');actions.className='flashcard-review-actions';const mark=(label,known)=>{const button=safeText(actions,'button',label,'btn');button.type='button';button.addEventListener('click',()=>{if(card.source!=='vocabulary'){const saved=local.get('er-flashcards',[]),found=saved.find(item=>item.id===card.id);if(found){found.reviewed=(Number(found.reviewed)||0)+1;if(known)found.known=(Number(found.known)||0)+1;local.set('er-flashcards',saved);}}local.set(indexKey,(index+1)%cards.length);renderLearning();});};mark('× Review again',false);mark('✓ Got it',true);
  const prev=safeText(actions,'button','Previous','btn');prev.type='button';prev.disabled=cards.length<2;prev.addEventListener('click',()=>{local.set(indexKey,(index-1+cards.length)%cards.length);renderLearning();});const next=safeText(actions,'button','Next →','btn');next.type='button';next.disabled=cards.length<2;next.addEventListener('click',()=>{local.set(indexKey,(index+1)%cards.length);renderLearning();});section.append(actions);
  const reviewed=custom.reduce((sum,item)=>sum+(Number(item.reviewed)||0),0),known=custom.reduce((sum,item)=>sum+(Number(item.known)||0),0);safeText(section,'p','Review activity: '+reviewed+' reviews · '+known+' marked “Got it”.','note');
  if(custom.length){const manage=document.createElement('div');manage.className='flashcard-manage-list';safeText(manage,'h3','Your flashcards');custom.forEach(item=>{const row=document.createElement('div');row.className='flashcard-manage-row';const content=document.createElement('div');safeText(content,'strong',item.front);safeText(content,'p',item.back);const remove=safeText(row,'button','Delete','vocab-remove');remove.type='button';remove.addEventListener('click',()=>{local.set('er-flashcards',local.get('er-flashcards',[]).filter(value=>value.id!==item.id));renderLearning();toast('Flashcard deleted.');});row.append(content,remove);manage.append(row);});section.append(manage);}root.append(section);
}
function updateDocMeta(){if(activeBook){byId('doc-meta').textContent=activePdf?`${pageCount} pages · original PDF layout`:`${pageCount?pageCount+(pageCount===1?' section · ':' sections · '):''}${(activeBook.words||0).toLocaleString()} words`;if(byId('jump'))byId('jump').max=String(Math.max(1,pageCount));if(byId('reader-page-jump'))byId('reader-page-jump').max=String(Math.max(1,pageCount));}}
function restorePosition(){setTimeout(()=>{if(activePdf)goPdfPage(activeBook.position?.page||1);else scrollTo({top:activeBook.position?.scroll||0});},120);}
function savePosition(force=false){
  if(!activeBook)return;
  const write=()=>{
    const savedAt=Date.now();
    const scrollingPdf=Boolean(activePdf&&pdfMode);
    const scroll=scrollingPdf?pdfPages.scrollTop:scrollY;
    activeBook.position={page:activePage,scroll,savedAt};
    local.set(`er-position:${activeBook.key}`,activeBook.position);
    clearTimeout(saveTimer);
    saveTimer=setTimeout(async()=>{
      activeBook.opened=savedAt;
      const maxScroll=scrollingPdf?Math.max(pdfPages.scrollHeight-pdfPages.clientHeight,1):Math.max(document.documentElement.scrollHeight-innerHeight,1);
      activeBook.progress=Math.round(Math.min(100,scroll/maxScroll*100));
      await putBook(activeBook).catch(()=>{});
      queueCloudSync();
    },650);
  };
  if(force){
    if(positionFrame){cancelAnimationFrame(positionFrame);positionFrame=0;}
    clearTimeout(positionWriteTimer);positionWriteTimer=null;
    write();
    return;
  }
  if(positionFrame)return;
  positionFrame=requestAnimationFrame(()=>{
    positionFrame=0;
    clearTimeout(positionWriteTimer);
    positionWriteTimer=setTimeout(()=>{positionWriteTimer=null;write();},180);
  });
}
function todayKey(){return new Date().toISOString().slice(0,10);}
function elapsedReadingSeconds(){return readerTimerSeconds+(readerTimerRunning?Math.floor((Date.now()-readerTimerStart)/1000):0);}
function formatTimer(seconds){const value=Math.max(0,Math.floor(seconds)),hours=Math.floor(value/3600),minutes=Math.floor(value%3600/60),remaining=value%60;return hours?`${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(remaining).padStart(2,'0')}`:`${String(minutes).padStart(2,'0')}:${String(remaining).padStart(2,'0')}`;}
function persistReadingTimer(){local.set('er-reading-timer',{day:readerTimerDay,seconds:elapsedReadingSeconds()});}
function updateReadingTimer(){const elapsed=elapsedReadingSeconds(),remaining=readerTimerGoal?Math.max(0,readerTimerGoal*60-elapsed):elapsed,output=byId('timer-display'),toggle=byId('timer-toggle');if(output){output.textContent=formatTimer(remaining);output.setAttribute('aria-label',readerTimerGoal?`${formatTimer(remaining)} remaining toward today's goal`:`${formatTimer(elapsed)} elapsed reading time`);}if(toggle){toggle.textContent=readerTimerRunning?'Pause':'Start';toggle.setAttribute('aria-label',readerTimerRunning?'Pause reading timer':'Start reading timer');}}
function recordReadingSeconds(total){const delta=total-readerTimerRecordedSeconds;readerTimerRecordedSeconds=total;if(delta<=0||!readerTimerBookKey)return;const stats=local.get('er-stats',{}),item=stats[readerTimerBookKey]||{seconds:0,day:readerTimerDay};item.seconds=(item.seconds||0)+delta;item.day=readerTimerDay;stats[readerTimerBookKey]=item;local.set('er-stats',stats);recordReadingDay(delta);}
function tickReadingTimer(){const today=todayKey();if(readerTimerDay!==today){readerTimerDay=today;readerTimerSeconds=0;readerTimerStart=Date.now();readerTimerRecordedSeconds=0;}const elapsed=elapsedReadingSeconds();recordReadingSeconds(elapsed);persistReadingTimer();updateReadingTimer();if(readerTimerGoal&&elapsed>=readerTimerGoal*60){pauseReadingTimer();toast("Today's reading goal is complete.");}}
function startReadingTimer(){if(readerTimerRunning)return;readerTimerRunning=true;readerTimerStart=Date.now();readerTimerInterval=setInterval(tickReadingTimer,1000);updateReadingTimer();}
function pauseReadingTimer(){if(!readerTimerRunning)return;readerTimerSeconds=elapsedReadingSeconds();readerTimerRunning=false;readerTimerStart=0;clearInterval(readerTimerInterval);readerTimerInterval=null;recordReadingSeconds(readerTimerSeconds);persistReadingTimer();updateReadingTimer();}
function resetReadingTimer(){pauseReadingTimer();readerTimerDay=todayKey();readerTimerSeconds=0;readerTimerRecordedSeconds=0;persistReadingTimer();updateReadingTimer();}
function changeReaderTextSize(delta){const settings=local.get('er-reader-settings',{}),size=Math.min(2,Math.max(.85,Number(settings.size||1.25)+delta));settings.size=Math.round(size*100)/100;local.set('er-reader-settings',settings);document.documentElement.style.setProperty('--reader-fs',settings.size+'rem');}
function changeReaderSpacing(delta){const settings=local.get('er-reader-settings',{}),spacing=Math.min(2.3,Math.max(1.5,Math.round((Number(settings.spacing||1.9)+delta)*10)/10));settings.spacing=spacing;local.set('er-reader-settings',settings);document.documentElement.style.setProperty('--reader-leading',String(spacing));byId('spacing').value=String(spacing);}
function loadReaderPreferences(){const settings=local.get('er-reader-settings',{}),root=document.documentElement,font=settings.font||'literata',spacing=settings.spacing||1.9,width=settings.width||780,size=Math.min(2,Math.max(.85,Number(settings.size)||1.25));byId('font-choice').value=font;byId('spacing').value=String(spacing);byId('width').value=String(width);root.style.setProperty('--reader-font',font==='serif'?'Georgia,serif':font==='dyslexic'?'Arial,sans-serif':"'Literata',Georgia,serif");root.style.setProperty('--reader-leading',String(spacing));root.style.setProperty('--reader-width',`${width}px`);root.style.setProperty('--reader-fs',`${size}rem`);readerTimerDay=todayKey();const saved=local.get('er-reading-timer',{day:readerTimerDay,seconds:0});readerTimerSeconds=saved.day===readerTimerDay?Math.max(0,Number(saved.seconds)||0):0;readerTimerGoal=Math.max(0,Number(local.get('er-reading-goal',byId('reading-goal').value))||0);byId('reading-goal').value=String(readerTimerGoal);readerTimerRecordedSeconds=readerTimerSeconds;updateReadingTimer();}

let authMode='signin';
function setAuthMode(mode){
  authMode=mode==='signup'?'signup':'signin';
  const signup=authMode==='signup',tabSignIn=byId('auth-tab-signin'),tabSignUp=byId('auth-tab-signup'),nameField=byId('auth-name-field'),submit=byId('email-auth-submit'),password=byId('auth-password'),forgot=byId('forgot-password');
  tabSignIn?.classList.toggle('active',!signup);tabSignUp?.classList.toggle('active',signup);
  tabSignIn?.setAttribute('aria-selected',String(!signup));tabSignUp?.setAttribute('aria-selected',String(signup));
  if(nameField)nameField.hidden=!signup;if(submit)submit.textContent=signup?'Create account':'Sign in';if(password)password.autocomplete=signup?'new-password':'current-password';if(forgot)forgot.hidden=signup;
  const status=byId('auth-status');if(status){status.textContent='';status.className='note';}
}
function setAuthStatus(message,type=''){
  const node=byId('auth-status');if(!node)return;node.textContent=message;node.className='note'+(type?' auth-'+type:'');
}
function friendlyAuthError(error){
  const code=error?.code||'',messages={'auth/invalid-email':'Please enter a valid email address.','auth/missing-password':'Please enter your password.','auth/weak-password':'That password is too weak. Use at least 6 characters.','auth/email-already-in-use':'An account already exists with this email. Try signing in instead.','auth/invalid-credential':'Email or password is incorrect.','auth/user-disabled':'This account has been disabled.','auth/too-many-requests':'Too many attempts. Please wait a moment and try again.','auth/network-request-failed':'Network error. Check your connection and try again.','auth/popup-blocked':'Your browser blocked the Google sign-in window. Please allow pop-ups for EasyRead and try again.','auth/popup-closed-by-user':'The Google sign-in window was closed before sign-in finished.','auth/cancelled-popup-request':'Another Google sign-in window is already open.','auth/operation-not-allowed':'This sign-in method is not enabled in the Firebase project yet.'};
  return messages[code]||error?.message||'Sign-in could not be completed. Please try again.';
}
async function initFirebase(){
  if(auth)return auth;if(firebaseInitPromise)return firebaseInitPromise;if(!window.EASYREAD_FIREBASE_CONFIG?.apiKey)throw new Error('Firebase sign-in has not been configured.');
  firebaseInitPromise=(async()=>{await Promise.all(['firebaseApp','firebaseAuth','firebaseStore'].map(loadLibrary));if(!firebase.apps.length)firebase.initializeApp(window.EASYREAD_FIREBASE_CONFIG);auth=firebase.auth();firestore=firebase.firestore();auth.onAuthStateChanged(next=>{user=next;updateProfile();if(user)syncCloud();});try{await auth.getRedirectResult();}catch(error){if(error?.code!=='auth/no-auth-event')setAuthStatus(friendlyAuthError(error),'error');}return auth;})();
  try{return await firebaseInitPromise;}catch(error){firebaseInitPromise=null;throw error;}
}
async function openAccount(){showPanel('account');try{await initFirebase();setAuthMode('signin');}catch(error){setAuthStatus('Sign-in is temporarily unavailable. '+error.message,'error');}}
function updateWelcomeSignin(){
  const welcome=byId('welcome-signin');
  if(welcome)welcome.hidden=!!user||local.get('er-signin-dismissed',false);
}
function updateProfile(){
  const label=user?.displayName?.split(' ')[0]||'Sign in';for(const id of ['account-label','sidebar-account-label'])if(byId(id))byId(id).textContent=label;
  if(byId('sidebar-account-meta'))byId('sidebar-account-meta').textContent=user?.email||'Sync your reading';
  const pic=profilePhoto();for(const id of ['account-avatar','account-photo','sidebar-avatar'])if(byId(id)){byId(id).src=pic;byId(id).hidden=!pic;}
  if(byId('photo-remove'))byId('photo-remove').hidden=!(user&&local.get('er-photo-'+user.uid,''));
  if(byId('account-name'))byId('account-name').textContent=user?.displayName||'';if(byId('account-email'))byId('account-email').textContent=user?.email||'';
  if(byId('account-signed-out'))byId('account-signed-out').hidden=!!user;if(byId('account-signed-in'))byId('account-signed-in').hidden=!user;
  updateWelcomeSignin();
}
async function signInWithGoogle(){
  try{setAuthStatus('Opening Google sign-in…');await initFirebase();const provider=new firebase.auth.GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});await auth.signInWithPopup(provider);const intro=byId('signin-modal');if(intro)intro.hidden=true;local.set('er-welcome-intro-dismissed',true);showPanel('account',false);toast('Signed in with Google.');}
  catch(error){setAuthStatus(friendlyAuthError(error),'error');if(error?.code==='auth/popup-blocked')try{await auth.signInWithRedirect(new firebase.auth.GoogleAuthProvider());}catch(redirectError){setAuthStatus(friendlyAuthError(redirectError),'error');}}
}
async function submitEmailAuth(event){
  event.preventDefault();const email=byId('auth-email')?.value.trim(),password=byId('auth-password')?.value,name=byId('auth-name')?.value.trim();
  if(!email||!password)return setAuthStatus('Enter your email and password.','error');if(authMode==='signup'&&!name)return setAuthStatus('Enter your name to create your account.','error');
  const submit=byId('email-auth-submit');submit?.classList.add('auth-loading');if(submit)submit.disabled=true;setAuthStatus(authMode==='signup'?'Creating your account…':'Signing you in…');
  try{
    await initFirebase();
    if(authMode==='signup'){
      const credential=await auth.createUserWithEmailAndPassword(email,password);
      if(name&&credential.user)await credential.user.updateProfile({displayName:name});
      user=auth.currentUser;updateProfile();showPanel('account',false);
      toast('Your EasyRead account is ready.');
    }else{await auth.signInWithEmailAndPassword(email,password);showPanel('account',false);toast('Welcome back to EasyRead.');}
  }catch(error){setAuthStatus(friendlyAuthError(error),'error');}
  finally{submit?.classList.remove('auth-loading');if(submit)submit.disabled=false;}
}
async function resetPassword(){
  const email=byId('auth-email')?.value.trim();if(!email)return setAuthStatus('Enter your email first, then choose “Forgot password?”.','error');
  try{await initFirebase();await auth.sendPasswordResetEmail(email);setAuthStatus('Password reset instructions have been sent to your email.','success');}catch(error){setAuthStatus(friendlyAuthError(error),'error');}
}
async function signIn(){return signInWithGoogle();}
function queueCloudSync(){if(!user)return;clearTimeout(cloudSyncTimer);cloudSyncTimer=setTimeout(syncCloud,800);}
async function syncCloud(){if(!user||!navigator.onLine)return;try{if(!firestore)await initFirebase();const ref=firestore.collection('users').doc(user.uid),snapshot=await ref.get(),remote=snapshot.exists?snapshot.data():{},data={};if(typeof remote.photoData==='string'&&remote.photoData.startsWith('data:image/')&&remote.photoData.length<200000&&remote.photoData!==local.get('er-photo-'+user.uid,'')){local.set('er-photo-'+user.uid,remote.photoData);updateProfile();}const localTombstones=local.get('er-vocabulary-deleted',{}),remoteTombstones=remote.vocabularyDeleted&&typeof remote.vocabularyDeleted==='object'?remote.vocabularyDeleted:{},tombstones={};for(const key of new Set([...Object.keys(remoteTombstones),...Object.keys(localTombstones)]))tombstones[key]=Math.max(Number(remoteTombstones[key]||0),Number(localTombstones[key]||0));const localDeletedSaved=local.get('er-deleted-saved-items',{}),remoteDeletedSaved=remote.deletedSavedItems&&typeof remote.deletedSavedItems==='object'?remote.deletedSavedItems:{},deletedSaved={};for(const key of new Set([...Object.keys(remoteDeletedSaved),...Object.keys(localDeletedSaved)]))deletedSaved[key]=Math.max(Number(remoteDeletedSaved[key]||0),Number(localDeletedSaved[key]||0));const localDeletedBookmarks=local.get('er-deleted-bookmarks',{}),remoteDeletedBookmarks=remote.deletedBookmarks&&typeof remote.deletedBookmarks==='object'?remote.deletedBookmarks:{},deletedBookmarks={};for(const key of new Set([...Object.keys(remoteDeletedBookmarks),...Object.keys(localDeletedBookmarks)]))deletedBookmarks[key]=Math.max(Number(remoteDeletedBookmarks[key]||0),Number(localDeletedBookmarks[key]||0));for(const [name,key]of Object.entries(STORE_KEYS)){const localItems=local.get(key,name==='stats'?{}:[]),remoteItems=Array.isArray(remote[name])?remote[name]:[];if(name==='stats'){const localStats=localItems&&typeof localItems==='object'&&!Array.isArray(localItems)?localItems:{},remoteStats=remote[name]&&typeof remote[name]==='object'&&!Array.isArray(remote[name])?remote[name]:{};data[name]={...remoteStats,...localStats};local.set(key,data[name]);continue;}let merged;if(name==='notes'||name==='highlights'){const kind=name==='notes'?'note':'highlight',byIdentity=new Map();for(const item of remoteItems)byIdentity.set(item.id?'id:'+item.id:savedItemLegacyKey(item,kind),item);for(const item of localItems)byIdentity.set(item.id?'id:'+item.id:savedItemLegacyKey(item,kind),item);merged=[...byIdentity.values()];}else{const seen=new Set();merged=[];for(const item of [...remoteItems,...localItems]){const identity=JSON.stringify(item);if(!seen.has(identity)){seen.add(identity);merged.push(item);}}}let finalItems=merged;if(name==='vocabulary'){finalItems=merged.filter(item=>{const word=String(item.word||'').trim().toLowerCase(),deletedAt=Number(tombstones[word]||0),savedAt=Number(item.created||0);return !deletedAt||savedAt>deletedAt;});}if(name==='notes'||name==='highlights'){const kind=name==='notes'?'note':'highlight';finalItems=merged.filter(item=>!savedItemTombstoneKeys(item,kind).some(tombstoneKey=>deletedSaved[tombstoneKey]));}if(name==='bookmarks'){finalItems=merged.filter(item=>!deletedBookmarks[item.id||savedItemLegacyKey(item,'bookmark')]);}data[name]=finalItems.slice(-1000);local.set(key,data[name]);}data.vocabularyDeleted=tombstones;data.deletedSavedItems=deletedSaved;data.deletedBookmarks=deletedBookmarks;local.set('er-vocabulary-deleted',tombstones);local.set('er-deleted-saved-items',deletedSaved);local.set('er-deleted-bookmarks',deletedBookmarks);await ref.set(data,{merge:true});byId('sync-label').textContent='Synced just now';byId('last-synced').textContent='Last synced '+new Date().toLocaleString();toast('Reading data synced.');}catch(error){byId('sync-label').textContent='Sync needs attention';console.warn('Sync failed',error);}}
function updateInstallButton() {
  const button = byId('install-btn');
  if (!button) return;
  button.hidden = !installPromptEvent;
}

async function init() {
  // Keep the UI interactive even if an optional reader feature fails during boot.
  const boot = (name, fn) => {
    try { return fn(); }
    catch (error) { console.error(`EasyRead ${name} failed:`, error); return null; }
  };
  // These must work before any other initialization, because the sign-in prompt
  // and overlays can otherwise sit above the whole app.
  for (const id of ['signin-modal-close','signin-modal-later']) {
    byId(id)?.addEventListener('click', () => {
      const modal = byId('signin-modal');
      if (modal) modal.hidden = true;
      local.set('er-signin-dismissed', true); local.set('er-welcome-intro-dismissed', true);
    });
  }
  boot('navigation', initNavigation);
  // Use an explicit toggle for the reader's More disclosure so touch browsers
  // reliably open it instead of losing the tap to horizontal toolbar scrolling.
  document.querySelectorAll('.toolbar-more > summary').forEach(summary => summary.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const details = summary.parentElement;
    if (!details) return;
    const menu = details.querySelector('.toolbar-menu');
    const opening = !details.open;
    if (matchMedia('(max-width: 700px)').matches && menu) {
      if (opening) {
        menu.dataset.portaled = 'true';
        document.body.append(menu);
        menu.style.position = 'fixed'; menu.style.left = 'auto'; menu.style.right = '10px'; menu.style.bottom = 'auto'; menu.style.top = '12px';
        menu.style.maxHeight = 'calc(100dvh - 150px)'; menu.style.overflowY = 'auto'; menu.style.zIndex = '200';
        const rect = summary.getBoundingClientRect();
        const height = Math.min(menu.scrollHeight, Math.max(180, window.innerHeight - 150));
        menu.style.maxHeight = `${height}px`;
        const desiredTop = rect.top - Math.min(height, 360) - 8;
        menu.style.top = `${Math.max(12, Math.min(desiredTop, window.innerHeight - height - 100))}px`;
      } else if (menu.dataset.portaled === 'true') {
        details.append(menu); delete menu.dataset.portaled; menu.removeAttribute('style');
      }
    }
    details.open = opening;
  }));
  boot('contact', initContact);
  updateWelcomeSignin();
  boot('reader preferences', loadReaderPreferences);
  boot('install state', updateInstallButton);
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPromptEvent = event;
    updateInstallButton();
  });
  window.addEventListener('appinstalled', () => {
    installPromptEvent = null;
    updateInstallButton();
    toast('EasyRead was installed.');
  });
  byId('install-btn')?.addEventListener('click', async () => {
    if (!installPromptEvent) { toast('Install is not available in this browser yet.'); return; }
    installPromptEvent.prompt();
    const choice = await installPromptEvent.userChoice;
    installPromptEvent = null;
    updateInstallButton();
    toast(choice.outcome === 'accepted' ? 'App installed.' : 'Install cancelled.');
  });
  // Core upload/paste controls are guarded so a single optional control cannot
  // abort initialization of every remaining reader button.
  boot('file input', () => fileInput?.addEventListener('change',()=>{openFile(fileInput.files?.[0]);fileInput.value='';}));
  boot('camera input', () => { const cam = byId('camera-input'); byId('camera-btn')?.addEventListener('click', () => cam?.click()); cam?.addEventListener('change', () => { openFile(cam.files?.[0]); cam.value = ''; }); });
  boot('paste controls', () => {
    byId('paste-open')?.addEventListener('click',()=>{
      const input=byId('paste-input');
      const text=input?.value||'';
      if(!text.trim()) return toast('Paste some text first.');
      openFile(new File([text], 'Pasted text.txt', {type:'text/plain'}));
    });
    byId('paste-clear')?.addEventListener('click',event=>{
      event.preventDefault(); event.stopPropagation();
      const input=byId('paste-input'); if(!input)return;
      input.value=''; input.dispatchEvent(new Event('input',{bubbles:true}));
      input.focus({preventScroll:true}); toast('Pasted text cleared.');
    });
  });

  drop.addEventListener('click',event=>{if(event.target!==fileInput)fileInput.click();}); drop.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();fileInput.click();}});
  for(const eventName of ['dragover','dragleave','drop'])drop.addEventListener(eventName,event=>{event.preventDefault();drop.classList.toggle('over',eventName==='dragover');if(eventName==='drop'&&event.dataTransfer.files[0])openFile(event.dataTransfer.files[0]);});
  byId('jump').addEventListener('change',goToRequestedPage);
  byId('reader-page-jump')?.addEventListener('change',event=>goToReaderPage(event.target.value));
  byId('reader-page-jump')?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();goToReaderPage(event.target.value);}});
  byId('jump').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();goToRequestedPage();}});
  byId('dictionary-btn').addEventListener('click',()=>{const panel=byId('dictionary-panel'),open=panel.hidden;panel.hidden=!open;byId('dictionary-btn').setAttribute('aria-expanded',String(open));if(open)byId('dictionary-query').focus();});
  byId('dictionary-panel').addEventListener('submit',submitDictionaryQuery);
  byId('text-smaller')?.addEventListener('click',()=>changeReaderTextSize(-.1));byId('text-larger')?.addEventListener('click',()=>changeReaderTextSize(.1));
  byId('reading-zoom-out')?.addEventListener('click',()=>{if(activePdf)scalePdf(-.15);else changeReaderTextSize(-.1);});
  byId('reading-zoom-in')?.addEventListener('click',()=>{if(activePdf)scalePdf(.15);else changeReaderTextSize(.1);});
  byId('text-spacing-down')?.addEventListener('click',()=>changeReaderSpacing(-.1));byId('text-spacing-up')?.addEventListener('click',()=>changeReaderSpacing(.1));
  byId('document-page-toggle')?.addEventListener('click',()=>setDocumentPageMode(!documentPageMode));
  byId('global-view-toggle')?.addEventListener('click',()=>{ if(activePdf) setPdfMode(!pdfMode); else setDocumentPageMode(!documentPageMode); });
  byId('global-view-prev')?.addEventListener('click',()=>{ if(activePdf) goPdfPage(activePage-1); else goToReaderPage(activePage-1); });
  byId('global-view-next')?.addEventListener('click',()=>{ if(activePdf) goPdfPage(activePage+1); else goToReaderPage(activePage+1); });
  byId('document-page-prev')?.addEventListener('click',()=>goToReaderPage(activePage-1));
  byId('document-page-next')?.addEventListener('click',()=>goToReaderPage(activePage+1));
  byId('note-form').addEventListener('submit',saveNote);byId('note-cancel').addEventListener('click',()=>byId('note-dialog').close());byId('delete-item-cancel')?.addEventListener('click',()=>byId('delete-item-dialog').close());byId('delete-item-confirm')?.addEventListener('click',confirmDeleteSavedItem);
  for(const id of ['library-search'])byId(id)?.addEventListener('input',renderLibraryPanel);for(const id of ['library-filter','library-sort'])byId(id)?.addEventListener('change',renderLibraryPanel);byId('home-library-sort')?.addEventListener('change',renderLibrary);
  byId('timer-toggle').addEventListener('click',()=>readerTimerRunning?pauseReadingTimer():startReadingTimer());byId('timer-reset').addEventListener('click',resetReadingTimer);byId('reading-goal').addEventListener('change',event=>{readerTimerGoal=Math.max(0,Number(event.target.value)||0);local.set('er-reading-goal',readerTimerGoal);updateReadingTimer();});
  byId('pdf-mode-btn').addEventListener('click',()=>setPdfMode(!pdfMode));byId('pdf-prev').addEventListener('click',()=>goPdfPage(activePage-1));byId('pdf-next').addEventListener('click',()=>goPdfPage(activePage+1));byId('pdf-zoom-in').addEventListener('click',()=>scalePdf(.15));byId('pdf-zoom-out').addEventListener('click',()=>scalePdf(-.15));byId('pdf-fullscreen').addEventListener('click',()=>pdfPages.requestFullscreen?.());byId('pdf-preview-toggle').addEventListener('click',()=>{pdfPreviewsVisible=!pdfPreviewsVisible;local.set('er-pdf-previews',pdfPreviewsVisible);pdfThumbs.hidden=!pdfMode||!pdfPreviewsVisible;byId('pdf-preview-toggle').textContent=pdfPreviewsVisible?'Hide previews':'Show previews';byId('pdf-preview-toggle').setAttribute('aria-pressed',String(pdfPreviewsVisible));});
  byId('fullscreen-btn').addEventListener('click',toggleReaderFullscreen);
  byId('search-btn').addEventListener('click',()=>{closeDictionaryPanel();byId('reader-tools').hidden=!byId('reader-tools').hidden;byId('search-input').focus();});
  byId('search-input').addEventListener('input',()=>{
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer=setTimeout(()=>searchBook(),120);
  });
  byId('search-prev').addEventListener('click',()=>moveMatch(-1));byId('search-next').addEventListener('click',()=>moveMatch(1));
  byId('highlight-btn').addEventListener('click',()=>{const text=getSelection()?.toString().trim();if(!text)return;const values=local.get('er-highlights',[]);values.unshift({id:newSavedItemId(),text,book:activeBook?.key,bookName:activeBook?.title||activeBook?.name||'',created:Date.now()});local.set('er-highlights',values);queueCloudSync();renderMyNotes();renderSavedItems();toast('Highlight saved.');});
  byId('bookmark-btn').addEventListener('click',()=>{const values=local.get('er-bookmarks',[]);values.unshift({id:newSavedItemId(),name:activeBook?.title||activeBook?.name||'Bookmark',book:activeBook?.key,bookName:activeBook?.title||activeBook?.name||'',scroll:scrollY,page:activePage,created:Date.now()});local.set('er-bookmarks',values);queueCloudSync();toast('Bookmark saved.');});
  byId('export-btn').addEventListener('click',exportData);byId('export-all').addEventListener('click',exportData);byId('delete-all').addEventListener('click',deleteLocalData);
  byId('google-signin').addEventListener('click',signInWithGoogle);byId('signin-modal-google').addEventListener('click',signInWithGoogle);byId('welcome-signin-btn')?.addEventListener('click',signInWithGoogle);byId('welcome-dismiss')?.addEventListener('click',()=>{local.set('er-signin-dismissed',true);local.set('er-welcome-intro-dismissed',true);const welcome=byId('welcome-signin');if(welcome)welcome.hidden=true;});byId('email-auth-form')?.addEventListener('submit',submitEmailAuth);byId('auth-tab-signin')?.addEventListener('click',()=>setAuthMode('signin'));byId('auth-tab-signup')?.addEventListener('click',()=>setAuthMode('signup'));byId('forgot-password')?.addEventListener('click',resetPassword);byId('auth-password-toggle')?.addEventListener('click',()=>{const input=byId('auth-password'),button=byId('auth-password-toggle');if(!input||!button)return;const visible=input.type==='text';input.type=visible?'password':'text';button.textContent=visible?'Show':'Hide';button.setAttribute('aria-label',visible?'Show password':'Hide password');});byId('sync-now').addEventListener('click',syncCloud);byId('signout').addEventListener('click',()=>auth?.signOut());
  byId('speak-page-btn').addEventListener('click',speakCurrent);byId('stop-speech-btn').addEventListener('click',()=>speechSynthesis.cancel());
  byId('autoscroll-btn').addEventListener('click',()=>{const button=byId('autoscroll-btn');if(button.dataset.running){clearInterval(Number(button.dataset.running));delete button.dataset.running;button.textContent='Auto-scroll';}else button.dataset.running=String(setInterval(()=>scrollBy(0,1),45));});
  byId('font-choice').addEventListener('change',event=>{const settings=local.get('er-reader-settings',{});settings.font=event.target.value;local.set('er-reader-settings',settings);document.documentElement.style.setProperty('--reader-font',event.target.value==='serif'?'Georgia,serif':event.target.value==='dyslexic'?'Arial,sans-serif':"'Literata',Georgia,serif");});byId('spacing').addEventListener('input',event=>{const settings=local.get('er-reader-settings',{});settings.spacing=Number(event.target.value);local.set('er-reader-settings',settings);document.documentElement.style.setProperty('--reader-leading',event.target.value);});byId('width').addEventListener('input',event=>{const settings=local.get('er-reader-settings',{});settings.width=Number(event.target.value);local.set('er-reader-settings',settings);document.documentElement.style.setProperty('--reader-width',event.target.value+'px');});
  for(const id of ['signin-modal-close','signin-modal-later'])byId(id).addEventListener('click',()=>{byId('signin-modal').hidden=true;local.set('er-signin-dismissed',true);local.set('er-welcome-intro-dismissed',true);});
  addEventListener('scroll',()=>{if(!readerWrap.hidden)savePosition();},{passive:true});addEventListener('beforeunload',()=>{savePosition(true);pauseReadingTimer();});document.addEventListener('visibilitychange',()=>{if(document.hidden&&readerTimerRunning){timerResumeOnVisible=true;pauseReadingTimer();}else if(!document.hidden&&timerResumeOnVisible&&!readerWrap.hidden){timerResumeOnVisible=false;startReadingTimer();}});addEventListener('resize',()=>{if(activePdf)scalePdf(0);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){hidePopup();hidePanels();byId('contents').classList.remove('open');byId('signin-modal').hidden=true;}if((event.ctrlKey||event.altKey)&&event.key==='Enter'&&!event.target.matches('input,textarea,select')){const selection=getSelection();if(selection&&!selection.isCollapsed&&selection.rangeCount){const text=selection.toString().trim();if(/^[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*$/u.test(text)){event.preventDefault();showWord({word:text.toLowerCase(),range:selection.getRangeAt(0).cloneRange()},{focus:true});return;}}}if(event.target.matches('input,textarea,select'))return;if(event.key==='?'){event.preventDefault();showPanel('shortcuts',true);return;}if(event.key==='/ '||event.key==='/'){event.preventDefault();if(!readerWrap.hidden){byId('reader-tools').hidden=false;byId('search-input').focus();}}if(event.key.toLowerCase()==='f'&&!readerWrap.hidden)document.body.classList.toggle('focus-mode');if(event.key.toLowerCase()==='t')byId('theme').click();});
  await renderLibrary().catch(()=>{});updateStreakChip();addEventListener('online',()=>{if(user)syncCloud();});
  // Introduce EasyRead once for new visitors, without requiring an account.
  const welcomeModal=byId('welcome-intro-modal');
  if(welcomeModal&&!local.get('er-welcome-intro-dismissed',false))welcomeModal.hidden=false;
  for(const id of ['welcome-intro-close','welcome-intro-continue'])byId(id)?.addEventListener('click',()=>{const intro=byId('welcome-intro-modal');if(intro)intro.hidden=true;local.set('er-welcome-intro-dismissed',true);});
  byId('welcome-intro-modal')?.addEventListener('click',event=>{if(event.target===event.currentTarget){event.currentTarget.hidden=true;local.set('er-welcome-intro-dismissed',true);}});
  if('serviceWorker'in navigator)addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
  window.__easyReadReady = true;
}
let matches=[],matchIndex=-1;async function searchBook(){const query=byId('search-input').value.trim().toLowerCase(),token=++searchToken;if(CSS.highlights)CSS.highlights.delete('search');matches=[];pdfSearchMatches=[];matchIndex=pdfSearchIndex=-1;if(!query){byId('search-count').textContent='';return;}if(activePdf&&pdfMode){for(let pageNumber=1;pageNumber<=activePdf.numPages;pageNumber++){if(token!==searchToken)return;const page=await activePdf.getPage(pageNumber),content=await page.getTextContent(),text=content.items.map(item=>item.str).join(' ').toLowerCase();let from=0,index;while((index=text.indexOf(query,from))>=0){pdfSearchMatches.push({page:pageNumber});from=index+query.length;}if(pageNumber%20===0){byId('search-count').textContent=`Searching ${pageNumber} of ${activePdf.numPages}…`;await new Promise(requestAnimationFrame);}}if(token!==searchToken)return;byId('search-count').textContent=`${pdfSearchMatches.length} results`;if(pdfSearchMatches.length)moveMatch(1);return;}const walker=document.createTreeWalker(reader,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const node=walker.currentNode;let from=0,index;while((index=node.data.toLowerCase().indexOf(query,from))>=0){const range=new Range();range.setStart(node,index);range.setEnd(node,index+query.length);matches.push(range);from=index+query.length;}}if(CSS.highlights&&matches.length)CSS.highlights.set('search',new Highlight(...matches));byId('search-count').textContent=`${matches.length} results`;if(matches.length)moveMatch(1);}
function fullscreenReaderHost(){return document.fullscreenElement===readerWrap||document.fullscreenElement===pdfPages||document.fullscreenElement===reader?document.fullscreenElement:null;}
function getFullscreenDictionaryLayer(host){
  if(!host)return null;
  let layer=host.querySelector(':scope > #fullscreen-dictionary-layer');
  if(!layer){
    layer=document.createElement('div');
    layer.id='fullscreen-dictionary-layer';
    layer.setAttribute('aria-live','polite');
    host.append(layer);
  }
  ensureFullscreenReaderControls(layer);
  return layer;
}
function ensureFullscreenReaderControls(layer){
  if(!layer || layer.querySelector('#fullscreen-reader-controls')) return;
  const controls=document.createElement('div');
  controls.id='fullscreen-reader-controls';
  controls.className='fullscreen-reader-controls';
  controls.setAttribute('role','group');
  controls.setAttribute('aria-label','Fullscreen document controls');
  const makeButton=(id,label,aria,action)=>{
    const button=document.createElement('button');
    button.type='button';button.id=id;button.className='btn';
    button.textContent=label;button.setAttribute('aria-label',aria);
    button.addEventListener('click',action);
    controls.append(button);
  };
  makeButton('fullscreen-ask-ai','✦ Ask AI','Ask AI about this passage',()=>{
    const trigger=byId('ask-ai-toggle')||byId('ask-ai-float');
    if(trigger) trigger.click();
  });
  makeButton('fullscreen-zoom-out','−','Zoom out',()=>{
    if(activePdf) scalePdf(-.15); else changeReaderTextSize(-.1);
  });
  makeButton('fullscreen-zoom-in','+','Zoom in',()=>{
    if(activePdf) scalePdf(.15); else changeReaderTextSize(.1);
  });
  makeButton('fullscreen-exit','Exit fullscreen','Exit fullscreen document view',()=>{
    if(document.fullscreenElement) document.exitFullscreen?.().catch(()=>{});
  });
  layer.append(controls);
}
function movePopupToFullscreenHost(){
  const host=fullscreenReaderHost();
  if(host){
    const layer=getFullscreenDictionaryLayer(host);
    if(layer&&popup.parentElement!==layer)layer.appendChild(popup);
    popup.dataset.fullscreenLayer='true';
    popup.style.zIndex='2147483647';
  }else{
    const layer=popup.parentElement?.id==='fullscreen-dictionary-layer'?popup.parentElement:null;
    if(popup.parentElement!==document.body)document.body.appendChild(popup);
    popup.dataset.fullscreenLayer='false';
    popup.style.zIndex='';
    layer?.remove();
  }
  if(!popup.hidden)placePopup(activeDictionaryRange);
}
async function toggleReaderFullscreen(){
  try{
    if(fullscreenReaderHost()){
      await document.exitFullscreen();
    }else{
      await readerWrap.requestFullscreen();
    }
  }catch(error){
    movePopupToFullscreenHost();
    toast('Fullscreen is not available in this browser.');
  }
}
document.addEventListener('fullscreenchange',movePopupToFullscreenHost);
async function moveMatch(direction){if(activePdf&&pdfMode&&pdfSearchMatches.length){pdfSearchIndex=(pdfSearchIndex+direction+pdfSearchMatches.length)%pdfSearchMatches.length;const page=pdfSearchMatches[pdfSearchIndex].page;goPdfPage(page);await renderPdfPage(page);const query=byId('search-input').value.trim().toLowerCase(),layer=pdfPages.querySelector(`[data-page="${page}"] .textLayer`),ranges=[];const walker=document.createTreeWalker(layer,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const node=walker.currentNode;let from=0,index;while((index=node.data.toLowerCase().indexOf(query,from))>=0){const range=new Range();range.setStart(node,index);range.setEnd(node,index+query.length);ranges.push(range);from=index+query.length;}}if(CSS.highlights&&ranges.length)CSS.highlights.set('search',new Highlight(...ranges));return;}if(!matches.length)return;matchIndex=(matchIndex+direction+matches.length)%matches.length;matches[matchIndex].startContainer.parentElement.scrollIntoView({behavior:'smooth',block:'center'});}
function speakCurrent(){const text=(pdfMode?reader:reader).innerText;if(!text)return toast('Open a readable document first.');speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text.slice(0,50000));const rate=Number(byId('speech-rate')?.value||1);utterance.rate=rate;applyPreferredVoice(utterance);speechSynthesis.speak(utterance);toast('Reading aloud.');}
async function exportData(){
  try{
    const localData={};
    for(let index=0;index<localStorage.length;index++){
      const key=localStorage.key(index);
      if(!key||!key.startsWith('er-'))continue;
      const value=localStorage.getItem(key);
      try{localData[key]=JSON.parse(value);}catch{localData[key]=value;}
    }
    const books=(await getBooks()).map(book=>({
      key:book.key,name:book.name,title:book.title,type:book.type,added:book.added,
      opened:book.opened,favorite:!!book.favorite,progress:book.progress||0,
      position:book.position||null,words:book.words||0,
      file:book.file?{name:book.file.name,size:book.file.size,type:book.file.type,lastModified:book.file.lastModified,contentIncluded:false}:null
    }));
    const data={format:'easyread-data-export-v1',exportedAt:new Date().toISOString(),localData,books,originalBookFilesIncluded:false};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='easyread-data.json';document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast('EasyRead data exported. Original book files are not included.');
  }catch(error){console.error('Could not export EasyRead data',error);toast('Could not export data. Please try again.');}
}
async function deleteLocalData(){
  if(!confirm('Delete all local reading data and books? This cannot be undone.'))return;
  try{
    // The app keeps this IndexedDB connection open. Clear its stores instead of
    // deleting the database, which can be blocked by the active connection.
    await Promise.all([
      dbRequest('books','readwrite',store=>store.clear()),
      dbRequest('definitions','readwrite',store=>store.clear())
    ]);
    localStorage.clear();
    if(activeBook){activeBook=null;activePdf=null;reader.replaceChildren();pdfPages.replaceChildren();readerWrap.hidden=true;}
    await renderLibrary().catch(()=>{});
    updateWelcomeSignin();
    toast('Local reading data deleted. Reload EasyRead to start fresh.');
  }catch(error){
    console.error('Could not delete local reading data',error);
    toast('Some local data could not be deleted. Please try again.');
  }
}
function renderPrivacyState(){byId('privacy-status').textContent='Books and reading position are stored in this browser. Sign-in sync is optional.';}
async function renderLibrary(){const books=await getBooks(),list=byId('library-preview');if(!list)return;updateContinueCard(books);list.replaceChildren();if(!books.length){safeText(list,'p','Your books will appear here after you open one.','note');return;}const sort=byId('home-library-sort')?.value||'recent';books.sort((a,b)=>sort==='favorites'?((b.favorite?1:0)-(a.favorite?1:0))||((b.opened||0)-(a.opened||0)):sort==='title'?(a.title||a.name).localeCompare(b.title||b.name):sort==='progress'?(b.progress||0)-(a.progress||0):(b.opened||0)-(a.opened||0)).slice(0,4).forEach(book=>{const card=document.createElement('article');card.className='book-card';safeText(card,'strong',(book.favorite?'\u2605 ':'')+(book.title||book.name));const progress=document.createElement('progress');progress.max=100;progress.value=book.progress||0;card.append(progress);const open=safeText(card,'button','Continue reading','btn');open.onclick=()=>openFile(book.file);list.append(card);});}
function initContact(){
  const contact=window.EASYREAD_CONTACT||{};
  const telegram=String(contact.telegram||'').trim();
  const handle=telegram.replace(/^@/,'');
  const phoneDisplay=String(contact.phone||'').trim();
  const phone=phoneDisplay.replace(/[\\s().-]/g,'');
  const email=String(contact.email||'').trim();
  const telegramLink=byId('contact-telegram');
  const phoneLink=byId('contact-phone');
  const emailLink=byId('contact-email');
  const setContactLink=(link,label,value,href)=>{
    byId(label).textContent=value||'Unavailable';
    if(value&&href){link.href=href;link.classList.remove('unavailable');link.removeAttribute('aria-disabled');}
    else{link.removeAttribute('href');link.classList.add('unavailable');link.setAttribute('aria-disabled','true');}
  };
  setContactLink(telegramLink,'contact-telegram-label',telegram,handle?'https://t.me/'+encodeURIComponent(handle):'');
  setContactLink(phoneLink,'contact-phone-label',phoneDisplay,phone?'tel:'+phone:'');
  setContactLink(emailLink,'contact-email-label',email,email?'mailto:'+email:'');
  byId('contact-send').addEventListener('click',()=>{
    if(!email)return toast('Email contact is unavailable.');
    if(!byId('contact-message').value.trim())return toast('Write a short message first.');
    const subject=encodeURIComponent('EasyRead feedback');
    const body=encodeURIComponent(byId('contact-message').value.trim());
    toast('Opening your email app…');
    window.location.href='mailto:'+email+'?subject='+subject+'&body='+body;
  });
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();

// Move up / move down buttons: scroll about one screen at a time.
(() => {
  const scroller = () => {
    const fs = document.fullscreenElement;
    if (fs) {
      if (fs.scrollHeight > fs.clientHeight + 4) return fs;
      const inner = fs.querySelector('#pdf-pages');
      if (inner && inner.scrollHeight > inner.clientHeight + 4) return inner;
    }
    return null;
  };
  const move = direction => {
    const el = scroller();
    const height = el ? el.clientHeight : window.innerHeight;
    const amount = Math.max(120, height * 0.85) * direction;
    if (el) el.scrollBy({ top: amount, behavior: 'smooth' });
    else window.scrollBy({ top: amount, behavior: 'smooth' });
  };
  const bind = () => {
    byId('scroll-up')?.addEventListener('click', () => move(-1));
    byId('scroll-down')?.addEventListener('click', () => move(1));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();

// Home "Continue reading" card for the most recently opened book.
function updateContinueCard(books) {
  const card = byId('continue-card');
  if (!card) return;
  const latest = [...(books || [])].filter(book => book && book.file).sort((x, y) => (y.opened || 0) - (x.opened || 0))[0];
  if (!latest) { card.hidden = true; return; }
  const percent = Math.max(0, Math.min(100, Math.round(latest.progress || 0)));
  byId('continue-title').textContent = latest.title || latest.name || 'Your book';
  byId('continue-bar').value = percent;
  const button = byId('continue-btn');
  button.textContent = percent >= 100 ? 'Read again' : percent > 0 ? `Resume · ${percent}%` : 'Start reading';
  button.onclick = () => openFile(latest.file);
  card.hidden = false;
}

// Pronunciation: use the dictionary's recorded audio when there is one, else the browser voice.
let wordAudio = null;
function speakWord(word) {
  try { speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(word); utterance.lang = 'en'; speechSynthesis.speak(utterance); } catch {}
}
function playWordAudio(result) {
  try { wordAudio?.pause(); } catch {}
  const url = typeof result?.audio === 'string' && /^https:\/\//.test(result.audio) ? result.audio : '';
  if (!url) { speakWord(result.word); return; }
  wordAudio = new Audio(url);
  wordAudio.play().catch(() => speakWord(result.word));
}

// Reading streak: consecutive days with at least a minute of reading.
function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function recordReadingDay(seconds) {
  if (!(seconds > 0)) return;
  const days = local.get('er-reading-days', {});
  const key = localDayKey();
  days[key] = (days[key] || 0) + seconds;
  local.set('er-reading-days', days);
  updateStreakChip();
}
function readingStreak(days) {
  const cursor = new Date();
  if ((days[localDayKey(cursor)] || 0) < 60) cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while ((days[localDayKey(cursor)] || 0) >= 60) { count++; cursor.setDate(cursor.getDate() - 1); }
  return count;
}
function updateStreakChip() {
  const chip = byId('streak-chip');
  if (!chip) return;
  const days = local.get('er-reading-days', {});
  const streak = readingStreak(days);
  const todayMinutes = Math.floor((days[localDayKey()] || 0) / 60);
  if (!streak && !todayMinutes) { chip.hidden = true; return; }
  const goalMinutes = Number(readerTimerGoal) || 0;
  const parts = [];
  if (streak) parts.push(`${streak}-day streak`);
  parts.push(goalMinutes ? `${todayMinutes} of ${goalMinutes} min today` : `${todayMinutes} min today`);
  chip.textContent = parts.join(' \u00b7 ');
  chip.hidden = false;
}

// Long runs of dots (table-of-contents leaders) cannot wrap, so show them as a single ellipsis.
function tidyLeaders(text) {
  return String(text).replace(/(?:\s*[.\u00b7\u2022\u2026]){4,}\s*/g, ' \u2026 ').trim();
}

// Close panels and menus by clicking outside them or by opening something else.
let panelJustOpened = '';
function markPanelOpened(id) {
  panelJustOpened = id;
  setTimeout(() => { panelJustOpened = ''; }, 0);
}
function closeOtherPanels(except = '') {
  if (except !== 'tools-sheet') { const sheet = byId('tools-sheet'); if (sheet && !sheet.hidden) { sheet.hidden = true; byId('tools-btn')?.setAttribute('aria-expanded', 'false'); } }
  document.querySelectorAll('.panel, .contents').forEach(panel => {
    if (panel.id === except) return;
    if (panel.classList.contains('contents')) panel.classList.remove('open');
    else panel.hidden = true;
  });
  byId('contents-btn')?.setAttribute('aria-expanded', except === 'contents' ? 'true' : 'false');
  byId('settings-btn')?.setAttribute('aria-expanded', except === 'settings' ? 'true' : 'false');
  const backdrop = byId('library-backdrop');
  if (backdrop && except !== 'library') backdrop.hidden = true;
}
document.addEventListener('click', event => {
  // composedPath is fixed when the click starts, so it still works if a handler re-rendered the target.
  const path = event.composedPath().filter(node => node instanceof Element);
  const inside = selector => path.some(node => node.matches(selector));

  // "More" menu: close when clicking elsewhere or after choosing an action.
  document.querySelectorAll('details.toolbar-more[open]').forEach(details => {
    const menu = details.querySelector('.toolbar-menu') || document.querySelector('.toolbar-menu[data-portaled="true"]');
    const clickedMenu = path.includes(details) || (menu && path.some(node => node === menu || menu.contains(node)));
    const keepOpen = inside('#smaller, #larger');
    if (!clickedMenu || (inside('.toolbar-menu button') && !keepOpen)) {
      details.open = false;
      if (menu?.dataset.portaled === 'true') {
        details.append(menu);
        delete menu.dataset.portaled;
        menu.removeAttribute('style');
      }
    }
  });

  // Sign-in prompt: tapping the dimmed background closes it.
  const modal = byId('signin-modal');
  if (modal && !modal.hidden && event.target === modal) { modal.hidden = true; local.set('er-signin-dismissed', true); local.set('er-welcome-intro-dismissed', true); }

  // Side panels: close when clicking outside them.
  const anyOpen = document.querySelector('.panel:not([hidden]), .contents.open');
  if (!anyOpen) return;
  if (inside('.panel, .contents, #popup, dialog, #signin-modal, #library-backdrop')) return;
  closeOtherPanels(panelJustOpened);
});

// Library panel: All books / Favorites switch.
(() => {
  const bind = () => {
    const setView = favoritesOnly => { local.set('er-library-favorites-only', favoritesOnly); renderLibraryPanel(); };
    byId('library-view-all')?.addEventListener('click', () => setView(false));
    byId('library-view-fav')?.addEventListener('click', () => setView(true));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();

// ---------- Page title follows the view ----------
function updateDocumentTitle() {
  const route = document.body.dataset.route;
  const view = route || document.body.dataset.view;
  const name = activeBook?.title || activeBook?.name;
  if (view === 'library') document.title = 'My Library - EasyRead';
  else if (view === 'notes') document.title = 'My Notes - EasyRead';
  else document.title = view === 'reader' ? (name ? `${name} - EasyRead` : 'Reader - EasyRead') : 'EasyRead - a calmer way to read';
}

// ---------- Reading preferences: Focus, Line focus, High contrast, voice, reading language ----------
const SPEECH_LANGS = { en: 'en-US', am: 'am-ET', es: 'es-ES', fr: 'fr-FR', de: 'de-DE' };
function applyPreferredVoice(utterance) {
  const saved = local.get('er-speech-voice', '');
  const voice = saved && 'speechSynthesis' in window ? speechSynthesis.getVoices().find(item => item.voiceURI === saved) : null;
  if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
  else utterance.lang = SPEECH_LANGS[local.get('er-source-language', 'en')] || 'en-US';
}
function populateVoices() {
  const select = byId('speech-voice');
  if (!select || !('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices().slice().sort((x, y) => x.lang.localeCompare(y.lang) || x.name.localeCompare(y.name));
  const saved = local.get('er-speech-voice', '');
  select.replaceChildren(new Option('Browser default', ''));
  voices.forEach(voice => select.append(new Option(`${voice.name} (${voice.lang})`, voice.voiceURI)));
  select.value = voices.some(voice => voice.voiceURI === saved) ? saved : '';
}
(() => {
  const prefs = () => local.get('er-view-prefs', {});
  const setPref = (key, value) => { const next = prefs(); next[key] = value; local.set('er-view-prefs', next); };
  const paint = () => {
    const current = prefs();
    document.body.classList.toggle('line-focus', Boolean(current.lineFocus));
    document.body.classList.toggle('high-contrast', Boolean(current.contrast));
    const checkbox = byId('contrast'); if (checkbox) checkbox.checked = Boolean(current.contrast);
    const lineButton = byId('line-focus-btn');
    if (lineButton) { lineButton.setAttribute('aria-pressed', String(Boolean(current.lineFocus))); lineButton.textContent = current.lineFocus ? 'Line focus: on' : 'Line focus'; }
  };
  const setFocusMode = on => {
    document.body.classList.toggle('focus-mode', on);
    const button = byId('focus-btn');
    if (button) { button.setAttribute('aria-pressed', String(on)); button.textContent = on ? 'Exit focus' : 'Focus'; }
  };
  const bind = () => {
    paint();
    byId('focus-btn')?.addEventListener('click', () => {
      const on = !document.body.classList.contains('focus-mode');
      setFocusMode(on);
      toast(on ? 'Focus mode on. Press Esc or choose Exit focus to leave.' : 'Focus mode off.');
    });
    byId('line-focus-btn')?.addEventListener('click', () => {
      setPref('lineFocus', !prefs().lineFocus); paint();
      toast(prefs().lineFocus ? 'Line focus on: hover or tap a paragraph to bring it forward.' : 'Line focus off.');
    });
    byId('contrast')?.addEventListener('change', event => { setPref('contrast', event.target.checked); paint(); });
    byId('focus-exit-floating')?.addEventListener('click',()=>{setFocusMode(false);document.querySelector('.toolbar-more')?.removeAttribute('open');});
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('focus-mode')) setFocusMode(false); });

    const language = byId('source-language');
    if (language) {
      language.value = local.get('er-source-language', 'en');
      language.addEventListener('change', () => { local.set('er-source-language', language.value); toast('Reading language saved.'); });
    }
    populateVoices();
    if ('speechSynthesis' in window) speechSynthesis.addEventListener?.('voiceschanged', populateVoices);
    byId('speech-voice')?.addEventListener('change', event => { local.set('er-speech-voice', event.target.value); toast('Voice saved.'); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();

// ---------- Back up / restore original book files (Firebase Storage, signed-in users) ----------
const BOOK_MIME_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg'
};
function setBackupStatus(message, kind = '') {
  const node = byId('book-backup-status');
  if (node) { node.textContent = message; node.className = 'note' + (kind === 'error' ? ' auth-error' : kind === 'success' ? ' auth-success' : ''); }
  toast(message);
}
async function bookBackupContext() {
  await initFirebase();
  const account = user || auth?.currentUser;
  if (!account) throw new Error('Sign in first to back up or restore your books.');
  await loadLibrary('firebaseStorage');
  return { account, folder: firebase.storage().ref(`users/${account.uid}/books`) };
}
function friendlyBackupError(error) {
  const code = String(error?.code || '');
  if (code.includes('unauthorized') || code.includes('permission')) return 'Storage permission was denied. Check that Firebase Storage is enabled and the storage rules are deployed.';
  if (code.includes('quota')) return 'Your Firebase Storage quota is full.';
  if (code.includes('canceled')) return 'The transfer was cancelled.';
  if (!navigator.onLine) return 'You are offline. Connect to the internet and try again.';
  return error?.message || 'Something went wrong. Please try again.';
}
async function backupBooks() {
  const button = byId('backup-books');
  try {
    button.disabled = true;
    setBackupStatus('Preparing backup…');
    const { folder } = await bookBackupContext();
    const books = (await getBooks()).filter(book => book.file);
    if (!books.length) return setBackupStatus('You have no books in this browser to back up yet.');
    let done = 0, skipped = 0;
    for (const [index, book] of books.entries()) {
      const ext = String(book.type || book.name?.split('.').pop() || '').toLowerCase();
      if (!BOOK_MIME_TYPES[ext] || book.file.size > 50 * 1024 * 1024) { skipped++; continue; }
      setBackupStatus(`Backing up ${index + 1} of ${books.length}: ${book.title || book.name}`);
      await folder.child(encodeURIComponent(book.key)).put(book.file, {
        contentType: BOOK_MIME_TYPES[ext],
        customMetadata: { key: book.key, name: book.name || '', title: book.title || '', type: ext }
      });
      done++;
    }
    setBackupStatus(`Backed up ${done} book${done === 1 ? '' : 's'}.` + (skipped ? ` ${skipped} skipped (unsupported type or over 50 MB).` : ''), 'success');
  } catch (error) {
    setBackupStatus(friendlyBackupError(error), 'error');
  } finally { button.disabled = false; }
}
async function restoreBooks() {
  const button = byId('restore-books');
  try {
    button.disabled = true;
    setBackupStatus('Looking for backed-up books…');
    const { folder } = await bookBackupContext();
    const { items } = await folder.listAll();
    if (!items.length) return setBackupStatus('No backed-up books were found for this account.');
    let restored = 0, existing = 0;
    for (const [index, item] of items.entries()) {
      const meta = await item.getMetadata();
      const info = meta.customMetadata || {};
      let key = info.key;
      if (!key) { try { key = decodeURIComponent(item.name); } catch { key = item.name; } }
      if (await getBook(key).catch(() => null)) { existing++; continue; }
      setBackupStatus(`Restoring ${index + 1} of ${items.length}…`);
      const response = await fetch(await item.getDownloadURL());
      if (!response.ok) throw new Error('A book could not be downloaded.');
      const blob = await response.blob();
      const name = info.name || item.name;
      const ext = info.type || name.split('.').pop().toLowerCase();
      const file = new File([blob], name, { type: meta.contentType || BOOK_MIME_TYPES[ext] || '' });
      await putBook({ key, name, title: info.title || name.replace(/\.[^.]+$/, ''), file, type: ext, added: Date.now(), opened: 0, favorite: false, progress: 0 });
      restored++;
    }
    await renderLibrary().catch(() => {}); await renderLibraryPanel().catch(() => {});
    setBackupStatus(`Restored ${restored} book${restored === 1 ? '' : 's'}.` + (existing ? ` ${existing} already on this device.` : ''), 'success');
  } catch (error) {
    setBackupStatus(friendlyBackupError(error), 'error');
  } finally { button.disabled = false; }
}
(() => {
  const bind = () => {
    byId('backup-books')?.addEventListener('click', backupBooks);
    byId('restore-books')?.addEventListener('click', restoreBooks);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();

// The full-screen backdrop behind the library must always match the panel, so it can never be left
// behind (for example after pressing Esc) and swallow the next click.
(() => {
  const bind = () => {
    const panel = byId('library'), backdrop = byId('library-backdrop');
    if (!panel || !backdrop) return;
    const sync = () => { backdrop.hidden = panel.hidden; };
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    sync();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();

// ---------- Phones: slide the main reader toolbar away while reading down, bring it back on scroll up ----------
(() => {
  const phone = matchMedia('(max-width: 700px)');
  let last = scrollY, ticking = false;
  const show = () => document.body.classList.remove('bar-away');
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = scrollY, delta = y - last;
      if (!phone.matches || y < 140 || document.querySelector('.toolbar-more[open]') || document.body.classList.contains('focus-mode')) { show(); last = y; return; }
      if (Math.abs(delta) < 12) return;
      document.body.classList.toggle('bar-away', delta > 0);
      last = y;
    });
  }, { passive: true });
  document.addEventListener('toggle', event => { if (event.target.matches?.('.toolbar-more') && event.target.open) show(); }, true);
  document.addEventListener('focusin', event => { if (event.target.closest?.('.bar')) show(); });
  phone.addEventListener?.('change', show);
})();

// ---------- PDF page view: the page counter follows the page actually under the reading line ----------
(() => {
  let ticking = false;
  const update = () => {
    ticking = false;
    if (typeof activePdf === 'undefined' || !activePdf || pdfPages.hidden) return;
    const line = innerHeight * 0.4;
    let best = null, bestGap = Infinity;
    for (const frame of pdfPages.children) {
      const rect = frame.getBoundingClientRect();
      if (rect.top <= line && rect.bottom > line) { best = frame; break; }
      const gap = Math.min(Math.abs(rect.top - line), Math.abs(rect.bottom - line));
      if (gap < bestGap) { bestGap = gap; best = frame; }
    }
    const page = Number(best?.dataset?.page);
    if (!page || page === activePage) return;
    activePage = page;
    byId('pdf-page-label').textContent = `Page ${page} of ${pageCount}`;
    syncPageCounter(page);
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
})();


// ---------- Ask AI about a selected phrase or sentence while reading ----------
(() => {
  const bind = () => {
    const toggles = [byId('ask-ai-toggle'), byId('ask-ai-float')].filter(Boolean);
    const toggle = byId('ask-ai-toggle');
    const panel = byId('ai-passage-panel');
    const passage = byId('ai-passage-text');
    const question = byId('ai-passage-question');
    const answer = byId('ai-passage-answer');
    const submit = byId('ai-passage-submit');
    const count = byId('ai-passage-count');
    if (!toggles.length || !panel || !passage || !answer || !submit) return;

    // Keep the panel in the active fullscreen subtree, otherwise browsers hide it
    // when Full document is opened on the PDF pages element.
    const originalParent = panel.parentElement;
    const originalNextSibling = panel.nextSibling;
    const movePanelForFullscreen = () => {
      const host = typeof fullscreenReaderHost === 'function' ? fullscreenReaderHost() : null;
      if (host) {
        const layer = typeof getFullscreenDictionaryLayer === 'function' ? getFullscreenDictionaryLayer(host) : null;
        if (layer && panel.parentElement !== layer) layer.appendChild(panel);
      } else if (originalParent && panel.parentElement !== originalParent) {
        originalParent.insertBefore(panel, originalNextSibling?.parentElement === originalParent ? originalNextSibling : null);
      }
    };
    document.addEventListener('fullscreenchange', movePanelForFullscreen);

    let rememberedSelection = '';
    const getSelectedPassage = () => {
      const selection = window.getSelection();
      const text = String(selection?.toString() || '').replace(/\s+/g, ' ').trim();
      if (!text) return rememberedSelection;
      const anchor = selection?.anchorNode;
      const reader = byId('reader-wrap');
      if (reader && anchor && reader.contains(anchor)) {
        rememberedSelection = text.slice(0, 900);
        return rememberedSelection;
      }
      return text.slice(0, 900);
    };
    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection();
      const text = String(selection?.toString() || '').replace(/\s+/g, ' ').trim();
      const anchor = selection?.anchorNode;
      const reader = byId('reader-wrap');
      if (text && reader && anchor && reader.contains(anchor)) rememberedSelection = text.slice(0, 900);
    });

    const updateCount = () => { if (count) count.textContent = passage.value.length + ' / 900'; };
    const openPanel = () => {
      panel.hidden = false;
      toggles.forEach(button => button.setAttribute('aria-expanded', 'true'));
      document.body.classList.add('ask-ai-open');
      const selected = getSelectedPassage();
      if (selected) passage.value = selected;
      updateCount();
      requestAnimationFrame(() => passage.focus({ preventScroll: true }));
    };
    const closePanel = (restoreFocus = true) => {
      if (panel.hidden) return;
      panel.hidden = true;
      toggles.forEach(button => button.setAttribute('aria-expanded', 'false'));
      document.body.classList.remove('ask-ai-open');
      if (restoreFocus) toggle?.focus({ preventScroll: true });
    };

    toggles.forEach(button => {
      button.addEventListener('pointerdown', () => { rememberedSelection = getSelectedPassage() || rememberedSelection; });
      button.addEventListener('click', () => {
        if (panel.hidden) openPanel();
        else closePanel();
      });
    });
    // Clicking anywhere outside the Ask AI dialog dismisses it without stealing focus.
    document.addEventListener('pointerdown', event => {
      if (panel.hidden) return;
      if (panel.contains(event.target) || toggles.some(button => button.contains(event.target)) ||
          event.target.closest?.('#fullscreen-ask-ai')) return;
      closePanel(false);
    }, true);
    byId('ai-passage-close')?.addEventListener('click', closePanel);
    passage.addEventListener('input', updateCount);
    passage.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') panel.requestSubmit();
    });

    const cache = new Map();
    panel.addEventListener('submit', async event => {
      event.preventDefault();
      const text = passage.value.replace(/\s+/g, ' ').trim().slice(0, 900);
      const questionText = question?.value?.replace(/\s+/g, ' ').trim().slice(0, 300) || '';
      if (!text) {
        passage.setCustomValidity('Select or enter a phrase or sentence first.');
        passage.reportValidity();
        passage.setCustomValidity('');
        passage.focus();
        return;
      }
      if (!navigator.onLine) {
        answer.hidden = false;
        answer.textContent = 'Connect to the internet to ask AI about this passage.';
        return;
      }
      const cacheKey = text + '|' + questionText;
      answer.hidden = false;
      answer.textContent = 'Reading the passage…';
      submit.disabled = true;
      submit.textContent = 'Thinking…';
      try {
        let explanation = cache.get(cacheKey);
        if (!explanation) {
          const params = new URLSearchParams({ text, question: questionText });
          const response = await fetchWithTimeout('/api/explain?' + params.toString(), {
            headers: { accept: 'application/json' }
          }, 15000);
          let data = {};
          try { data = await response.json(); } catch {}
          if (!response.ok) {
            const error = new Error(data.error || 'AI explanation is unavailable right now.');
            error.notConfigured = Boolean(data.notConfigured);
            throw error;
          }
          explanation = String(data.explanation || '').trim();
          if (!explanation) throw new Error('AI did not return an explanation. Please try again.');
          cache.set(cacheKey, explanation);
        }
        answer.replaceChildren();
        const responseText = document.createElement('p');
        responseText.className = 'ai-passage-response';
        responseText.textContent = explanation;
        answer.append(responseText);
        const source = document.createElement('small');
        source.textContent = 'AI-generated by Gemini. It may miss the author’s intended meaning, so use the surrounding text as context.';
        answer.append(source);
        const actions = document.createElement('div'); actions.className = 'ask-response-actions';
        const copyButton = document.createElement('button'); copyButton.type='button'; copyButton.className='ask-response-action'; copyButton.textContent='Copy';
        copyButton.addEventListener('click',async()=>{try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(explanation);else{const field=document.createElement('textarea');field.value=explanation;field.readOnly=true;field.style.position='fixed';field.style.opacity='0';document.body.append(field);field.select();const ok=document.execCommand('copy');field.remove();if(!ok)throw new Error('Copy unavailable');}copyButton.textContent='Copied';setTimeout(()=>{if(copyButton.isConnected)copyButton.textContent='Copy';},1400);}catch{toast('Could not copy automatically. Select the answer and copy it.');}});
        const noteButton=document.createElement('button');noteButton.type='button';noteButton.className='ask-response-action';noteButton.textContent='Take as a note';
        noteButton.addEventListener('click',()=>{const notes=local.get('er-notes',[]);notes.unshift({id:newSavedItemId(),word:'Ask AI response',text:explanation+'\n\nPassage: '+text+(questionText?'\nQuestion: '+questionText:''),book:activeBook?.key,bookName:activeBook?.title||activeBook?.name||'',created:Date.now()});local.set('er-notes',notes);queueCloudSync();renderMyNotes();renderSavedItems();toast('AI response saved to My Notes.');});
        actions.append(copyButton,noteButton);answer.append(actions);
        submit.textContent = 'Explain again';
      } catch (error) {
        answer.replaceChildren(); safeText(answer,error.message || 'AI explanation is unavailable right now.','ai-passage-error');
        if(!error.notConfigured){const retry=safeText(answer,'button','↻ Try again','ask-response-action ask-retry-response');retry.type='button';retry.addEventListener('click',()=>{if(!submit.disabled)panel.requestSubmit();});}
        submit.textContent = 'Try again';
      } finally {
        submit.disabled = false;
      }
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();

// ---------- Profile picture (custom photo overrides the Google one; stored locally and in the user's own Firestore doc) ----------
function profilePhoto(){return user?(local.get('er-photo-'+user.uid,'')||user.photoURL||''):'';}
(() => {
  const input=byId('photo-input'),pick=byId('photo-change'),remove=byId('photo-remove');
  if(!input||!pick)return;
  const saveRemote=async data=>{try{if(!firestore)await initFirebase();await firestore.collection('users').doc(user.uid).set({photoData:data},{merge:true});}catch(e){}};
  pick.addEventListener('click',()=>input.click());
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];input.value='';if(!file||!user)return;
    if(!/^image\//.test(file.type))return toast('Please choose an image file.');
    try{
      const bmp=await createImageBitmap(file),size=256,side=Math.min(bmp.width,bmp.height),canvas=document.createElement('canvas');
      canvas.width=canvas.height=size;canvas.getContext('2d').drawImage(bmp,(bmp.width-side)/2,(bmp.height-side)/2,side,side,0,0,size,size);
      const data=canvas.toDataURL('image/jpeg',.85);local.set('er-photo-'+user.uid,data);updateProfile();toast('Profile picture updated.');saveRemote(data);
    }catch(e){toast('That image could not be used. Try another one.');}
  });
  remove?.addEventListener('click',()=>{if(!user)return;local.remove?local.remove('er-photo-'+user.uid):localStorage.removeItem('er-photo-'+user.uid);updateProfile();toast('Profile picture removed.');saveRemote('');});
})();

// ---------- Reader tools sheet (phones) ----------
(() => {
  const phone = matchMedia('(max-width: 700px)');
  const sheet = byId('tools-sheet'), grid = byId('tools-sheet-grid'), toolsBtn = byId('tools-btn');
  if (!sheet || !grid || !toolsBtn) return;
  const el = id => byId(id);
  const place = (parent, nodes, before = null) => nodes.filter(Boolean).forEach(node => parent.insertBefore(node, before));
  const closeSheet = () => { sheet.hidden = true; toolsBtn.setAttribute('aria-expanded', 'false'); };
  const openSheet = () => {
    closeOverlayPanels();
    byId('contents')?.classList.remove('open');
    hidePopup?.();
    sheet.hidden = false;
    toolsBtn.setAttribute('aria-expanded', 'true');
  };
  const ids = ['saved-btn', 'notes-btn', 'dictionary-btn', 'ask-ai-toggle', 'full-document-btn', 'focus-btn', 'fullscreen-btn', 'settings-btn', 'again'];
  const marks = new Map();
  const mark = node => { if (node && !marks.has(node)) { const m = document.createComment('tool-slot'); node.before(m); marks.set(node, m); } };
  const layout = () => {
    const timer = document.querySelector('.reading-timer'), textSize = document.querySelector('.text-size');
    const nodes = [timer, ...ids.map(el), textSize].filter(Boolean);
    nodes.forEach(mark);
    if (phone.matches) {
      nodes.forEach(node => grid.append(node));
    } else {
      closeSheet();
      nodes.forEach(node => { const m = marks.get(node); if (m?.parentNode) m.parentNode.insertBefore(node, m.nextSibling); });
    }
  };
  toolsBtn.addEventListener('click', event => { event.stopPropagation(); if (sheet.hidden) openSheet(); else closeSheet(); });
  byId('tools-close')?.addEventListener('click', closeSheet);
  sheet.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || ['tools-close', 'smaller', 'larger', 'timer-toggle', 'timer-reset'].includes(button.id)) return;
    setTimeout(closeSheet, 0);
  });
  document.addEventListener('click', event => {
    if (sheet.hidden) return;
    const path = event.composedPath();
    if (!path.includes(sheet) && !path.includes(toolsBtn)) closeSheet();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !sheet.hidden) closeSheet(); });
  phone.addEventListener?.('change', layout);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', layout); else layout();
})();

// ---------- Warm up heavy parts in idle time so opening a file feels instant ----------
(() => {
  const saveData = navigator.connection?.saveData;
  const warm = () => { if (!saveData) loadPdfLibrary().catch(() => {}); };
  (window.requestIdleCallback || (cb => setTimeout(cb, 2500)))(warm, { timeout: 6000 });
  // Word, PowerPoint, EPUB and OpenDocument files need the zip reader: fetch it as soon as the file picker is touched.
  const prime = () => { if (!saveData) { loadLibrary('zip').catch(() => {}); loadLibrary('mammoth').catch(() => {}); } };
  byId('drop')?.addEventListener('pointerdown', prime, { once: true, passive: true });
  byId('camera-btn')?.addEventListener('pointerdown', () => loadLibrary('ocr').catch(() => {}), { once: true, passive: true });
})();
