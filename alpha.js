'use strict';

let staff = null, csrfToken = '', editingRevision = 0, formDirty = false, saving = false;
let imageGeneration = 0, pendingImages = 0, syncTimer = null, historyManual = '';
const roleNames = { viewer: '閲覧', editor: '編集', admin: '管理者' };
const actionNames = { create: '新規', save: '更新', delete: '削除', restore: '版の復元', import: '一括復元' };
const canEdit = () => staff && staff.role !== 'viewer';
const canAdmin = () => staff?.role === 'admin';
const formatTime = value => value ? new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '';

document.body.insertAdjacentHTML('afterbegin', `
 <div id="sharedBar" hidden>
   <span class="shared-brand">業務マニュアル <span class="alpha-label">共有α版</span></span>
   <span id="syncState" role="status"></span><div class="spacer"></div>
   <span id="staffName"></span>
   <button type="button" class="secondary" id="openHistory">更新履歴</button>
   <button type="button" class="secondary" id="openTeam" hidden>スタッフ・バックアップ</button>
   <button type="button" class="secondary" id="changePassword">パスワード変更</button>
   <button type="button" class="secondary" id="logout">ログアウト</button>
 </div>
 <div id="sharedMessage" role="alert" hidden></div>
 <section id="loginScreen" class="screen auth-screen">
   <div class="auth-wrap"><h1>業務マニュアル</h1><p class="small">共有α版</p>
   <h2 id="authTitle">ログイン</h2>
   <form id="authForm" class="auth-form">
     <div class="field" id="setupNameField" hidden><label for="setupName">管理者の氏名</label><input id="setupName" maxlength="100" autocomplete="name"></div>
     <div class="field"><label for="loginId">ログインID</label><input id="loginId" required maxlength="80" pattern="[A-Za-z0-9._-]+" autocomplete="username" autocapitalize="none"></div>
     <div class="field"><label for="loginPassword">パスワード</label><input id="loginPassword" type="password" required maxlength="128" autocomplete="current-password"></div>
     <div class="field" id="setupConfirmField" hidden><label for="setupConfirm">パスワード（確認）</label><input id="setupConfirm" type="password" maxlength="128" autocomplete="new-password"></div>
     <button class="primary" id="authSubmit">ログイン</button><p id="authError" role="alert"></p>
   </form></div>
 </section>
 <section id="historyScreen" class="screen workspace-screen">
   <div class="workspace-heading"><button class="secondary" id="historyBack">← ホーム</button><h1>更新履歴</h1><span id="historyScope" class="small"></span></div>
   <div id="historyList"></div>
 </section>
 <section id="teamScreen" class="screen workspace-screen">
   <div class="workspace-heading"><button class="secondary" id="teamBack">← ホーム</button><h1>スタッフ・バックアップ</h1></div>
   <section class="workspace-section"><h2>スタッフ</h2><div id="teamList"></div>
   <h3>スタッフ追加</h3><form id="addStaffForm" class="staff-form">
     <div class="field"><label for="newStaffName">氏名</label><input id="newStaffName" required maxlength="100"></div>
     <div class="field"><label for="newStaffId">ログインID</label><input id="newStaffId" required pattern="[A-Za-z0-9._-]+" maxlength="80" autocomplete="off" autocapitalize="none"></div>
     <div class="field"><label for="newStaffRole">権限</label><select id="newStaffRole"><option value="viewer">閲覧</option><option value="editor">編集</option><option value="admin">管理者</option></select></div>
     <div class="field"><label for="newStaffPassword">初期パスワード（12文字以上）</label><input id="newStaffPassword" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></div>
     <button class="primary" type="submit">追加</button>
   </form></section>
   <section class="workspace-section"><div class="workspace-heading"><h2>バックアップ</h2><button class="secondary" id="createBackup">今すぐ作成</button></div>
     <p id="backupHealth" role="status"></p><div id="backupList"></div>
   </section>
   <section class="workspace-section"><h2>管理の操作履歴</h2><div id="auditList"></div></section>
 </section>
 <dialog id="revisionDialog"><div class="dialog-heading"><h2>過去の版</h2><button class="secondary" id="closeRevision" aria-label="閉じる">×</button></div><div id="revisionContent"></div><button class="primary" id="restoreRevision" hidden>この版へ戻す</button></dialog>
 <dialog id="passwordDialog"><form id="passwordForm"><div class="dialog-heading"><h2>パスワード変更</h2><button type="button" class="secondary" id="closePassword" aria-label="閉じる">×</button></div>
   <div class="field"><label for="currentPassword">現在のパスワード</label><input id="currentPassword" type="password" required autocomplete="current-password" maxlength="128"></div>
   <div class="field"><label for="nextPassword">新しいパスワード（12文字以上）</label><input id="nextPassword" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></div>
   <div class="field"><label for="nextPasswordConfirm">新しいパスワード（確認）</label><input id="nextPasswordConfirm" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></div>
   <p id="passwordError" role="alert"></p><button class="primary">変更</button>
 </form></dialog>
`);

$('#manualForm .form-grid').insertAdjacentHTML('beforeend', `
 <div class="field"><label for="fOwner">担当者</label><input id="fOwner" maxlength="200"></div>
 <div class="field"><label for="fReviewed">内容確認日</label><input id="fReviewed" type="date"></div>
 <div class="field"><label for="fNextReview">次回見直し日</label><input id="fNextReview" type="date"></div>
 <div class="field full"><label for="fChangeNote">今回の変更内容</label><input id="fChangeNote" maxlength="2000"></div>
`);
$('#detailStar').insertAdjacentHTML('beforebegin', '<button class="secondary" id="detailHistory">履歴</button><button class="secondary" id="detailEdit">編集</button>');

function message(value, error = false) {
  const el = $('#sharedMessage'); el.textContent = value; el.hidden = !value; el.classList.toggle('error', error);
}
async function api(path, { method = 'GET', data } = {}) {
  const headers = {};
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = csrfToken; }
  let response;
  try { response = await fetch(`/api/${path}`, { method, headers, credentials: 'same-origin', body: data === undefined ? undefined : JSON.stringify(data), cache: 'no-store' }); }
  catch { throw new Error('共有サーバーに接続できません。接続を確認して再度お試しください。'); }
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && staff) { loggedOut(); $('#authError').textContent = 'ログインの有効期限が切れました。再度ログインしてください。'; }
    throw Object.assign(new Error(result.error || '処理できませんでした。'), { status: response.status });
  }
  return result;
}
const guard = fn => async (...args) => { try { await fn(...args); } catch (error) { message(error.message, true); } };

// Keep preferences separate for each signed-in staff member on a shared PC.
uiStore.get = function (key, fallback = []) { try { return JSON.parse(localStorage.getItem(`alpha-${staff?.id || 'guest'}-${key}`)) ?? fallback; } catch { return fallback; } };
uiStore.set = function (key, value) { try { localStorage.setItem(`alpha-${staff?.id || 'guest'}-${key}`, JSON.stringify(value)); } catch { message('この端末ではお気に入り・履歴を保存できません。', true); } };
today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
dbAll = () => api('manuals');
dbPut = value => api('manuals', { method: 'PUT', data: value });
dbDel = id => api(`manuals/${encodeURIComponent(id)}`, { method: 'DELETE', data: { revision: editingRevision } });
loadManuals = async () => {
  manuals = await dbAll();
  manuals.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  refreshAll();
  $('#dbStatus').textContent = `共有：${manuals.length}件`;
  $('#syncState').textContent = `確認 ${new Date().toLocaleTimeString('ja-JP')}`;
};
const originalClearForm = clearForm;
clearForm = function () {
  if (formDirty && !confirm('保存していない変更を破棄しますか？')) return;
  imageGeneration++; originalClearForm(); editingRevision = 0;
  $('#fOwner').value = staff?.name || ''; $('#fReviewed').value = ''; $('#fNextReview').value = ''; $('#fChangeNote').value = '';
  formDirty = false;
};
const originalEditManual = editManual;
editManual = function (id) {
  if (formDirty && !confirm('保存していない変更を破棄して、マニュアルを開きますか？')) return;
  const manual = manuals.find(m => m.id === id); if (!manual) return;
  imageGeneration++; originalEditManual(id); editingRevision = manual.revision;
  for (const [field, key] of [['fOwner', 'owner'], ['fReviewed', 'reviewed'], ['fNextReview', 'nextReview']]) $(`#${field}`).value = manual[key] || '';
  $('#fChangeNote').value = ''; formDirty = false;
};
const originalFormToManual = formToManual;
formToManual = function (forceId = null) {
  return { ...originalFormToManual(forceId), revision: forceId ? 0 : editingRevision, owner: $('#fOwner').value.trim(), reviewed: $('#fReviewed').value, nextReview: $('#fNextReview').value, changeNote: $('#fChangeNote').value.trim() };
};

async function sharedSave(event) {
  event.preventDefault(); if (saving || !canEdit()) return;
  if (pendingImages) { message('画像の読み込み完了後に保存してください。', true); return; }
  saving = true; $('#manualForm button[type="submit"]').disabled = true;
  try {
    const value = formToManual(); await dbPut(value); formDirty = false;
    await loadManuals(); editManual(value.id); message('保存しました。全スタッフに共有されます。');
  } catch (error) { message(error.message, true); }
  finally { saving = false; $('#manualForm button[type="submit"]').disabled = false; }
}
$('#manualForm').removeEventListener('submit', saveManual);
$('#manualForm').addEventListener('submit', sharedSave);
$('#manualForm').addEventListener('input', () => { formDirty = true; });
$('#manualForm').addEventListener('change', () => { formDirty = true; });
$('#manualForm').addEventListener('click', event => { if (event.target.closest('.image-item button')) formDirty = true; });
window.addEventListener('beforeunload', event => { if (formDirty) { event.preventDefault(); event.returnValue = ''; } });
$('#duplicateManual').onclick = guard(async () => {
  if (!currentEditId || saving) return;
  const value = formToManual(slug()); value.title += ' コピー'; value.updated = today();
  await dbPut(value); formDirty = false; await loadManuals(); editManual(value.id); message('複製しました。');
});
$('#deleteManual').onclick = guard(async () => {
  if (!currentEditId || saving || !confirm('このマニュアルを削除しますか？管理者は更新履歴から復元できます。')) return;
  await dbDel(currentEditId); formDirty = false; await loadManuals(); clearForm(); message('削除しました。');
});
$('#adminBack').onclick = () => { if (formDirty && !confirm('保存していない変更を破棄しますか？')) return; formDirty = false; show('homeScreen'); };
$('#newManual').onclick = clearForm;
$('#openAdmin').onclick = () => { if (canEdit()) { show('adminScreen'); clearForm(); } };
addImages = async function (files) {
  const generation = imageGeneration;
  const images = [...files].filter(file => file.type.startsWith('image/'));
  if (editImages.length + pendingImages + images.length > 50) { message('画像は50枚までです。', true); return; }
  pendingImages += images.length;
  try {
  for (const file of images) {
    try {
      if (file.size > 30 * 1024 * 1024) throw new Error('読込前の画像は30MBまでです。');
      const src = await imageToData(file);
      if (generation !== imageGeneration) return;
      if (src.length > 3 * 1024 * 1024 || editImages.reduce((n, im) => n + im.src.length, src.length) > 15 * 1024 * 1024) throw new Error('保存画像は1枚3MB、合計15MBまでです。');
      editImages.push({ src, caption: '', step: 0 }); formDirty = true;
    } catch (error) { message(`${file.name}: ${error.message}`, true); }
  }
  } finally { pendingImages -= images.length; }
  if (generation === imageGeneration) renderImageEditor();
};
$('#imageFiles').onchange = guard(async event => { await addImages(event.target.files); event.target.value = ''; });

const originalOpenManual = openManual;
openManual = function (id) {
  originalOpenManual(id); const manual = manuals.find(m => m.id === id); if (!manual) return;
  const due = manual.nextReview && manual.nextReview < today();
  $('#detailContent .updated').insertAdjacentHTML('afterend', `<div class="ownership-meta">
    <span>担当：${esc(manual.owner || '未設定')}</span><span>内容確認：${esc(manual.reviewed || '未設定')}</span>
    <span class="${due ? 'overdue' : ''}">次回見直し：${esc(manual.nextReview || '未設定')}${due ? '（期限超過）' : ''}</span>
    <span>第${manual.revision}版 · 更新者：${esc(manual.editedBy || '')}</span></div>`);
  $('#detailEdit').hidden = !canEdit();
};
$('#detailEdit').onclick = () => { show('adminScreen'); editManual(currentDetailId); };
$('#detailHistory').onclick = guard(() => openHistory(currentDetailId));

function downloadJson(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#exportJson').onclick = guard(async () => downloadJson(await api('export'), `業務マニュアル_backup_${today()}.json`));
importJson = async function (file) {
  if (!file || !canAdmin()) return;
  try {
    if (file.size > 38 * 1024 * 1024) throw new Error('JSONファイルは38MBまでです。');
    const data = JSON.parse(await file.text()); const items = Array.isArray(data) ? data : data?.manuals;
    if (!Array.isArray(items)) throw new Error('マニュアルの配列がありません。');
    if (formDirty) throw new Error('編集中の内容を保存してから復元してください。');
    const { version } = await api('version');
    if (!confirm(`${items.length}件で共有中の全マニュアルを置き換えます。現在の内容は自動退避されます。実行しますか？`)) return;
    await api('import', { method: 'POST', data: { manuals: items, expectedVersion: version } });
    await loadManuals(); clearForm(); message(`${items.length}件を復元しました。`);
  } catch (error) { message(error.message, true); }
};

async function openHistory(id = '') {
  historyManual = id;
  const rows = await api(`history${id ? `?manual=${encodeURIComponent(id)}` : ''}`);
  $('#historyScope').textContent = id ? (manuals.find(m => m.id === id)?.title || 'マニュアル別') : '全マニュアル・最新200件';
  const list = $('#historyList'); list.innerHTML = '';
  if (!rows.length) list.innerHTML = '<p class="empty">更新履歴はまだありません。</p>';
  for (const row of rows) {
    const item = document.createElement('div'); item.className = 'history-row';
    item.innerHTML = `<div><strong>${esc(row.title)}</strong><div class="small">${esc(formatTime(row.at))} · ${esc(row.actor)} · 第${row.revision}版 · ${esc(actionNames[row.action] || row.action)}</div><div>${esc(row.changeNote || '')}</div></div>`;
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = '内容を見る'; button.onclick = guard(() => previewRevision(row.id)); item.append(button); list.append(item);
  }
  show('historyScreen');
}
async function previewRevision(id) {
  const row = await api(`history/${id}`), manual = row.body;
  const history = await api(`history?manual=${encodeURIComponent(row.manual_id)}`);
  const expectedRevision = history[0].revision;
  $('#revisionContent').innerHTML = `<h3>${esc(manual.title)}</h3><p class="small">第${row.revision}版 · ${esc(formatTime(row.at))} · ${esc(row.actor)}</p>
    <p>担当：${esc(manual.owner || '未設定')}</p><p>${esc(manual.description)}</p>
    <h3>必要なもの</h3><ul>${manual.required.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    <h3>手順</h3><ol>${manual.steps.map((x, i) => `<li>${esc(x)}${imageFigures(manual, i + 1)}</li>`).join('')}</ol>${imageFigures(manual, 0)}
    <h3>注意・重要事項</h3><p class="preserve-lines">${esc(manual.notice)}\n${esc(manual.danger)}</p>`;
  $('#restoreRevision').hidden = !canAdmin() || row.action === 'delete';
  $('#restoreRevision').onclick = guard(async () => {
    if (!confirm(`「${manual.title}」を第${row.revision}版の内容へ戻しますか？`)) return;
    await api('revert', { method: 'POST', data: { id, expectedRevision } });
    $('#revisionDialog').close(); await loadManuals(); await openHistory(historyManual); message('過去の版を復元しました。');
  });
  $('#revisionDialog').showModal();
}
$('#openHistory').onclick = guard(() => openHistory());
$('#historyBack').onclick = () => show('homeScreen');
$('#closeRevision').onclick = () => $('#revisionDialog').close();

async function loadTeam() {
  const [users, backups, audits] = await Promise.all([api('users'), api('backups'), api('audit')]);
  const list = $('#teamList'); list.innerHTML = '';
  for (const user of users) {
    const row = document.createElement('div'); row.className = 'staff-row';
    const identity = document.createElement('div'); identity.innerHTML = `<strong>${esc(user.name)}</strong><div class="small">${esc(user.username)}</div>`;
    const role = document.createElement('select'); role.setAttribute('aria-label', `${user.name}の権限`);
    for (const [value, label] of Object.entries(roleNames)) { const option = document.createElement('option'); option.value = value; option.textContent = label; role.append(option); } role.value = user.role;
    const activeLabel = document.createElement('label'); activeLabel.className = 'active-toggle';
    const active = document.createElement('input'); active.type = 'checkbox'; active.checked = !!user.active; activeLabel.append(active, '利用中');
    const save = document.createElement('button'); save.className = 'secondary'; save.textContent = '変更を保存';
    save.onclick = guard(async () => { await api(`users/${user.id}`, { method: 'PATCH', data: { role: role.value, active: active.checked ? 1 : 0 } }); await loadTeam(); message('スタッフ設定を更新しました。'); });
    const reset = document.createElement('button'); reset.className = 'secondary'; reset.textContent = 'パスワード再設定';
    reset.onclick = guard(async () => {
      const value = prompt(`${user.name}の新しいパスワード（12文字以上）`); if (value === null) return;
      await api(`users/${user.id}`, { method: 'PATCH', data: { role: user.role, active: user.active, password: value } }); message('パスワードを再設定しました。本人にお伝えください。');
    });
    if (user.id === staff.id) { role.disabled = true; active.disabled = true; save.disabled = true; reset.hidden = true; }
    row.append(identity, role, activeLabel, save, reset); list.append(row);
  }
  $('#backupHealth').textContent = backups.error || '自動保存：起動時・稼働中は毎日。全件復元・旧版復元の直前にも退避します。';
  $('#backupHealth').classList.toggle('overdue', !!backups.error);
  $('#backupList').innerHTML = backups.files.map(file => `<div class="backup-row"><a href="/api/backups/${encodeURIComponent(file.name)}">${esc(file.name)}</a><span class="small">${(file.bytes / 1024 / 1024).toFixed(1)} MB</span></div>`).join('') || '<p>バックアップはまだありません。</p>';
  $('#auditList').innerHTML = audits.map(row => `<div class="audit-row"><span>${esc(row.action)}</span><span class="small">${esc(row.actor)} · ${esc(formatTime(row.at))}</span></div>`).join('');
}
$('#openTeam').onclick = guard(async () => { await loadTeam(); show('teamScreen'); });
$('#teamBack').onclick = () => show('homeScreen');
$('#createBackup').onclick = guard(async () => { await api('backups', { method: 'POST', data: {} }); await loadTeam(); message('バックアップを作成しました。'); });
$('#addStaffForm').onsubmit = guard(async event => {
  event.preventDefault();
  await api('users', { method: 'POST', data: { name: $('#newStaffName').value, username: $('#newStaffId').value, role: $('#newStaffRole').value, password: $('#newStaffPassword').value } });
  $('#addStaffForm').reset(); await loadTeam(); message('スタッフを追加しました。');
});
$('#changePassword').onclick = () => { $('#passwordForm').reset(); $('#passwordError').textContent = ''; $('#passwordDialog').showModal(); };
$('#closePassword').onclick = () => $('#passwordDialog').close();
$('#passwordForm').onsubmit = async event => {
  event.preventDefault();
  try {
    if ($('#nextPassword').value !== $('#nextPasswordConfirm').value) throw new Error('新しいパスワードが一致していません。');
    await api('password', { method: 'POST', data: { current: $('#currentPassword').value, password: $('#nextPassword').value } });
    $('#passwordDialog').close(); $('#passwordForm').reset(); message('パスワードを変更しました。');
  } catch (error) { $('#passwordError').textContent = error.message; }
};

function loggedOut() {
  clearInterval(syncTimer); syncTimer = null; staff = null; csrfToken = ''; imageGeneration++; formDirty = false;
  manuals = []; editImages = []; currentEditId = ''; currentDetailId = ''; editingRevision = 0;
  $('#manualForm').reset();
  for (const selector of ['#detailContent', '#historyList', '#teamList', '#backupList', '#auditList', '#revisionContent', '#imageList', '#resultsList', '#recentCards', '#favCards', '#adminItems', '#fRelated']) $(selector).innerHTML = '';
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('#sharedBar').hidden = true; $('#authForm').reset(); message(''); show('loginScreen');
}
$('#logout').onclick = guard(async () => {
  if (formDirty && !confirm('保存していない変更を破棄してログアウトしますか？')) return;
  await api('logout', { method: 'POST', data: {} }); loggedOut();
});
async function signedIn() {
  staff = await api('me'); csrfToken = staff.csrf;
  $('#sharedBar').hidden = false;
  $('#staffName').textContent = `${staff.name}（${roleNames[staff.role]}）`;
  $('#openAdmin').hidden = !canEdit(); $('#openTeam').hidden = !canAdmin();
  $('#exportJson').hidden = !canAdmin(); document.querySelector('label[for="importJson"]').hidden = !canAdmin();
  await loadManuals(); clearForm(); show('homeScreen');
  $('#authForm').reset(); message(manuals.length ? '' : 'マニュアルはまだありません。管理者・編集担当者が登録できます。');
  clearInterval(syncTimer);
  syncTimer = setInterval(guard(syncManuals), 15000);
}
async function syncManuals() {
  if (!staff || document.hidden) return;
  const next = await dbAll();
  manuals = next.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  renderHomeCards(); renderResults(lastQuery); renderAdminList($('#adminSearch').value);
  $('#dbStatus').textContent = `共有：${manuals.length}件`;
  $('#syncState').textContent = `確認 ${new Date().toLocaleTimeString('ja-JP')}`;
  if ($('#detailScreen').classList.contains('active')) {
    const manual = manuals.find(m => m.id === currentDetailId);
    if (manual) openManual(currentDetailId);
    else { show('resultsScreen'); message('表示中のマニュアルは削除されました。'); }
  }
}
window.addEventListener('focus', guard(syncManuals));
let setupMode = false;
$('#authForm').onsubmit = async event => {
  event.preventDefault(); $('#authSubmit').disabled = true; $('#authError').textContent = '';
  try {
    const credentials = { username: $('#loginId').value, password: $('#loginPassword').value };
    if (setupMode) {
      if (credentials.password !== $('#setupConfirm').value) throw new Error('確認用パスワードが一致していません。');
      await api('setup', { method: 'POST', data: { ...credentials, name: $('#setupName').value } });
      setupMode = false; configureAuth(false);
    }
    await api('login', { method: 'POST', data: credentials }); await signedIn();
  } catch (error) { $('#authError').textContent = error.message; }
  finally { $('#authSubmit').disabled = false; }
};
function configureAuth(setup) {
  setupMode = setup;
  $('#authTitle').textContent = setup ? '最初の管理者を登録' : 'ログイン';
  $('#authSubmit').textContent = setup ? '管理者を登録して開始' : 'ログイン';
  $('#setupNameField').hidden = !setup; $('#setupName').required = setup;
  $('#setupConfirmField').hidden = !setup; $('#setupConfirm').required = setup;
  $('#loginPassword').minLength = setup ? 12 : 1;
  $('#loginPassword').autocomplete = setup ? 'new-password' : 'current-password';
  $('#loginPassword').previousElementSibling.textContent = setup ? 'パスワード（12文字以上）' : 'パスワード';
}
(async () => {
  show('loginScreen');
  try {
    const status = await api('status'); configureAuth(!status.initialized);
    if (!status.initialized && !status.localSetup) { $('#authForm').hidden = true; $('#authTitle').textContent = 'サーバーPCで最初の管理者を登録してください。'; return; }
    if (status.initialized) {
      try { await signedIn(); } catch (error) { if (error.status !== 401) throw error; }
    }
  } catch (error) { $('#authError').textContent = error.message; }
})();
