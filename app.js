pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const $ = s => document.querySelector(s);
const fileInput = $('#file'), drop = $('#drop'), statusEl = $('#status'), progress = $('#progress');
const reader = $('#reader'), readerWrap = $('#reader-wrap'), popup = $('#popup');
const API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const cache = new Map();
let openToken = 0, lookupToken = 0, revealed = false;

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
  readerWrap.hidden = true; hidePopup(); window.scrollTo({ top: 0 });
});

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'err' : '';
}

function reveal(name) {
  if (revealed) return;
  revealed = true;
  $('#file-name').textContent = name;
  readerWrap.hidden = false;
  setStatus('');
  readerWrap.scrollIntoView();
}

async function openFile(file) {
  const my = ++openToken, name = file.name.toLowerCase();
  revealed = false; hidePopup(); reader.textContent = ''; progress.textContent = '';
  try {
    setStatus('Opening ' + file.name + '…');
    if (name.endsWith('.pdf')) await readPdf(file, my);
    else if (name.endsWith('.docx')) await readDocx(file);
    else if (name.endsWith('.txt')) addParagraphs((await file.text()).split(/\n\s*\n/));
    else return setStatus('Use a PDF, DOCX or TXT file. For an old .doc file, save it as .docx first.', true);
    if (my !== openToken) return;
    if (!reader.textContent.trim()) return setStatus('No text found. This file may be scanned images.', true);
    reveal(file.name);
    progress.textContent = '';
  } catch (e) {
    console.error(e);
    setStatus('Could not read this file. Try another one.', true);
  }
}

function addParagraphs(list) {
  const frag = document.createDocumentFragment();
  for (const t of list) {
    const s = t.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const p = document.createElement('p');
    p.textContent = s;
    frag.append(p);
  }
  reader.append(frag);
}

async function readDocx(file) {
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  addParagraphs(value.split(/\n\s*\n/));
}

async function readPdf(file, my) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  let carry = '';
  for (let n = 1; n <= pdf.numPages; n++) {
    if (my !== openToken) return;
    const { items } = await (await pdf.getPage(n)).getTextContent();
    const lines = [];
    let lastY = null;
    for (const it of items) {
      if (!it.str) continue;
      const y = it.transform[5];
      if (lastY === null || Math.abs(y - lastY) > 2) lines.push({ y, t: '' });
      lines[lines.length - 1].t += it.str;
      lastY = y;
    }
    // A gap much bigger than the usual line spacing starts a new paragraph.
    const gaps = lines.slice(1).map((l, i) => lines[i].y - l.y).filter(g => g > 0).sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)] || 12;
    const paras = [];
    let text = carry;
    lines.forEach((l, i) => {
      const t = l.t.trim();
      if (!t) return;
      if (i && lines[i - 1].y - l.y > med * 1.5) { paras.push(text); text = ''; }
      text = /[a-z]-$/i.test(text) ? text.slice(0, -1) + t : text + ' ' + t;
    });
    if (/[.!?”"’)]\s*$/.test(text)) { paras.push(text); carry = ''; } else carry = text;
    addParagraphs(paras);
    if (reader.firstChild) reveal(file.name);
    progress.textContent = n < pdf.numPages ? `Loading page ${n} of ${pdf.numPages}…` : '';
  }
  if (carry) addParagraphs([carry]);
}

/* ---------- Tap a word ---------- */
document.addEventListener('click', e => {
  if (e.target.closest('#popup')) return;
  const hit = e.target.closest('.readable') && wordAt(e.clientX, e.clientY);
  hit ? showWord(hit) : hidePopup();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') hidePopup(); });

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

async function define(word) {
  if (cache.has(word)) return cache.get(word);
  for (const w of candidates(word)) {
    let res;
    try { res = await fetch(API + encodeURIComponent(w)); } catch { return { offline: true }; }
    if (res.ok) {
      const result = { entry: (await res.json())[0] };
      cache.set(word, result);
      return result;
    }
  }
  return { missing: true };
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
    kids.push(el('h2', '', asked), el('p', 'note', 'Cannot reach the dictionary. Check your internet, then tap the word again.'));
  } else if (result.missing) {
    kids.push(el('h2', '', asked), el('p', 'note', 'No meaning found. Try tapping a nearby word.'));
  } else {
    const e = result.entry;
    kids.push(el('h2', '', e.word));
    const ph = e.phonetic || (e.phonetics.find(p => p.text) || {}).text;
    if (ph) kids.push(el('p', 'ph', ph));
    e.meanings.slice(0, 3).forEach(m => {
      const d = m.definitions[0];
      kids.push(el('p', 'pos', m.partOfSpeech), el('p', 'def', d.definition));
      if (d.example) kids.push(el('p', 'ex', '“' + d.example + '”'));
    });
    if (e.word.toLowerCase() !== asked) kids.push(el('p', 'note', `Showing the meaning of “${e.word}”.`));
  }
  popup.replaceChildren(...kids);
}
