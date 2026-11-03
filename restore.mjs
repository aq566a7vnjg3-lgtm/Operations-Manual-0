import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
const checked = (value, max = 20000) => { if (typeof value !== 'string' || value.length > max) invalid('全体バックアップの内容が正しくありません。'); return value; };

export function restoreSystemBackup({ database, dataDir, encoded, session, validateManual, snapshot }) {
  if (typeof encoded !== 'string' || encoded.length > 38 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) invalid('バックアップの形式・サイズを確認してください。');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') invalid('SQLiteバックアップではありません。');
  const path = join(dataDir, `restore-${randomBytes(12).toString('hex')}.sqlite`);
  let source, validated = false;
  writeFileSync(path, bytes, { flag: 'wx' });
  try {
    source = new DatabaseSync(path, { readOnly: true });
    source.exec('PRAGMA trusted_schema=OFF');
    if (source.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') invalid('バックアップが破損しています。');
    for (const table of ['users', 'manuals', 'revisions', 'audit']) {
      if (!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) invalid('必要なバックアップ項目がありません。');
    }
    const users = source.prepare('SELECT id,username,name,password,role,active,created_at FROM users').all();
    const manuals = source.prepare('SELECT id,body,revision FROM manuals').all();
    const revisions = source.prepare('SELECT id,manual_id,revision,body,action,actor,at FROM revisions').all();
    const events = source.prepare('SELECT id,action,actor,at FROM audit').all();
    const owner = users.find(user => user.username === session.username && user.role === 'admin' && user.active === 1);
    if (!owner) invalid('現在の管理者と同じログインIDの有効な管理者が必要です。');
    for (const user of users) {
      if (!/^[a-f0-9]{24}$/.test(checked(user.id, 24)) || !/^[a-zA-Z0-9._-]+$/.test(checked(user.username, 80)) || !['viewer','editor','manager','admin'].includes(user.role) || ![0,1].includes(user.active) || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(checked(user.password, 161))) invalid('アカウント情報が正しくありません。');
      checked(user.name, 100); checked(user.created_at, 40);
    }
    for (const row of manuals) {
      const manual = validateManual(JSON.parse(row.body));
      if (manual.id !== row.id || !Number.isSafeInteger(row.revision) || row.revision < 1) invalid('マニュアル情報が正しくありません。');
    }
    for (const row of revisions) {
      if (validateManual(JSON.parse(row.body)).id !== row.manual_id || !Number.isSafeInteger(row.id) || row.id < 1 || !Number.isSafeInteger(row.revision) || row.revision < 1 || !['create','save','delete','restore','import'].includes(row.action)) invalid('更新履歴が正しくありません。');
      checked(row.actor, 100); checked(row.at, 40);
    }
    for (const event of events) { checked(event.action); checked(event.actor, 100); checked(event.at, 40); }
    validated = true;
    snapshot('before-system-restore');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec('DELETE FROM sessions; DELETE FROM manuals; DELETE FROM revisions; DELETE FROM audit; DELETE FROM users;');
      const putUser = database.prepare('INSERT INTO users(id,username,name,password,role,active,created_at) VALUES(?,?,?,?,?,?,?)');
      for (const user of users) putUser.run(user.id, user.username, user.name, user.password, user.role, user.active, user.created_at);
      const putManual = database.prepare('INSERT INTO manuals(id,body,revision) VALUES(?,?,?)');
      for (const row of manuals) putManual.run(row.id, row.body, row.revision);
      const putRevision = database.prepare('INSERT INTO revisions(id,manual_id,revision,body,action,actor,at) VALUES(?,?,?,?,?,?,?)');
      for (const row of revisions) putRevision.run(row.id, row.manual_id, row.revision, row.body, row.action, row.actor, row.at);
      const putEvent = database.prepare('INSERT INTO audit(id,action,actor,at) VALUES(?,?,?,?)');
      for (const event of events) putEvent.run(event.id, event.action, event.actor, event.at);
      database.prepare('INSERT INTO sessions(token,user_id,csrf,expires) VALUES(?,?,?,?)').run(session.token, owner.id, session.csrf, session.expires);
      database.prepare('INSERT INTO audit(action,actor,at) VALUES(?,?,?)').run('全体バックアップから復元', session.name, new Date().toISOString());
      if (database.prepare('PRAGMA foreign_key_check').get()) invalid('復元データの整合性を確認できません。');
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    return { ok: true, users: users.length, manuals: manuals.length, revisions: revisions.length };
  } catch (error) {
    if (error.status) throw error;
    if (!validated) invalid('バックアップを開けないか、内容が正しくありません。');
    throw error;
  } finally { source?.close(); unlinkSync(path); }
}
