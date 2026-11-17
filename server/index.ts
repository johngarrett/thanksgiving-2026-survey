import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase, readForm } from './database';

interface Config { databasePath: string; adminPassword: string; publicOrigin: string; adminOrigin: string; secureCookies: boolean }
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) return fail(400, `${field} must contain 1–${max} characters.`);
  return value.trim();
}
function recipe(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const url = text(value, 'Recipe URL', 2048);
  try { if (['https:', 'http:'].includes(new URL(url).protocol)) return url; } catch {}
  return fail(400, 'Recipe URL must start with http:// or https://.');
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function createApp(config: Config) {
  if (!config.adminPassword) throw new Error('ADMIN_PASSWORD is required.');
  for (const origin of [config.publicOrigin, config.adminOrigin]) {
    if (new URL(origin).origin !== origin) throw new Error('Origins must include scheme and host, without a path or trailing slash.');
  }
  const db = openDatabase(config.databasePath);
  // Password changes invalidate existing sessions, including after a restart.
  const sessionHash = (token: string) => hash(`${config.adminPassword}\0${token}`);
  const app = express();
  app.disable('x-powered-by');
  const cookieName = config.secureCookies ? '__Host-thanksgiving_admin' : 'thanksgiving_admin';
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'strict' as const, path: '/' };
  const allowedOrigins = new Set([config.publicOrigin, config.adminOrigin]);
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.vary('Origin');
    const origin = req.get('Origin');
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: 'Origin is not allowed.' });
    if (origin && origin === config.publicOrigin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (!['GET', 'HEAD'].includes(req.method)) {
      const adminRequest = req.path.startsWith('/admin');
      if (!origin || (adminRequest && origin !== config.adminOrigin)) return res.status(403).json({ error: 'A valid request origin is required.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'Use application/json.' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/form', (_req, res) => res.json(readForm(db)));
  app.post('/api/claims', (req, res) => {
    const name = text(req.body?.name, 'Name', 100);
    const selections = req.body?.selections;
    const custom = req.body?.custom ?? [];
    if (!Array.isArray(selections) || !Array.isArray(custom) || selections.length + custom.length < 1 || selections.length + custom.length > 100) fail(400, 'Select 1–100 options.');
    const chosen = selections.map((item: any) => ({ id: text(item?.optionId, 'Option ID'), url: recipe(item?.recipeUrl) }));
    const added = custom.map((item: any) => ({ sectionId: text(item?.sectionId, 'Section ID'), label: text(item?.label, 'Custom option'), url: recipe(item?.recipeUrl) }));
    if (new Set(chosen.map((item: { id: string }) => item.id)).size !== chosen.length) fail(400, 'Duplicate selections are not allowed.');
    db.transaction(() => {
      for (const item of chosen) {
        if (!db.query('SELECT id FROM options WHERE id = ?').get(item.id) || db.query('SELECT option_id FROM claims WHERE option_id = ?').get(item.id)) fail(409, 'Some selections are no longer available. Review the refreshed form.');
      }
      for (const item of added) {
        if (!db.query('SELECT id FROM sections WHERE id = ?').get(item.sectionId)) fail(409, 'A section was removed. Review the refreshed form.');
      }
      for (const item of chosen) db.query('INSERT INTO claims VALUES (?, ?, ?)').run(item.id, name, item.url);
      for (const item of added) {
        const id = crypto.randomUUID();
        db.query('INSERT INTO options VALUES (?, ?, ?, (SELECT COALESCE(MAX(display_order), -1) + 1 FROM options WHERE section_id = ?))').run(id, item.sectionId, item.label, item.sectionId);
        db.query('INSERT INTO claims VALUES (?, ?, ?)').run(id, name, item.url);
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
    db.query('INSERT INTO sections VALUES (?, ?, (SELECT COALESCE(MAX(display_order), -1) + 1 FROM sections))').run(crypto.randomUUID(), text(req.body?.title, 'Section title'));
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
    const name = text(req.body?.name, 'Name', 100), url = recipe(req.body?.recipeUrl);
    db.transaction(() => {
      const id = req.params.id as string;
      if (!db.query('SELECT id FROM options WHERE id = ?').get(id)) fail(404, 'Option no longer exists.');
      if (db.query('SELECT option_id FROM claims WHERE option_id = ?').get(id)) fail(409, 'This option is already claimed. Clear it before assigning a new name.');
      db.query('INSERT INTO claims VALUES (?, ?, ?)').run(id, name, url);
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
      ids.forEach((id, i) => statement.run(i, id));
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
    publicOrigin: process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:5173',
    adminOrigin: process.env.ADMIN_ORIGIN || 'http://127.0.0.1:5174',
    secureCookies: process.env.COOKIE_SECURE !== 'false',
  });
  app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Thanksgiving server: http://${process.env.HOST || '127.0.0.1'}:${port}`));
}
