# shortlink architecture

Architecture catalog for [shortlink](https://github.com/shortlink-org), built with
[EventCatalog](https://www.eventcatalog.dev/).

📖 **https://shortlink-org.github.io/architecture**

The catalog documents shortlink's bounded contexts — the domains, systems, services, containers, entities, flows and
architecture decisions that make up the platform — and is generated from the source repositories rather than
maintained by hand as prose.

## Boundaries

| Boundary | Status | Source |
|----------|--------|--------|
| Auth | documented | [shortlink-org/auth](https://github.com/shortlink-org/auth) |
| Link | documented | [shortlink-org/shortlink](https://github.com/shortlink-org/shortlink) `boundaries/link`, `bff`, `proxy`, `metadata` |
| API | not yet | [shortlink-org/shortlink](https://github.com/shortlink-org/shortlink) `boundaries/api` |
| UI | not yet | [shortlink-org/shortlink](https://github.com/shortlink-org/shortlink) `boundaries/ui` |

## Local development

```sh
npm install
npm run dev      # http://localhost:3000
npm run lint     # catalog linter — runs in CI
npm run build    # static site into dist/
```

> [!NOTE]
> After deleting or renaming resources, clear the Astro content cache before rebuilding, otherwise the build fails
> on stale references:
>
> ```sh
> rm -rf node_modules/.astro .eventcatalog-core/.astro dist && npm run build
> ```

## Layout

```
domains/<Domain>/
  index.mdx                 domain definition
  ubiquitous-language.mdx   DDD glossary for the bounded context
  entities/                 aggregates and domain objects
  flows/                    business / request flows
  adrs/                     architecture decision records
  systems/<system>/
    index.mdx               system definition, actors, relationships
    services/               deployables
    containers/             databases and stores
systems/                    external / third-party systems
teams/                      ownership
```

## Deployment

Pushing to `main` builds the catalog and publishes it to GitHub Pages
(`.github/workflows/deploy.yml`). Pull requests run lint and build only (`.github/workflows/ci.yml`).

The site is served from `/architecture`, set as `base` in `eventcatalog.config.js` — if a custom domain is attached
later, set `base` back to `'/'`.
