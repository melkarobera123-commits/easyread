const $ = selector => document.querySelector(selector);
const byId = id => document.getElementById(id);
const local = {
  get(key, fallback = null) { try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
};
const loadedScripts = new Map();
let pdfjsLib = null, pdfLibraryPromise = null;
const sources = {
  mammoth: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
  zip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  ocr: 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js',
  firebaseApp: 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  firebaseAuth: 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  firebaseStore: 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  firebaseStorage: 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage-compat.js',
  purifier: 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.6/purify.min.js'
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
let activeBook = null, activePdf = null, pdfMode = true, zoom = 1, pageCount = 0, lookupController = null, toastTimer, saveTimer, auth = null, firestore = null, storage = null, user = null, installPromptEvent = null;
let pageObserver = null, thumbObserver = null, activePage = 1, pdfTextPromise = null, pdfSearchMatches = [], pdfSearchIndex = -1, searchToken = 0, firebaseInitPromise = null, cloudSyncTimer = null;
let popupReturnFocus = null;
let activeNoteWord = '';
let pdfPreviewsVisible = local.get('er-pdf-previews', true) !== false;
let readerTimerInterval = null, readerTimerStart = 0, readerTimerSeconds = 0, readerTimerGoal = 0, readerTimerDay = '', readerTimerRunning = false, readerTimerRecordedSeconds = 0, readerTimerBookKey = null, timerResumeOnVisible = false;
const pdfRenderPromises = new Map();

function toast(message) { const node = byId('toast'); node.textContent = message; node.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 2800); }
function status(message, error = false) { const node = byId('status'); node.textContent = message; node.classList.toggle('err', error); }
function safeText(parent, tag, text, className = '') { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text; parent.append(node); return node; }
function setView(view) { document.body.dataset.view = view; for (const id of ['about-nav','sidebar-about','mobile-about']) byId(id)?.classList.toggle('active', view === 'about'); for (const id of ['reader-nav','sidebar-reader','mobile-reader']) byId(id)?.classList.toggle('active', view === 'reader'); if (view === 'reader') readerWrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); else scrollTo({ top: 0, behavior: 'smooth' }); }
function goToUpload() { setView('about'); status('Choose a book to open the Reader.'); requestAnimationFrame(() => { drop.scrollIntoView({ behavior: 'smooth', block: 'center' }); drop.focus({ preventScroll: true }); drop.classList.add('guide-focus'); setTimeout(() => drop.classList.remove('guide-focus'), 900); }); }
function closeDictionaryPanel(){const panel=byId('dictionary-panel');if(panel)panel.hidden=true;byId('dictionary-btn')?.setAttribute('aria-expanded','false');}
function showPanel(id, open) { const panel = byId(id); if (!panel) return; closeDictionaryPanel();panel.hidden = open === undefined ? !panel.hidden : !open; if (id === 'library' && !panel.hidden) renderLibraryPanel(); if (id === 'vocab' && !panel.hidden) renderVocabulary(); if (id === 'stats' && !panel.hidden) renderStats(); if (id === 'privacy' && !panel.hidden) renderPrivacyState(); }
function hidePanels() { document.querySelectorAll('.panel, .contents').forEach(panel => { panel.hidden = true; panel.classList.remove('open'); }); }

function initNavigation() {
  document.querySelector('.brand')?.addEventListener('click', event => { event.preventDefault(); setView('about'); });
  for (const id of ['about-nav','sidebar-about','mobile-about']) byId(id)?.addEventListener('click', () => setView('about'));
  for (const id of ['reader-nav','sidebar-reader','mobile-reader']) byId(id)?.addEventListener('click', () => readerWrap.hidden ? goToUpload() : setView('reader'));
  for (const id of ['sidebar-library','mobile-library','library-btn','library-home-btn']) byId(id)?.addEventListener('click', () => showPanel('library'));
  for (const id of ['sidebar-account','mobile-account','account-btn']) byId(id)?.addEventListener('click', openAccount);
  byId('saved-btn')?.addEventListener('click',()=>showPanel('vocab'));
  byId('sidebar-theme')?.addEventListener('click', () => byId('theme').click());
  for (const [id, panel] of [['settings-btn','settings'],['vocab-btn','vocab'],['stats-btn','stats'],['flashcards-btn','learning'],['contact-link','contact'],['privacy-link','privacy'],['shortcuts-link','shortcuts']]) byId(id)?.addEventListener('click', event => { if (id === 'contact-link') event.preventDefault(); showPanel(panel); });
  byId('contents-btn')?.addEventListener('click',()=>{const panel=byId('contents'),open=!panel.classList.contains('open');panel.hidden=false;panel.classList.toggle('open',open);byId('contents-btn').setAttribute('aria-expanded',String(open));if(open){renderContents();renderSavedItems();}});
  document.querySelectorAll('[id$="-close"]').forEach(button => button.addEventListener('click', () => { const panel = button.closest('aside'); if (panel) showPanel(panel.id, false); if (panel?.id === 'contents') panel.classList.remove('open'); }));
  document.addEventListener('click',event=>{if(!byId('dictionary-panel').hidden&&!event.target.closest('#dictionary-panel,#dictionary-btn'))closeDictionaryPanel();});
  byId('again')?.addEventListener('click', () => { pauseReadingTimer(); readerWrap.hidden = true; setView('about'); hidePopup(); });
}

async function openFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase(), allowed = ['pdf','docx','pptx','epub','txt','png','jpg','jpeg'];
  if (!allowed.includes(ext)) return status('Choose a PDF, DOCX, PPTX, EPUB, TXT, or image file.', true);
  if (file.size > 150 * 1024 * 1024) return status('This file is larger than 150 MB. Try a smaller copy.', true);
  hidePopup(); reader.replaceChildren(); pdfPages.replaceChildren(); pdfThumbs.replaceChildren(); activePdf = null; pdfTextPromise = null; pdfRenderPromises.clear(); pdfMode = true; byId('pdf-toolbar').hidden = true; byId('pdf-controls').hidden = true; pageCount = 0;
  byId('loading-skeleton').hidden = false; readerWrap.hidden = false; setView('reader'); status(`Preparing ${file.name}…`);
  const key = `${file.name}:${file.size}:${file.lastModified}`;
  activeBook = await getBook(key).catch(() => null) || { key, name: file.name, title: file.name.replace(/\.[^.]+$/, ''), file, type: ext, added: Date.now(), favorite: false, progress: 0 };
  const rememberedPosition = local.get(`er-position:${key}`);
  if (rememberedPosition && rememberedPosition.savedAt > (activeBook.position?.savedAt || 0)) activeBook.position = rememberedPosition;
  activeBook.file = file; activeBook.opened = Date.now(); activeBook.type = ext;
  try { if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);
    if (ext === 'pdf') await parsePdf(file);
    else if (ext === 'docx') await parseDocx(file);
    else if (ext === 'pptx') await parsePptx(file);
    else if (ext === 'epub') await parseEpub(file);
    else if (ext === 'txt') appendTextPages(await file.text());
    else await parseImage(file);
    if (!reader.textContent.trim() && ext !== 'pdf') throw new Error('No readable text was found in this file.');
    activeBook.words = wordCount(reader.textContent); await putBook(activeBook); byId('file-name').textContent = activeBook.title; updateDocMeta(); renderLibrary();
    byId('loading-skeleton').hidden = true; status(''); if (activeBook.position) restorePosition(); byId('reader-page-jump').max=String(Math.max(1,pageCount)); byId('reader-page-jump').value=String(activeBook.position?.page||1); byId('text-view-controls').hidden=Boolean(activePdf&&pdfMode); readerTimerBookKey=activeBook.key;readerTimerRecordedSeconds=elapsedReadingSeconds();startReadingTimer(); toast('Book opened. Your reading position will be saved here.');
  } catch (error) { console.error(error); byId('loading-skeleton').hidden = true; status(error.message || 'Could not open this file. It may be damaged or password-protected.', true); }
}
function wordCount(text) { return (text.match(/\S+/g) || []).length; }
function updateDocMeta() { byId('doc-meta').textContent = `${pageCount ? `${pageCount} pages · ` : ''}${(activeBook.words || 0).toLocaleString()} words`;byId('jump').max=String(Math.max(1,pageCount)); }
function appendTextPages(text) { const blocks = String(text).split(/\n\s*\n/).map(part => part.trim()).filter(Boolean); const chunks = []; for (let i = 0; i < blocks.length; i += 20) chunks.push(blocks.slice(i, i + 20)); chunks.forEach((chunk, index) => { const section = document.createElement('section'); section.className = 'page'; section.dataset.page = String(index + 1); safeText(section, 'div', `Section ${index + 1}`, 'page-mark'); chunk.forEach(paragraph => safeText(section, 'p', paragraph)); reader.append(section); }); pageCount = chunks.length; }
async function parseDocx(file) { await loadLibrary('mammoth'); const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() }); appendTextPages(result.value); }
async function parsePptx(file) { await loadLibrary('zip'); const zip = await JSZip.loadAsync(await file.arrayBuffer()); const names = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b) => Number(a.match(/slide(\d+)/)[1])-Number(b.match(/slide(\d+)/)[1])); pageCount = names.length; for (let i=0;i<names.length;i++) { const xml = new DOMParser().parseFromString(await zip.file(names[i]).async('text'),'application/xml'); const text = [...xml.getElementsByTagName('a:t')].map(node => node.textContent).join(' ').trim(); const section = document.createElement('section'); section.className='page'; section.dataset.page=String(i+1); safeText(section,'div',`Slide ${i+1}`,'page-mark'); if(text) safeText(section,'p',text); reader.append(section); if(i%12===11) await new Promise(requestAnimationFrame); } }
async function parseEpub(file) { await loadLibrary('zip'); const zip=await JSZip.loadAsync(await file.arrayBuffer()); const container=new DOMParser().parseFromString(await zip.file('META-INF/container.xml').async('text'),'application/xml'); const root=container.querySelector('rootfile')?.getAttribute('full-path'); if(!root) throw new Error('This EPUB has an invalid package file.'); const opf=new DOMParser().parseFromString(await zip.file(root).async('text'),'application/xml'); const title=opf.getElementsByTagNameNS('*','title')[0]?.textContent.trim(); if(title) activeBook.title=title; const base=root.includes('/')?root.slice(0,root.lastIndexOf('/')+1):''; const items=new Map([...opf.querySelectorAll('manifest item')].map(item=>[item.id,item.getAttribute('href')])); let index=0; for(const ref of opf.querySelectorAll('spine itemref')) { const path=items.get(ref.getAttribute('idref')); const entry=path&&zip.file(base+decodeURIComponent(path)); if(!entry) continue; const doc=new DOMParser().parseFromString(await entry.async('text'),'text/html'); const text=doc.body?.textContent||''; if(text.trim()){ const section=document.createElement('section'); section.className='page'; section.dataset.page=String(++index); appendTextNodes(section,text); reader.append(section); } if(index%8===0) await new Promise(requestAnimationFrame); } pageCount=index; }
function appendTextNodes(section,text) { const paragraphs=String(text).split(/\n\s*\n/).map(value=>value.replace(/\s+/g,' ').trim()).filter(Boolean); paragraphs.forEach(value=>safeText(section,'p',value)); }
async function parseImage(file) { await loadLibrary('ocr'); status('Reading image text…'); const worker=await Tesseract.createWorker('eng'); try { const result=await worker.recognize(file,{logger:message=>{ if(message.status==='recognizing text') status(`Reading image text… ${Math.round(message.progress*100)}%`); }}); appendTextPages(result.data.text); } finally { await worker.terminate(); } }

async function parsePdf(file) {
  await loadPdfLibrary();
  let pdf; try { pdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise; } catch { throw new Error('Could not open this PDF. It may be damaged or password-protected.'); }
  activePdf=pdf; pageCount=pdf.numPages; zoom=1; pdfPages.hidden=false; pdfThumbs.hidden=!pdfPreviewsVisible; byId('pdf-toolbar').hidden=false; byId('pdf-controls').hidden=false; byId('pdf-mode-btn').textContent='Text view';byId('jump').max=String(pageCount);byId('pdf-preview-toggle').textContent=pdfPreviewsVisible?'Hide previews':'Show previews';byId('pdf-preview-toggle').setAttribute('aria-pressed',String(pdfPreviewsVisible));reader.hidden=true;
  pageObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{ if(entry.isIntersecting){ const page=Number(entry.target.dataset.page); activePage=page; byId('pdf-page-label').textContent=`Page ${page} of ${pageCount}`; renderPdfPage(page).catch(console.error); } else if(Math.abs(Number(entry.target.dataset.page)-activePage)>1) releasePdfPage(entry.target); }),{rootMargin:'30% 0px'});
  thumbObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{ if(entry.isIntersecting) renderThumbnail(Number(entry.target.dataset.page)); }),{rootMargin:'0px 240px'});
  for(let number=1;number<=pdf.numPages;number++){
    const frame=document.createElement('figure'); frame.className='pdf-page readable'; frame.dataset.page=String(number);
    const canvas=document.createElement('canvas'); canvas.setAttribute('aria-label',`PDF page ${number}`);
    const textLayer=document.createElement('div'); textLayer.className='textLayer';
    frame.append(canvas,textLayer,safeText(document.createElement('div'),'span',`Page ${number}`,'pdf-caption')); pdfPages.append(frame); pageObserver.observe(frame);
    const thumbButton=document.createElement('button'); thumbButton.className='pdf-thumb'; thumbButton.type='button'; thumbButton.dataset.page=String(number); thumbButton.setAttribute('aria-label',`Go to page ${number}`); safeText(thumbButton,'span',String(number)); thumbButton.addEventListener('click',()=>goPdfPage(number)); pdfThumbs.append(thumbButton); thumbObserver.observe(thumbButton);
    if(number%80===0) await new Promise(requestAnimationFrame);
  }
  pageCount=pdf.numPages;
}
async function buildPdfTextView(){
  if(!activePdf)return;
  if(pdfTextPromise)return pdfTextPromise;
  pdfTextPromise=(async()=>{reader.replaceChildren();for(let number=1;number<=activePdf.numPages;number++){const page=await activePdf.getPage(number),content=await page.getTextContent(),section=document.createElement('section');section.className='page readable';section.dataset.page=String(number);safeText(section,'div',`Page ${number}`,'page-mark');const lines=[];let line='';for(const item of content.items){if(!item||typeof item.str!=='string')continue;const value=item.str.trim();if(value)line+=(line?' ':'')+value;if(item.hasEOL&&line){lines.push(line);line='';}}if(line)lines.push(line);const textLines=lines.length?lines:[content.items.map(item=>item?.str||'').join(' ').trim()];for(const value of textLines){if(value)safeText(section,'p',value);}reader.append(section);if(number%8===0)await new Promise(requestAnimationFrame);}return true;})();
  try{return await pdfTextPromise;}catch(error){pdfTextPromise=null;throw error;}
}
function pageScale(page) { const base=page.getViewport({scale:1}); const fit=Math.min((pdfPages.clientWidth-36)/base.width,1.5); return Math.max(.5,fit*zoom); }
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
async function drawPdfPage(pdf,number,frame) { const page=await pdf.getPage(number), scale=pageScale(page), viewport=page.getViewport({scale}), desiredDpr=Math.min(devicePixelRatio||1,2), pixelBudget=12_000_000, dpr=Math.min(desiredDpr,Math.max(.5,Math.sqrt(pixelBudget/(viewport.width*viewport.height)))), canvas=frame.querySelector('canvas'), context=canvas.getContext('2d',{alpha:false}); canvas.width=Math.round(viewport.width*dpr); canvas.height=Math.round(viewport.height*dpr); canvas.style.width=`${viewport.width}px`; canvas.style.height=`${viewport.height}px`; frame.style.minHeight=`${viewport.height+48}px`; const renderViewport=page.getViewport({scale:scale*dpr}); await page.render({canvasContext:context,viewport:renderViewport}).promise; const layer=frame.querySelector('.textLayer'); unregisterPdfSelectionLayer(layer); layer.replaceChildren(); layer.style.left=`${canvas.offsetLeft}px`; layer.style.top=`${canvas.offsetTop}px`; layer.style.width=`${viewport.width}px`; layer.style.height=`${viewport.height}px`; layer.style.setProperty('--total-scale-factor',String(scale)); try { const textContentSource=page.streamTextContent({includeMarkedContent:true,disableNormalization:true}); const textLayer=new pdfjsLib.TextLayer({textContentSource,container:layer,viewport}); await textLayer.render(); registerPdfSelectionLayer(layer); } catch(error){ console.warn('PDF text layer failed',error); } }
function releasePdfPage(frame) { if(pdfRenderPromises.has(frame)){frame.dataset.releaseAfterRender='yes';return;} if(frame.dataset.rendered!=='yes') return; const canvas=frame.querySelector('canvas'), layer=frame.querySelector('.textLayer'); unregisterPdfSelectionLayer(layer); canvas.width=0; canvas.height=0; layer.replaceChildren(); frame.dataset.rendered=''; delete frame.dataset.releaseAfterRender; }
async function renderThumbnail(number) { const button=pdfThumbs.querySelector(`[data-page="${number}"]`); if(!button||button.dataset.rendered) return; try { const page=await activePdf.getPage(number), viewport=page.getViewport({scale:.11}), canvas=document.createElement('canvas'); canvas.width=viewport.width*2; canvas.height=viewport.height*2; canvas.style.width='56px'; await page.render({canvasContext:canvas.getContext('2d'),viewport:page.getViewport({scale:.22})}).promise; button.prepend(canvas); button.dataset.rendered='yes'; } catch {} }
function goPdfPage(number) { const page=Math.min(pageCount,Math.max(1,Number(number)||1)),target=pdfPages.querySelector(`[data-page="${page}"]`);if(!target)return;activePage=page;byId('pdf-page-label').textContent=`Page ${page} of ${pageCount}`;target.scrollIntoView({behavior:'smooth',block:'start'}); }
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
}
function scalePdf(amount) { zoom=Math.min(2.4,Math.max(.65,zoom+amount)); pdfPages.querySelectorAll('.pdf-page[data-rendered="yes"]').forEach(releasePdfPage); pdfPages.querySelectorAll('.pdf-page').forEach(frame=>{ if(pageObserver) pageObserver.unobserve(frame); pageObserver?.observe(frame); }); }

const pdfSelectionLayers = new Map();
let pdfSelectionAbort = null;

function resetPdfSelectionLayer(layer, end) {
  if (!layer) return;
  if (end && end.parentNode !== layer) layer.append(end);
  if (end) {
    end.style.width = '';
    end.style.height = '';
    end.style.userSelect = '';
  }
  layer.classList.remove('selecting');
}

function unregisterPdfSelectionLayer(layer) {
  if (!layer) return;
  const end = pdfSelectionLayers.get(layer);
  pdfSelectionLayers.delete(layer);
  if (pdfSelectionLayers.size === 0) {
    pdfSelectionAbort?.abort();
    pdfSelectionAbort = null;
  }
  resetPdfSelectionLayer(layer, end);
}

function ensurePdfSelectionListener() {
  if (pdfSelectionAbort) return;
  pdfSelectionAbort = new AbortController();
  const { signal } = pdfSelectionAbort;
  let pointerDown = false;
  let previousRange = null;

  const resetAll = () => {
    pointerDown = false;
    previousRange = null;
    pdfSelectionLayers.forEach((end, layer) => resetPdfSelectionLayer(layer, end));
  };

  document.addEventListener('pointerdown', () => {
    pointerDown = true;
  }, { signal });

  document.addEventListener('pointerup', resetAll, { signal });
  window.addEventListener('blur', resetAll, { signal });
  document.addEventListener('keyup', () => {
    if (!pointerDown) resetAll();
  }, { signal });

  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
      pdfSelectionLayers.forEach((end, layer) => resetPdfSelectionLayer(layer, end));
      previousRange = null;
      return;
    }

    const active = new Set();
    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);
      pdfSelectionLayers.forEach((end, layer) => {
        if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
      });
    }

    pdfSelectionLayers.forEach((end, layer) => {
      if (active.has(layer)) {
        layer.classList.add('selecting');
      } else {
        resetPdfSelectionLayer(layer, end);
      }
    });

    // Chromium/Firefox have improved this behavior in recent versions.
    // For other browsers, keep the selection anchor close to the text being
    // modified instead of letting an empty area expand the selection wildly.
    const firstLayer = active.values().next().value;
    if (!firstLayer) return;

    const range = selection.getRangeAt(0);
    const end = pdfSelectionLayers.get(firstLayer);
    if (!end) return;

    const parent = range.endContainer.nodeType === Node.TEXT_NODE
      ? range.endContainer.parentNode
      : range.endContainer;

    if (!parent?.closest?.('.textLayer')) return;

    const shouldMoveEnd = previousRange &&
      (range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0 ||
       range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0);

    if (!shouldMoveEnd && range.endOffset === 0) {
      let anchor = parent;
      while (anchor && !anchor.previousSibling && anchor.parentNode) anchor = anchor.parentNode;
      if (anchor?.previousSibling) anchor = anchor.previousSibling;
      if (anchor?.parentElement?.closest?.('.textLayer')) {
        anchor.parentNode.insertBefore(end, anchor.nextSibling);
      }
    }

    previousRange = range.cloneRange();
  }, { signal });
}

function registerPdfSelectionLayer(layer) {
  if (!layer) return;
  unregisterPdfSelectionLayer(layer);
  const end = document.createElement('div');
  end.className = 'endOfContent';
  layer.append(end);
  pdfSelectionLayers.set(layer, end);
  ensurePdfSelectionListener();

  if (!layer.dataset.selectionBound) {
    layer.dataset.selectionBound = 'yes';
    layer.addEventListener('mousedown', () => {
      layer.classList.add('selecting');
    });
    layer.addEventListener('copy', event => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) return;
      event.clipboardData?.setData('text/plain', selection.toString().normalize());
      event.preventDefault();
    });
  }
}

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

function nearestPdfTextNode(x, y) {
  const elements = document.elementsFromPoint(x, y);
  const direct = elements.find(element =>
    element.matches?.('.textLayer span:not(.markedContent)')
  );
  if (!direct) return null;

  const node = direct.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.data.trim()) return null;

  const range = document.createRange();
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  for (let index = 0; index < node.data.length; index++) {
    if (/\\s/.test(node.data[index])) continue;
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
      const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
      if (dx === 0 && dy === 0) return { node, index };
    }
  }
  return nearestDistance < 900 ? { node, index: nearestIndex } : null;
}

function wordAt(x, y) {
  let hit = pdfTextNodeAtPoint(x, y) || nearestPdfTextNode(x, y);
  const node = hit?.node;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.data;
  let offset = Math.max(0, Math.min(text.length, hit.index));
  if (/\\s/.test(text[offset] || '') && offset > 0) offset--;

  let start = offset;
  let end = offset;
  while (start > 0 && /[-'’\\p{L}\\p{M}]/u.test(text[start - 1])) start--;
  while (end < text.length && /[-'’\\p{L}\\p{M}]/u.test(text[end])) end++;

  const word = text.slice(start, end).replace(/^[-'’]+|[-'’]+$/g, '').toLowerCase();
  if (!word) return null;

  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const rects = [...range.getClientRects()];
  if (!rects.some(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) return null;
  return { word, range };
}

document.addEventListener('click',event=>{if(event.target.closest('button,a,input,select,textarea,#popup,.pdf-thumb'))return;const readable=event.target.closest('.readable');if(!readable)return;const selection=getSelection();if(selection&&!selection.isCollapsed)return;const hit=wordAt(event.clientX,event.clientY);if(hit)showWord(hit);else hidePopup();});
document.addEventListener('dblclick',event=>{if(event.target.closest('button,a,input,select,textarea,#popup,.pdf-thumb'))return;const readable=event.target.closest('.readable'),selection=getSelection();if(!readable||!selection||selection.isCollapsed)return;const selected=selection.toString().trim().match(/^[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*$/u);if(selected)showWord({word:selected[0].toLowerCase(),range:selection.getRangeAt(0).cloneRange()});});
function popupShell(word,message){popup.replaceChildren();const close=safeText(popup,'button','×','close');close.type='button';close.setAttribute('aria-label','Close definition');close.addEventListener('click',hidePopup);const heading=safeText(popup,'h2',word);heading.id='popup-word';popup.setAttribute('aria-labelledby','popup-word');if(message)safeText(popup,'p',message,'note');}
async function showWord(hit,options={}){const word=String(hit.word||'').trim().toLowerCase();if(!word)return;lookupController?.abort();lookupController=new AbortController();popupReturnFocus=options.returnFocus||document.activeElement;const range=hit.range||null;if(range&&CSS.highlights)CSS.highlights.set('picked',new Highlight(range));popup.hidden=false;popupShell(word,'Looking up…');placePopup(range);if(options.focus)popup.querySelector('.close')?.focus();try{const result=await define(word,lookupController.signal),clean={...result,meanings:result.meanings.map(item=>({...item,definition:plainDefinition(item.definition),example:plainDefinition(item.example)}))};renderDefinition(clean,word);popup.setAttribute('aria-labelledby','popup-word');popup.querySelector('h2').id='popup-word';popup.querySelector('.close')?.setAttribute('aria-label','Close definition');placePopup(range);if(options.focus)popup.querySelector('.close')?.focus();}catch(error){if(error.name==='AbortError')return;popupShell(word,error.message||'Could not load this definition.');placePopup(range);if(options.focus)popup.querySelector('.close')?.focus();}}
function submitDictionaryQuery(event){event.preventDefault();const input=byId('dictionary-query'),word=input.value.trim().toLowerCase();if(!/^[a-z][a-z'-]{0,59}$/.test(word)){input.setCustomValidity('Enter one English word using letters, apostrophes, or hyphens.');input.reportValidity();return;}input.setCustomValidity('');showWord({word,range:null},{focus:true,returnFocus:input});}
function hidePopup(){lookupController?.abort();popup.hidden=true;if(CSS.highlights)CSS.highlights.delete('picked');const target=popupReturnFocus;popupReturnFocus=null;if(target&&target!==document.body&&target.isConnected)target.focus({preventScroll:true});}
function placePopup(range){if(!range){popup.classList.add('dictionary-search-popup');popup.style.position='fixed';popup.style.left='50%';popup.style.top='18vh';popup.style.transform='translateX(-50%)';return;}popup.classList.remove('dictionary-search-popup');popup.style.position='absolute';popup.style.transform='';if(matchMedia('(max-width: 640px)').matches){popup.style.left='';popup.style.top='';return;}const rect=range.getBoundingClientRect();popup.style.left=`${Math.max(12,Math.min(scrollX+rect.left,scrollX+innerWidth-popup.offsetWidth-12))}px`;popup.style.top=`${scrollY+rect.bottom+8}px`;}
function plainDefinition(value){let text=String(value||'');for(let attempt=0;attempt<2;attempt++){const parsed=new DOMParser().parseFromString(text,'text/html');parsed.querySelectorAll('script,style,template').forEach(node=>node.remove());const next=parsed.body.textContent||'';if(next===text)break;text=next;}return text.replace(/\s+/g,' ').trim();}
const FALLBACK_DEFINITIONS = {
  ominous: { word: 'ominous', phonetic: '/ˈɒmɪnəs/', meanings: [{ partOfSpeech: 'adjective', definition: 'giving the impression that something bad or unpleasant is going to happen.', example: 'The sky looked ominous before the storm.' }] },
  gentle: { word: 'gentle', phonetic: '/ˈdʒentəl/', meanings: [{ partOfSpeech: 'adjective', definition: 'mild, calm, and not harsh or severe.', example: 'She used a gentle tone with the children.' }] },
  read: { word: 'read', phonetic: '/riːd/', meanings: [{ partOfSpeech: 'verb', definition: 'look at and understand the meaning of written or printed words or symbols.', example: 'I read a chapter before bed.' }] },
  calm: { word: 'calm', phonetic: '/kɑːm/', meanings: [{ partOfSpeech: 'adjective', definition: 'not showing or feeling nervousness, anger, or anxiety.', example: 'He remained calm during the debate.' }] }
};
async function define(word,signal){
  const stem=String(word||'').trim().toLowerCase().replace(/\\s+/g,'_');
  const cached=await getDefinition(stem).catch(()=>null);
  const cachedResult=cached?.result||cached;
  if(cachedResult?.meanings?.length)return {...cachedResult,cached:true};
  if(signal?.aborted)throw new DOMException('Lookup cancelled.','AbortError');
  try {
    const response=await fetch('/api/definition?word='+encodeURIComponent(stem),{signal,headers:{accept:'application/json'}});
    if(response.ok){
      const result=await response.json();
      await putDefinition({word:stem,result}).catch(()=>{});
      return result;
    }
    if(response.status!==404)throw new Error('Dictionary lookup is temporarily unavailable.');
  } catch(error) {
    if(error.name==='AbortError')throw error;
    const fallback=FALLBACK_DEFINITIONS[stem];
    if(fallback){await putDefinition({word:stem,result:{...fallback,source:'Built-in'}}).catch(()=>{});return {...fallback,source:'Built-in'};}
    throw new Error('You are offline and this word has not been cached yet. Connect once to add it to your offline dictionary.');
  }
  const fallback=FALLBACK_DEFINITIONS[stem];
  if(fallback){const result={...fallback,source:'Built-in'};await putDefinition({word:stem,result}).catch(()=>{});return result;}
  throw new Error(`No definition found for “${stem.replace(/_/g,' ')}”. Try checking the spelling or search another word.`);
}
function renderDefinition(result,asked){popup.replaceChildren();safeText(popup,'button','×','close').addEventListener('click',hidePopup);safeText(popup,'h2',result.word);const source=result.source||'';if(result.phonetic)safeText(popup,'p',result.phonetic,'ph');if(source)safeText(popup,'span',result.cached?'Cached · '+source:source,'dictionary-source');const actions=document.createElement('div');actions.className='word-actions';const button=(label,handler)=>{const control=document.createElement('button');control.className='btn';control.type='button';control.textContent=label;control.addEventListener('click',handler);actions.append(control);return control;};button('Save',event=>{const values=local.get('er-vocabulary',[]);if(!values.some(item=>item.word===result.word))values.unshift({word:result.word,definition:result.meanings[0]?.definition});local.set('er-vocabulary',values);queueCloudSync();event.currentTarget.textContent='Saved';toast('Word saved to your vocabulary.');});button('Listen',()=>speechSynthesis.speak(new SpeechSynthesisUtterance(result.word)));button('Translate',async event=>{const control=event.currentTarget;control.textContent='Translating…';try{const language=byId('translation-language').value,response=await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(result.word)}&langpair=en|${language}`,{signal:lookupController?.signal});if(!response.ok)throw new Error();const data=await response.json();safeText(popup,'p',data.responseData?.translatedText||'Translation unavailable','note');control.textContent='Translated';}catch{control.textContent='Try translate again';}});button('Note',()=>{const text=prompt(`Add a note for “${result.word}”`);if(text?.trim()){const notes=local.get('er-notes',[]);notes.unshift({word:result.word,text:text.trim(),book:activeBook?.key,created:Date.now()});local.set('er-notes',notes);queueCloudSync();toast('Note saved.');}});popup.append(actions);result.meanings.forEach(item=>{safeText(popup,'p',item.partOfSpeech,'pos');safeText(popup,'p',item.definition,'def');if(item.example)safeText(popup,'p',`“${item.example}”`,'ex');});if(result.word!==asked)safeText(popup,'p',`Showing the base form “${result.word}”.`,'note');}

function renderDefinition(result,asked){
  popup.replaceChildren();
  const close=safeText(popup,'button','×','close');
  close.type='button';
  close.setAttribute('aria-label','Close definition');
  close.addEventListener('click',hidePopup);
  const heading=safeText(popup,'h2',result.word);
  heading.id='popup-word';
  popup.setAttribute('aria-labelledby','popup-word');
  if(result.phonetic)safeText(popup,'p',result.phonetic,'ph');
  if(result.source)safeText(popup,'span',result.cached?'Cached · '+result.source:result.source,'dictionary-source');
  const translated=safeText(popup,'p','','translation-result');
  translated.hidden=true;
  translated.setAttribute('role','status');
  translated.setAttribute('aria-live','polite');
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
    if(!values.some(item=>item.word===result.word))values.unshift({word:result.word,definition:plainDefinition(result.meanings[0]?.definition)});
    local.set('er-vocabulary',values);
    queueCloudSync();
    renderVocabulary();
    event.currentTarget.textContent='Saved';
    toast('Word saved to your vocabulary.');
  });
  button('Listen',()=>speechSynthesis.speak(new SpeechSynthesisUtterance(result.word)));
  button('Translate',async event=>{
    const control=event.currentTarget;
    control.disabled=true;
    control.textContent='Translating…';
    translated.hidden=false;
    translated.textContent='Translating…';
    try{
      const language=byId('translation-language').value;
      const response=await fetch('https://api.mymemory.translated.net/get?q='+encodeURIComponent(result.word)+'&langpair=en|'+language,{signal:lookupController?.signal});
      if(!response.ok)throw new Error();
      const data=await response.json();
      const value=plainDefinition(data.responseData?.translatedText);
      translated.textContent=value?'Translation ('+language+'): '+value:'No translation was returned.';
      control.textContent='Translate';
    }catch{
      translated.textContent='Translation is unavailable right now.';
      control.textContent='Translate';
    }finally{control.disabled=false;}
  });
  button('Note',()=>openNoteEditor(result.word));
  popup.append(actions);
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
function saveNote(event){event.preventDefault();const text=byId('note-editor-text').value.trim();if(!text)return;const notes=local.get('er-notes',[]);notes.unshift({word:activeNoteWord,text,book:activeBook?.key,created:Date.now()});local.set('er-notes',notes);queueCloudSync();byId('note-dialog').close();toast('Note saved.');}
async function renderLibraryPanel(){
  const list=byId('library-list'),favorites=byId('library-favorites');
  if(!list||!favorites)return;
  list.replaceChildren();favorites.replaceChildren();
  const search=(byId('library-search')?.value||'').trim().toLowerCase(),filter=byId('library-filter')?.value||'all',sort=byId('library-sort')?.value||'recent';
  let books=await getBooks();
  books=books.filter(book=>{const ext=String(book.type||book.name?.split('.').pop()||'').toLowerCase(),matchesType=filter==='all'||(filter==='favorite'?book.favorite:filter==='image'?['png','jpg','jpeg'].includes(ext):ext===filter),matchesText=`${book.title||''} ${book.name||''}`.toLowerCase().includes(search);return matchesType&&matchesText;});
  books.sort((a,b)=>sort==='title'?(a.title||a.name).localeCompare(b.title||b.name):sort==='progress'?(b.progress||0)-(a.progress||0):(b.opened||0)-(a.opened||0));
  if(!books.length){safeText(list,'p',search||filter!=='all'?'No books match these filters.':'Your books will appear here after you open one.','note');return;}
  const createRow=book=>{const row=document.createElement('div');row.className='library-row';const details=document.createElement('div');details.className='library-book-details';safeText(details,'strong',book.title||book.name);safeText(details,'small',`${String(book.type||'').toUpperCase()} · ${Math.round(book.progress||0)}% read`,'note');const progress=document.createElement('progress');progress.max=100;progress.value=book.progress||0;const actions=document.createElement('div');actions.className='library-book-actions';const open=safeText(actions,'button','Continue','btn');open.type='button';open.onclick=()=>openFile(book.file);const rename=safeText(actions,'button','Rename','icon-btn');rename.type='button';rename.setAttribute('aria-label',`Rename ${book.title||book.name}`);rename.onclick=async()=>{const value=prompt('Book title',book.title||book.name);if(value?.trim()){book.title=value.trim();await putBook(book);renderLibraryPanel();renderLibrary();}};const favorite=safeText(actions,'button',book.favorite?'★':'☆','icon-btn');favorite.type='button';favorite.setAttribute('aria-label',book.favorite?'Remove from favorites':'Add to favorites');favorite.onclick=async()=>{book.favorite=!book.favorite;await putBook(book);renderLibraryPanel();renderLibrary();};row.append(details,progress,actions);return {row,favorite};};
  for(const book of books){const {row,favorite}=createRow(book);(book.favorite?favorites:list).append(row);}
}
function renderVocabulary(){const list=byId('vocab-list');list.replaceChildren();const values=local.get('er-vocabulary',[]);if(!values.length)return safeText(list,'p','Saved words will appear here.','note');values.forEach(item=>{safeText(list,'strong',item.word);safeText(list,'p',item.definition||'');});}
function renderSavedItems(){const bookmarks=local.get('er-bookmarks',[]),notes=local.get('er-notes',[]),highlights=local.get('er-highlights',[]);const b=byId('bookmark-list'),s=byId('saved-list');b.replaceChildren();s.replaceChildren();if(!bookmarks.length)safeText(b,'p','No bookmarks yet.','note');bookmarks.forEach(item=>{const button=safeText(b,'button',item.name||'Bookmark','saved-item');button.onclick=()=>scrollTo({top:item.scroll||0,behavior:'smooth'});});[...notes,...highlights].forEach(item=>safeText(s,'p',item.text||item.word||'Saved note','saved-item'));}
function goToReaderPage(value){const page=Math.min(pageCount,Math.max(1,Number(value)||1)),container=activePdf&&pdfMode?pdfPages:reader,target=container.querySelector(`[data-page="${page}"]`);if(!target)return false;if(activePdf){activePage=page;byId('pdf-page-label').textContent=`Page ${page} of ${pageCount}`;}target.scrollIntoView({behavior:'smooth',block:'start'});return true;}
function goToRequestedPage(event){event?.preventDefault();const input=byId('jump'),requested=Number.parseInt(input.value,10);if(!Number.isInteger(requested)||requested<1||requested>pageCount){input.setCustomValidity(`Enter a page from 1 to ${pageCount}.`);input.reportValidity();return;}input.setCustomValidity('');input.value=String(requested);goToReaderPage(requested);}
async function renderContents(){const outline=byId('outline'),empty=byId('outline-empty');outline.replaceChildren();if(!pageCount){empty.textContent='Open a book to see its contents.';empty.hidden=false;return;}let found=false;if(activePdf){try{const entries=await activePdf.getOutline();const appendEntries=async(items,list)=>{for(const entry of items||[]){const item=document.createElement('li'),button=safeText(item,'button',entry.title||'Untitled section','saved-item');button.type='button';try{const dest=typeof entry.dest==='string'?await activePdf.getDestination(entry.dest):entry.dest;if(Array.isArray(dest)&&dest[0]){const index=Number.isInteger(dest[0])?dest[0]:await activePdf.getPageIndex(dest[0]),page=index+1;button.addEventListener('click',()=>goToReaderPage(page));button.setAttribute('aria-label',`${entry.title||'Section'}, page ${page}`);}else{button.disabled=true;}}catch{button.disabled=true;}list.append(item);if(entry.items?.length){const nested=document.createElement('ol');item.append(nested);await appendEntries(entry.items,nested);}}};if(entries?.length){await appendEntries(entries,outline);found=outline.childElementCount>0;}}catch(error){console.warn('Could not read PDF outline',error);}}
  if(!found){const sections=activePdf?Array.from({length:pageCount},(_,index)=>({page:index+1,title:`Page ${index+1}`})):Array.from(reader.querySelectorAll('.page'),(section,index)=>({page:Number(section.dataset.page)||index+1,title:section.querySelector('.page-mark')?.textContent||`Page ${index+1}`}));for(const section of sections){const item=document.createElement('li'),button=safeText(item,'button',section.title,'saved-item');button.type='button';button.addEventListener('click',()=>goToReaderPage(section.page));outline.append(item);}empty.textContent=activePdf?'No chapter outline was found. Choose a page:':'Sections in this book';}
  empty.hidden=found;
}
function renderStats(){const stats=local.get('er-stats',{}),seconds=Object.values(stats).reduce((sum,item)=>sum+(item.seconds||0),0);const node=byId('stats-content');node.replaceChildren();safeText(node,'strong',`${Math.round(seconds/60)} minutes read`);safeText(node,'p',`${local.get('er-vocabulary',[]).length} saved words`);}
function updateDocMeta(){if(activeBook){byId('doc-meta').textContent=activePdf?`${pageCount} pages · original PDF layout`:`${pageCount?pageCount+' sections · ':''}${(activeBook.words||0).toLocaleString()} words`;if(byId('jump'))byId('jump').max=String(Math.max(1,pageCount));if(byId('reader-page-jump'))byId('reader-page-jump').max=String(Math.max(1,pageCount));}}
function restorePosition(){setTimeout(()=>{if(activePdf)goPdfPage(activeBook.position?.page||1);else scrollTo({top:activeBook.position?.scroll||0});},120);}
function savePosition(){
  if(!activeBook)return;
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
}
function todayKey(){return new Date().toISOString().slice(0,10);}
function elapsedReadingSeconds(){return readerTimerSeconds+(readerTimerRunning?Math.floor((Date.now()-readerTimerStart)/1000):0);}
function formatTimer(seconds){const value=Math.max(0,Math.floor(seconds)),hours=Math.floor(value/3600),minutes=Math.floor(value%3600/60),remaining=value%60;return hours?`${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(remaining).padStart(2,'0')}`:`${String(minutes).padStart(2,'0')}:${String(remaining).padStart(2,'0')}`;}
function persistReadingTimer(){local.set('er-reading-timer',{day:readerTimerDay,seconds:elapsedReadingSeconds()});}
function updateReadingTimer(){const elapsed=elapsedReadingSeconds(),remaining=readerTimerGoal?Math.max(0,readerTimerGoal*60-elapsed):elapsed,output=byId('timer-display'),toggle=byId('timer-toggle');if(output){output.textContent=formatTimer(remaining);output.setAttribute('aria-label',readerTimerGoal?`${formatTimer(remaining)} remaining toward today's goal`:`${formatTimer(elapsed)} elapsed reading time`);}if(toggle){toggle.textContent=readerTimerRunning?'Pause':'Start';toggle.setAttribute('aria-label',readerTimerRunning?'Pause reading timer':'Start reading timer');}}
function recordReadingSeconds(total){const delta=total-readerTimerRecordedSeconds;readerTimerRecordedSeconds=total;if(delta<=0||!readerTimerBookKey)return;const stats=local.get('er-stats',{}),item=stats[readerTimerBookKey]||{seconds:0,day:readerTimerDay};item.seconds=(item.seconds||0)+delta;item.day=readerTimerDay;stats[readerTimerBookKey]=item;local.set('er-stats',stats);}
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
function updateProfile(){
  const label=user?.displayName?.split(' ')[0]||'Sign in';for(const id of ['account-label','sidebar-account-label'])if(byId(id))byId(id).textContent=label;
  if(byId('sidebar-account-meta'))byId('sidebar-account-meta').textContent=user?.email||'Sync your reading';
  for(const id of ['account-avatar','account-photo','sidebar-avatar'])if(byId(id)){byId(id).src=user?.photoURL||'';byId(id).hidden=!user?.photoURL;}
  if(byId('account-name'))byId('account-name').textContent=user?.displayName||'';if(byId('account-email'))byId('account-email').textContent=user?.email||'';
  if(byId('account-signed-out'))byId('account-signed-out').hidden=!!user;if(byId('account-signed-in'))byId('account-signed-in').hidden=!user;
}
async function signInWithGoogle(){
  try{setAuthStatus('Opening Google sign-in…');await initFirebase();const provider=new firebase.auth.GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});await auth.signInWithPopup(provider);showPanel('account',false);toast('Signed in with Google.');}
  catch(error){setAuthStatus(friendlyAuthError(error),'error');if(error?.code==='auth/popup-blocked')try{await auth.signInWithRedirect(new firebase.auth.GoogleAuthProvider());}catch(redirectError){setAuthStatus(friendlyAuthError(redirectError),'error');}}
}
async function submitEmailAuth(event){
  event.preventDefault();const email=byId('auth-email')?.value.trim(),password=byId('auth-password')?.value,name=byId('auth-name')?.value.trim();
  if(!email||!password)return setAuthStatus('Enter your email and password.','error');if(authMode==='signup'&&!name)return setAuthStatus('Enter your name to create your account.','error');
  const submit=byId('email-auth-submit');submit?.classList.add('auth-loading');if(submit)submit.disabled=true;setAuthStatus(authMode==='signup'?'Creating your account…':'Signing you in…');
  try{await initFirebase();if(authMode==='signup'){const credential=await auth.createUserWithEmailAndPassword(email,password);if(name&&credential.user)await credential.user.updateProfile({displayName:name});user=auth.currentUser;updateProfile();showPanel('account',false);toast('Your EasyRead account is ready.');}else{await auth.signInWithEmailAndPassword(email,password);showPanel('account',false);toast('Welcome back to EasyRead.');}}
  catch(error){setAuthStatus(friendlyAuthError(error),'error');}finally{submit?.classList.remove('auth-loading');if(submit)submit.disabled=false;}
}
async function resetPassword(){
  const email=byId('auth-email')?.value.trim();if(!email)return setAuthStatus('Enter your email first, then choose “Forgot password?”.','error');
  try{await initFirebase();await auth.sendPasswordResetEmail(email);setAuthStatus('Password reset instructions have been sent to your email.','success');}catch(error){setAuthStatus(friendlyAuthError(error),'error');}
}
async function signIn(){return signInWithGoogle();}
function queueCloudSync(){if(!user)return;clearTimeout(cloudSyncTimer);cloudSyncTimer=setTimeout(syncCloud,800);}
async function syncCloud(){if(!user||!navigator.onLine)return;try{if(!firestore)await initFirebase();const ref=firestore.collection('users').doc(user.uid),snapshot=await ref.get(),remote=snapshot.exists?snapshot.data():{},data={};for(const [name,key]of Object.entries(STORE_KEYS)){const localItems=local.get(key,[]),remoteItems=Array.isArray(remote[name])?remote[name]:[],seen=new Set(),merged=[];for(const item of [...remoteItems,...localItems]){const signature=JSON.stringify(item);if(!seen.has(signature)){seen.add(signature);merged.push(item);}}data[name]=merged.slice(-1000);local.set(key,data[name]);}await ref.set(data,{merge:true});byId('sync-label').textContent='Synced just now';byId('last-synced').textContent='Last synced '+new Date().toLocaleString();toast('Reading data synced.');}catch(error){byId('sync-label').textContent='Sync needs attention';console.warn('Sync failed',error);}}
function updateInstallButton() {
  const button = byId('install-btn');
  if (!button) return;
  button.hidden = !installPromptEvent;
}

async function init() {
  initNavigation();
  initContact();
  loadReaderPreferences();
  updateInstallButton();
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
  fileInput.addEventListener('change',()=>{openFile(fileInput.files?.[0]);fileInput.value='';});
  drop.addEventListener('click',event=>{if(event.target!==fileInput)fileInput.click();}); drop.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();fileInput.click();}});
  for(const eventName of ['dragover','dragleave','drop'])drop.addEventListener(eventName,event=>{event.preventDefault();drop.classList.toggle('over',eventName==='dragover');if(eventName==='drop'&&event.dataTransfer.files[0])openFile(event.dataTransfer.files[0]);});
  byId('jump').addEventListener('change',goToRequestedPage);
  byId('reader-page-jump')?.addEventListener('change',event=>goToReaderPage(event.target.value));
  byId('reader-page-jump')?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();goToReaderPage(event.target.value);}});
  byId('jump').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();goToRequestedPage();}});
  byId('dictionary-btn').addEventListener('click',()=>{const panel=byId('dictionary-panel'),open=panel.hidden;panel.hidden=!open;byId('dictionary-btn').setAttribute('aria-expanded',String(open));if(open)byId('dictionary-query').focus();});
  byId('dictionary-panel').addEventListener('submit',submitDictionaryQuery);
  byId('text-smaller')?.addEventListener('click',()=>changeReaderTextSize(-.1));byId('text-larger')?.addEventListener('click',()=>changeReaderTextSize(.1));
  byId('text-spacing-down')?.addEventListener('click',()=>changeReaderSpacing(-.1));byId('text-spacing-up')?.addEventListener('click',()=>changeReaderSpacing(.1));
  byId('note-form').addEventListener('submit',saveNote);byId('note-cancel').addEventListener('click',()=>byId('note-dialog').close());
  for(const id of ['library-search'])byId(id)?.addEventListener('input',renderLibraryPanel);for(const id of ['library-filter','library-sort'])byId(id)?.addEventListener('change',renderLibraryPanel);byId('home-library-sort')?.addEventListener('change',renderLibrary);
  byId('timer-toggle').addEventListener('click',()=>readerTimerRunning?pauseReadingTimer():startReadingTimer());byId('timer-reset').addEventListener('click',resetReadingTimer);byId('reading-goal').addEventListener('change',event=>{readerTimerGoal=Math.max(0,Number(event.target.value)||0);local.set('er-reading-goal',readerTimerGoal);updateReadingTimer();});
  byId('pdf-mode-btn').addEventListener('click',()=>setPdfMode(!pdfMode));byId('pdf-prev').addEventListener('click',()=>goPdfPage(activePage-1));byId('pdf-next').addEventListener('click',()=>goPdfPage(activePage+1));byId('pdf-zoom-in').addEventListener('click',()=>scalePdf(.15));byId('pdf-zoom-out').addEventListener('click',()=>scalePdf(-.15));byId('pdf-fullscreen').addEventListener('click',()=>pdfPages.requestFullscreen?.());byId('pdf-preview-toggle').addEventListener('click',()=>{pdfPreviewsVisible=!pdfPreviewsVisible;local.set('er-pdf-previews',pdfPreviewsVisible);pdfThumbs.hidden=!pdfMode||!pdfPreviewsVisible;byId('pdf-preview-toggle').textContent=pdfPreviewsVisible?'Hide previews':'Show previews';byId('pdf-preview-toggle').setAttribute('aria-pressed',String(pdfPreviewsVisible));});
  byId('fullscreen-btn').addEventListener('click',toggleReaderFullscreen);
  byId('search-btn').addEventListener('click',()=>{closeDictionaryPanel();byId('reader-tools').hidden=!byId('reader-tools').hidden;byId('search-input').focus();});byId('search-input').addEventListener('input',searchBook);
  byId('search-prev').addEventListener('click',()=>moveMatch(-1));byId('search-next').addEventListener('click',()=>moveMatch(1));
  byId('highlight-btn').addEventListener('click',()=>{const text=getSelection()?.toString().trim();if(!text)return;const values=local.get('er-highlights',[]);values.unshift({text,book:activeBook?.key});local.set('er-highlights',values);queueCloudSync();toast('Highlight saved.');});
  byId('bookmark-btn').addEventListener('click',()=>{const values=local.get('er-bookmarks',[]);values.unshift({name:activeBook?.title,book:activeBook?.key,scroll:scrollY,page:activePage,created:Date.now()});local.set('er-bookmarks',values);queueCloudSync();toast('Bookmark saved.');});
  byId('export-btn').addEventListener('click',exportData);byId('export-all').addEventListener('click',exportData);byId('delete-all').addEventListener('click',deleteLocalData);
  byId('google-signin').addEventListener('click',signInWithGoogle);byId('signin-modal-google').addEventListener('click',signInWithGoogle);byId('email-auth-form')?.addEventListener('submit',submitEmailAuth);byId('auth-tab-signin')?.addEventListener('click',()=>setAuthMode('signin'));byId('auth-tab-signup')?.addEventListener('click',()=>setAuthMode('signup'));byId('forgot-password')?.addEventListener('click',resetPassword);byId('auth-password-toggle')?.addEventListener('click',()=>{const input=byId('auth-password'),button=byId('auth-password-toggle');if(!input||!button)return;const visible=input.type==='text';input.type=visible?'password':'text';button.textContent=visible?'Show':'Hide';button.setAttribute('aria-label',visible?'Show password':'Hide password');});byId('sync-now').addEventListener('click',syncCloud);byId('signout').addEventListener('click',()=>auth?.signOut());
  byId('speak-page-btn').addEventListener('click',speakCurrent);byId('stop-speech-btn').addEventListener('click',()=>speechSynthesis.cancel());
  byId('autoscroll-btn').addEventListener('click',()=>{const button=byId('autoscroll-btn');if(button.dataset.running){clearInterval(Number(button.dataset.running));delete button.dataset.running;button.textContent='Auto-scroll';}else button.dataset.running=String(setInterval(()=>scrollBy(0,1),45));});
  byId('font-choice').addEventListener('change',event=>{const settings=local.get('er-reader-settings',{});settings.font=event.target.value;local.set('er-reader-settings',settings);document.documentElement.style.setProperty('--reader-font',event.target.value==='serif'?'Georgia,serif':event.target.value==='dyslexic'?'Arial,sans-serif':"'Literata',Georgia,serif");});byId('spacing').addEventListener('input',event=>{const settings=local.get('er-reader-settings',{});settings.spacing=Number(event.target.value);local.set('er-reader-settings',settings);document.documentElement.style.setProperty('--reader-leading',event.target.value);});byId('width').addEventListener('input',event=>{const settings=local.get('er-reader-settings',{});settings.width=Number(event.target.value);local.set('er-reader-settings',settings);document.documentElement.style.setProperty('--reader-width',event.target.value+'px');});
  for(const id of ['signin-modal-close','signin-modal-later'])byId(id).addEventListener('click',()=>{byId('signin-modal').hidden=true;local.set('er-signin-dismissed',true);});
  addEventListener('scroll',()=>{if(!readerWrap.hidden)savePosition();},{passive:true});addEventListener('beforeunload',()=>{savePosition();pauseReadingTimer();});document.addEventListener('visibilitychange',()=>{if(document.hidden&&readerTimerRunning){timerResumeOnVisible=true;pauseReadingTimer();}else if(!document.hidden&&timerResumeOnVisible&&!readerWrap.hidden){timerResumeOnVisible=false;startReadingTimer();}});addEventListener('resize',()=>{if(activePdf)scalePdf(0);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){hidePopup();hidePanels();byId('contents').classList.remove('open');byId('signin-modal').hidden=true;}if((event.ctrlKey||event.altKey)&&event.key==='Enter'&&!event.target.matches('input,textarea,select')){const selection=getSelection();if(selection&&!selection.isCollapsed&&selection.rangeCount){const text=selection.toString().trim();if(/^[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*$/u.test(text)){event.preventDefault();showWord({word:text.toLowerCase(),range:selection.getRangeAt(0).cloneRange()},{focus:true});return;}}}if(event.target.matches('input,textarea,select'))return;if(event.key==='/ '||event.key==='/'){event.preventDefault();if(!readerWrap.hidden){byId('reader-tools').hidden=false;byId('search-input').focus();}}if(event.key.toLowerCase()==='f'&&!readerWrap.hidden)document.body.classList.toggle('focus-mode');if(event.key.toLowerCase()==='t')byId('theme').click();});
  await renderLibrary().catch(()=>{});addEventListener('online',()=>{if(user)syncCloud();});
  const showSigninPrompt = () => { if (!user && !local.get('er-signin-dismissed', false) && !local.get('er-onboarding-done', false)) byId('signin-modal').hidden = false; };
  if ('requestIdleCallback' in window) requestIdleCallback(() => setTimeout(showSigninPrompt, 300)); else setTimeout(showSigninPrompt, 800);
  if('serviceWorker'in navigator)addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
let matches=[],matchIndex=-1;async function searchBook(){const query=byId('search-input').value.trim().toLowerCase(),token=++searchToken;if(CSS.highlights)CSS.highlights.delete('search');matches=[];pdfSearchMatches=[];matchIndex=pdfSearchIndex=-1;if(!query){byId('search-count').textContent='';return;}if(activePdf&&pdfMode){for(let pageNumber=1;pageNumber<=activePdf.numPages;pageNumber++){if(token!==searchToken)return;const page=await activePdf.getPage(pageNumber),content=await page.getTextContent(),text=content.items.map(item=>item.str).join(' ').toLowerCase();let from=0,index;while((index=text.indexOf(query,from))>=0){pdfSearchMatches.push({page:pageNumber});from=index+query.length;}if(pageNumber%20===0){byId('search-count').textContent=`Searching ${pageNumber} of ${activePdf.numPages}…`;await new Promise(requestAnimationFrame);}}if(token!==searchToken)return;byId('search-count').textContent=`${pdfSearchMatches.length} results`;if(pdfSearchMatches.length)moveMatch(1);return;}const walker=document.createTreeWalker(reader,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const node=walker.currentNode;let from=0,index;while((index=node.data.toLowerCase().indexOf(query,from))>=0){const range=new Range();range.setStart(node,index);range.setEnd(node,index+query.length);matches.push(range);from=index+query.length;}}if(CSS.highlights&&matches.length)CSS.highlights.set('search',new Highlight(...matches));byId('search-count').textContent=`${matches.length} results`;if(matches.length)moveMatch(1);}
async function toggleReaderFullscreen(){try{if(document.fullscreenElement===readerWrap)await document.exitFullscreen();else await readerWrap.requestFullscreen();}catch(error){toast('Fullscreen is not available in this browser.');}}
async function moveMatch(direction){if(activePdf&&pdfMode&&pdfSearchMatches.length){pdfSearchIndex=(pdfSearchIndex+direction+pdfSearchMatches.length)%pdfSearchMatches.length;const page=pdfSearchMatches[pdfSearchIndex].page;goPdfPage(page);await renderPdfPage(page);const query=byId('search-input').value.trim().toLowerCase(),layer=pdfPages.querySelector(`[data-page="${page}"] .textLayer`),ranges=[];const walker=document.createTreeWalker(layer,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const node=walker.currentNode;let from=0,index;while((index=node.data.toLowerCase().indexOf(query,from))>=0){const range=new Range();range.setStart(node,index);range.setEnd(node,index+query.length);ranges.push(range);from=index+query.length;}}if(CSS.highlights&&ranges.length)CSS.highlights.set('search',new Highlight(...ranges));return;}if(!matches.length)return;matchIndex=(matchIndex+direction+matches.length)%matches.length;matches[matchIndex].startContainer.parentElement.scrollIntoView({behavior:'smooth',block:'center'});}
function speakCurrent(){const text=(pdfMode?reader:reader).innerText;if(!text)return toast('Open a readable document first.');speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text.slice(0,50000));const rate=Number(byId('speech-rate')?.value||1);utterance.rate=rate;speechSynthesis.speak(utterance);toast('Reading aloud.');}
function exportData(){const data={vocabulary:local.get('er-vocabulary',[]),notes:local.get('er-notes',[]),highlights:local.get('er-highlights',[]),bookmarks:local.get('er-bookmarks',[]),stats:local.get('er-stats',{})};const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));link.download='easyread-data.json';link.click();URL.revokeObjectURL(link.href);toast('Your data was exported.');}
async function deleteLocalData(){if(!confirm('Delete all local reading data and books? This cannot be undone.'))return;localStorage.clear();await new Promise(resolve=>{const request=indexedDB.deleteDatabase('easyread-library-v2');request.onsuccess=request.onerror=request.onblocked=resolve;});toast('Local data deleted. Reload EasyRead.');}
function renderPrivacyState(){byId('privacy-status').textContent='Books and reading position are stored in this browser. Sign-in sync is optional.';}
async function renderLibrary(){const books=await getBooks(),list=byId('library-preview');if(!list)return;list.replaceChildren();if(!books.length){safeText(list,'p','Your books will appear here after you open one.','note');return;}const sort=byId('home-library-sort')?.value||'recent';books.sort((a,b)=>sort==='title'?(a.title||a.name).localeCompare(b.title||b.name):sort==='progress'?(b.progress||0)-(a.progress||0):(b.opened||0)-(a.opened||0)).slice(0,4).forEach(book=>{const card=document.createElement('article');card.className='book-card';safeText(card,'strong',book.title||book.name);const progress=document.createElement('progress');progress.max=100;progress.value=book.progress||0;card.append(progress);const open=safeText(card,'button','Continue reading','btn');open.onclick=()=>openFile(book.file);list.append(card);});}
function initContact(){const contact=window.EASYREAD_CONTACT||{},telegram=String(contact.telegram||'').trim(),handle=telegram.replace(/^@/,'');const phone=String(contact.phone||'').trim().replace(/[\s().-]/g,'');const email=String(contact.email||'').trim();const telegramLink=byId('contact-telegram'),phoneLink=byId('contact-phone'),emailLink=byId('contact-email');byId('contact-telegram-label').textContent=telegram||'Unavailable';byId('contact-phone-label').textContent=contact.phone||'Unavailable';byId('contact-email-label').textContent=email||'Unavailable';if(handle)telegramLink.href=`https://t.me/${encodeURIComponent(handle)}`;if(phone)phoneLink.href=`tel:${phone}`;if(email)emailLink.href=`mailto:${email}`;byId('contact-send').addEventListener('click',()=>{if(!email)return toast('Email contact is unavailable.');const subject=encodeURIComponent('EasyRead feedback'),body=encodeURIComponent(byId('contact-message').value.trim());window.location.href=`mailto:${email}?subject=${subject}&body=${body}`;});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
