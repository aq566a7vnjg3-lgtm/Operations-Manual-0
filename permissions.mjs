export const PERMISSIONS = [
  ['read', '閲覧・検索'], ['edit', '追加・編集'], ['delete', '削除'],
  ['restore', '過去の版へ復元'], ['transfer', '資料のバックアップ・復元'],
  ['users', 'アカウント管理'], ['systemBackup', '全体バックアップ']
];
export const ROLE_DEFINITIONS = [
  { id: 'viewer', name: '一般ユーザー', permissions: ['read'] },
  { id: 'editor', name: '編集担当', permissions: ['read', 'edit'] },
  { id: 'manager', name: '資料管理者', permissions: ['read', 'edit', 'delete', 'restore', 'transfer'] },
  { id: 'admin', name: 'システム管理者', permissions: PERMISSIONS.map(([id]) => id) }
];
export const permissionsFor = role => ROLE_DEFINITIONS.find(item => item.id === role)?.permissions || [];
