import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index';
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

describe('public signup', () => {
  test('seeds both sections and ten options; JSON includes optional recipe URLs', async () => {
    const data = await form(); expect(data.sections).toHaveLength(2);
    expect(data.sections.flatMap(s => s.options)).toHaveLength(10);
    expect(data.sections[0].options[0].recipeUrl).toBeNull();
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
  test('custom entries and recipes become public together', async () => {
    const section = (await form()).sections[0];
    const response = await request('/claims', 'POST', { name: ' Alex ', selections: [{ optionId: section.options[0].id, recipeUrl: 'https://example.com/mac' }], custom: [{ sectionId: section.id, label: ' Pumpkin pie ', recipeUrl: 'https://example.com/pie' }] });
    expect(response.status).toBe(201);
    const updated = (await form()).sections[0];
    expect(updated.options[0].recipeUrl).toBe('https://example.com/mac');
    expect(updated.options.at(-1)).toMatchObject({ label: 'Pumpkin pie', claimedBy: 'Alex', recipeUrl: 'https://example.com/pie' });
  });
  test('validates name, selections, duplicates, URLs and deleted sections', async () => {
    const section = (await form()).sections[0], selection = { optionId: section.options[0].id };
    for (const body of [
      { name: ' ', selections: [selection] },
      { name: 'Alex', selections: [] },
      { name: 'Alex', selections: [selection, selection] },
      { name: 'Alex', selections: [{ ...selection, recipeUrl: 'javascript:alert(1)' }] },
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
    await request(`/admin/options/${pie.id}/claim`, 'POST', { name: 'Alex', recipeUrl: 'https://example.com' }, true);
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
