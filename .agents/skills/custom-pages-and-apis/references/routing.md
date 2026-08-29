# Routing Reference

How files in the catalog's `pages/` folder map to URLs.

## The prefix

All custom pages are served under a URL prefix so they can never collide with EventCatalog's own routes. Configure it in `eventcatalog.config.js`:

```js
export default {
  // ...
  pages: {
    prefix: 'custom', // default — pages/reports.astro → /custom/reports
  },
};
```

Rules (validated at startup, invalid values throw a config error):

- Defaults to `custom` when omitted.
- May contain letters, numbers, `-` and `_`, optionally separated by `/` (e.g. `internal/tools` is valid → pages served at `/internal/tools/...`).
- Cannot be empty.
- The first segment cannot be one of the reserved core routes: `api`, `api-catalog`, `architecture`, `auth`, `diagrams`, `directory`, `discover`, `docs`, `icepanel`, `miro`, `rss`, `schemas`, `settings`, `studio`, `unauthorized`, `visualiser`, `.well-known`.

## File-to-URL mapping

Given the default prefix `custom`:

| File in `pages/` | URL | Type |
|---|---|---|
| `reports.astro` | `/custom/reports` | page |
| `reports/index.astro` | `/custom/reports` | page (index collapses to parent) |
| `reports/[id].astro` | `/custom/reports/:id` | dynamic page |
| `docs/[...slug].astro` | `/custom/docs/*` | rest/catch-all page |
| `api/stats.ts` | `/custom/api/stats` | endpoint |
| `api/teams/[id].ts` | `/custom/api/teams/:id` | dynamic endpoint |
| `homepage.astro` | `/` | special: replaces the catalog homepage (not under the prefix) |
| `_components/Card.astro` | — | never routed (underscore) |
| `reports/_helpers.ts` | — | never routed (underscore) |
| `styles.css`, `logo.png`, `data.json` | — | not routable code files |

Details:

- **Routable extensions**: `.astro` (pages), `.ts` / `.js` / `.mjs` (endpoints). Everything else in `pages/` is ignored for routing.
- **Underscore convention** (same as Astro): any file or directory whose name starts with `_` is never routable. Use it for colocated components, helpers, and shared data (`pages/_components/`, `pages/_lib/`).
- **Dynamic segments** use Astro syntax: `[param]` for one segment, `[...rest]` for catch-all. Access via `Astro.params` in pages or the `params` argument in endpoints.
  - In **static** output mode, dynamic `.astro` pages must export `getStaticPaths()` (standard Astro rule). In `server` mode they render on demand.
- **`homepage.astro`** is special-cased: it does not become `/custom/homepage`. It is rendered as the catalog's landing page at `/`, replacing the default EventCatalog homepage. Everything else about it works the same (toolkit imports, Tailwind, partials).

## Dev-server behavior

- **Adding or deleting** a file in `pages/` is picked up automatically — EventCatalog rewrites an internal routes manifest, which triggers a brief automatic dev-server restart (a few seconds). No manual restart needed.
- **Editing** an existing page hot-reloads instantly via the normal Astro/Vite pipeline.

## Scale gating

Route injection only happens with a valid EventCatalog Scale license. Without one:

- No custom routes are served — every custom page URL returns 404.
- The server logs: `[EventCatalog] Custom pages require the Scale plan. The routes for your pages will not be served.`
- The `pages/` folder is otherwise ignored; nothing breaks.

Users without a Scale key can get a free 30-day trial from [eventcatalog.cloud](https://eventcatalog.cloud/).
