# Thanksgiving signup sites

## Summary

Build a public signup form hosted on GitHub Pages and a separate admin portal served by a Bun backend through the existing Cloudflare Tunnel. Use TypeScript, Bun, Express, Bun SQLite, and Docker Compose.

Both sites use Georgia titles, Helvetica body text, white backgrounds, native controls, and separate CSS files for later styling. Public sections have no border boxes.

## Public signup

- Display ordered sections and checkbox options. Guests may select multiple options across sections.
- Claimed options are disabled and show the guest's name.
- Submit opens an accessible name-entry modal. Save claims every selected option in one database transaction.
- If any selected option was claimed or deleted meanwhile, save nothing. Refresh availability, explain the conflict, and preserve the name and remaining valid selections.
- Refresh on page load, return to the tab, and successful save. No continuous polling.
- Each section has a visible optional custom-choice textbox; a nonempty description reveals an optional recipe URL field. Custom choices become normal options visible to everyone and are created and claimed in the same transaction.
- Checking a standard option reveals an optional recipe URL field beneath it. Accept HTTP/HTTPS URLs without fetching them.
- Remove routine availability-update messages and the public refresh button; keep error and save messages.
- Guests have no accounts. They can claim additional options later; only admins can change or clear claims.
- Show loading, saving, success, and connection-error states. Confirm saves only after server confirmation.

## Data and API

SQLite tables:

| Table | Fields |
| --- | --- |
| Sections | Stable ID, title, display order |
| Options | Stable ID, section ID, label, display order |
| Claims | Unique option ID, guest name, nullable recipe URL |

Store the editable page title in a single settings record. Renaming preserves IDs and claims. Deleting an option removes its claim; deleting a section removes its options and claims.

- `GET /api/form`: title and ordered sections/options, with `claimedBy` as a name or null and `recipeUrl` as a URL or null.
- `POST /api/claims`: name, selected option IDs with optional recipe URLs, and custom entries with section IDs and labels; validates input and atomically reserves all options, returning a conflict if any is unavailable.
- Admin endpoints: title editing, section/option CRUD and ordering, claim clearing.
- Validate nonempty names and labels with bounded lengths. Render user content as text.
- Keep live form responses uncached. Allow public API requests from any origin without cookies; keep admin mutation origin checks. CORS is not authentication.
- Seed both supplied sections and all ten options, including the kids-crafts note.

## Admin and deployment

- Show sections, options, and claimant names with explicit Save buttons for edits.
- Drag handles reorder sections and options within their section. Include keyboard-accessible move controls.
- Confirm destructive deletions and identify affected claims.
- Sign-in is just a large password box with a Password placeholder and a Sign in button; show editor headings after login.
- One shared admin password in a server-only, Git-ignored `.env`; login, logout, rate limiting, and a seven-day secure HTTP-only session cookie.
- Persist sessions in SQLite. Protect all admin API routes and validate origins for admin mutations. Never include credentials in the public build.
- Docker Compose runs one app instance with persistent database storage. The existing tunnel forwards to its local port.
- GitHub Actions builds and deploys only public assets to GitHub Pages. Configure the backend URL at build time and support repository-subpath hosting.
- `bun run dev` starts and initializes the backend, public frontend, and admin frontend, printing all URLs. Configure server/public/admin ports with `.env`.
- Provide `.env.example` and local development, deployment, password-change, and SQLite-safe backup/restore instructions.

## Verification and limits

Test concurrent claims, transaction rollback, invalid input, persistence, authentication, claim management, ordering, and deletion. Verify core browser flows, modal keyboard behavior, drag/keyboard reordering, error states, and the GitHub Pages build.

Defaults: one Thanksgiving form, publicly visible guest names, no guest cancellation, no cross-section dragging, and no decorative styling.

Skipped: guest accounts, polling, and a separate database service. Home-server uptime and tunnel latency require deployment verification.
