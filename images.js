'use strict';

const manualImageSource = src => /^(?:data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*|\/api\/images\/[a-zA-Z0-9_-]+\/\d+\/\d+)$/.test(src || '');

async function optimizeManualImage(file) {
  const src = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('画像の読み取りに失敗しました。'));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  return api('optimize-image', { method: 'POST', data: { src } });
}

function prepareManualImage(img, image) {
  img.alt = image.caption || '手順画像';
  img.decoding = 'async';
  img.width = image.width || 4; img.height = image.height || 3;
  img.style.aspectRatio = `${img.width} / ${img.height}`;
  if (manualImageSource(image.src)) img.dataset.imageSrc = image.src;
}

imageFigures = function (manual, position) {
  return (manual.images || []).filter(image => (Number(image.step) || 0) === position && manualImageSource(image.src))
    .map(image => {
      const width = Number.isInteger(image.width) && image.width > 0 ? image.width : 4;
      const height = Number.isInteger(image.height) && image.height > 0 ? image.height : 3;
      return `<figure class="manual-figure"><img alt="${esc(image.caption || '手順画像')}" data-image-src="${esc(image.src)}" width="${width}" height="${height}" style="aspect-ratio:${width}/${height}" decoding="async" role="button" tabindex="0" aria-label="${esc(image.caption || '手順画像')}を拡大"><figcaption>${esc(image.caption || '')}</figcaption></figure>`;
    }).join('');
};

const nearbyImages = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    const img = entry.target;
    if (manualImageSource(img.dataset.imageSrc)) img.src = img.dataset.imageSrc;
    nearbyImages.unobserve(img);
  }
}, { rootMargin: '200px 0px' });
const watchedImages = new WeakSet();
function watchManualImages() {
  document.querySelectorAll('img[data-image-src]').forEach(img => {
    if (!watchedImages.has(img)) { watchedImages.add(img); nearbyImages.observe(img); }
  });
}
new MutationObserver(records => {
  for (const record of records) for (const node of record.removedNodes) {
    if (node.nodeType !== 1) continue;
    if (node.matches('img[data-image-src]')) nearbyImages.unobserve(node);
    node.querySelectorAll('img[data-image-src]').forEach(img => nearbyImages.unobserve(img));
  }
  watchManualImages();
}).observe(document.body, { childList: true, subtree: true });

document.body.insertAdjacentHTML('beforeend', `
 <dialog id="imageViewer" aria-label="画像の拡大表示">
  <div class="image-viewer-toolbar">
   <span id="imageViewerCaption"></span><output id="imageViewerScale" aria-live="polite"></output>
   <button type="button" id="imageZoomOut" title="縮小" aria-label="縮小">−</button>
   <button type="button" id="imageZoomIn" title="拡大" aria-label="拡大">+</button>
   <button type="button" id="imageFit" title="画面に合わせる" aria-label="画面に合わせる">⤢</button>
   <button type="button" id="imageActual" title="等倍表示" aria-label="等倍表示">1:1</button>
   <button type="button" id="imageClose" title="閉じる" aria-label="拡大画像を閉じる">×</button>
  </div>
  <div id="imageViewerStage"><img id="imageViewerPicture" alt="" draggable="false"><span id="imageViewerError" role="alert"></span></div>
 </dialog>`);
const viewer = document.querySelector('#imageViewer');
const stage = document.querySelector('#imageViewerStage');
const picture = document.querySelector('#imageViewerPicture');
let imageZoom = 1, fitScale = 1, imagePanX = 0, imagePanY = 0;
let savedImageScroll = 0, savedImageOverflow = '', imageReturnFocus = null;
const imagePointers = new Map();
const maxImageZoom = () => Math.min(64, Math.max(8, 2 / fitScale));
function paintImage() {
  const w = picture.naturalWidth * fitScale * imageZoom, h = picture.naturalHeight * fitScale * imageZoom;
  const maxX = Math.max(0, (w - stage.clientWidth) / 2 + 24), maxY = Math.max(0, (h - stage.clientHeight) / 2 + 24);
  imagePanX = Math.max(-maxX, Math.min(maxX, imagePanX));
  imagePanY = Math.max(-maxY, Math.min(maxY, imagePanY));
  picture.style.width = `${picture.naturalWidth * fitScale}px`;
  picture.style.height = `${picture.naturalHeight * fitScale}px`;
  picture.style.transform = `translate(-50%, -50%) translate(${imagePanX}px, ${imagePanY}px) scale(${imageZoom})`;
  document.querySelector('#imageViewerScale').value = `${Math.round(fitScale * imageZoom * 100)}%`;
  document.querySelector('#imageZoomOut').disabled = imageZoom <= 1;
  document.querySelector('#imageZoomIn').disabled = imageZoom >= maxImageZoom();
}
function fitImage() {
  if (!picture.naturalWidth) return;
  fitScale = Math.min(1, (stage.clientWidth - 24) / picture.naturalWidth, (stage.clientHeight - 24) / picture.naturalHeight);
  imageZoom = 1; imagePanX = 0; imagePanY = 0; paintImage();
}
function zoomImageTo(value, clientX, clientY) {
  if (!picture.naturalWidth) return;
  const bounds = stage.getBoundingClientRect();
  const x = (clientX ?? bounds.left + bounds.width / 2) - bounds.left - bounds.width / 2;
  const y = (clientY ?? bounds.top + bounds.height / 2) - bounds.top - bounds.height / 2;
  const next = Math.max(1, Math.min(maxImageZoom(), value)), ratio = next / imageZoom;
  imagePanX = x - (x - imagePanX) * ratio; imagePanY = y - (y - imagePanY) * ratio;
  imageZoom = next; paintImage();
}
showImageZoom = function (src, caption = '', opener = document.activeElement) {
  if (!manualImageSource(src) || viewer.open) return;
  imageReturnFocus = opener; savedImageScroll = window.scrollY;
  savedImageOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
  imagePointers.clear(); imageZoom = 1; imagePanX = imagePanY = 0;
  picture.style.visibility = 'hidden'; document.querySelector('#imageViewerError').textContent = '';
  document.querySelector('#imageViewerCaption').textContent = caption;
  document.querySelector('#imageViewerScale').value = '';
  picture.alt = caption || '手順画像';
  picture.onload = () => { fitImage(); picture.style.visibility = ''; };
  picture.onerror = () => { document.querySelector('#imageViewerError').textContent = '画像を読み込めません。閉じて再度お試しください。'; };
  viewer.showModal(); picture.src = src;
};
viewer.addEventListener('close', () => {
  imagePointers.clear(); picture.onload = null; picture.onerror = null; picture.removeAttribute('src');
  document.body.style.overflow = savedImageOverflow;
  if (imageReturnFocus?.isConnected) imageReturnFocus.focus({ preventScroll: true });
  window.scrollTo(0, savedImageScroll);
});
document.querySelector('#imageClose').onclick = () => viewer.close();
document.querySelector('#imageZoomIn').onclick = () => zoomImageTo(imageZoom * 1.3);
document.querySelector('#imageZoomOut').onclick = () => zoomImageTo(imageZoom / 1.3);
document.querySelector('#imageFit').onclick = fitImage;
document.querySelector('#imageActual').onclick = () => zoomImageTo(1 / fitScale);
// Some mobile browsers suppress compatibility clicks immediately after a pinch.
viewer.querySelector('.image-viewer-toolbar').addEventListener('touchend', event => {
  const button = event.target.closest('button'), point = event.changedTouches[0];
  if (!button || button.disabled || event.touches.length || !point) return;
  const bounds = button.getBoundingClientRect();
  if (point.clientX < bounds.left || point.clientX > bounds.right || point.clientY < bounds.top || point.clientY > bounds.bottom) return;
  event.preventDefault(); button.click();
}, { passive: false });
stage.addEventListener('wheel', event => {
  event.preventDefault(); zoomImageTo(imageZoom * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
}, { passive: false });
stage.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault(); stage.setPointerCapture(event.pointerId);
  imagePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
});
stage.addEventListener('pointermove', event => {
  const previous = imagePointers.get(event.pointerId); if (!previous) return;
  const before = [...imagePointers.values()];
  imagePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const after = [...imagePointers.values()];
  if (after.length === 2) {
    const distance = points => Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
    const mid = points => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
    const oldMid = mid(before), newMid = mid(after);
    zoomImageTo(imageZoom * distance(after) / Math.max(1, distance(before)), oldMid.x, oldMid.y);
    imagePanX += newMid.x - oldMid.x; imagePanY += newMid.y - oldMid.y;
  } else if (after.length === 1) {
    imagePanX += event.clientX - previous.x; imagePanY += event.clientY - previous.y;
  }
  paintImage();
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(event, e => imagePointers.delete(e.pointerId));
new ResizeObserver(() => { if (viewer.open) fitImage(); }).observe(stage);
document.addEventListener('click', event => {
  const img = event.target.closest('.manual-figure img'); if (!img) return;
  event.preventDefault(); event.stopImmediatePropagation();
  showImageZoom(img.dataset.imageSrc || img.src, img.alt, img);
}, true);
document.addEventListener('keydown', event => {
  if (viewer.open) {
    if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); zoomImageTo(imageZoom * (event.key === '-' ? 1 / 1.3 : 1.3)); }
    return;
  }
  if (event.target.matches('.manual-figure img') && ['Enter', ' '].includes(event.key)) {
    event.preventDefault(); event.target.click();
  }
});
