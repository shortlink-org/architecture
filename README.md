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
| Link | documented | [shortlink-org/shortlink](https://github.com/shortlink-org/shortlink) `boundaries/link`, `bff`, `proxy`, `metadata`, `ui` |
| Shop | documented | [shortlink-org/shop](https://github.com/shortlink-org/shop) `admin`, `admin-graphql`, `admin-ui`, `oms`, `oms-graphql`, `pricer`, `bff`, `ui` |
| Delivery | documented | [shortlink-org/shop](https://github.com/shortlink-org/shop) `delivery`, `delivery-graphql`, `courier-emulation`, `support` |
| API | deprecated — not documented | [shortlink-org/shortlink](https://github.com/shortlink-org/shortlink) `boundaries/api` |

> [!NOTE]
> Shop and Delivery are two domains from one repository. They are split because the aggregates, the databases and
> the Temporal namespaces are separate.

## Local development

```sh
npm install
npm run dev            # http://localhost:3000
npm run lint           # catalog linter — runs in CI
npm run build          # static site into dist/
npm run check:schemas  # compare copied schemas with upstream — runs in CI
npm run sync:schemas   # rewrite them from upstream
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
adrs/                       platform-wide decision records
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
systems/                    shared systems — the Istio edge, external identity providers
teams/                      ownership
```

## Decision records

`adrs/` at the catalog root holds the platform-wide decisions from the monorepo's `docs/ADR/decisions` — the ones
that constrain every boundary rather than any single one. Boundary-specific ADRs live next to the resource they
apply to, under `domains/<Domain>/adrs/` or inside a system.

ADR ids are prefixed by source (`adr-platform-*`, `adr-auth-*`, `adr-link-*`, `adr-proxy-*`, `adr-shop-*`,
`adr-admin-*`, `adr-oms-*`, `adr-oms-graphql-*`, `adr-delivery-*`, `adr-delivery-graphql-*`,
`adr-courier-emulation-*`, `adr-support-*`) because the upstream repositories number their ADRs independently and
would otherwise collide.

## Schemas

The `.proto` and OpenAPI files under `domains/` are copies of files that live in the source
repositories. `scripts/sync-schemas.mjs` owns that relationship: it fetches each upstream file, applies the
derivation the catalog needs (extract a single protobuf message, bundle a multi-file OpenAPI document, or copy
verbatim), and either writes the result or fails on a difference.

`.github/workflows/schemas.yml` runs the check daily rather than on every pull request — upstream moving is a reason
to know, not a reason to fail an unrelated PR. When it fails, run `npm run sync:schemas`, read the diff, update the
prose that described the old contract, and commit.

Add a new schema by adding an entry to `FILES` in the script; do not copy files in by hand.

## Deployment

Pushing to `main` builds the catalog and publishes it to GitHub Pages
(`.github/workflows/deploy.yml`). Pull requests run lint and build only (`.github/workflows/ci.yml`).

The site is served from `/architecture`, set as `base` in `eventcatalog.config.js` — if a custom domain is attached
later, set `base` back to `'/'`.
