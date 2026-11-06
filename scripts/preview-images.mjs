import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';
import { optimizeImage } from '../image-service.mjs';
import { screenshotFixture, dataImage, imageManual } from './image-fixtures.mjs';

// Local demonstration only. Never use this account or data directory in production.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'test-output', 'image-preview'); mkdirSync(dataDir, { recursive: true });
const port = Number(process.env.PORT || 8897);
const app = createApplication({ dataDir, initialAdmin: { username: 'preview', name: 'ローカル検証', password: 'PreviewImage123' } });
await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${port}`;
if (!app.database.prepare('SELECT id FROM manuals LIMIT 1').get()) {
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'preview', password: 'PreviewImage123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } })).json();
  const headers = { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': me.csrf };
  const image = await optimizeImage(dataImage(await screenshotFixture()));
  const saved = await fetch(`${origin}/api/manuals`, { method: 'PUT', headers, body: JSON.stringify({ ...imageManual, images: [1, 5, 9, 12].map((step, i) => ({ ...image, step, caption: `確認画面 ${i + 1}` })) }) });
  if (!saved.ok) throw new Error('Could not seed local preview.');
  await fetch(`${origin}/api/logout`, { method: 'POST', headers, body: '{}' });
}
console.log(`Local image preview: ${origin}\nLocal-only ID: preview / Password: PreviewImage123`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
