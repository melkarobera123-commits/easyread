/* Adds a selectable PDF.js text layer above the faithful canvas rendering. */
(() => {
  const originalGetDocument = pdfjsLib.getDocument.bind(pdfjsLib);
  const pages = new Map();
  const rendered = new WeakSet();

  pdfjsLib.getDocument = (...args) => {
    const loadingTask = originalGetDocument(...args);
    loadingTask.promise.then(pdf => {
      const originalGetPage = pdf.getPage.bind(pdf);
      pdf.getPage = pageNumber => originalGetPage(pageNumber).then(page => {
        pages.set(pageNumber, page);
        return page;
      });
    }).catch(() => {});
    return loadingTask;
  };

  function addTextLayer(pageEl) {
    if (rendered.has(pageEl)) return;
    const canvas = pageEl.querySelector('canvas');
    const pageNumber = Number(pageEl.dataset.page);
    const page = pages.get(pageNumber);
    if (!canvas || !page) return;
    rendered.add(pageEl);

    const scale = 1.2;
    const viewport = page.getViewport({ scale });
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    layer.setAttribute('aria-label', `Selectable text from page ${pageNumber}`);
    layer.style.cssText = `position:absolute;left:${canvas.offsetLeft}px;top:${canvas.offsetTop}px;width:${canvas.offsetWidth}px;height:${canvas.offsetHeight}px;overflow:hidden;line-height:1;pointer-events:auto;`;
    pageEl.append(layer);

    page.getTextContent().then(textContent => {
      const ratio = canvas.clientWidth / viewport.width || 1;
      for (const item of textContent.items) {
        if (!item.str) continue;
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.max(Math.hypot(tx[2], tx[3]), 1);
        const span = document.createElement('span');
        span.textContent = item.str;
        span.style.cssText = `position:absolute;white-space:pre;transform-origin:0 0;color:transparent;cursor:text;left:${tx[4] * ratio}px;top:${(tx[5] - fontHeight) * ratio}px;font-size:${fontHeight * ratio}px;font-family:sans-serif;transform:scaleX(${Math.max(.01, (item.width * viewport.scale) / Math.max(span.offsetWidth || item.width * viewport.scale, 1))});`;
        layer.append(span);
      }
    }).catch(() => {});
  }

  const observer = new MutationObserver(() => {
    document.querySelectorAll('#reader .pdf-page').forEach(addTextLayer);
  });
  document.addEventListener('DOMContentLoaded', () => {
    const reader = document.querySelector('#reader');
    if (reader) observer.observe(reader, { childList: true, subtree: true });
  });
})();
