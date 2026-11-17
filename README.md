# Thanksgiving signup

A GitHub Pages signup form, with a Bun/Express server and admin portal backed by SQLite. The public site reads live JSON from the server; no signup data or passwords are published to GitHub.

## Local development

Requires Bun 1.3.8 or later.

```sh
bun install
cp .env.example .env
# Edit .env and choose ADMIN_PASSWORD.
bun run dev
```

One command initializes the database, seeds the original ten choices on first run, and starts all three processes. It prints:

- Public signup: `http://127.0.0.1:5173`
- Admin portal: `http://127.0.0.1:5174/admin/`
- Backend JSON: `http://127.0.0.1:3000/api/form`

Set `PUBLIC_PORT`, `ADMIN_PORT`, and `PORT` in `.env` to change those ports. Both Vite servers listen on the network: from another device, use `http://<your-computer-IP>:5173` or `http://<your-computer-IP>:5174/admin/`. Vite prints the network URLs at startup. The backend stays on loopback; Vite's API proxies supply the local origins expected by the backend. Development uses non-secure HTTP cookies, so use a trusted network. Production values in `.env` do not affect that setup. Ctrl-C stops all three processes.

SQLite lives at `DATABASE_PATH` (default `data/thanksgiving.sqlite`). Keep `.env` and `data/` out of Git. Deleting all sections does not reseed the database on restart.

## Signup behavior

Guests may select multiple options and type one custom choice per section. Custom choices become regular options visible to everyone, already claimed by their creator. Checking a standard option reveals an optional recipe URL; typing a custom choice reveals its recipe URL field. Empty custom fields are ignored. Recipe URLs allow only HTTP/HTTPS and are never fetched by the server.

Submit opens the name modal. Every selected and custom option saves in one SQLite transaction. If anything is unavailable, the entire save fails and the form refreshes while retaining the guest's name and remaining valid choices. The database's unique claim constraint prevents double bookings. Availability refreshes on load, tab return, and successful save. It is not continuously updated.

Only admins can clear or assign claims. Clearing a custom entry's claim leaves that option available for someone else. Delete the option to remove it entirely. Names and recipe links are public.

If a connection drops during saving, the request may already have succeeded. Reload and check your claims before trying again, particularly custom entries.

## Admin

Sign in with `ADMIN_PASSWORD` from the server's `.env`; no username is needed. The server stores hashed random session tokens in SQLite. Sessions last seven days. Changing `ADMIN_PASSWORD` and restarting invalidates existing logins.

The admin editor supports page/section/option text, adding/removing sections and options, assigning/clearing claims, and pointer or keyboard reordering. Drag the handle or use Move up/down, then **Save order**. Options move within their section. Text edits have separate Save buttons. Destructive actions show confirmations including affected claims.

## Server deployment

Set these values in the server's `.env`:

```dotenv
ADMIN_PASSWORD=your-own-password
PUBLIC_ORIGIN=https://garrepi.github.io
ADMIN_ORIGIN=https://garrepi.dev
PORT=3000
```

Origins have a scheme and host, without a path or trailing slash. `PUBLIC_ORIGIN` does not contain the GitHub repository path.

```sh
docker compose up -d --build
```

The server binds only to host loopback at `PORT`, with SQLite stored in the `thanksgiving-data` named volume. Point the existing Cloudflare Tunnel at `http://localhost:3000` (or your chosen host port). If `cloudflared` is itself in Docker, connect it to the Compose network and use `http://thanksgiving:3000` instead.

The admin portal is `https://garrepi.dev/admin/`. The public API is `https://garrepi.dev/api/form`. Route both `/admin/` and `/api/` through the tunnel, and avoid caching `/api/*`. The tunnel must preserve `Origin` and cookies. HTTPS is required for production login cookies. The app uses `CF-Connecting-IP` for login rate limiting, so the app's port must remain inaccessible to the public internet.

To rotate the admin password, update `.env` and run `docker compose up -d` to recreate the service. Keep the data volume; `docker compose down -v` destroys it.

## GitHub Pages deployment

In the GitHub repository:

1. Set **Settings → Pages → Source** to **GitHub Actions**.
2. Optionally set the repository Actions variable `VITE_API_URL` to the backend URL. It defaults to `https://garrepi.dev`.
3. Push to `main`, or run **Publish signup to GitHub Pages** manually.

The workflow runs type checks and API tests, builds only `public-site/`, and uploads `dist/public/`. It derives the correct base path for project or user Pages. The server, admin files, `.env`, and database are never uploaded. `VITE_*` variables are public; never put passwords in them.

For a manual build:

```sh
bun run build
```

`dist/public/` is the public site, `dist/admin/` is the admin portal, and `dist/server/` is the server. `bun start` runs the built server; set `ADMIN_ORIGIN` to the actual URL used to access it and `COOKIE_SECURE=false` only for local HTTP testing.

## Checks

```sh
bun run check
bun test tests/api.test.ts
bunx playwright install chromium
bun run test:browser
bun run build
```

If Chrome is already installed, use `PLAYWRIGHT_CHANNEL=chrome bun run test:browser` instead of downloading Chromium. Browser tests start their own three-process development stack on ports 3300, 5373, and 5374 with an in-memory test database, without touching real signup data.

## Backup and restore

The simplest SQLite-safe backup is a stopped-service copy. Do not copy only the main database file while the service is writing; SQLite may have pending WAL data.

```sh
mkdir -p backups
docker compose stop thanksgiving
docker compose cp thanksgiving:/data/. ./backups/thanksgiving-data
docker compose start thanksgiving
```

Store that backup directory privately; it includes guest data and session records. To restore a chosen backup, stop the service, clear the existing volume contents, then copy the complete backup directory back. This overwrites current data, so first preserve a backup of it:

```sh
docker compose stop thanksgiving
docker compose run --rm --user root thanksgiving sh -c 'find /data -mindepth 1 -maxdepth 1 -type f -delete'
docker compose cp ./backups/thanksgiving-data/. thanksgiving:/data/
docker compose run --rm --user root thanksgiving chown -R bun:bun /data
docker compose start thanksgiving
```

Restore all files from the same backup together. Rotate the password after restoring if old sessions should no longer be usable.

The approved design is in [docs/plan.md](docs/plan.md).
