import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase, readForm } from './database';

interface Config { databasePath: string; adminPassword: string; adminOrigin: string; secureCookies: boolean }
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) return fail(400, `${field} must contain 1–${max} characters.`);
  return value.trim();
}
function notes(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return text(value, 'Notes', 2048);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function ownerHash(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail(400, 'Invalid owner ID.');
  return hash(value as string);
}

export function createApp(config: Config) {
  if (!config.adminPassword) throw new Error('ADMIN_PASSWORD is required.');
  for (const origin of [config.adminOrigin]) {
    if (new URL(origin).origin !== origin) throw new Error('Origins must include scheme and host, without a path or trailing slash.');
  }
  const db = openDatabase(config.databasePath);
  // Password changes invalidate existing sessions, including after a restart.
  const sessionHash = (token: string) => hash(`${config.adminPassword}\0${token}`);
  const app = express();
  const subscribers = new Set<Response>();
  app.disable('x-powered-by');
  const cookieName = config.secureCookies ? '__Host-thanksgiving_admin' : 'thanksgiving_admin';
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'strict' as const, path: '/' };
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('Origin');
    const adminRequest = req.path === '/admin' || req.path.startsWith('/admin/');
    if (!adminRequest) {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (!['GET', 'HEAD'].includes(req.method)) {
      let sameOrigin = origin === config.adminOrigin;
      if (origin) {
        try { sameOrigin ||= new URL(origin).host === req.get('Host'); } catch {}
      }
      if (adminRequest && !sameOrigin) return res.status(403).json({ error: 'Admin changes must come from this site.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'Use application/json.' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !['/admin/login', '/admin/logout', '/claims/owned'].includes(req.path)) {
      res.once('finish', () => {
        if (res.statusCode >= 400 || !subscribers.size) return;
        const event = `data: ${JSON.stringify(readForm(db))}\n\n`;
        for (const subscriber of subscribers) subscriber.write(event);
      });
    }
    next();
  });
  app.get('/api/form', (_req, res) => res.json(readForm(db)));
  app.post('/api/claims/owned', (req, res) => {
    const owner = ownerHash(req.body?.ownerId);
    res.json(db.query('SELECT option_id AS optionId, is_custom AS custom FROM claim_owners WHERE owner_hash = ?').all(owner));
  });
  app.delete('/api/claims/:id', (req, res) => {
    const owner = ownerHash(req.body?.ownerId);
    const id = req.params.id as string;
    db.transaction(() => {
      const claim = db.query('SELECT is_custom FROM claim_owners WHERE option_id = ? AND owner_hash = ?').get(id, owner) as { is_custom: number } | null;
      if (!claim) fail(403, 'Only your own claims can be deleted.');
      if (claim!.is_custom) db.query('DELETE FROM options WHERE id = ?').run(id);
      else db.query('DELETE FROM claims WHERE option_id = ?').run(id);
    }).immediate();
    res.json(readForm(db));
  });
  app.post('/api/claims', (req, res) => {
    const owner = ownerHash(req.body?.ownerId);
    const name = text(req.body?.name, 'Name', 100);
    const selections = req.body?.selections;
    const custom = req.body?.custom ?? [];
    if (!Array.isArray(selections) || !Array.isArray(custom) || selections.length + custom.length < 1 || selections.length + custom.length > 100) fail(400, 'Select 1–100 options.');
    const chosen = selections.map((item: any) => ({ id: text(item?.optionId, 'Option ID'), notes: notes(item?.notes), label: item?.label === undefined ? undefined : text(item.label, 'Custom title') }));
    const added = custom.map((item: any) => ({ sectionId: text(item?.sectionId, 'Section ID'), label: text(item?.label, 'Custom option'), notes: notes(item?.notes) }));
    if (new Set(chosen.map((item: { id: string }) => item.id)).size !== chosen.length) fail(400, 'Duplicate selections are not allowed.');
    db.transaction(() => {
      for (const item of chosen) {
        const claimed = db.query('SELECT option_id FROM claims WHERE option_id = ?').get(item.id);
        const owned = owner && db.query('SELECT option_id FROM claim_owners WHERE option_id = ? AND owner_hash = ?').get(item.id, owner);
        if (!db.query('SELECT id FROM options WHERE id = ?').get(item.id) || (claimed && !owned)) fail(409, 'Some selections are no longer available. Review the refreshed form.');
        if (item.label !== undefined && (!owner || !db.query('SELECT option_id FROM claim_owners WHERE option_id = ? AND owner_hash = ? AND is_custom = 1').get(item.id, owner))) fail(403, 'Only your custom entries can be renamed.');
      }
      for (const item of added) {
        if (!db.query('SELECT id FROM sections WHERE id = ?').get(item.sectionId)) fail(409, 'A section was removed. Review the refreshed form.');
      }
      for (const item of chosen) {
        db.query('INSERT INTO claims VALUES (?, ?, ?) ON CONFLICT(option_id) DO UPDATE SET guest_name = excluded.guest_name, recipe_url = excluded.recipe_url').run(item.id, name, item.notes);
        if (owner) db.query('INSERT OR IGNORE INTO claim_owners (option_id, owner_hash) VALUES (?, ?)').run(item.id, owner);
        if (item.label !== undefined) db.query('UPDATE options SET label = ? WHERE id = ?').run(item.label, item.id);
      }
      for (const item of added) {
        const id = crypto.randomUUID();
        db.query('INSERT INTO options VALUES (?, ?, ?, (SELECT COALESCE(MAX(display_order), -1) + 1 FROM options WHERE section_id = ?))').run(id, item.sectionId, item.label, item.sectionId);
        db.query('INSERT INTO claims VALUES (?, ?, ?)').run(id, name, item.notes);
        if (owner) db.query('INSERT INTO claim_owners VALUES (?, ?, 1)').run(id, owner);
      }
    }).immediate();
    res.status(201).json(readForm(db));
  });

  const loginAttempts = new Map<string, { count: number; until: number }>();
  app.post('/api/admin/login', (req, res) => {
    const now = Date.now();
    for (const [key, attempt] of loginAttempts) if (attempt.until <= now) loginAttempts.delete(key);
    // With the configured tunnel, CF-Connecting-IP identifies the visitor. Do not expose the port publicly.
    const address = req.get('CF-Connecting-IP') || req.socket.remoteAddress || 'unknown';
    const attempt = loginAttempts.get(address) || { count: 0, until: now + 15 * 60_000 };
    if (attempt.count >= 10) { res.set('Retry-After', String(Math.ceil((attempt.until - now) / 1000))); return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' }); }
    if (loginAttempts.size >= 10_000 && !loginAttempts.has(address)) return res.status(429).json({ error: 'Login is busy. Try again later.' });
    attempt.count++;
    loginAttempts.set(address, attempt);
    const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!timingSafeEqual(Buffer.from(hash(supplied), 'hex'), Buffer.from(hash(config.adminPassword), 'hex'))) fail(401, 'Incorrect password.');
    loginAttempts.delete(address);
    db.query('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    const token = randomBytes(32).toString('hex');
    db.query('INSERT INTO sessions VALUES (?, ?)').run(sessionHash(token), now + 7 * 86400_000);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: 7 * 86400_000 }).json({ ok: true });
  });
  app.use('/api/admin', (req, _res, next) => {
    const token = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!token || !db.query('SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sessionHash(token), Date.now())) return next(new HttpError(401, 'Please sign in.'));
    next();
  });
  app.get('/api/admin/session', (_req, res) => res.json({ ok: true }));
  app.get('/api/admin/events', (_req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    subscribers.add(res);
    res.write(`data: ${JSON.stringify(readForm(db))}\n\n`);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25000);
    res.once('close', () => { clearInterval(heartbeat); subscribers.delete(res); });
  });
  app.post('/api/admin/logout', (req, res) => {
    const token = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (token) db.query('DELETE FROM sessions WHERE token_hash = ?').run(sessionHash(token));
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  app.put('/api/admin/title', (req, res) => {
    db.query('UPDATE settings SET title = ? WHERE id = 1').run(text(req.body?.title, 'Title'));
    res.json(readForm(db));
  });
  app.post('/api/admin/sections', (req, res) => {
    db.query('INSERT INTO sections (id, title, display_order) VALUES (?, ?, (SELECT COALESCE(MAX(display_order), -1) + 1 FROM sections))').run(crypto.randomUUID(), text(req.body?.title, 'Section title'));
    res.status(201).json(readForm(db));
  });
  app.put('/api/admin/sections/:id', (req, res) => {
    if (!db.query('UPDATE sections SET title = ? WHERE id = ?').run(text(req.body?.title, 'Section title'), req.params.id as string).changes) fail(404, 'Section no longer exists.');
    res.json(readForm(db));
  });
  app.delete('/api/admin/sections/:id', (req, res) => {
    if (!db.query('DELETE FROM sections WHERE id = ?').run(req.params.id as string).changes) fail(404, 'Section no longer exists.');
    res.json(readForm(db));
  });
  app.post('/api/admin/sections/:id/options', (req, res) => {
    const sectionId = req.params.id as string;
    if (!db.query('SELECT id FROM sections WHERE id = ?').get(sectionId)) fail(404, 'Section no longer exists.');
    db.query('INSERT INTO options VALUES (?, ?, ?, (SELECT COALESCE(MAX(display_order), -1) + 1 FROM options WHERE section_id = ?))').run(crypto.randomUUID(), sectionId, text(req.body?.label, 'Option label'), sectionId);
    res.status(201).json(readForm(db));
  });
  app.put('/api/admin/options/:id', (req, res) => {
    if (!db.query('UPDATE options SET label = ? WHERE id = ?').run(text(req.body?.label, 'Option label'), req.params.id as string).changes) fail(404, 'Option no longer exists.');
    res.json(readForm(db));
  });
  app.delete('/api/admin/options/:id', (req, res) => {
    if (!db.query('DELETE FROM options WHERE id = ?').run(req.params.id as string).changes) fail(404, 'Option no longer exists.');
    res.json(readForm(db));
  });
  app.post('/api/admin/options/:id/claim', (req, res) => {
    const name = text(req.body?.name, 'Name', 100), note = notes(req.body?.notes);
    db.transaction(() => {
      const id = req.params.id as string;
      if (!db.query('SELECT id FROM options WHERE id = ?').get(id)) fail(404, 'Option no longer exists.');
      if (db.query('SELECT option_id FROM claims WHERE option_id = ?').get(id)) fail(409, 'This option is already claimed. Clear it before assigning a new name.');
      db.query('INSERT INTO claims VALUES (?, ?, ?)').run(id, name, note);
    }).immediate();
    res.json(readForm(db));
  });
  app.delete('/api/admin/options/:id/claim', (req, res) => {
    if (!db.query('SELECT id FROM options WHERE id = ?').get(req.params.id as string)) fail(404, 'Option no longer exists.');
    db.query('DELETE FROM claims WHERE option_id = ?').run(req.params.id as string);
    res.json(readForm(db));
  });
  app.put('/api/admin/order', (req, res) => {
    const sectionId = req.body?.sectionId;
    const ids = req.body?.ids;
    if (sectionId !== undefined && typeof sectionId !== 'string') fail(400, 'Invalid section ID.');
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) fail(400, 'Provide an ordered list of IDs.');
    db.transaction(() => {
      if (sectionId !== undefined && !db.query('SELECT id FROM sections WHERE id = ?').get(sectionId)) fail(409, 'Section no longer exists.');
      const current = (sectionId === undefined ? db.query('SELECT id FROM sections').all() : db.query('SELECT id FROM options WHERE section_id = ?').all(sectionId)) as { id: string }[];
      if (ids.length !== current.length || new Set(ids).size !== ids.length || current.some(row => !ids.includes(row.id))) fail(409, 'The list changed. Refresh before reordering.');
      const statement = db.query(sectionId === undefined ? 'UPDATE sections SET display_order = ? WHERE id = ?' : 'UPDATE options SET display_order = ? WHERE id = ?');
      ids.forEach((id: string, i: number) => statement.run(i, id));
    }).immediate();
    res.json(readForm(db));
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  app.use('/admin', express.static(resolve('dist/admin')));
  app.get('/', (_req, res) => res.redirect('/admin/'));
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof HttpError ? error.status : error.status === 400 || error.status === 413 ? error.status : 500;
    if (status === 500) console.error(error);
    res.status(status).json({ error: status === 500 ? 'Unable to complete the request. Please try again.' : error.message });
  });
  return { app, db };
}

if (import.meta.main) {
  const port = Number(process.env.PORT || 3000);
  const { app } = createApp({
    databasePath: process.env.DATABASE_PATH || 'data/thanksgiving.sqlite',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    adminOrigin: process.env.ADMIN_ORIGIN || 'http://127.0.0.1:5174',
    secureCookies: process.env.COOKIE_SECURE !== 'false',
  });
  app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Thanksgiving server: http://${process.env.HOST || '127.0.0.1'}:${port}`));
}
