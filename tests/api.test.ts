import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index';
import { Database } from 'bun:sqlite';
import { openDatabase, readForm } from '../server/database';
import type { SignupForm } from '../shared/types';

const publicOrigin = 'https://garrepi.github.io', adminOrigin = 'https://garrepi.dev';
let server: Server, base: string, db: ReturnType<typeof openDatabase>;
let cookie: string;
async function request(path: string, method = 'GET', body?: unknown, admin = false, origin = admin ? adminOrigin : publicOrigin) {
  return fetch(`${base}/api${path}`, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(admin && cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function form(): Promise<SignupForm> { return (await request('/form')).json(); }
async function login() {
  const response = await request('/admin/login', 'POST', { password: 'test-password' }, true);
  expect(response.status).toBe(200);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  return response;
}
beforeEach(async () => {
  const created = createApp({ databasePath: ':memory:', adminPassword: 'test-password', adminOrigin, secureCookies: true });
  db = created.db; cookie = '';
  server = created.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });

test('authenticated admin events push public claims without polling', async () => {
  expect((await request('/admin/events')).status).toBe(401);
  await login();
  const controller = new AbortController();
  const response = await fetch(`${base}/api/admin/events`, { headers: { Cookie: cookie }, signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const nextForm = async () => {
    let event = '';
    while (!event.includes('\n\n')) event += decoder.decode((await reader.read()).value, { stream: true });
    return JSON.parse(event.slice(6).trim()) as SignupForm;
  };
  try {
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const initial = await nextForm();
    const option = initial.sections[0].options[0];
    expect((await request('/claims', 'POST', { name: 'Live guest', selections: [{ optionId: option.id }] })).status).toBe(201);
    const updated = await nextForm();
    expect(updated.sections[0].options[0].claimedBy).toBe('Live guest');
  } finally { controller.abort(); await reader.cancel().catch(() => {}); }
});

describe('public signup', () => {
  test('only the stored owner ID can edit notes and rename owned custom entries', async () => {
    const ownerId = crypto.randomUUID(), stranger = crypto.randomUUID();
    const section = (await form()).sections[0];
    const preset = section.options[0];
    const response = await request('/claims', 'POST', { ownerId, name: 'Alex', selections: [{ optionId: preset.id, notes: 'Original' }], custom: [{ sectionId: section.id, label: 'Pie', notes: 'Apple' }] });
    expect(response.status).toBe(201);
    const custom = ((await response.json()) as SignupForm).sections[0].options.at(-1)!;
    expect(await (await request('/claims/owned', 'POST', { ownerId })).json()).toEqual([{ optionId: preset.id, custom: 0 }, { optionId: custom.id, custom: 1 }]);
    expect(await (await request('/claims/owned', 'POST', { ownerId: stranger })).json()).toEqual([]);
    for (const id of [undefined, stranger]) {
      expect((await request('/claims', 'POST', { ownerId: id, name: 'Alex', selections: [{ optionId: preset.id, notes: 'Stolen' }] })).status).toBe(409);
    }
    expect((await request('/claims', 'POST', { ownerId, name: 'Alex', selections: [{ optionId: preset.id, label: 'Rename preset', notes: 'No' }] })).status).toBe(403);
    expect((await request('/claims', 'POST', { ownerId, name: 'Alex', selections: [{ optionId: preset.id, notes: 'Updated' }, { optionId: custom.id, label: 'Pumpkin pie', notes: '' }] })).status).toBe(201);
    const updated = (await form()).sections[0];
    expect(updated.options[0].notes).toBe('Updated');
    expect(updated.options.at(-1)).toMatchObject({ id: custom.id, label: 'Pumpkin pie', notes: null });
    expect(updated.options).toHaveLength(section.options.length + 1);
    expect(JSON.stringify(await form())).not.toContain(ownerId);
    expect((await request(`/claims/${custom.id}`, 'DELETE', { ownerId: stranger })).status).toBe(403);
    expect((await request(`/claims/${custom.id}`, 'DELETE', { ownerId })).status).toBe(200);
    expect((await form()).sections[0].options.some(option => option.id === custom.id)).toBe(false);
    expect((await request(`/claims/${preset.id}`, 'DELETE', { ownerId })).status).toBe(200);
    expect((await form()).sections[0].options[0]).toMatchObject({ id: preset.id, claimedBy: null, notes: null });
    expect(db.query('SELECT * FROM claim_owners WHERE option_id = ?').get(preset.id)).toBeNull();
    await request('/claims', 'POST', { ownerId, name: 'Alex', selections: [{ optionId: preset.id }] });
    await login();
    await request(`/admin/options/${preset.id}/claim`, 'DELETE', {}, true);
    expect(db.query('SELECT * FROM claim_owners WHERE option_id = ?').get(preset.id)).toBeNull();
  });
  test('seeds both sections and ten options; JSON includes optional notes', async () => {
    const data = await form(); expect(data.sections).toHaveLength(2);
    expect(data.sections.flatMap(s => s.options)).toHaveLength(10);
    expect(data.sections[0].options[0].notes).toBeNull();
  });
  test('only one concurrent claim wins', async () => {
    const id = (await form()).sections[0].options[0].id;
    const results = await Promise.all(['Alex', 'Jordan'].map(name => request('/claims', 'POST', { name, selections: [{ optionId: id }] })));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect((await form()).sections[0].options[0].claimedBy).not.toBeNull();
  });
  test('conflicts roll back all selections and custom additions', async () => {
    const section = (await form()).sections[0]; const [first, second] = section.options;
    await request('/claims', 'POST', { name: 'Alex', selections: [{ optionId: first.id }] });
    const response = await request('/claims', 'POST', { name: 'Jordan', selections: [{ optionId: second.id }, { optionId: first.id }], custom: [{ sectionId: section.id, label: 'Pie' }] });
    expect(response.status).toBe(409);
    const updated = (await form()).sections[0];
    expect(updated.options).toHaveLength(5); expect(updated.options[1].claimedBy).toBeNull();
  });
  test('custom entries and notes become public together', async () => {
    const section = (await form()).sections[0];
    const response = await request('/claims', 'POST', { name: ' Alex ', selections: [{ optionId: section.options[0].id, notes: 'No nuts, please' }], custom: [{ sectionId: section.id, label: ' Pumpkin pie ', notes: 'https://example.com/pie' }] });
    expect(response.status).toBe(201);
    const updated = (await form()).sections[0];
    expect(updated.options[0].notes).toBe('No nuts, please');
    expect(updated.options.at(-1)).toMatchObject({ label: 'Pumpkin pie', claimedBy: 'Alex', notes: 'https://example.com/pie' });
  });
  test('validates name, selections, duplicates, notes and deleted sections', async () => {
    const section = (await form()).sections[0], selection = { optionId: section.options[0].id };
    for (const body of [
      { name: ' ', selections: [selection] },
      { name: 'Alex', selections: [] },
      { name: 'Alex', selections: [selection, selection] },
      { name: 'Alex', selections: [{ ...selection, notes: 42 }] },
      { name: 'Alex', selections: [null] },
    ]) expect((await request('/claims', 'POST', body)).status).toBe(400);
    expect((await request('/claims', 'POST', { name: 'Alex', selections: [selection], custom: [{ sectionId: 'deleted', label: 'Pie' }] })).status).toBe(409);
    expect((await form()).sections[0].options[0].claimedBy).toBeNull();
  });
  test('CORS permits any public origin and preflights, and disables caching', async () => {
    const response = await request('/form');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const preflight = await fetch(`${base}/api/claims`, { method: 'OPTIONS', headers: { Origin: publicOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-headers')).toBe('Content-Type');
    expect((await request('/form', 'GET', undefined, false, 'https://other.example')).status).toBe(200);
    const id = (await form()).sections[0].options[0].id;
    expect((await request('/claims', 'POST', { name: 'Alex', selections: [{ optionId: id }] }, false, 'https://other.example')).status).toBe(201);
    expect((await fetch(`${base}/api/claims`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
  });
});

describe('admin', () => {
  test('protects routes, checks origins, sets secure cookies, and invalidates logout', async () => {
    expect((await request('/admin/session', 'GET', undefined, true)).status).toBe(401);
    expect((await request('/admin/login', 'POST', { password: 'wrong' }, true)).status).toBe(401);
    expect((await request('/admin/login', 'POST', { password: 'test-password' })).status).toBe(403);
    const response = await login();
    const header = response.headers.get('set-cookie')!;
    expect(header).toContain('HttpOnly'); expect(header).toContain('Secure'); expect(header).toContain('SameSite=Strict');
    expect((await request('/admin/session', 'GET', undefined, true)).status).toBe(200);
    expect((await request('/admin/title', 'PUT', { title: 'No' }, true, publicOrigin)).status).toBe(403);
    await request('/admin/logout', 'POST', {}, true);
    expect((await request('/admin/session', 'GET', undefined, true)).status).toBe(401);
  });
  test('accepts admin login from the actual host used to visit the portal', async () => {
    const response = await request('/admin/login', 'POST', { password: 'test-password' }, true, base);
    expect(response.status).toBe(200);
  });
  test('limits failed logins', async () => {
    for (let i = 0; i < 10; i++) expect((await request('/admin/login', 'POST', { password: 'bad' }, true)).status).toBe(401);
    expect((await request('/admin/login', 'POST', { password: 'test-password' }, true)).status).toBe(429);
  });
  test('adds, edits, reorders, assigns, clears, and deletes with cascading claims', async () => {
    await login();
    expect((await request('/admin/title', 'PUT', { title: 'Dinner' }, true)).status).toBe(200);
    await request('/admin/sections', 'POST', { title: 'Desserts' }, true);
    let data = await form(); const dessert = data.sections.at(-1)!;
    await request(`/admin/sections/${dessert.id}/options`, 'POST', { label: 'Pie' }, true);
    data = await form(); const pie = data.sections.at(-1)!.options[0];
    await request(`/admin/options/${pie.id}/claim`, 'POST', { name: 'Alex', notes: 'https://example.com' }, true);
    expect((await request(`/admin/options/${pie.id}/claim`, 'POST', { name: 'Jordan' }, true)).status).toBe(409);
    await request(`/admin/options/${pie.id}`, 'PUT', { label: 'Apple pie' }, true);
    expect((await form()).sections.at(-1)!.options[0]).toMatchObject({ label: 'Apple pie', claimedBy: 'Alex' });
    await request(`/admin/options/${pie.id}/claim`, 'DELETE', {}, true);
    expect((await form()).sections.at(-1)!.options[0].claimedBy).toBeNull();
    await request(`/admin/options/${pie.id}/claim`, 'POST', { name: 'Jordan' }, true);
    const ids = data.sections.map(s => s.id).reverse();
    expect((await request('/admin/order', 'PUT', { ids }, true)).status).toBe(200);
    expect((await form()).sections.map(s => s.id)).toEqual(ids);
    expect((await request('/admin/order', 'PUT', { ids: [ids[0], ids[0], ids[1]] }, true)).status).toBe(409);
    const options = data.sections[0].options.map(o => o.id).reverse();
    await request('/admin/order', 'PUT', { sectionId: data.sections[0].id, ids: options }, true);
    expect((await form()).sections.find(s => s.id === data.sections[0].id)!.options.map(o => o.id)).toEqual(options);
    await request(`/admin/sections/${dessert.id}`, 'PUT', { title: 'Sweets' }, true);
    await request(`/admin/sections/${dessert.id}`, 'DELETE', {}, true);
    expect(db.query('SELECT * FROM claims WHERE option_id = ?').get(pie.id)).toBeNull();
    expect((await form()).title).toBe('Dinner');
    const id = (await form()).sections[0].options[0].id;
    await request(`/admin/options/${id}/claim`, 'POST', { name: 'Alex' }, true);
    await request(`/admin/options/${id}`, 'DELETE', {}, true);
    expect(db.query('SELECT * FROM claims WHERE option_id = ?').get(id)).toBeNull();
  });
});

test('database data and sessions survive reopening without reseeding', () => {
  const folder = mkdtempSync(join(tmpdir(), 'thanksgiving-'));
  try {
    const path = join(folder, 'test.sqlite');
    let disk = openDatabase(path); const data = readForm(disk);
    disk.query('INSERT INTO claims VALUES (?, ?, ?)').run(data.sections[0].options[0].id, 'Alex', 'https://example.com');
    disk.query('INSERT INTO sessions VALUES (?, ?)').run('token', Date.now() + 10000);
    disk.close(); disk = openDatabase(path);
    expect(readForm(disk).sections[0].options[0].claimedBy).toBe('Alex');
    expect(readForm(disk).sections).toHaveLength(2);
    expect(disk.query('SELECT token_hash FROM sessions').all()).toHaveLength(1);
    disk.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('older ownership tables gain is_custom without losing claims or owner IDs', () => {
  const folder = mkdtempSync(join(tmpdir(), 'thanksgiving-'));
  try {
    const path = join(folder, 'test.sqlite');
    let disk = openDatabase(path);
    const id = readForm(disk).sections[0].options[0].id;
    disk.query('INSERT INTO claims VALUES (?, ?, ?)').run(id, 'Alex', 'Saved note');
    disk.exec('ALTER TABLE claim_owners DROP COLUMN is_custom');
    disk.query('INSERT INTO claim_owners VALUES (?, ?)').run(id, 'saved-owner-hash');
    disk.close();
    for (let i = 0; i < 2; i++) {
      disk = openDatabase(path);
      expect(disk.query('SELECT * FROM claim_owners WHERE option_id = ?').get(id)).toEqual({ option_id: id, owner_hash: 'saved-owner-hash', is_custom: 0 });
      expect(readForm(disk).sections[0].options[0]).toMatchObject({ claimedBy: 'Alex', notes: 'Saved note' });
      disk.close();
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('section prompts survive migration, renaming, and reordering by ID', () => {
  const folder = mkdtempSync(join(tmpdir(), 'thanksgiving-'));
  try {
    const path = join(folder, 'test.sqlite');
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE sections (id TEXT PRIMARY KEY, title TEXT NOT NULL, display_order INTEGER NOT NULL);
      INSERT INTO sections VALUES ('food', 'Food', 0), ('tasks', 'Helping out', 1);`);
    legacy.close();
    let disk = openDatabase(path);
    disk.query('UPDATE sections SET title = ?, display_order = ? WHERE id = ?').run('Anything', -1, 'tasks');
    disk.close();
    disk = openDatabase(path);
    expect(readForm(disk).sections.find(section => section.id === 'tasks')?.customPlaceholder).toBe('What will u do?');
    expect(readForm(disk).sections.find(section => section.id === 'food')?.customPlaceholder).toBe('What will u cook?');
    disk.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
