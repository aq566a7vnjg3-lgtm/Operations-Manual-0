import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';
import { optimizeImage } from '../image-service.mjs';
import { screenshotFixture, imageManual, dataImage } from './image-fixtures.mjs';

if (!process.env.MANUAL_QA_MODULES) throw new Error('Set MANUAL_QA_MODULES to the bundled node_modules directory.');
const require = createRequire(join(process.env.MANUAL_QA_MODULES, 'package.json'));
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'test-output'); mkdirSync(output, { recursive: true });
const app = createApplication({ dataDir: mkdtempSync(join(output, 'ui-images-')), initialAdmin: { username: 'admin', name: '画像QA', password: 'TestPass123' } });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [], traffic = [];
const imageReady = locator => locator.evaluate(img => new Promise((resolve, reject) => {
  if (img.complete && img.naturalWidth) { resolve(); return; }
  setTimeout(() => reject(new Error(`Timed out loading image: ${img.src || img.dataset.imageSrc}`)), 10000);
  img.addEventListener('load', resolve, { once: true });
  img.addEventListener('error', () => reject(new Error(`Image did not load: ${img.src}`)), { once: true });
}));
try {
  const png = await screenshotFixture(), optimized = await optimizeImage(dataImage(png));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.request.post(`${origin}/api/login`, { headers: { Origin: origin }, data: { username: 'admin', password: 'TestPass123' } });
  const me = await (await context.request.get(`${origin}/api/me`)).json();
  const headers = { Origin: origin, 'X-CSRF-Token': me.csrf };
  const images = [1, 5, 9, 12].map((step, i) => ({ ...optimized, step, caption: `確認画面 ${i + 1}` }));
  for (const value of [{ ...imageManual, images }, { ...imageManual, id: 'unopened', title: '非表示マニュアル', images }]) {
    const response = await context.request.put(`${origin}/api/manuals`, { headers, data: value }); assert.equal(response.status(), 200);
  }
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const requested = [];
  page.on('request', req => { if (req.url().includes('/api/images/')) requested.push(req.url()); });
  await page.goto(origin); await page.locator('#homeScreen.active').waitFor();
  assert.equal(requested.length, 0, 'No images on home/login');
  await page.evaluate(() => openManual('image-qa'));
  const first = page.locator('.manual-figure img').first();
  await first.scrollIntoViewIfNeeded(); await imageReady(first);
  assert.ok(requested.length >= 1 && requested.length < 4, `Only near-viewport images should load: ${requested.length}`);
  assert.ok(requested.every(url => !url.includes('/unopened/')));
  const before = await page.locator('.manual-figure').nth(3).boundingBox();
  await page.locator('.manual-figure img').nth(3).scrollIntoViewIfNeeded();
  await imageReady(page.locator('.manual-figure img').nth(3));
  const after = await page.locator('.manual-figure').nth(3).boundingBox();
  assert.ok(Math.abs(before.height - after.height) <= 1, 'Image decoding must not change reserved height');
  assert.ok(requested.some(url => url.endsWith('/3')));
  const scrollBefore = await page.evaluate(() => scrollY);
  await page.locator('.manual-figure img').nth(3).click(); await page.locator('#imageViewer[open]').waitFor();
  await imageReady(page.locator('#imageViewerPicture'));
  const fit = await page.locator('#imageViewerScale').innerText();
  await page.locator('#imageZoomIn').click(); assert.notEqual(await page.locator('#imageViewerScale').innerText(), fit);
  await page.locator('#imageActual').click(); assert.equal(await page.locator('#imageViewerScale').innerText(), '100%');
  await page.mouse.move(720, 500); await page.mouse.wheel(0, -250);
  await page.waitForFunction(() => Number(document.querySelector('#imageViewerScale').textContent.replace('%', '')) > 100);
  const transformBefore = await page.locator('#imageViewerPicture').getAttribute('style');
  await page.mouse.move(720, 500); await page.mouse.down(); await page.mouse.move(810, 580, { steps: 8 }); await page.mouse.up();
  assert.notEqual(await page.locator('#imageViewerPicture').getAttribute('style'), transformBefore);
  await page.locator('#imageFit').click(); await page.locator('#imageActual').click();
  await page.mouse.move(700, 500); await page.mouse.down(); await page.mouse.move(1000, 620, { steps: 8 }); await page.mouse.up();
  await page.screenshot({ path: join(output, 'images-zoom-desktop.png') });
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#imageViewer').isVisible(), false);
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - scrollBefore) <= 1);
  await page.evaluate(() => syncManuals());
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - scrollBefore) <= 1, 'Polling must not reset the reading position');
  await page.screenshot({ path: join(output, 'images-detail-desktop.png') });

  // Observe real browser network responses without enabling interception (which disables caching).
  const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', event => { if (event.response.url.includes('/api/images/')) traffic.push({ status: event.response.status, fromDiskCache: event.response.fromDiskCache || false, url: event.response.url }); });
  cdp.on('Network.responseReceivedExtraInfo', event => { if (event.statusCode === 304) traffic.push({ actualHttpStatus: 304 }); });
  await page.evaluate(() => { show('homeScreen'); document.querySelector('#detailContent').innerHTML = ''; });
  await page.evaluate(() => openManual('image-qa'));
  await first.scrollIntoViewIfNeeded(); await imageReady(first);
  await page.reload(); await page.locator('#homeScreen.active').waitFor();
  await page.evaluate(() => openManual('image-qa'));
  await first.scrollIntoViewIfNeeded(); await imageReady(first);
  assert.ok(traffic.some(item => item.actualHttpStatus === 304 || item.fromDiskCache), 'Browser should revalidate/reuse its image cache');

  // File upload is exercised through the actual existing editor, without resizing.
  await page.locator('#detailEdit').click();
  await page.locator('#imageFiles').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => pendingImages === 0 && editImages.length === 5);
  const newImage = await page.evaluate(() => editImages.at(-1));
  assert.equal(newImage.width, 1920); assert.equal(newImage.height, 1080); assert.match(newImage.src, /^data:image\/webp;/);
  for (const kind of ['paste', 'drop']) {
    await page.evaluate(({ src, kind }) => {
      const bytes = Uint8Array.from(atob(src.split(',')[1]), c => c.charCodeAt(0));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'screen.png', { type: 'image/png' }));
      const event = kind === 'paste' ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
        : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
      document.querySelector('#imageDrop').dispatchEvent(event);
    }, { src: dataImage(png), kind });
    await page.waitForFunction(count => pendingImages === 0 && editImages.length === count, kind === 'paste' ? 6 : 7);
  }
  await page.locator('#manualForm button[type=submit]').click();
  await page.getByText('保存しました。全スタッフに共有されます。', { exact: true }).waitFor();
  await page.locator('#adminBack').click();
  await page.evaluate(() => openManual('image-qa'));
  await page.locator('.manual-figure img').last().scrollIntoViewIfNeeded();
  await imageReady(page.locator('.manual-figure img').last());
  await page.evaluate(() => previewRevision(1));
  await page.locator('#revisionDialog[open]').waitFor();
  const historicalImage = page.locator('#revisionContent .manual-figure img').first();
  await historicalImage.scrollIntoViewIfNeeded(); await imageReady(historicalImage);
  await historicalImage.focus(); await page.keyboard.press('Enter');
  await page.locator('#imageViewer[open]').waitFor(); await imageReady(page.locator('#imageViewerPicture'));
  await page.keyboard.press('Escape'); await page.locator('#imageViewer').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#revisionDialog').isVisible(), true);
  await page.locator('#closeRevision').click();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.addCookies(await context.cookies());
  const phone = await mobile.newPage(); phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(origin); await phone.locator('#homeScreen.active').waitFor();
  await phone.evaluate(() => openManual('image-qa'));
  await phone.locator('.manual-figure img').first().scrollIntoViewIfNeeded();
  await imageReady(phone.locator('.manual-figure img').first());
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await phone.screenshot({ path: join(output, 'images-detail-mobile.png') });
  await phone.locator('.manual-figure img').first().tap();
  await imageReady(phone.locator('#imageViewerPicture'));
  const mobileFit = await phone.locator('#imageViewerScale').innerText();
  const touch = await mobile.newCDPSession(phone);
  const touchPoint = (id, x, y) => ({ id, x, y, radiusX: 2, radiusY: 2, force: 1 });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(1, 145, 400), touchPoint(2, 245, 400)] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(1, 65, 400), touchPoint(2, 325, 400)] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.notEqual(await phone.locator('#imageViewerScale').innerText(), mobileFit);
  const mobileTransform = await phone.locator('#imageViewerPicture').getAttribute('style');
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(1, 180, 430)] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(1, 240, 460)] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.notEqual(await phone.locator('#imageViewerPicture').getAttribute('style'), mobileTransform);
  assert.ok(await phone.evaluate(() => document.querySelector('#imageClose').getBoundingClientRect().right <= innerWidth));
  await phone.screenshot({ path: join(output, 'images-zoom-mobile.png') });
  await phone.locator('#imageClose').tap();
  await phone.locator('#imageViewer').waitFor({ state: 'hidden' });
  console.log('PASS: mobile pinch/swipe and close');
  await phone.setViewportSize({ width: 844, height: 390 });
  await phone.locator('.manual-figure img').first().tap(); await phone.locator('#imageViewer[open]').waitFor(); await imageReady(phone.locator('#imageViewerPicture'));
  assert.ok(await phone.evaluate(() => document.querySelector('#imageViewerStage').clientHeight > 250));
  await phone.locator('#imageClose').tap(); await phone.locator('#imageViewer').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'image-browser-traffic.json'), JSON.stringify({ initialHomeImageRequests: 0, hiddenManualImageRequests: requested.filter(url => url.includes('/unopened/')).length, imageRequests: requested.length, cacheResponses: traffic, pageErrors: errors, desktopWheelAndDrag: true, mobilePinchAndSwipe: true, scrollPreserved: true, reservedLayoutStable: true }, null, 2));
  console.log('PASS: lazy loading, stable layout, authenticated browser cache, file/paste/drop, desktop wheel/drag, mobile pinch/swipe, Esc, close, scroll, portrait/landscape; no page errors.');
} finally { await browser.close(); await app.close(); }
