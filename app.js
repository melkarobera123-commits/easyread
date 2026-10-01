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
  if (!pdfLibraryPromise) pdfLibraryPromise = import('./node_modules/pdfjs-dist/legacy/build/pdf.mjs').then(library => {
    pdfjsLib = library;
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', document.baseURI).href;
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
const pdfRenderPromises = new Map();

function toast(message) { const node = byId('toast'); node.textContent = message; node.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 2800); }
function status(message, error = false) { const node = byId('status'); node.textContent = message; node.classList.toggle('err', error); }
function safeText(parent, tag, text, className = '') { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text; parent.append(node); return node; }
function setView(view) { document.body.dataset.view = view; for (const id of ['about-nav','sidebar-about','mobile-about']) byId(id)?.classList.toggle('active', view === 'about'); for (const id of ['reader-nav','sidebar-reader','mobile-reader']) byId(id)?.classList.toggle('active', view === 'reader'); if (view === 'reader') readerWrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); else scrollTo({ top: 0, behavior: 'smooth' }); }
function goToUpload() { setView('about'); status('Choose a book to open the Reader.'); requestAnimationFrame(() => { drop.scrollIntoView({ behavior: 'smooth', block: 'center' }); drop.focus({ preventScroll: true }); drop.classList.add('guide-focus'); setTimeout(() => drop.classList.remove('guide-focus'), 900); }); }
function showPanel(id, open) { const panel = byId(id); if (!panel) return; panel.hidden = open === undefined ? !panel.hidden : !open; if (id === 'library' && !panel.hidden) renderLibrary(); if (id === 'vocab' && !panel.hidden) renderVocabulary(); if (id === 'stats' && !panel.hidden) renderStats(); if (id === 'privacy' && !panel.hidden) renderPrivacyState(); }
function hidePanels() { document.querySelectorAll('.panel, .contents').forEach(panel => { panel.hidden = true; panel.classList.remove('open'); }); }

function initNavigation() {
  document.querySelector('.brand')?.addEventListener('click', event => { event.preventDefault(); setView('about'); });
  for (const id of ['about-nav','sidebar-about','mobile-about']) byId(id)?.addEventListener('click', () => setView('about'));
  for (const id of ['reader-nav','sidebar-reader','mobile-reader']) byId(id)?.addEventListener('click', () => readerWrap.hidden ? goToUpload() : setView('reader'));
  for (const id of ['sidebar-library','mobile-library','library-btn','library-home-btn']) byId(id)?.addEventListener('click', () => showPanel('library'));
  for (const id of ['sidebar-account','mobile-account','account-btn']) byId(id)?.addEventListener('click', openAccount);
  byId('sidebar-theme')?.addEventListener('click', () => byId('theme').click());
  for (const [id, panel] of [['contents-btn','contents'],['settings-btn','settings'],['vocab-btn','vocab'],['stats-btn','stats'],['flashcards-btn','learning'],['contact-link','contact'],['privacy-link','privacy'],['shortcuts-link','shortcuts']]) byId(id)?.addEventListener('click', event => { if (id === 'contact-link') event.preventDefault(); if (panel === 'contents') { const on = !byId(panel).classList.contains('open'); byId(panel).classList.toggle('open', on); byId(id).setAttribute('aria-expanded', String(on)); if (on) renderSavedItems(); } else showPanel(panel); });
  document.querySelectorAll('[id$="-close"]').forEach(button => button.addEventListener('click', () => { const panel = button.closest('aside'); if (panel) showPanel(panel.id, false); if (panel?.id === 'contents') panel.classList.remove('open'); }));
  byId('again')?.addEventListener('click', () => { readerWrap.hidden = true; setView('about'); hidePopup(); });
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
    byId('loading-skeleton').hidden = true; status(''); if (activeBook.position) restorePosition(); toast('Book opened. Your reading position will be saved here.');
  } catch (error) { console.error(error); byId('loading-skeleton').hidden = true; status(error.message || 'Could not open this file. It may be damaged or password-protected.', true); }
}
function wordCount(text) { return (text.match(/\S+/g) || []).length; }
function updateDocMeta() { byId('doc-meta').textContent = `${pageCount ? `${pageCount} pages · ` : ''}${(activeBook.words || 0).toLocaleString()} words`; }
function appendTextPages(text) { const blocks = String(text).split(/\n\s*\n/).map(part => part.trim()).filter(Boolean); const chunks = []; for (let i = 0; i < blocks.length; i += 20) chunks.push(blocks.slice(i, i + 20)); chunks.forEach((chunk, index) => { const section = document.createElement('section'); section.className = 'page'; section.dataset.page = String(index + 1); safeText(section, 'div', `Section ${index + 1}`, 'page-mark'); chunk.forEach(paragraph => safeText(section, 'p', paragraph)); reader.append(section); }); pageCount = chunks.length; }
async function parseDocx(file) { await loadLibrary('mammoth'); const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() }); appendTextPages(result.value); }
async function parsePptx(file) { await loadLibrary('zip'); const zip = await JSZip.loadAsync(await file.arrayBuffer()); const names = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b) => Number(a.match(/slide(\d+)/)[1])-Number(b.match(/slide(\d+)/)[1])); pageCount = names.length; for (let i=0;i<names.length;i++) { const xml = new DOMParser().parseFromString(await zip.file(names[i]).async('text'),'application/xml'); const text = [...xml.getElementsByTagName('a:t')].map(node => node.textContent).join(' ').trim(); const section = document.createElement('section'); section.className='page'; section.dataset.page=String(i+1); safeText(section,'div',`Slide ${i+1}`,'page-mark'); if(text) safeText(section,'p',text); reader.append(section); if(i%12===11) await new Promise(requestAnimationFrame); } }
async function parseEpub(file) { await loadLibrary('zip'); const zip=await JSZip.loadAsync(await file.arrayBuffer()); const container=new DOMParser().parseFromString(await zip.file('META-INF/container.xml').async('text'),'application/xml'); const root=container.querySelector('rootfile')?.getAttribute('full-path'); if(!root) throw new Error('This EPUB has an invalid package file.'); const opf=new DOMParser().parseFromString(await zip.file(root).async('text'),'application/xml'); const title=opf.getElementsByTagNameNS('*','title')[0]?.textContent.trim(); if(title) activeBook.title=title; const base=root.includes('/')?root.slice(0,root.lastIndexOf('/')+1):''; const items=new Map([...opf.querySelectorAll('manifest item')].map(item=>[item.id,item.getAttribute('href')])); let index=0; for(const ref of opf.querySelectorAll('spine itemref')) { const path=items.get(ref.getAttribute('idref')); const entry=path&&zip.file(base+decodeURIComponent(path)); if(!entry) continue; const doc=new DOMParser().parseFromString(await entry.async('text'),'text/html'); const text=doc.body?.textContent||''; if(text.trim()){ const section=document.createElement('section'); section.className='page'; section.dataset.page=String(++index); appendTextNodes(section,text); reader.append(section); } if(index%8===0) await new Promise(requestAnimationFrame); } pageCount=index; }
function appendTextNodes(section,text) { const paragraphs=String(text).split(/\n\s*\n/).map(value=>value.replace(/\s+/g,' ').trim()).filter(Boolean); paragraphs.forEach(value=>safeText(section,'p',value)); }
async function parseImage(file) { await loadLibrary('ocr'); status('Reading image text…'); const worker=await Tesseract.createWorker('eng'); try { const result=await worker.recognize(file,{logger:message=>{ if(message.status==='recognizing text') status(`Reading image text… ${Math.round(message.progress*100)}%`); }}); appendTextPages(result.data.text); } finally { await worker.terminate(); } }

async function parsePdf(file) {
  await loadPdfLibrary();
  let pdf; try { pdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise; } catch { throw new Error('Could not open this PDF. It may be damaged or password-protected.'); }
  activePdf=pdf; pageCount=pdf.numPages; zoom=1; pdfPages.hidden=false; pdfThumbs.hidden=false; byId('pdf-toolbar').hidden=false; byId('pdf-controls').hidden=false; byId('pdf-mode-btn').textContent='Text view'; reader.hidden=true;
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
  pdfTextPromise=(async()=>{reader.replaceChildren();for(let number=1;number<=activePdf.numPages;number++){const page=await activePdf.getPage(number),content=await page.getTextContent(),section=document.createElement('section');section.className='page readable';section.dataset.page=String(number);safeText(section,'div',`Page ${number}`,'page-mark');safeText(section,'p',content.items.map(item=>item.str).join(' '));reader.append(section);if(number%8===0)await new Promise(requestAnimationFrame);}return true;})();
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
async function drawPdfPage(pdf,number,frame) { const page=await pdf.getPage(number), scale=pageScale(page), viewport=page.getViewport({scale}), desiredDpr=Math.min(devicePixelRatio||1,2), pixelBudget=12_000_000, dpr=Math.min(desiredDpr,Math.max(.5,Math.sqrt(pixelBudget/(viewport.width*viewport.height)))), canvas=frame.querySelector('canvas'), context=canvas.getContext('2d',{alpha:false}); canvas.width=Math.round(viewport.width*dpr); canvas.height=Math.round(viewport.height*dpr); canvas.style.width=`${viewport.width}px`; canvas.style.height=`${viewport.height}px`; frame.style.minHeight=`${viewport.height+48}px`; const renderViewport=page.getViewport({scale:scale*dpr}); await page.render({canvasContext:context,viewport:renderViewport}).promise; const layer=frame.querySelector('.textLayer'); layer.replaceChildren(); layer.style.left=`${canvas.offsetLeft}px`; layer.style.top=`${canvas.offsetTop}px`; layer.style.width=`${viewport.width}px`; layer.style.height=`${viewport.height}px`; layer.style.setProperty('--total-scale-factor',String(scale)); try { const content=await page.getTextContent(); const textLayer=new pdfjsLib.TextLayer({textContentSource:content,container:layer,viewport}); await textLayer.render(); } catch(error){ console.warn('PDF text layer failed',error); } }
function releasePdfPage(frame) { if(pdfRenderPromises.has(frame)){frame.dataset.releaseAfterRender='yes';return;} if(frame.dataset.rendered!=='yes') return; const canvas=frame.querySelector('canvas'); canvas.width=0; canvas.height=0; frame.querySelector('.textLayer').replaceChildren(); frame.dataset.rendered=''; delete frame.dataset.releaseAfterRender; }
async function renderThumbnail(number) { const button=pdfThumbs.querySelector(`[data-page="${number}"]`); if(!button||button.dataset.rendered) return; try { const page=await activePdf.getPage(number), viewport=page.getViewport({scale:.11}), canvas=document.createElement('canvas'); canvas.width=viewport.width*2; canvas.height=viewport.height*2; canvas.style.width='56px'; await page.render({canvasContext:canvas.getContext('2d'),viewport:page.getViewport({scale:.22})}).promise; button.prepend(canvas); button.dataset.rendered='yes'; } catch {} }
function goPdfPage(number) { const target=pdfPages.querySelector(`[data-page="${Math.min(pageCount,Math.max(1,number))}"]`); target?.scrollIntoView({behavior:'smooth',block:'start'}); }
async function setPdfMode(visual) {
  pdfMode=visual;
  pdfPages.hidden=!visual;
  pdfThumbs.hidden=!visual;
  byId('pdf-controls').hidden=!visual;
  reader.hidden=visual;
  byId('pdf-mode-btn').textContent=visual?'Text view':'Page view';
  if(!visual&&activePdf){
    try { await buildPdfTextView(); }
    catch { toast('Could not prepare the text view.'); }
  }
}
function scalePdf(amount) { zoom=Math.min(2.4,Math.max(.65,zoom+amount)); pdfPages.querySelectorAll('.pdf-page[data-rendered="yes"]').forEach(releasePdfPage); pdfPages.querySelectorAll('.pdf-page').forEach(frame=>{ if(pageObserver) pageObserver.unobserve(frame); pageObserver?.observe(frame); }); }

function wordAt(x,y) { let node,offset; if(document.caretPositionFromPoint){const p=document.caretPositionFromPoint(x,y);node=p?.offsetNode;offset=p?.offset;}else{const range=document.caretRangeFromPoint?.(x,y);node=range?.startContainer;offset=range?.startOffset;} if(!node||node.nodeType!==Node.TEXT_NODE)return null; const text=node.data; let start=offset,end=offset; while(start>0&&/[-'’\p{L}\p{M}]/u.test(text[start-1]))start--; while(end<text.length&&/[-'’\p{L}\p{M}]/u.test(text[end]))end++; const word=text.slice(start,end).replace(/^[-'’]+|[-'’]+$/g,'').toLowerCase(); if(!word)return null; const range=document.createRange();range.setStart(node,start);range.setEnd(node,end); if(![...range.getClientRects()].some(rect=>x>=rect.left-3&&x<=rect.right+3&&y>=rect.top-3&&y<=rect.bottom+3))return null;return {word,range}; }
document.addEventListener('click',event=>{ if(event.target.closest('button,a,input,select,textarea,#popup,.pdf-thumb'))return; const readable=event.target.closest('.readable'); if(!readable)return; const hit=wordAt(event.clientX,event.clientY); if(hit) showWord(hit); else hidePopup(); });
document.addEventListener('pointerdown',event=>{ if(event.target.closest('button,a,input,select,textarea,#popup,.pdf-thumb'))return; const readable=event.target.closest('.readable'); if(!readable||!(event.pointerType==='touch'||event.pointerType==='pen'))return; const hit=wordAt(event.clientX,event.clientY); if(hit){ event.preventDefault(); showWord(hit); } },{passive:false});
async function showWord(hit) { lookupController?.abort(); lookupController=new AbortController(); const range=hit.range; if(CSS.highlights)CSS.highlights.set('picked',new Highlight(range)); popup.hidden=false; popup.replaceChildren(); safeText(popup,'button','×','close').addEventListener('click',hidePopup); safeText(popup,'h2',hit.word); safeText(popup,'p','Looking up…','note'); placePopup(range); try { const result=await define(hit.word,lookupController.signal); if(result.offline) throw new Error('offline'); renderDefinition(result,hit.word); placePopup(range); } catch(error){ if(error.name==='AbortError')return; popup.replaceChildren();safeText(popup,'button','×','close').addEventListener('click',hidePopup);safeText(popup,'h2',hit.word);safeText(popup,'p',error.message==='offline'?'Offline: no saved meaning for this word yet.':'Could not load a definition. Check your connection and try again.','note'); } }
function hidePopup(){lookupController?.abort();popup.hidden=true;if(CSS.highlights)CSS.highlights.delete('picked');}
function placePopup(range){if(matchMedia('(max-width: 640px)').matches){popup.style.left='';popup.style.top='';return;}const rect=range.getBoundingClientRect();popup.style.left=`${Math.max(12,Math.min(scrollX+rect.left,scrollX+innerWidth-popup.offsetWidth-12))}px`;popup.style.top=`${scrollY+rect.bottom+8}px`;}
function lemma(word){if(word.length>5&&word.endsWith('ies'))return word.slice(0,-3)+'y';if(word.length>5&&word.endsWith('ing'))return word.slice(0,-3).replace(/(.)\1$/,'$1');if(word.length>4&&word.endsWith('ed'))return word.slice(0,-2);if(word.length>4&&word.endsWith('s')&&!/(ss|us|is|ous)$/.test(word))return word.slice(0,-1);return word;}
const FALLBACK_DEFINITIONS = {
  ominous: { word: 'ominous', phonetic: '/ˈɒmɪnəs/', meanings: [{ partOfSpeech: 'adjective', definition: 'giving the impression that something bad or unpleasant is going to happen.', example: 'The sky looked ominous before the storm.' }] },
  gentle: { word: 'gentle', phonetic: '/ˈdʒentəl/', meanings: [{ partOfSpeech: 'adjective', definition: 'mild, calm, and not harsh or severe.', example: 'She used a gentle tone with the children.' }] },
  read: { word: 'read', phonetic: '/riːd/', meanings: [{ partOfSpeech: 'verb', definition: 'look at and understand the meaning of written or printed words or symbols.', example: 'I read a chapter before bed.' }] },
  calm: { word: 'calm', phonetic: '/kɑːm/', meanings: [{ partOfSpeech: 'adjective', definition: 'not showing or feeling nervousness, anger, or anxiety.', example: 'He remained calm during the debate.' }] }
};
function dictionaryFetch(url,signal,options={}){const controller=new AbortController(),abort=()=>controller.abort(signal?.reason||new DOMException('Lookup cancelled.','AbortError'));if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});const timeout=setTimeout(()=>controller.abort(new DOMException('Dictionary lookup timed out.','TimeoutError')),2500);return fetch(url,{...options,signal:controller.signal}).finally(()=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);});}
async function define(word,signal){const stem=lemma(String(word||'').toLowerCase());const cached=await getDefinition(stem).catch(()=>null);const cachedResult=cached?.result||cached;if(cachedResult?.meanings?.length)return cachedResult;const handlers=[async()=>{const response=await fetch('/api/definition?word='+encodeURIComponent(stem),{signal});if(!response.ok)throw new Error('missing');return response.json();},async()=>{const response=await dictionaryFetch('https://api.dictionaryapi.dev/api/v2/entries/en/'+encodeURIComponent(stem),signal,{headers:{'Accept':'application/json'}});if(!response.ok)throw new Error('missing');const data=await response.json(),entry=data?.[0];if(!entry)throw new Error('missing');return {word:entry.word||stem,phonetic:entry.phonetic||'',meanings:(entry.meanings||[]).slice(0,3).map(item=>({partOfSpeech:item.partOfSpeech||'word',definition:item.definitions?.[0]?.definition||'No definition available.',example:item.definitions?.[0]?.example||''}))};},async()=>{const response=await dictionaryFetch('https://en.wiktionary.org/api/rest_v1/page/definition/'+encodeURIComponent(stem),signal);if(!response.ok)throw new Error('missing');const entry=(await response.json())?.en?.[0];const meanings=(entry?.definitions||[]).slice(0,3).map(item=>({partOfSpeech:item.partOfSpeech||'word',definition:item.definition||'',example:''})).filter(item=>item.definition);if(!meanings.length)throw new Error('missing');return {word:stem,phonetic:'',meanings};},async()=>{const fallback=FALLBACK_DEFINITIONS[stem];if(!fallback)throw new Error('missing');return fallback;}];for(const step of handlers){try{const result=await step();await putDefinition({word:stem,result}).catch(()=>{});return result;}catch(error){if(error.name==='AbortError')throw error;}}throw new Error(`No definition is available for “${stem}” right now.`);}
function renderDefinition(result,asked){popup.replaceChildren();safeText(popup,'button','×','close').addEventListener('click',hidePopup);safeText(popup,'h2',result.word);if(result.phonetic)safeText(popup,'p',result.phonetic,'ph');const actions=document.createElement('div');actions.className='word-actions';const button=(label,handler)=>{const control=document.createElement('button');control.className='btn';control.type='button';control.textContent=label;control.addEventListener('click',handler);actions.append(control);return control;};button('Save',event=>{const values=local.get('er-vocabulary',[]);if(!values.some(item=>item.word===result.word))values.unshift({word:result.word,definition:result.meanings[0]?.definition});local.set('er-vocabulary',values);queueCloudSync();event.currentTarget.textContent='Saved';toast('Word saved to your vocabulary.');});button('Listen',()=>speechSynthesis.speak(new SpeechSynthesisUtterance(result.word)));button('Translate',async event=>{const control=event.currentTarget;control.textContent='Translating…';try{const language=byId('translation-language').value,response=await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(result.word)}&langpair=en|${language}`,{signal:lookupController?.signal});if(!response.ok)throw new Error();const data=await response.json();safeText(popup,'p',data.responseData?.translatedText||'Translation unavailable','note');control.textContent='Translated';}catch{control.textContent='Try translate again';}});button('Note',()=>{const text=prompt(`Add a note for “${result.word}”`);if(text?.trim()){const notes=local.get('er-notes',[]);notes.unshift({word:result.word,text:text.trim(),book:activeBook?.key,created:Date.now()});local.set('er-notes',notes);queueCloudSync();toast('Note saved.');}});popup.append(actions);result.meanings.forEach(item=>{safeText(popup,'p',item.partOfSpeech,'pos');safeText(popup,'p',item.definition,'def');if(item.example)safeText(popup,'p',`“${item.example}”`,'ex');});if(result.word!==asked)safeText(popup,'p',`Showing the base form “${result.word}”.`,'note');}

function renderLibrary(){const list=byId('library-list'),favorites=byId('library-favorites');if(!list)return;Promise.all([getBooks(),Promise.resolve()]).then(([books])=>{list.replaceChildren();favorites.replaceChildren();const sort=byId('library-sort')?.value||'recent';books.sort((a,b)=>sort==='title'?a.title.localeCompare(b.title):sort==='progress'?(b.progress||0)-(a.progress||0):(b.opened||0)-(a.opened||0));if(!books.length){safeText(list,'p','Add a book to begin your library.','note');return;}for(const book of books){const row=document.createElement('div');row.className='library-row';const title=safeText(row,'strong',book.title||book.name);const progress=document.createElement('progress');progress.max=100;progress.value=book.progress||0;row.append(progress);const open=document.createElement('button');open.className='btn';open.textContent='Open';open.onclick=()=>openFile(book.file);const fav=document.createElement('button');fav.className='icon-btn';fav.textContent=book.favorite?'★':'☆';fav.setAttribute('aria-label','Toggle favorite');fav.onclick=async()=>{book.favorite=!book.favorite;await putBook(book);renderLibrary();};const rename=document.createElement('button');rename.className='icon-btn';rename.textContent='✎';rename.setAttribute('aria-label','Rename book');rename.onclick=async()=>{const value=prompt('Book title',book.title);if(value?.trim()){book.title=value.trim();await putBook(book);renderLibrary();}};row.append(open,rename,fav);(book.favorite?favorites:list).append(row);}});}
function renderVocabulary(){const list=byId('vocab-list');list.replaceChildren();const values=local.get('er-vocabulary',[]);if(!values.length)return safeText(list,'p','Saved words will appear here.','note');values.forEach(item=>{safeText(list,'strong',item.word);safeText(list,'p',item.definition||'');});}
function renderSavedItems(){const bookmarks=local.get('er-bookmarks',[]),notes=local.get('er-notes',[]),highlights=local.get('er-highlights',[]);const b=byId('bookmark-list'),s=byId('saved-list');b.replaceChildren();s.replaceChildren();if(!bookmarks.length)safeText(b,'p','No bookmarks yet.','note');bookmarks.forEach(item=>{const button=safeText(b,'button',item.name||'Bookmark','saved-item');button.onclick=()=>scrollTo({top:item.scroll||0,behavior:'smooth'});});[...notes,...highlights].forEach(item=>safeText(s,'p',item.text||item.word||'Saved note','saved-item'));}
function renderStats(){const stats=local.get('er-stats',{}),seconds=Object.values(stats).reduce((sum,item)=>sum+(item.seconds||0),0);const node=byId('stats-content');node.replaceChildren();safeText(node,'strong',`${Math.round(seconds/60)} minutes read`);safeText(node,'p',`${local.get('er-vocabulary',[]).length} saved words`);}
function updateDocMeta(){if(activeBook)byId('doc-meta').textContent=activePdf?`${pageCount} pages · original PDF layout`:`${pageCount?pageCount+' sections · ':''}${(activeBook.words||0).toLocaleString()} words`;}
function restorePosition(){setTimeout(()=>{if(activePdf)goPdfPage(activeBook.position?.page||1);else scrollTo({top:activeBook.position?.scroll||0});},120);}
function savePosition(){if(!activeBook)return;const savedAt=Date.now();activeBook.position={page:activePage,scroll:scrollY,savedAt};local.set(`er-position:${activeBook.key}`,activeBook.position);clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{activeBook.opened=savedAt;activeBook.progress=Math.round(Math.min(100,scrollY/Math.max(document.documentElement.scrollHeight-innerHeight,1)*100));const stats=local.get('er-stats',{});stats[activeBook.key]={...(stats[activeBook.key]||{}),seconds:(stats[activeBook.key]?.seconds||0)+1,day:new Date().toISOString().slice(0,10)};local.set('er-stats',stats);await putBook(activeBook).catch(()=>{});queueCloudSync();},650);}

async function initFirebase(){if(auth)return auth;if(firebaseInitPromise)return firebaseInitPromise;if(!window.EASYREAD_FIREBASE_CONFIG?.apiKey)throw new Error('Firebase sign-in has not been configured.');firebaseInitPromise=(async()=>{await Promise.all(['firebaseApp','firebaseAuth','firebaseStore'].map(loadLibrary));if(!firebase.apps.length)firebase.initializeApp(window.EASYREAD_FIREBASE_CONFIG);auth=firebase.auth();firestore=firebase.firestore();auth.onAuthStateChanged(next=>{user=next;updateProfile();if(user)syncCloud();});return auth;})();try{return await firebaseInitPromise;}catch(error){firebaseInitPromise=null;throw error;}}
async function openAccount(){showPanel('account');try{await initFirebase();}catch(error){byId('auth-status').textContent='Sign-in is temporarily unavailable. '+error.message;}}
function updateProfile(){const label=user?.displayName?.split(' ')[0]||'Sign in';for(const id of ['account-label','sidebar-account-label'])if(byId(id))byId(id).textContent=label;if(byId('sidebar-account-meta'))byId('sidebar-account-meta').textContent=user?.email||'Sync your reading';for(const id of ['account-avatar','account-photo','sidebar-avatar'])if(byId(id)){byId(id).src=user?.photoURL||'';byId(id).hidden=!user?.photoURL;}byId('account-signed-out').hidden=!!user;byId('account-signed-in').hidden=!user;}
async function signIn(){try{await initFirebase();await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());showPanel('account',false);toast('Signed in with Google.');}catch(error){byId('auth-status').textContent=error.message;}}
function queueCloudSync(){if(!user)return;clearTimeout(cloudSyncTimer);cloudSyncTimer=setTimeout(syncCloud,800);}
async function syncCloud(){if(!user||!navigator.onLine)return;try{if(!firestore)await initFirebase();const ref=firestore.collection('users').doc(user.uid),snapshot=await ref.get(),remote=snapshot.exists?snapshot.data():{},data={};for(const [name,key]of Object.entries(STORE_KEYS)){const localItems=local.get(key,[]),remoteItems=Array.isArray(remote[name])?remote[name]:[],seen=new Set(),merged=[];for(const item of [...remoteItems,...localItems]){const signature=JSON.stringify(item);if(!seen.has(signature)){seen.add(signature);merged.push(item);}}data[name]=merged.slice(-1000);local.set(key,data[name]);}await ref.set(data,{merge:true});byId('sync-label').textContent='Synced just now';byId('last-synced').textContent='Last synced '+new Date().toLocaleString();toast('Reading data synced.');}catch(error){byId('sync-label').textContent='Sync needs attention';console.warn('Sync failed',error);}}
function updateInstallButton() {
  const button = byId('install-btn');
  if (!button) return;
  button.hidden = !installPromptEvent;
}

async function init() {
  initNavigation();
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
  byId('contents-btn').addEventListener('click',()=>{const panel=byId('contents'),open=!panel.classList.contains('open');panel.classList.toggle('open',open);byId('contents-btn').setAttribute('aria-expanded',String(open));if(open)renderSavedItems();});
  byId('contents-close').addEventListener('click',()=>byId('contents').classList.remove('open'));
  byId('pdf-mode-btn').addEventListener('click',()=>setPdfMode(!pdfMode));byId('pdf-prev').addEventListener('click',()=>goPdfPage(activePage-1));byId('pdf-next').addEventListener('click',()=>goPdfPage(activePage+1));byId('pdf-zoom-in').addEventListener('click',()=>scalePdf(.15));byId('pdf-zoom-out').addEventListener('click',()=>scalePdf(-.15));byId('pdf-fullscreen').addEventListener('click',()=>pdfPages.requestFullscreen?.());
  byId('search-btn').addEventListener('click',()=>{byId('reader-tools').hidden=!byId('reader-tools').hidden;byId('search-input').focus();});byId('search-input').addEventListener('input',searchBook);
  byId('search-prev').addEventListener('click',()=>moveMatch(-1));byId('search-next').addEventListener('click',()=>moveMatch(1));
  byId('highlight-btn').addEventListener('click',()=>{const text=getSelection()?.toString().trim();if(!text)return;const values=local.get('er-highlights',[]);values.unshift({text,book:activeBook?.key});local.set('er-highlights',values);queueCloudSync();toast('Highlight saved.');});
  byId('bookmark-btn').addEventListener('click',()=>{const values=local.get('er-bookmarks',[]);values.unshift({name:activeBook?.title,book:activeBook?.key,scroll:scrollY,page:activePage,created:Date.now()});local.set('er-bookmarks',values);queueCloudSync();toast('Bookmark saved.');});
  byId('export-btn').addEventListener('click',exportData);byId('export-all').addEventListener('click',exportData);byId('delete-all').addEventListener('click',deleteLocalData);
  byId('google-signin').addEventListener('click',signIn);byId('signin-modal-google').addEventListener('click',signIn);byId('sync-now').addEventListener('click',syncCloud);byId('signout').addEventListener('click',()=>auth?.signOut());
  byId('speak-page-btn').addEventListener('click',speakCurrent);byId('stop-speech-btn').addEventListener('click',()=>speechSynthesis.cancel());
  byId('autoscroll-btn').addEventListener('click',()=>{const button=byId('autoscroll-btn');if(button.dataset.running){clearInterval(Number(button.dataset.running));delete button.dataset.running;button.textContent='Auto-scroll';}else button.dataset.running=String(setInterval(()=>scrollBy(0,1),45));});
  byId('font-choice').addEventListener('change',event=>document.documentElement.style.setProperty('--reader-font',event.target.value==='serif'?'Georgia,serif':event.target.value==='dyslexic'?'Arial,sans-serif':"'Literata',Georgia,serif"));byId('spacing').addEventListener('input',event=>document.documentElement.style.setProperty('--reader-leading',event.target.value));byId('width').addEventListener('input',event=>document.documentElement.style.setProperty('--reader-width',event.target.value+'px'));
  for(const id of ['signin-modal-close','signin-modal-later'])byId(id).addEventListener('click',()=>{byId('signin-modal').hidden=true;local.set('er-signin-dismissed',true);});
  addEventListener('scroll',()=>{if(!readerWrap.hidden)savePosition();},{passive:true});addEventListener('beforeunload',savePosition);addEventListener('resize',()=>{if(activePdf)scalePdf(0);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){hidePopup();hidePanels();byId('contents').classList.remove('open');byId('signin-modal').hidden=true;}if(event.target.matches('input,textarea,select'))return;if(event.key==='/ '||event.key==='/'){event.preventDefault();if(!readerWrap.hidden){byId('reader-tools').hidden=false;byId('search-input').focus();}}if(event.key.toLowerCase()==='f'&&!readerWrap.hidden)document.body.classList.toggle('focus-mode');if(event.key.toLowerCase()==='t')byId('theme').click();});
  await renderLibrary().catch(()=>{});addEventListener('online',()=>{if(user)syncCloud();});
  const showSigninPrompt = () => { if (!user && !local.get('er-signin-dismissed', false) && !local.get('er-onboarding-done', false)) byId('signin-modal').hidden = false; };
  if ('requestIdleCallback' in window) requestIdleCallback(() => setTimeout(showSigninPrompt, 300)); else setTimeout(showSigninPrompt, 800);
  if('serviceWorker'in navigator)addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
let matches=[],matchIndex=-1;async function searchBook(){const query=byId('search-input').value.trim().toLowerCase(),token=++searchToken;if(CSS.highlights)CSS.highlights.delete('search');matches=[];pdfSearchMatches=[];matchIndex=pdfSearchIndex=-1;if(!query){byId('search-count').textContent='';return;}if(activePdf&&pdfMode){for(let pageNumber=1;pageNumber<=activePdf.numPages;pageNumber++){if(token!==searchToken)return;const page=await activePdf.getPage(pageNumber),content=await page.getTextContent(),text=content.items.map(item=>item.str).join(' ').toLowerCase();let from=0,index;while((index=text.indexOf(query,from))>=0){pdfSearchMatches.push({page:pageNumber});from=index+query.length;}if(pageNumber%20===0){byId('search-count').textContent=`Searching ${pageNumber} of ${activePdf.numPages}…`;await new Promise(requestAnimationFrame);}}if(token!==searchToken)return;byId('search-count').textContent=`${pdfSearchMatches.length} results`;if(pdfSearchMatches.length)moveMatch(1);return;}const walker=document.createTreeWalker(reader,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const node=walker.currentNode;let from=0,index;while((index=node.data.toLowerCase().indexOf(query,from))>=0){const range=new Range();range.setStart(node,index);range.setEnd(node,index+query.length);matches.push(range);from=index+query.length;}}if(CSS.highlights&&matches.length)CSS.highlights.set('search',new Highlight(...matches));byId('search-count').textContent=`${matches.length} results`;if(matches.length)moveMatch(1);}
async function moveMatch(direction){if(activePdf&&pdfMode&&pdfSearchMatches.length){pdfSearchIndex=(pdfSearchIndex+direction+pdfSearchMatches.length)%pdfSearchMatches.length;const page=pdfSearchMatches[pdfSearchIndex].page;goPdfPage(page);await renderPdfPage(page);const query=byId('search-input').value.trim().toLowerCase(),layer=pdfPages.querySelector(`[data-page="${page}"] .textLayer`),ranges=[];const walker=document.createTreeWalker(layer,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const node=walker.currentNode;let from=0,index;while((index=node.data.toLowerCase().indexOf(query,from))>=0){const range=new Range();range.setStart(node,index);range.setEnd(node,index+query.length);ranges.push(range);from=index+query.length;}}if(CSS.highlights&&ranges.length)CSS.highlights.set('search',new Highlight(...ranges));return;}if(!matches.length)return;matchIndex=(matchIndex+direction+matches.length)%matches.length;matches[matchIndex].startContainer.parentElement.scrollIntoView({behavior:'smooth',block:'center'});}
function speakCurrent(){const text=(pdfMode?reader:reader).innerText;if(!text)return toast('Open a readable document first.');speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text.slice(0,50000));const rate=Number(byId('speech-rate')?.value||1);utterance.rate=rate;speechSynthesis.speak(utterance);toast('Reading aloud.');}
function exportData(){const data={vocabulary:local.get('er-vocabulary',[]),notes:local.get('er-notes',[]),highlights:local.get('er-highlights',[]),bookmarks:local.get('er-bookmarks',[]),stats:local.get('er-stats',{})};const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));link.download='easyread-data.json';link.click();URL.revokeObjectURL(link.href);toast('Your data was exported.');}
async function deleteLocalData(){if(!confirm('Delete all local reading data and books? This cannot be undone.'))return;localStorage.clear();await new Promise(resolve=>{const request=indexedDB.deleteDatabase('easyread-library-v2');request.onsuccess=request.onerror=request.onblocked=resolve;});toast('Local data deleted. Reload EasyRead.');}
function renderPrivacyState(){byId('privacy-status').textContent='Books and reading position are stored in this browser. Sign-in sync is optional.';}
async function renderLibrary(){const books=await getBooks();const list=byId('library-preview');if(!list)return;list.replaceChildren();if(!books.length){safeText(list,'p','Your books will appear here after you open one.','note');return;}books.sort((a,b)=>(b.opened||0)-(a.opened||0)).slice(0,4).forEach(book=>{const card=document.createElement('article');card.className='book-card';safeText(card,'strong',book.title||book.name);const progress=document.createElement('progress');progress.max=100;progress.value=book.progress||0;card.append(progress);const open=safeText(card,'button','Continue reading','btn');open.onclick=()=>openFile(book.file);list.append(card);});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
