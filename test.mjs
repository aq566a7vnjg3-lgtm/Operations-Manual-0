import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from './server.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const fixture = { id: 'test-manual', title: '共有テスト', category: 'テスト', description: '確認用', steps: ['手順1'], tags: ['登録'], keywords: ['テスト'], required: ['確認物'], related: [], images: [], owner: '担当者A', reviewed: '2026-10-18', nextReview: '2026-11-18', notice: '注意', danger: '', updated: '2026-10-18', changeNote: '初版' };
const pass = 'test-password-1234';

function client(origin) {
  let cookie = '', csrf = '';
  return {
    async request(path, method = 'GET', data, expected = 200, extraHeaders = {}) {
      const response = await fetch(`${origin}/api/${path}`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...extraHeaders }, body: data === undefined ? undefined : JSON.stringify(data) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const result = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
      return result;
    },
    async login(username, password = pass) { await this.request('login', 'POST', { username, password }); const me = await this.request('me'); csrf = me.csrf; return me; }
  };
}

test('shared alpha: authorization, concurrency, migration, recovery and persistence', async t => {
  mkdirSync(join(root, 'test-output'), { recursive: true });
  const dataDir = mkdtempSync(join(root, 'test-output', 'api-'));
  let app = createApplication({ dataDir });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let origin = `http://127.0.0.1:${app.server.address().port}`;
  const admin = client(origin), editor = client(origin), viewer = client(origin), otherEditor = client(origin);
  try {
    await t.test('first setup and authentication; no default data or shared password', async () => {
      assert.equal((await admin.request('status')).initialized, false);
      await admin.request('manuals', 'GET', undefined, 401);
      await admin.request('setup', 'POST', { username: 'admin', name: '管理者', password: pass }, 201);
      await admin.request('setup', 'POST', {}, 409);
      await admin.login('admin');
      assert.deepEqual(await admin.request('manuals'), []);
      await admin.request('users', 'POST', { username: 'editor', name: '編集者', password: pass, role: 'editor' }, 201);
      await admin.request('users', 'POST', { username: 'viewer', name: '閲覧者', password: pass, role: 'viewer' }, 201);
      await editor.login('editor'); await otherEditor.login('editor'); await viewer.login('viewer');
      const html = await (await fetch(origin)).text();
      assert.ok(html.includes('/alpha.js')); assert.ok(!html.includes('await openDB();await loadManuals();clearForm()'));
      assert.equal((await fetch(`${origin}/data/manuals.sqlite`)).status, 404);
    });
    await t.test('server enforces roles, same-origin and CSRF', async () => {
      await viewer.request('manuals', 'PUT', fixture, 403);
      for (const path of ['users', 'backups', 'export', 'audit']) await viewer.request(path, 'GET', undefined, 403);
      await editor.request('users', 'GET', undefined, 403);
      await editor.request('import', 'POST', { manuals: [] }, 403);
      await admin.request('manuals', 'PUT', fixture, 403, { Origin: 'https://example.invalid' });
      await admin.request('manuals', 'PUT', fixture, 403, { 'X-CSRF-Token': 'bad-token' });
      assert.deepEqual(await admin.request('manuals'), []);
    });
    await t.test('multiple staff share content, owners and history', async () => {
      const saved = await editor.request('manuals', 'PUT', fixture);
      assert.equal(saved.revision, 1); assert.equal(saved.editedBy, '編集者');
      assert.equal((await viewer.request('manuals'))[0].owner, '担当者A');
      assert.equal((await viewer.request('history'))[0].action, 'create');
      const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=';
      const updated = await editor.request('manuals', 'PUT', { ...fixture, title: '<script>test</script>', images: [{ src: image, caption: '画像 <test>', step: 1 }], revision: 1 });
      assert.equal(updated.revision, 2);
      assert.equal((await viewer.request('manuals'))[0].images[0].src, image);
    });
    await t.test('stale updates and deletions cannot overwrite another editor', async () => {
      await otherEditor.request('manuals', 'PUT', { ...fixture, revision: 1 }, 409);
      await editor.request('manuals/test-manual', 'DELETE', { revision: 1 }, 409);
      assert.equal((await viewer.request('manuals'))[0].revision, 2);
    });
    await t.test('invalid import is rejected before changing data', async () => {
      const before = await admin.request('manuals');
      const { version } = await admin.request('version');
      const imports = [[fixture, { ...fixture, id: 'bad-id', steps: 'wrong' }], [fixture, fixture], [{ ...fixture, id: 'bad" onclick="alert(1)' }], [{ ...fixture, updated: '<svg/onload=alert(1)>' }], [{ ...fixture, images: [{ src: 'data:image/png;base64,abc" onerror="alert(1)', step: 0 }] }]];
      for (const manuals of imports) await admin.request('import', 'POST', { manuals, expectedVersion: version }, 400);
      assert.deepEqual(await admin.request('manuals'), before);
      await admin.request('import', 'POST', { manuals: [], expectedVersion: -1 }, 409);
      assert.deepEqual(await admin.request('manuals'), before);
    });
    await t.test('mid-import database failure rolls back deletions and writes', async () => {
      const before = await admin.request('manuals');
      const { version } = await admin.request('version');
      app.database.exec("CREATE TRIGGER fail_test BEFORE INSERT ON manuals WHEN NEW.id='force-failure' BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
      await admin.request('import', 'POST', { manuals: [{ ...fixture, id: 'temporary' }, { ...fixture, id: 'force-failure' }], expectedVersion: version }, 500);
      app.database.exec('DROP TRIGGER fail_test');
      assert.deepEqual(await admin.request('manuals'), before);
      assert.equal((await admin.request('version')).version, version);
    });
    await t.test('JSON round-trip preserves images and v0.3 records can be imported', async () => {
      const backup = await admin.request('export');
      let { version } = await admin.request('version');
      await admin.request('import', 'POST', { manuals: backup.manuals, expectedVersion: version });
      const restored = (await admin.request('manuals'))[0];
      assert.deepEqual(restored.images, backup.manuals[0].images);
      assert.equal(restored.owner, fixture.owner);
      ({ version } = await admin.request('version'));
      const old = { ...fixture, id: 'legacy' }; delete old.images; delete old.owner; delete old.reviewed; delete old.nextReview;
      await admin.request('import', 'POST', { manuals: [old], expectedVersion: version });
      assert.deepEqual((await viewer.request('manuals'))[0].images, []);
    });
    await t.test('empty restore stays empty; deleted manual can be recovered from history', async () => {
      const { version } = await admin.request('version');
      await admin.request('import', 'POST', { manuals: [], expectedVersion: version });
      assert.deepEqual(await viewer.request('manuals'), []);
      assert.deepEqual(await viewer.request('manuals'), []);
      const history = await admin.request('history?manual=legacy');
      const earlier = history.find(row => row.action !== 'delete');
      await viewer.request('revert', 'POST', { id: earlier.id, expectedRevision: history[0].revision }, 403);
      await admin.request('revert', 'POST', { id: earlier.id, expectedRevision: history[0].revision });
      assert.equal((await viewer.request('manuals'))[0].id, 'legacy');
      await admin.request('revert', 'POST', { id: earlier.id, expectedRevision: history[0].revision }, 409);
    });
    await t.test('account deactivation revokes existing sessions; last own admin protected', async () => {
      const users = await admin.request('users'); const target = users.find(u => u.username === 'viewer'); const own = users.find(u => u.username === 'admin');
      assert.ok(users.every(user => !('password' in user)));
      await admin.request(`users/${own.id}`, 'PATCH', { role: 'viewer', active: 1 }, 400);
      await admin.request(`users/${target.id}`, 'PATCH', { role: 'viewer', active: 0 });
      await viewer.request('manuals', 'GET', undefined, 401);
      await viewer.request('login', 'POST', { username: 'viewer', password: pass }, 401);
    });
    await t.test('complete SQLite backups contain usable history and staff data', async () => {
      const { name } = await admin.request('backups', 'POST', {}, 201);
      const backup = new DatabaseSync(join(dataDir, 'backups', name), { readOnly: true });
      assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.ok(backup.prepare('SELECT COUNT(*) AS n FROM revisions').get().n > 0);
      assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3); backup.close();
      assert.ok((await admin.request('backups')).files.length >= 3);
      const downloaded = await admin.request(`backups/${name}`); assert.equal(downloaded.subarray(0, 15).toString(), 'SQLite format 3');
    });
    await t.test('password change revokes other sessions and allows whitespace passwords', async () => {
      const newPassword = '  test-new-password  ';
      await editor.request('password', 'POST', { current: pass, password: newPassword });
      await otherEditor.request('manuals', 'GET', undefined, 401);
      await otherEditor.login('editor', newPassword);
      await otherEditor.request('logout', 'POST', {});
      await otherEditor.request('manuals', 'GET', undefined, 401);
    });
    await t.test('database survives server restart', async () => {
      await app.close(); app = createApplication({ dataDir });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${app.server.address().port}`;
      const restarted = client(origin); await restarted.login('admin');
      assert.equal((await restarted.request('manuals'))[0].id, 'legacy');
      assert.ok((await restarted.request('history')).length > 0);
      assert.ok(readdirSync(join(dataDir, 'backups')).length > 0);
    });
  } finally { await app.close(); }
});

test('Render bootstrap, readiness and preview banner', async () => {
  mkdirSync(join(root, 'test-output'), { recursive: true });
  const dataDir = mkdtempSync(join(root, 'test-output', 'bootstrap-'));
  let app = createApplication({ dataDir, previewMode: true, initialAdmin: { username: 'admin', name: '検証管理者', password: pass } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    let origin = `http://127.0.0.1:${app.server.address().port}`;
    const health = await (await fetch(`${origin}/health`)).json();
    assert.equal(health.ok, true); assert.equal(health.preview, true);
    const html = await (await fetch(origin)).text();
    assert.ok(html.includes('正式な業務資料は登録しないでください'));
    const admin = client(origin); assert.equal((await admin.login('admin')).role, 'admin');
    await app.close();
    app = createApplication({ dataDir, initialAdmin: { username: 'admin', password: 'different-password-1234' } });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await client(origin).login('admin')).role, 'admin');
  } finally { await app.close(); }
});

test('public deployment rejects setup even through a loopback proxy', async () => {
  const dataDir = mkdtempSync(join(root, 'test-output', 'locked-'));
  const app = createApplication({ dataDir, allowLocalSetup: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const anonymous = client(origin);
    assert.deepEqual(await anonymous.request('status'), { initialized: false, localSetup: false });
    await anonymous.request('setup', 'POST', { username: 'attacker', name: 'test', password: pass }, 403);
    assert.equal(app.database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  } finally { await app.close(); }
});
