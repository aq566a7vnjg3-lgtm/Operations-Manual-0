import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_DEFINITIONS, PERMISSIONS, permissionsFor } from './permissions.mjs';
import { restoreSystemBackup } from './restore.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 40 * 1024 * 1024;
const ROLES = ROLE_DEFINITIONS.map(role => role.id);
const now = () => new Date().toISOString();
const localDay = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
const hashToken = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const loopback = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordOK(password, stored) {
  const [salt, value] = stored.split(':');
  const actual = Buffer.from(passwordHash(password, salt).split(':')[1], 'hex');
  return timingSafeEqual(actual, Buffer.from(value, 'hex'));
}
function text(value, label, max = 20000, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `${label}を確認してください。`);
  return value.trim();
}
function password(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || /[^A-Za-z0-9]/.test(value) || !/[A-Z]/.test(value) || !/[a-z]/.test(value)) fail(400, 'パスワードは半角英数字8〜128文字で、大文字・小文字をそれぞれ1文字以上含めてください。');
  return value;
}
function existingPassword(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) fail(400, 'パスワードを確認してください。');
  return value;
}
function generatedPassword() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value;
  do { value = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join(''); }
  while (!/[A-Z]/.test(value) || !/[a-z]/.test(value));
  return value;
}
function date(value, label) {
  value = text(value, label, 10);
  if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) fail(400, `${label}が正しくありません。`);
  return value;
}
export function validateManual(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'マニュアルの形式が正しくありません。');
  const out = {};
  out.id = text(input.id, 'ID', 100, true);
  if (!/^[a-zA-Z0-9_-]+$/.test(out.id)) fail(400, 'IDには半角英数字・ハイフン・下線を使用してください。');
  for (const key of ['title', 'category', 'description']) out[key] = text(input[key], key, key === 'description' ? 20000 : 300, true);
  for (const key of ['target', 'notice', 'danger', 'owner', 'changeNote']) out[key] = text(input[key], key, key === 'owner' ? 200 : 20000);
  out.updated = date(input.updated || localDay(), '更新日');
  out.reviewed = date(input.reviewed, '確認日');
  out.nextReview = date(input.nextReview, '次回見直し日');
  for (const key of ['tags', 'keywords', 'required', 'steps', 'related']) {
    const list = input[key] ?? [];
    if (!Array.isArray(list) || list.length > 500) fail(400, `${key}の形式・件数を確認してください。`);
    out[key] = list.map(value => text(value, key, key === 'steps' ? 20000 : 2000, true));
  }
  const images = input.images ?? [];
  if (!Array.isArray(images) || images.length > 50) fail(400, '画像は1件につき50枚までです。');
  let size = 0;
  out.images = images.map(image => {
    if (!image || typeof image !== 'object' || typeof image.src !== 'string' || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.src)) fail(400, '画像の形式が正しくありません。');
    size += image.src.length;
    if (image.src.length > 3 * 1024 * 1024 || size > 15 * 1024 * 1024) fail(400, '画像は1枚3MB、1マニュアル合計15MBまでです。');
    const step = Number(image.step ?? 0);
    if (!Number.isInteger(step) || step < 0 || step > out.steps.length) fail(400, '画像の手順番号を確認してください。');
    return { src: image.src, caption: text(image.caption, '画像の説明', 2000), step };
  });
  return out;
}

export function createApplication({ dataDir = join(ROOT, 'data'), secureCookies = false, initialAdmin = null, previewMode = false, allowLocalSetup = true } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const backupDir = join(dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const database = new DatabaseSync(join(dataDir, 'manuals.sqlite'));
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('viewer','editor','manager','admin')),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS manuals (id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, manual_id TEXT NOT NULL, revision INTEGER NOT NULL,
      body TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL,
      UNIQUE(manual_id, revision)
    );
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL);
  `);
  const run = (sql, ...params) => database.prepare(sql).run(...params);
  const get = (sql, ...params) => database.prepare(sql).get(...params);
  const all = (sql, ...params) => database.prepare(sql).all(...params);
  const transaction = fn => {
    database.exec('BEGIN IMMEDIATE');
    try { const value = fn(); database.exec('COMMIT'); return value; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  };
  const audit = (action, actor) => run('INSERT INTO audit(action,actor,at) VALUES(?,?,?)', action, actor, now());
  if (!get("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").sql.includes("'manager'")) {
    snapshot('before-role-migration');
    database.exec('PRAGMA foreign_keys=OFF');
    try {
      transaction(() => database.exec(`
        CREATE TABLE users_next (
          id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
          password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('viewer','editor','manager','admin')),
          active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
        );
        INSERT INTO users_next SELECT id,username,name,password,role,active,created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_next RENAME TO users;
      `));
    } finally { database.exec('PRAGMA foreign_keys=ON'); }
    if (get('PRAGMA foreign_key_check')) throw new Error('Account migration integrity check failed.');
  }
  if (initialAdmin && !get('SELECT id FROM users LIMIT 1')) {
    const username = text(initialAdmin.username || 'admin', '初期管理者ID', 80, true);
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) throw new Error('Invalid initial administrator username.');
    const name = text(initialAdmin.name || '管理者', '管理者名', 100, true);
    // Keep existing deployment bootstrap credentials usable during policy upgrades.
    if (typeof initialAdmin.password !== 'string' || initialAdmin.password.length < 8) fail(400, '初期管理者のパスワードは8文字以上にしてください。');
    const stored = passwordHash(existingPassword(initialAdmin.password));
    transaction(() => {
      run('INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)', randomBytes(12).toString('hex'), username, name, stored, 'admin', now());
      audit('初期管理者を環境設定から作成', name);
    });
  }
  function snapshot(label) {
    const filename = `${now().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}-${label}.sqlite`;
    database.prepare('VACUUM INTO ?').run(join(backupDir, filename));
    return filename;
  }
  let backupError = '';
  function dailyBackup() {
    try {
      const today = localDay();
      const marker = `daily-${today}`;
      if (!readdirSync(backupDir).some(name => name.endsWith(`${marker}.sqlite`))) snapshot(marker);
      backupError = '';
    } catch (error) { backupError = '自動バックアップに失敗しています。保存先の空き容量を確認してください。'; console.error('Backup failed:', error.message); }
  }
  dailyBackup();
  const timer = setInterval(dailyBackup, 60 * 60 * 1000);
  timer.unref();
  const readManuals = () => all('SELECT body,revision FROM manuals').map(row => ({ ...JSON.parse(row.body), revision: row.revision }));
  function record(input, actor, action = 'save') {
    const previous = get('SELECT MAX(revision) AS revision FROM revisions WHERE manual_id=?', input.id);
    const revision = (previous?.revision || 0) + 1;
    const body = JSON.stringify({ ...input, editedBy: actor, editedAt: now() });
    if (action !== 'delete') run('INSERT INTO manuals(id,body,revision) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=excluded.revision', input.id, body, revision);
    else run('DELETE FROM manuals WHERE id=?', input.id);
    run('INSERT INTO revisions(manual_id,revision,body,action,actor,at) VALUES(?,?,?,?,?,?)', input.id, revision, body, action, actor, now());
    return { ...JSON.parse(body), revision };
  }
  const html = readFileSync(join(ROOT, 'base.html'), 'utf8')
    .replace('<title>業務マニュアル検索 v0.4</title>', '<title>業務マニュアル 共有α版</title>')
    .replace('</head>', '<link rel="stylesheet" href="/alpha.css"></head>')
    .replace('<body>', previewMode ? '<body><div class="preview-banner" role="note">動作確認版：再起動・再配置・休止で登録データが消える場合があります。正式な業務資料は登録しないでください。</div>' : '<body>')
    .replace(/\(async\(\)=>\{try\{await openDB\(\);await loadManuals\(\);clearForm\(\)\}catch\(e\)\{console.error\(e\);alert\([^\n]+\}\}\)\(\);/, '')
    .replace('</body>', '<script src="/alpha.js"></script></body>');
  if (html.includes('await openDB();await loadManuals();clearForm()')) throw new Error('The legacy initialization was not removed.');
  const assets = {
    '/': ['text/html; charset=utf-8', html],
    '/alpha.js': ['text/javascript; charset=utf-8', readFileSync(join(ROOT, 'alpha.js'))],
    '/alpha.css': ['text/css; charset=utf-8', readFileSync(join(ROOT, 'alpha.css'))]
  };
  const attempts = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/health') {
        get('SELECT 1 AS ready');
        send(200, { ok: true, version: '0.6-alpha-accounts', preview: previewMode }); return;
      }
      if (req.method === 'GET' && assets[path]) {
        const [type, body] = assets[path]; res.writeHead(200, { 'Content-Type': type }); res.end(body); return;
      }
      if (!path.startsWith('/api/')) fail(404, '見つかりません。');
      let body;
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        if (req.headers.origin !== `${secureCookies ? 'https' : 'http'}://${req.headers.host}`) fail(403, '同じ画面から操作してください。');
        if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'JSON形式で送信してください。');
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BODY) fail(413, '送信サイズは40MBまでです。'); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail(400, 'JSONの形式が正しくありません。'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '送信内容を確認してください。');
      }
      const initialized = !!get('SELECT id FROM users LIMIT 1');
      if (req.method === 'GET' && path === '/api/status') { send(200, { initialized, localSetup: allowLocalSetup && loopback(req.socket.remoteAddress) }); return; }
      if (req.method === 'POST' && path === '/api/setup') {
        if (initialized) fail(409, '初期設定は完了しています。');
        if (!allowLocalSetup || !loopback(req.socket.remoteAddress)) fail(403, '管理者の初期設定はサーバーの環境設定から行ってください。');
        const username = text(body.username, 'ログインID', 80, true);
        if (!/^[a-zA-Z0-9._-]+$/.test(username)) fail(400, 'ログインIDは半角英数字で入力してください。');
        const name = text(body.name, '氏名', 100, true);
        const stored = passwordHash(password(body.password));
        transaction(() => { run('INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)', randomBytes(12).toString('hex'), username, name, stored, 'admin', now()); audit('初期管理者を作成', name); });
        snapshot('setup'); send(201, { ok: true }); return;
      }
      if (req.method === 'POST' && path === '/api/login') {
        const ip = req.socket.remoteAddress;
        const time = Date.now();
        for (const [key, value] of attempts) if (time - value.at > 15 * 60 * 1000) attempts.delete(key);
        const attempt = attempts.get(ip) || { count: 0, at: time };
        if (attempt.count >= 10) fail(429, 'ログイン試行が多いため、15分後に再度お試しください。');
        const username = text(body.username, 'ログインID', 80, true);
        const supplied = existingPassword(body.password);
        const user = get('SELECT * FROM users WHERE username=?', username);
        const fallback = passwordHash('dummy-password-1234', '00000000000000000000000000000000');
        const valid = passwordOK(supplied, user?.password || fallback);
        if (!valid || !user?.active) { attempt.count++; attempts.set(ip, attempt); fail(401, 'ログインIDまたはパスワードが違います。'); }
        attempts.delete(ip);
        const token = randomBytes(32).toString('hex');
        run('DELETE FROM sessions WHERE expires<?', time);
        run('INSERT INTO sessions(token,user_id,csrf,expires) VALUES(?,?,?,?)', hashToken(token), user.id, randomBytes(24).toString('hex'), time + 12 * 60 * 60 * 1000);
        res.setHeader('Set-Cookie', `manual_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secureCookies ? '; Secure' : ''}`);
        send(200, { ok: true }); return;
      }
      const token = /(?:^|;\s*)manual_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1] || '';
      const session = get('SELECT s.*,u.name,u.username,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', hashToken(token), Date.now());
      if (!session?.active) fail(401, 'ログインしてください。');
      if (req.method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) fail(403, '画面を再読み込みしてから操作してください。');
      const admin = () => { if (session.role !== 'admin') fail(403, '管理者のみ操作できます。'); };
      const permit = permission => { if (!permissionsFor(session.role).includes(permission)) fail(403, 'この操作の権限がありません。'); };
      const editor = () => permit('edit');
      if (req.method === 'GET' && path === '/api/me') { send(200, { id: session.user_id, name: session.name, username: session.username, role: session.role, permissions: permissionsFor(session.role), csrf: session.csrf }); return; }
      if (req.method === 'GET' && path === '/api/roles') { send(200, { roles: ROLE_DEFINITIONS, permissions: PERMISSIONS }); return; }
      if (req.method === 'POST' && path === '/api/logout') { run('DELETE FROM sessions WHERE token=?', session.token); res.setHeader('Set-Cookie', 'manual_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); send(200, { ok: true }); return; }
      if (req.method === 'POST' && path === '/api/password') {
        const user = get('SELECT password FROM users WHERE id=?', session.user_id);
        if (!passwordOK(existingPassword(body.current), user.password)) fail(400, '現在のパスワードが違います。');
        transaction(() => { run('UPDATE users SET password=? WHERE id=?', passwordHash(password(body.password)), session.user_id); run('DELETE FROM sessions WHERE user_id=? AND token<>?', session.user_id, session.token); audit('パスワードを変更', session.name); });
        send(200, { ok: true }); return;
      }
      if (req.method === 'GET' && path === '/api/manuals') { send(200, readManuals()); return; }
      if (req.method === 'PUT' && path === '/api/manuals') {
        editor(); const manual = validateManual(body);
        const result = transaction(() => {
          const previous = get('SELECT revision FROM manuals WHERE id=?', manual.id);
          const historical = get('SELECT id FROM revisions WHERE manual_id=? LIMIT 1', manual.id);
          if ((previous && body.revision !== previous.revision) || (!previous && (body.revision || historical))) fail(409, '別のスタッフが更新または削除しました。入力内容を控えて、最新の内容を開き直してください。');
          if (!manual.owner) manual.owner = session.name;
          return record(manual, session.name, previous ? 'save' : 'create');
        }); send(200, result); return;
      }
      const manualPath = /^\/api\/manuals\/([a-zA-Z0-9_-]+)$/.exec(path);
      if (req.method === 'DELETE' && manualPath) {
        permit('delete'); transaction(() => {
          const row = get('SELECT body,revision FROM manuals WHERE id=?', manualPath[1]);
          if (!row) fail(404, 'すでに削除されています。');
          if (body.revision !== row.revision) fail(409, '別のスタッフが更新しました。最新の内容を開き直してください。');
          record(JSON.parse(row.body), session.name, 'delete');
        }); send(200, { ok: true }); return;
      }
      if (req.method === 'GET' && path === '/api/history') {
        const id = url.searchParams.get('manual');
        const rows = id
          ? all('SELECT id,manual_id,revision,action,actor,at,body FROM revisions WHERE manual_id=? ORDER BY id DESC LIMIT 200', id)
          : all('SELECT id,manual_id,revision,action,actor,at,body FROM revisions ORDER BY id DESC LIMIT 200');
        send(200, rows.map(({ body: data, ...row }) => { const m = JSON.parse(data); return { ...row, title: m.title, changeNote: m.changeNote, owner: m.owner }; })); return;
      }
      const revisionPath = /^\/api\/history\/(\d+)$/.exec(path);
      if (req.method === 'GET' && revisionPath) {
        const row = get('SELECT * FROM revisions WHERE id=?', Number(revisionPath[1]));
        if (!row) fail(404, '履歴がありません。');
        send(200, { ...row, body: JSON.parse(row.body) }); return;
      }
      if (req.method === 'POST' && path === '/api/revert') {
        permit('restore'); const row = get('SELECT * FROM revisions WHERE id=?', Number(body.id));
        if (!row) fail(404, '履歴がありません。');
        if (row.action === 'delete') fail(400, '削除する前の版を選んでください。');
        const manual = validateManual(JSON.parse(row.body));
        snapshot('before-revert');
        const result = transaction(() => {
          const current = get('SELECT MAX(revision) AS revision FROM revisions WHERE manual_id=?', row.manual_id);
          if (body.expectedRevision !== current.revision) fail(409, '履歴が更新されています。履歴を開き直してください。');
          manual.changeNote = `第${row.revision}版へ復元`;
          return record(manual, session.name, 'restore');
        }); send(200, result); return;
      }
      if (req.method === 'GET' && path === '/api/export') {
        permit('transfer'); res.setHeader('Content-Disposition', `attachment; filename="manuals-${localDay()}.json"`);
        send(200, { app: '業務マニュアル検索', version: '0.5-alpha', exportedAt: now(), manuals: readManuals() }); return;
      }
      if (req.method === 'POST' && path === '/api/import') {
        permit('transfer');
        if (!Array.isArray(body.manuals) || body.manuals.length > 2000) fail(400, 'マニュアル配列は2000件までです。');
        const items = body.manuals.map(validateManual);
        if (new Set(items.map(m => m.id)).size !== items.length) fail(400, '同じIDが重複しています。');
        if (!Number.isInteger(body.expectedVersion)) fail(400, '画面を再読み込みしてから復元してください。');
        snapshot('before-import');
        transaction(() => {
          const version = get('SELECT COALESCE(MAX(id),0) AS version FROM revisions').version;
          if (body.expectedVersion !== version) fail(409, '別のスタッフが更新しました。内容を確認してから復元し直してください。');
          const ids = new Set(items.map(m => m.id));
          for (const current of readManuals()) if (!ids.has(current.id)) record(current, session.name, 'delete');
          for (const item of items) record(item, session.name, 'import');
          audit(`${items.length}件を一括復元`, session.name);
        }); send(200, { ok: true, count: items.length }); return;
      }
      if (req.method === 'GET' && path === '/api/version') { send(200, { version: get('SELECT COALESCE(MAX(id),0) AS version FROM revisions').version }); return; }
      if (req.method === 'GET' && path === '/api/users') { admin(); send(200, all('SELECT id,username,name,role,active,created_at FROM users ORDER BY created_at')); return; }
      if (req.method === 'POST' && path === '/api/users') {
        admin(); const username = text(body.username, 'ログインID', 80, true);
        if (!/^[a-zA-Z0-9._-]+$/.test(username)) fail(400, 'ログインIDは半角英数字で入力してください。');
        const name = text(body.name, '氏名', 100, true);
        if (!ROLES.includes(body.role)) fail(400, '権限を確認してください。');
        if (get('SELECT id FROM users WHERE username=?', username)) fail(409, 'そのログインIDは使用されています。');
        const issuedPassword = body.password === undefined || body.password === '' ? generatedPassword() : null;
        const stored = passwordHash(password(issuedPassword || body.password));
        transaction(() => { run('INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)', randomBytes(12).toString('hex'), username, name, stored, body.role, now()); audit(`スタッフ追加: ${username} (${body.role})`, session.name); });
        send(201, { ok: true, username, generatedPassword: issuedPassword }); return;
      }
      const userPath = /^\/api\/users\/([a-f0-9]+)$/.exec(path);
      if (req.method === 'PATCH' && userPath) {
        admin(); const user = get('SELECT * FROM users WHERE id=?', userPath[1]);
        if (!user) fail(404, 'スタッフが見つかりません。');
        const role = body.role ?? user.role, active = body.active ?? user.active;
        const username = text(body.username ?? user.username, 'ログインID', 80, true);
        const name = text(body.name ?? user.name, '氏名', 100, true);
        if (!/^[a-zA-Z0-9._-]+$/.test(username)) fail(400, 'ログインIDは半角英数字で入力してください。');
        if (!ROLES.includes(role) || ![0, 1].includes(active)) fail(400, '権限・利用状態を確認してください。');
        if (get('SELECT id FROM users WHERE username=? AND id<>?', username, user.id)) fail(409, 'そのログインIDは使用されています。');
        if (user.id === session.user_id && (role !== 'admin' || !active)) fail(400, '自分の管理権限・利用状態は変更できません。');
        if (body.resetPassword !== undefined && typeof body.resetPassword !== 'boolean') fail(400, '再発行の指定が正しくありません。');
        if (body.resetPassword && body.password !== undefined) fail(400, '自動発行と任意のパスワードは同時に指定できません。');
        const issuedPassword = body.resetPassword ? generatedPassword() : null;
        const changingPassword = issuedPassword !== null || body.password !== undefined;
        const stored = changingPassword ? passwordHash(password(issuedPassword || body.password)) : user.password;
        transaction(() => {
          run('UPDATE users SET username=?,name=?,role=?,active=?,password=? WHERE id=?', username, name, role, active, stored, user.id);
          run('DELETE FROM sessions WHERE user_id=? AND token<>?', user.id, user.id === session.user_id ? session.token : '');
          audit(`${changingPassword ? 'パスワード再設定' : 'スタッフ設定変更'}: ${user.username}${username !== user.username ? ` → ${username}` : ''}`, session.name);
        });
        send(200, { ok: true, username, generatedPassword: issuedPassword }); return;
      }
      if (req.method === 'POST' && path === '/api/system-restore') {
        admin();
        if (body.confirm !== true) fail(400, '全体復元の明示的な確認が必要です。');
        const result = restoreSystemBackup({ database, dataDir, encoded: body.sqlite, session, validateManual, snapshot });
        send(200, result); return;
      }
      if (req.method === 'GET' && path === '/api/backups') {
        admin(); send(200, { error: backupError, files: readdirSync(backupDir).filter(n => n.endsWith('.sqlite')).sort().reverse().map(name => ({ name, bytes: statSync(join(backupDir, name)).size })) }); return;
      }
      if (req.method === 'POST' && path === '/api/backups') { admin(); const name = snapshot('manual'); backupError = ''; send(201, { name }); return; }
      const backupPath = /^\/api\/backups\/([a-zA-Z0-9._-]+\.sqlite)$/.exec(path);
      if (req.method === 'GET' && backupPath) {
        admin(); const filename = backupPath[1];
        if (!readdirSync(backupDir).includes(filename)) fail(404, 'バックアップが見つかりません。');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename}"` }); res.end(readFileSync(join(backupDir, filename))); return;
      }
      if (req.method === 'GET' && path === '/api/audit') { admin(); send(200, all('SELECT * FROM audit ORDER BY id DESC LIMIT 100')); return; }
      fail(404, '見つかりません。');
    } catch (error) {
      if (!error.status) console.error(error);
      if (!res.headersSent) send(error.status || 500, { error: error.status ? error.message : '処理できませんでした。保存容量とサーバーの状態を確認してください。' });
      else res.end();
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return { server, database, close: () => new Promise((resolveClose, reject) => { clearInterval(timer); server.close(error => { database.close(); error ? reject(error) : resolveClose(); }); server.closeIdleConnections(); }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const app = createApplication({
    dataDir: process.env.MANUAL_DATA_DIR || join(ROOT, 'data'),
    secureCookies: process.env.MANUAL_HTTPS === '1',
    previewMode: process.env.MANUAL_PREVIEW_MODE === '1',
    allowLocalSetup: process.env.MANUAL_HTTPS !== '1',
    initialAdmin: process.env.INITIAL_ADMIN_PASSWORD ? { username: process.env.INITIAL_ADMIN_USERNAME, name: process.env.INITIAL_ADMIN_NAME, password: process.env.INITIAL_ADMIN_PASSWORD } : null
  });
  app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to another number.` : error); app.database.close(); process.exitCode = 1; });
  app.server.listen(port, host, () => console.log(`Business Manual alpha: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\nData: ${process.env.MANUAL_DATA_DIR || join(ROOT, 'data')}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    app.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
  });
}
