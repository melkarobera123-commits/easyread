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

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('pdf-print-page')?.addEventListener('click', printCurrentPage);
    document.getElementById('pdf-save-page')?.addEventListener('click', saveCurrentPageImage);
  });
})();