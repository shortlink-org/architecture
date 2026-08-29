# shortlink architecture

Architecture catalog for [shortlink](https://github.com/shortlink-org), built with
[EventCatalog](https://www.eventcatalog.dev/).

📖 **https://shortlink-org.github.io/architecture**

The catalog documents shortlink's bounded contexts — the domains, systems, services, containers, entities, flows and
architecture decisions that make up the platform.

The prose is written here, not generated: it condenses and cross-links what the source repositories say. What *is*
derived from upstream is checked automatically, so the catalog cannot drift out of step in silence — see
[Staying in step with upstream](#staying-in-step-with-upstream).

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
npm run check:adrs     # verify the generated decision records match upstream — runs in CI
npm run sync:adrs      # regenerate them from upstream
```

> [!NOTE]
> After deleting or renaming resources, clear the Astro content cache before rebuilding, otherwise the build fails
> on stale references:
>
> ```sh
> rm -rf node_modules/.astro .eventcatalog-core/.astro dist && npm run build
> ```

## Staying in step with upstream

Two things in this catalog are derived from the source repositories, and each has a check that runs
nightly and on pull requests that touch it.

**Schemas.** The protobuf and OpenAPI files under each service are copies of upstream contracts.
`scripts/sync-schemas.mjs` re-derives them and fails when a copy no longer matches.

**Decision records.** Decisions belong to the repositories that make them. Every
`adrs/**/index.mdx` in this catalog is *generated* from the upstream markdown by
`scripts/sync-adrs.mjs` — nothing about a decision is written or reworded here, and editing one of
those files by hand will be undone on the next run.

`adrs.overlay.yaml` is the single hand-maintained input. It holds only what upstream cannot: where
a decision belongs in the catalog, and how it ties to the resources the catalog documents.

```yaml
adr-platform-0042-link-privacy-control:
  source: shortlink-org/shortlink:docs/ADR/decisions/0042-link-privacy-control.md
  location: adrs
  owners: [platform]
  appliesTo:
    - { type: service, id: LinkService }
```

The generated frontmatter comes from upstream: the title, the `## Status` section, the `Date:`
line, and the opening sentence of `## Context` as the summary. The body is the decision text
verbatim, minus those parts, with relative links and images rewritten to point back at the
repository they resolve in.

Because the output is fully derived there is no hash to keep — `--check` regenerates and compares
the files themselves, and reports:

| | |
|---|---|
| `OUTDATED` | the file on disk no longer matches upstream — `sync:adrs` rewrites it |
| `MISSING` | an upstream decision with no overlay entry — `sync:adrs` adopts it |
| `ORPHAN` | a file with no overlay entry behind it |
| `GONE` | the upstream file was moved or deleted |
| `UNDATED` | upstream carries no date and the overlay supplies no fallback |
| `unmapped` | a decision in a directory this catalog has never drawn from — reported only, does not fail |

A decision made in this repository rather than adopted from upstream declares that instead of a
source, and is left alone by the generator:

```yaml
adr-platform-0043-likec4-for-c4-diagrams:
  origin: catalog
  location: adrs
```

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
