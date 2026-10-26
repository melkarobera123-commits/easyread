/* EasyRead PDF workspace add-ons.
 * These tools work with the page currently rendered by the existing PDF.js reader.
 * They do not alter the source PDF or EasyRead's saved reading data.
 */
(() => {
  'use strict';

  function currentRenderedPage() {
    const pages = [...document.querySelectorAll('#pdf-pages .pdf-page')];
    if (!pages.length) return null;
    const targetY = Math.min(window.innerHeight * 0.42, 360);
    let best = null;
    let bestDistance = Infinity;
    for (const page of pages) {
      const rect = page.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const distance = Math.abs((rect.top + rect.bottom) / 2 - targetY);
      if (distance < bestDistance) { best = page; bestDistance = distance; }
    }
    return best || pages.find(page => page.dataset.page === '1') || null;
  }

  function getPageCanvas() {
    const page = currentRenderedPage();
    const canvas = page?.querySelector('canvas');
    if (!page || !canvas || !canvas.width || !canvas.height) {
      announce('This page is still loading. Wait a moment, then try again.');
      return null;
    }
    return { page, canvas, number: Number(page.dataset.page) || 1 };
  }

  function announce(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(announce.timer);
    announce.timer = window.setTimeout(() => { toast.hidden = true; }, 2800);
  }

  function printCurrentPage() {
    const current = getPageCanvas();
    if (!current) return;
    let image;
    try { image = current.canvas.toDataURL('image/png'); }
    catch { announce('This page could not be prepared for printing.'); return; }
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      announce('Allow pop-ups for EasyRead to print this page.');
      return;
    }
    printWindow.document.open();
    printWindow.document.write('<!doctype html><html><head><meta charset="utf-8"><title>EasyRead PDF page</title><style>html,body{margin:0;padding:0;background:#fff}body{display:grid;place-items:start center}img{display:block;width:auto;height:auto;max-width:100%;max-height:100vh;object-fit:contain}@page{margin:8mm}</style></head><body><img alt="PDF page" src="' + image + '"></body></html>');
    printWindow.document.close();
    const imageNode = printWindow.document.querySelector('img');
    const startPrint = () => {
      printWindow.focus();
      printWindow.print();
    };
    if (imageNode.complete && imageNode.naturalWidth) startPrint();
    else {
      imageNode.addEventListener('load', startPrint, { once: true });
      imageNode.addEventListener('error', () => printWindow.close(), { once: true });
    }
  }

  function saveCurrentPageImage() {
    const current = getPageCanvas();
    if (!current) return;
    try {
      const link = document.createElement('a');
      link.href = current.canvas.toDataURL('image/png');
      link.download = 'easyread-page-' + current.number + '.png';
      document.body.append(link);
      link.click();
      link.remove();
      announce('Saved page ' + current.number + ' as a PNG image.');
    } catch {
      announce('This page could not be exported. Try again after it finishes rendering.');
    }
  }

  const marksKey = () => 'easyread-pdf-marks-v1:' + ((document.getElementById('file-name')?.textContent || 'document').trim().slice(0,160));
  const readMarks = () => { try { return JSON.parse(localStorage.getItem(marksKey()) || '{}') || {}; } catch { return {}; } };
  const writeMarks = data => { try { localStorage.setItem(marksKey(), JSON.stringify(data)); } catch { announce('Could not save marks. Browser storage may be full.'); } };
  let drawing = false;
  let activeStroke = null;

  function pageMarks(number) {
    const all = readMarks();
    return all[String(number)] || { paths: [], notes: [] };
  }
  function savePageMarks(number, marks) {
    const all = readMarks(); all[String(number)] = marks; writeMarks(all);
  }
  function renderMarks(page) {
    if (!page || page.querySelector('.pdf-annotation-layer')) return;
    const number = Number(page.dataset.page) || 1;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.classList.add('pdf-annotation-layer');
    svg.setAttribute('viewBox', '0 0 1000 1414');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-label', 'PDF annotations');
    const marks = pageMarks(number);
    (marks.paths || []).forEach(d => {
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', d); svg.append(path);
    });
    page.append(svg);
    if (drawing) svg.classList.add('is-drawing');
    (marks.notes || []).forEach(note => makeNote(page, number, note));
    svg.addEventListener('pointerdown', event => {
      if (!drawing || event.button !== 0) return;
      event.preventDefault();
      const box = svg.getBoundingClientRect();
      const point = [(event.clientX-box.left)/box.width*1000, (event.clientY-box.top)/box.height*1414];
      const path = document.createElementNS(svgNS, 'path');
      const d = 'M '+point[0].toFixed(1)+' '+point[1].toFixed(1);
      path.setAttribute('d', d); svg.append(path);
      activeStroke = { svg, path, page: number, points: [d] };
      svg.setPointerCapture?.(event.pointerId);
    });
    svg.addEventListener('pointermove', event => {
      if (!activeStroke || activeStroke.svg !== svg) return;
      const box = svg.getBoundingClientRect();
      activeStroke.points.push('L '+((event.clientX-box.left)/box.width*1000).toFixed(1)+' '+((event.clientY-box.top)/box.height*1414).toFixed(1));
      activeStroke.path.setAttribute('d', activeStroke.points.join(' '));
    });
    const finish = () => {
      if (!activeStroke || activeStroke.svg !== svg) return;
      const stroke = activeStroke; activeStroke = null;
      if (stroke.points.length < 2) { stroke.path.remove(); return; }
      const current = pageMarks(stroke.page); current.paths.push(stroke.points.join(' ')); savePageMarks(stroke.page, current);
    };
    svg.addEventListener('pointerup', finish); svg.addEventListener('pointercancel', finish);
  }
  function makeNote(page, number, note) {
    const card = document.createElement('div'); card.className = 'pdf-annotation-note';
    card.style.top = (note.top || 14)+'%'; card.style.right = (note.right || 5)+'%';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label','Delete note');
    close.addEventListener('click', () => {
      const marks = pageMarks(number); marks.notes = marks.notes.filter(item => item.id !== note.id); savePageMarks(number, marks); card.remove();
    });
    card.append(close, document.createTextNode(note.text)); page.append(card);
  }
  function toggleDrawing() {
    drawing = !drawing;
    const button = document.getElementById('pdf-draw-toggle');
    if (button) { button.textContent = drawing ? 'Stop drawing' : 'Draw'; button.setAttribute('aria-pressed', String(drawing)); }
    document.querySelectorAll('#pdf-pages .pdf-page').forEach(page => {
      renderMarks(page); page.querySelector('.pdf-annotation-layer')?.classList.toggle('is-drawing', drawing);
    });
    announce(drawing ? 'Drawing mode on. Draw on the PDF page with your mouse or finger.' : 'Drawing mode off.');
  }
  function addPageNote() {
    const current = getPageCanvas(); if (!current) return;
    const text = window.prompt('Write a note for PDF page '+current.number+':');
    if (text === null || !text.trim()) return;
    const note = { id: (window.crypto?.randomUUID?.() || String(Date.now())), text: text.trim().slice(0,1000), top: 14, right: 5 };
    const marks = pageMarks(current.number); marks.notes.push(note); savePageMarks(current.number, marks);
    if (current.page.querySelector('.pdf-annotation-layer')) makeNote(current.page, current.number, note);
    else renderMarks(current.page);
    announce('Note saved on page '+current.number+'.');
  }
  function clearPageMarks() {
    const current = getPageCanvas(); if (!current) return;
    if (!window.confirm('Clear all drawings and notes from page '+current.number+'?')) return;
    const all = readMarks(); delete all[String(current.number)]; writeMarks(all);
    current.page.querySelector('.pdf-annotation-layer')?.remove();
    current.page.querySelectorAll('.pdf-annotation-note').forEach(note => note.remove());
    if (drawing) renderMarks(current.page);
    announce('Marks cleared from page '+current.number+'.');
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('pdf-print-page')?.addEventListener('click', printCurrentPage);
    document.getElementById('pdf-save-page')?.addEventListener('click', saveCurrentPageImage);
    document.getElementById('pdf-draw-toggle')?.addEventListener('click', toggleDrawing);
    document.getElementById('pdf-note-add')?.addEventListener('click', addPageNote);
    document.getElementById('pdf-marks-clear')?.addEventListener('click', clearPageMarks);
    const annotationObserver = new MutationObserver(() => {
      document.querySelectorAll('#pdf-pages .pdf-page[data-rendered="yes"]').forEach(renderMarks);
    });
    const pdfPages = document.getElementById('pdf-pages');
    if (pdfPages) annotationObserver.observe(pdfPages, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-rendered'] });
  });
})();