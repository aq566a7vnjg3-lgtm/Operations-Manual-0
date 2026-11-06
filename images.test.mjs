import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from './server.mjs';
import { optimizeImage, decodeImage } from './image-service.mjs';
import { screenshotFixture, imageManual, dataImage } from './scripts/image-fixtures.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'test-output');
mkdirSync(output, { recursive: true });
const raw = bytes => sharp(bytes).autoOrient().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });

test('screenshot WebP is smaller with identical dimensions and decoded RGBA pixels', async () => {
  const input = await screenshotFixture();
  const result = await optimizeImage(dataImage(input));
  assert.equal(result.converted, true); assert.equal(result.format, 'image/webp');
  assert.ok(result.bytes < input.length); assert.equal(result.width, 1920); assert.equal(result.height, 1080);
  const before = await raw(input), after = await raw(decodeImage(result.src).bytes);
  assert.deepEqual(after.info, before.info); assert.deepEqual(after.data, before.data);
  writeFileSync(join(output, 'screenshot-original.png'), input);
  writeFileSync(join(output, 'screenshot-optimized.webp'), decodeImage(result.src).bytes);
  writeFileSync(join(output, 'image-quality.json'), JSON.stringify({ originalBytes: input.length, optimizedBytes: result.bytes, reductionPercent: (1 - result.bytes / input.length) * 100, width: result.width, height: result.height, decodedPixelsIdentical: true }, null, 2));
});

test('transparent RGB and alpha channels survive lossless conversion', async () => {
  const pixels = Buffer.alloc(128 * 128 * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = (i / 4) % 256; pixels[i + 1] = 30; pixels[i + 2] = 201; pixels[i + 3] = (i / 4) % 3 ? 120 : 0; }
  const png = await sharp(pixels, { raw: { width: 128, height: 128, channels: 4 } }).png().toBuffer();
  const result = await optimizeImage(dataImage(png));
  assert.deepEqual((await raw(decodeImage(result.src).bytes)).data, (await raw(png)).data);
});

test('equal or larger WebP keeps the original file byte-for-byte', async () => {
  const first = await optimizeImage(dataImage(await screenshotFixture()));
  const second = await optimizeImage(first.src);
  assert.equal(second.converted, false); assert.equal(second.src, first.src);
});

test('legacy unpadded Base64 decodes to the same image bytes', async () => {
  const png = await screenshotFixture();
  assert.deepEqual(decodeImage(dataImage(png).replace(/=+$/, '')).bytes, png);
});

test('PNG beyond WebP dimension limits remains original without downscaling', async () => {
  const png = await sharp({ create: { width: 20000, height: 8, channels: 3, background: 'white' } }).png().toBuffer();
  const result = await optimizeImage(dataImage(png));
  assert.equal(result.src, dataImage(png)); assert.equal(result.width, 20000); assert.equal(result.height, 8);
});

test('EXIF rotated JPEG keeps displayed orientation and resolution', async () => {
  const jpeg = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#2d8a71' } })
    .composite([{ input: await sharp({ create: { width: 60, height: 40, channels: 3, background: '#e73a42' } }).png().toBuffer(), left: 0, top: 0 }])
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await optimizeImage(dataImage(jpeg, 'jpeg'));
  assert.equal(result.width, 80); assert.equal(result.height, 120);
  assert.deepEqual((await raw(decodeImage(result.src).bytes)).data, (await raw(jpeg)).data);
});

test('invalid, mismatched, oversized and animated inputs fail safely', async () => {
  for (const value of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,YQ==', 'https://example.com/a.png']) await assert.rejects(optimizeImage(value), { status: 400 });
  const png = await screenshotFixture();
  await assert.rejects(optimizeImage(dataImage(png, 'jpeg')), { status: 400 });
  const huge = await sharp({ create: { width: 4100, height: 4100, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(optimizeImage(dataImage(huge)), { status: 400 });
  const frames = await Promise.all(['red', 'blue'].map(background => sharp({ create: { width: 8, height: 8, channels: 4, background } }).png().toBuffer()));
  const animation = await sharp(frames, { join: { animated: true } }).webp({ delay: [100, 100], loop: 0 }).toBuffer();
  assert.equal((await sharp(animation).metadata()).pages, 2);
  await assert.rejects(optimizeImage(dataImage(animation, 'webp')), { status: 400 });
});

test('high-bit-depth PNG stays original; ICC-tagged colour is preserved', async () => {
  const source = await screenshotFixture();
  const high = await sharp(source).toColourspace('rgb16').png().toBuffer();
  assert.equal((await sharp(high).metadata()).depth, 'ushort');
  assert.equal((await optimizeImage(dataImage(high))).src, dataImage(high));
  const tagged = await sharp(source).withIccProfile('p3').png().toBuffer();
  const result = await optimizeImage(dataImage(tagged));
  assert.deepEqual((await raw(tagged)).data, (await raw(decodeImage(result.src).bytes)).data);
  assert.ok((await sharp(decodeImage(result.src).bytes).metadata()).icc);
});

test('authenticated lazy image URLs, caching, editing, backups and legacy compatibility', async t => {
  const dataDir = mkdtempSync(join(output, 'image-api-'));
  let app = createApplication({ dataDir, initialAdmin: { username: 'admin', name: 'QA', password: 'TestPass123' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '', csrf = '';
  const request = (path, method = 'GET', body, headers = {}) => fetch(`${origin}/api/${path}`, {
    method, headers: { Connection: 'close', Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = async (path, method = 'GET', body, status = 200) => {
    const res = await request(path, method, body); assert.equal(res.status, status); return res.json();
  };
  const login = async () => {
    const res = await request('login', 'POST', { username: 'admin', password: 'TestPass123' });
    cookie = res.headers.get('set-cookie').split(';')[0]; csrf = (await json('me')).csrf;
  };
  let link, saved;
  try {
    await login();
    const input = dataImage(await screenshotFixture());
    await t.test('conversion checks role, CSRF and origin', async () => {
      assert.equal((await request('optimize-image', 'POST', { src: input }, { Cookie: '' })).status, 401);
      assert.equal((await request('optimize-image', 'POST', { src: input }, { 'X-CSRF-Token': 'wrong' })).status, 403);
      assert.equal((await request('optimize-image', 'POST', { src: input }, { Origin: 'http://elsewhere.invalid' })).status, 403);
      await json('users', 'POST', { username: 'viewer', name: 'Viewer', role: 'viewer', password: 'TestPass123' }, 201);
      const adminCookie = cookie, adminCsrf = csrf;
      const res = await request('login', 'POST', { username: 'viewer', password: 'TestPass123' });
      cookie = res.headers.get('set-cookie').split(';')[0]; csrf = (await json('me')).csrf;
      await json('optimize-image', 'POST', { src: input }, 403);
      cookie = adminCookie; csrf = adminCsrf;
    });
    await t.test('linked list and revision omit Base64, export remains self-contained', async () => {
      const optimized = await json('optimize-image', 'POST', { src: input });
      saved = await json('manuals?images=links', 'PUT', { ...imageManual, images: [{ ...optimized, caption: '品質確認', step: 1 }] });
      link = saved.images[0].src;
      assert.match(link, /^\/api\/images\/image-qa\/1\/0$/);
      assert.equal(saved.images[0].width, 1920);
      const linked = await json('manuals?images=links');
      assert.ok(!JSON.stringify(linked).includes('data:image/'));
      const legacy = await json('manuals'); assert.equal(legacy[0].images[0].src, optimized.src);
      const exported = await json('export'); assert.equal(exported.manuals[0].images[0].src, optimized.src);
      const history = await json('history');
      assert.equal((await json(`history/${history[0].id}?images=links`)).body.images[0].src, link);
      const inlineBytes = Buffer.byteLength(JSON.stringify(legacy)), linkedBytes = Buffer.byteLength(JSON.stringify(linked));
      assert.ok(linkedBytes < inlineBytes / 2);
      writeFileSync(join(output, 'image-api-traffic.json'), JSON.stringify({ inlineBytes, linkedBytes, listReductionPercent: (1 - linkedBytes / inlineBytes) * 100 }, null, 2));
    });
    await t.test('image ETag gives authenticated 304; guests cannot use cache validators', async () => {
      const res = await request(link.slice(5));
      assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'private, no-cache');
      assert.equal(res.headers.get('content-type'), 'image/webp'); assert.equal(res.headers.get('vary'), 'Cookie');
      const bytes = Buffer.from(await res.arrayBuffer()); assert.ok(bytes.length > 0);
      const etag = res.headers.get('etag');
      const cached = await request(link.slice(5), 'GET', undefined, { 'If-None-Match': etag });
      assert.equal(cached.status, 304); assert.equal((await cached.arrayBuffer()).byteLength, 0);
      assert.equal((await request(link.slice(5), 'GET', undefined, { Cookie: '', 'If-None-Match': etag })).status, 401);
      assert.equal((await request('images/image-qa/999/0')).status, 404);
    });
    await t.test('edit and duplicate preserve references; invalid external sources are rejected', async () => {
      saved = await json('manuals?images=links', 'PUT', { ...saved, title: '変更後', images: [{ ...saved.images[0], caption: '説明変更' }] });
      assert.equal((await json('export')).manuals[0].images[0].caption, '説明変更');
      await json('manuals', 'PUT', { ...saved, id: 'image-copy', revision: 0 });
      assert.equal((await json('manuals')).length, 2);
      await json('manuals', 'PUT', { ...saved, images: [{ src: 'https://example.com/x.png' }] }, 400);
    });
    await t.test('JSON import and complete SQLite recovery retain image bytes', async () => {
      const exported = await json('export');
      const { name } = await json('backups', 'POST', {}, 201);
      const backup = Buffer.from(await (await request(`backups/${name}`)).arrayBuffer());
      const version = (await json('version')).version;
      await json('import', 'POST', { manuals: exported.manuals, expectedVersion: version });
      const current = await json('manuals?images=links');
      assert.ok(current.every(manual => manual.images[0].src.startsWith('/api/images/')));
      assert.deepEqual((await json('export')).manuals.map(m => m.images[0].src), exported.manuals.map(m => m.images[0].src));
      await json('system-restore', 'POST', { confirm: true, sqlite: backup.toString('base64') });
      assert.deepEqual((await json('export')).manuals, exported.manuals);
      assert.equal((await request(link.slice(5))).status, 200);
    });
    await t.test('restart preserves image URLs and bytes without a migration', async () => {
      const before = Buffer.from(await (await request(link.slice(5))).arrayBuffer());
      await app.close(); app = createApplication({ dataDir });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${app.server.address().port}`;
      const after = Buffer.from(await (await request(link.slice(5))).arrayBuffer());
      assert.deepEqual(after, before);
      await json('logout', 'POST', {});
      assert.equal((await request(link.slice(5))).status, 401);
    });
  } finally { await app.close(); }
});
