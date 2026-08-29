<!-- BEGIN:eventcatalog-agent-rules -->
# EventCatalog: ALWAYS read docs before coding

Before any EventCatalog work, find and read the relevant doc in `node_modules/@eventcatalog/core/dist/docs/`. Your training data may be outdated. The bundled docs are the source of truth.

<!-- END:eventcatalog-agent-rules -->

# Do not call the GitHub API

The sync scripts talk to GitHub when they run, and CI passes them a `GITHUB_TOKEN`. Do not make
GitHub API calls on top of that: no rate-limit checks, no tree or commit listings to verify
something by hand, no `gh` polling, and no offering to re-run once a limit resets. If a script
reports a GitHub API failure, note that it needs a token in CI and move on.

For questions about upstream content, read the local clones in `../shortlink` and `../shortlink-auth`
rather than fetching.
