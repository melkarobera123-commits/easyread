pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const $ = s => document.querySelector(s);
const fileInput = $('#file'), drop = $('#drop'), statusEl = $('#status'), progress = $('#progress');
const reader = $('#reader'), readerWrap = $('#reader-wrap'), popup = $('#popup');
const API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const cache = new Map();
let openToken = 0, lookupToken = 0, revealed = false, totalPages = 0, headingCount = 0;
const seenHeadings = new Set();
const contents = $('#contents'), outlineList = $('#outline'), outlineEmpty = $('#outline-empty');
const pageNow = $('#page-now'), docMeta = $('#doc-meta');
const pageObserver = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) pageNow.textContent = `Page ${e.target.dataset.page} of ${totalPages}`;
}, { rootMargin: '-40% 0px -55% 0px' });

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
}

async function openFile(file) {
  const my = ++openToken, name = file.name.toLowerCase();
  revealed = false; hidePopup(); reader.replaceChildren(); progress.textContent = ''; resetOutline();
  try {
    setStatus('Opening ' + file.name + '…');
    if (name.endsWith('.pdf')) await readPdf(file, my);
    else if (name.endsWith('.docx')) await readDocx(file);
    else if (name.endsWith('.txt')) addParagraphs((await file.text()).split(/\n\s*\n/));
    else return setStatus('Use a PDF, DOCX or TXT file. For an old .doc file, save it as .docx first.', true);
    if (my !== openToken) return;
    const hasPdfCanvas = !!reader.querySelector('.pdf-page canvas');
    if (!reader.textContent.trim() && !hasPdfCanvas) return setStatus('No text found. This file may be scanned images.', true);
    reveal(file.name);
    progress.textContent = '';
    showMeta();
  } catch (e) {
    console.error(e);
    setStatus('Could not read this file. Try another one.', true);
  }
}

function addParagraphs(list) {
  const paragraphs = list.map(text => ({ text })).filter(b => b.text.trim());
  const chunkSize = 8;
  totalPages = Math.max(1, Math.ceil(paragraphs.length / chunkSize));
  for (let i = 0; i < paragraphs.length; i += chunkSize) addBlocks(paragraphs.slice(i, i + chunkSize), Math.floor(i / chunkSize) + 1);
}

function addBlocks(blocks, page) {
  const sec = document.createElement('section');
  if (page) {
    sec.className = 'page'; sec.id = 'p' + page; sec.dataset.page = page; sec.append(el('div', 'page-mark', 'Page ' + page));
  }
  for (const b of blocks) {
    const text = b.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (b.heading) {
      const key = text.toLowerCase();
      if (seenHeadings.has(key)) continue;
      seenHeadings.add(key);
      const h = el('h2', '', text);
      h.id = 'h' + (++headingCount);
      sec.append(h);
      outlineAdd(text, h.id, page);
    } else {
      sec.append(el('p', '', text));
    }
  }
  if (sec.children.length > (page ? 1 : 0)) {
    reader.append(sec);
    if (page) pageObserver.observe(sec);
  }
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
  while (n > 0 && !(target = document.getElementById('p' + n))) n--;
  if (target) { target.scrollIntoView({ behavior: 'smooth' }); toggleContents(false); }
});

async function readDocx(file) {
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  addParagraphs(value.split(/\n\s*\n/));
}

async function readPdf(file, my) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  totalPages = pdf.numPages;

  for (let n = 1; n <= pdf.numPages; n++) {
    if (my !== openToken) return;
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1.2 });
    const pageEl = document.createElement('section');
    pageEl.className = 'page pdf-page';
    pageEl.id = 'p' + n;
    pageEl.dataset.page = n;

    const pageLabel = document.createElement('div');
    pageLabel.className = 'page-mark';
    pageLabel.textContent = 'Page ' + n;

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrap';
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.width = viewport.width + 'px';
    wrapper.style.maxWidth = '100%';

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const textLayer = document.createElement('div');
    textLayer.className = 'pdf-text-layer';
    textLayer.style.position = 'absolute';
    textLayer.style.left = '0';
    textLayer.style.top = '0';
    textLayer.style.width = canvas.width + 'px';
    textLayer.style.height = canvas.height + 'px';
    textLayer.style.zIndex = '2';
    textLayer.style.pointerEvents = 'auto';

    const textContent = await page.getTextContent();
    const scaleX = canvas.width / viewport.width;
    const scaleY = canvas.height / viewport.height;
    for (const item of textContent.items) {
      if (!item.str) continue;
      const word = document.createElement('span');
      word.className = 'pdf-word';
      const text = item.str; 
      const bounds = item.transform;
      const left = bounds[4] * scaleX;
      const top = bounds[5] * scaleY;
      const fontSize = Math.abs(bounds[3]) * scaleY;
      word.textContent = text;
      word.style.position = 'absolute';
      word.style.left = left + 'px';
      word.style.top = (top - fontSize) + 'px';
      word.style.fontSize = Math.max(8, fontSize) + 'px';
      word.style.lineHeight = '1';
      word.style.whiteSpace = 'pre';
      word.style.color = 'transparent';
      word.style.cursor = 'pointer';
      word.style.userSelect = 'none';
      word.style.pointerEvents = 'auto';
      word.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const value = (text || '').replace(/[^A-Za-z’'-]/g, '').toLowerCase();
        if (!value) return;
        const fakeRange = document.createRange();
        const node = document.createTextNode(text);
        fakeRange.selectNodeContents(node);
        showWord({ word: value, range: fakeRange });
      });
      textLayer.appendChild(word);
    }

    wrapper.append(canvas, textLayer);
    pageEl.append(pageLabel, wrapper);
    reader.append(pageEl);
    pageObserver.observe(pageEl);

    if (reader.firstChild) reveal(file.name);
    progress.textContent = n < pdf.numPages ? `Rendering page ${n} of ${pdf.numPages}…` : '';
  }
}

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
  if (!range || !range.getBoundingClientRect) return;
  if (matchMedia('(max-width: 640px)').matches) { popup.style.left = popup.style.top = ''; return; }
  const r = range.getBoundingClientRect(), w = popup.offsetWidth;
  popup.style.left = Math.max(12, Math.min(scrollX + r.left, scrollX + innerWidth - w - 12)) + 'px';
  popup.style.top = scrollY + r.bottom + 10 + 'px';
}

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
    return { partOfSpeech: m.partOfSpeech.toLowerCase(), definition: text(d.definition), example: d.examples && d.examples[0] ? text(d.examples[0]) : '' };
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
    if (e.phonetic) kids.push(el('p', 'ph', e.phonetic));
    e.meanings.forEach(m => {
      kids.push(el('p', 'pos', m.partOfSpeech), el('p', 'def', m.definition));
      if (m.example) kids.push(el('p', 'ex', '“' + m.example + '”'));
    });
    if (e.word.toLowerCase() !== asked) kids.push(el('p', 'note', `Showing the meaning of “${e.word}”.`));
  }
  popup.replaceChildren(...kids);
}
