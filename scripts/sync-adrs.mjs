#!/usr/bin/env node
/**
 * Generates this catalog's architecture decision records from the ones in the source repositories.
 *
 *   node scripts/sync-adrs.mjs           regenerate every decision record
 *   node scripts/sync-adrs.mjs --check   fail if any file on disk differs from what upstream says
 *
 * The decisions belong to the repositories that make them. Nothing about a decision is written or
 * reworded here: each `adrs/**\/index.mdx` is derived, in full, from the upstream markdown.
 *
 * `adrs.overlay.yaml` is the one hand-maintained input. It holds only what upstream cannot: where a
 * decision belongs in the catalog, and how it ties to the resources the catalog documents —
 * appliesTo, related, amends, owners, badges. Those point at catalog ids that do not exist in the
 * source repositories, so they cannot live upstream.
 *
 * Because the output is fully derived, there is no hash to keep: `--check` regenerates and compares
 * the file itself. An upstream edit shows up as a diff, not as a stale copy nobody noticed.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OVERLAY = join(ROOT, 'adrs.overlay.yaml');
const CHECK = process.argv.includes('--check');
const DEFAULT_REF = 'main';

/** Directories that never contain catalog resources. */
const SKIP = new Set(['node_modules', 'dist', '.git', '.astro', '.eventcatalog-core', 'public']);

/** Files in an upstream ADR directory that are not themselves decisions. */
const NOT_A_DECISION = /^(readme|template|index)\b/i;

/** Any `docs/ADR/decisions/*.md`, at a repository root or under a boundary. */
const DECISION_PATH = /(?:^|\/)docs\/ADR\/decisions\/([^/]+\.md)$/;

/** Overlay fields that are copied into the generated frontmatter as-is. */
const CARRIED = [
  'owners',
  'decisionMakers',
  'appliesTo',
  'related',
  'amends',
  'amendedBy',
  'supersedes',
  'supersededBy',
  'badges',
];

// ------------------------------------------------------------------------------------------------
// upstream
// ------------------------------------------------------------------------------------------------

async function fetchRaw({ repo, ref = DEFAULT_REF, path }) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
  const res = await fetch(url);

  if (res.status === 404) return null;

  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }

  return res.text();
}

/**
 * Every decision file in a repository, in one request. Listing directory by directory would only
 * find the directories the catalog already knows about, which is the blind spot worth closing —
 * `shortlink` alone keeps decisions in nine separate places.
 */
async function listRepoDecisions({ repo, ref = DEFAULT_REF }) {
  const url = `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`;
  const headers = { accept: 'application/vnd.github+json' };

  // Only to lift the unauthenticated rate limit; the repositories are public.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });

  if (res.status === 403 || res.status === 429) {
    throw new Error('the GitHub API rate limit is exhausted — set GITHUB_TOKEN to raise it');
  }

  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }

  const { tree, truncated } = await res.json();

  if (truncated) {
    throw new Error(`the git tree for ${repo} came back truncated; new decisions may be missed`);
  }

  return tree
    .filter((e) => e.type === 'blob')
    .map((e) => e.path)
    .filter((path) => {
      const name = path.match(DECISION_PATH)?.[1];
      return name && !NOT_A_DECISION.test(name);
    });
}

const normalize = (text) => text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');

const upstreamTitle = (md) => md.match(/^#[ \t]+(?:\d+\.[ \t]*)?(.+?)[ \t]*$/m)?.[1];

/**
 * The upstream `Date:` line. One decision is dated `2025-01-XX`, so a date can be approximate —
 * EventCatalog requires the field, so an approximate one is better than none.
 */
function upstreamDate(md) {
  const raw = md.match(/^Date:[ \t]*(\S+)/m)?.[1];

  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { value: raw, exact: true };

  const month = raw.match(/^(\d{4}-\d{2})(?:-\D+)?$/)?.[1];

  return month ? { value: `${month}-01`, exact: false } : null;
}

/**
 * The first recognised status word in the `## Status` section. One upstream decision states its
 * status in a sentence rather than a bare word, and one has no Status section at all.
 */
function upstreamStatus(md) {
  const section = md.match(/^##[ \t]+Status[ \t]*\n([\s\S]*?)(?=\n#{1,2}[ \t]|$(?![\s\S]))/m);

  return section?.[1].match(/\b(accepted|proposed|rejected|deprecated|superseded)\b/i)?.[1].toLowerCase();
}

/**
 * The opening sentence of the upstream Context, when it is a plain sentence. Used verbatim as the
 * summary shown in catalog lists — a sentence taken from the decision, never one written here.
 * Anything that starts with a list, a table, a heading or a code fence is left without a summary
 * rather than truncated into nonsense.
 */
function upstreamSummary(md) {
  const context = md.match(/^##[ \t]+Context[ \t]*\n([\s\S]*?)(?=\n#{1,2}[ \t]|$(?![\s\S]))/m)?.[1];

  for (const paragraph of context?.trim().split(/\n\s*\n/) ?? []) {
    const trimmed = paragraph.trim();

    // Lists, tables, headings and code fences do not reduce to a sentence.
    if (/^[-*>|#`]|^\d+\./.test(trimmed)) continue;

    const flat = trimmed.replace(/\s+/g, ' ');
    const sentence = flat.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? flat;

    // A sentence ending in a colon introduces a list or a code block that is not coming with it.
    if (sentence.endsWith(':') || sentence.length > 220 || /[<>{}]/.test(sentence)) continue;

    return sentence;
  }

  // Whatever the shape of the Context, the title is still a sentence upstream wrote.
  return upstreamTitle(md);
}

/**
 * The decision text, with the parts that became frontmatter removed: the title heading, the date
 * line and the Status section. Everything else is upstream's, untouched — including the PlantUML
 * blocks, which this catalog renders as source rather than silently rewriting someone else's
 * diagram.
 */
function upstreamBody(md) {
  return normalize(md)
    .replace(/^#[ \t]+.+\n/m, '')
    .replace(/^Date:[ \t]*.*\n/m, '')
    .replace(/^##[ \t]+Status[ \t]*\n[\s\S]*?(?=\n#{1,2}[ \t])/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** File extensions that mark a link target as a path in the repository rather than a hostname. */
const REPO_FILE = /\.(md|markdown|png|jpe?g|gif|svg|webp|go|rs|ts|tsx|js|mjs|py|ya?ml|json|proto|zed|toml|sh|sql|puml)$/i;

/**
 * Rewrites the relative links and images upstream wrote — `./images/ADR-0035/rules.png`,
 * `./0002-implement-as-event-naming.md`, `../../src/domain/services/dispatch.rs` — to point back at
 * the repository they resolve in. Without this a relative image is a build failure and a relative
 * link is a 404: they resolve against the source tree, which is not this one.
 */
function absolutize(body, { repo, ref = DEFAULT_REF, path }) {
  const base = path.replace(/\/[^/]+$/, '');

  return body.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (match, bang, text, target, title) => {
    // Absolute URLs, anchors, and bare hostnames such as `golang.org/x/sync` are left alone.
    if (/^(https?:|mailto:|#|\/)/.test(target)) return match;
    if (!target.startsWith('./') && !target.startsWith('../') && !REPO_FILE.test(target.split('#')[0])) {
      return match;
    }

    const [rawPath, fragment] = target.split('#');
    const segments = [];

    for (const segment of `${base}/${rawPath}`.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') segments.pop();
      else segments.push(segment);
    }

    const resolved = segments.join('/');
    const url = bang
      ? `https://raw.githubusercontent.com/${repo}/${ref}/${resolved}`
      : `https://github.com/${repo}/blob/${ref}/${resolved}${fragment ? `#${fragment}` : ''}`;

    return `${bang}[${text}](${url}${title ?? ''})`;
  });
}

/**
 * MDX reads `{` and `<` as expression and element syntax. Upstream prose is markdown and uses them
 * literally — `<hash>`, `{id}` — so anything outside a code fence or a code span is escaped. Code
 * is left exactly as written.
 */
function escapeForMdx(body) {
  return body
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((chunk, i) => (i % 2 ? chunk : chunk.replace(/[<{]/g, (c) => `\\${c}`)))
    .join('');
}

// ------------------------------------------------------------------------------------------------
// rendering
// ------------------------------------------------------------------------------------------------

/** `adr-platform-0042-link-privacy-control` -> `platform`, `0042` */
const idParts = (id) => id.match(/^adr-(.+?)-(\d+)-/)?.slice(1) ?? [];

function render({ id, entry, upstream }) {
  const [scope, number] = idParts(id);
  const [repo, path] = entry.source.split(':');
  const url = `https://github.com/${repo}/blob/${entry.ref ?? DEFAULT_REF}/${path}`;
  const title = upstreamTitle(upstream) ?? id;
  // Upstream owns the date. `date` in the overlay is a fallback for the one decision whose
  // upstream file carries no `Date:` line at all, since EventCatalog requires the field.
  const date = upstreamDate(upstream) ?? (entry.date ? { value: entry.date } : null);
  const summary = upstreamSummary(upstream);

  const frontmatter = {
    id,
    name: scope ? `ADR-${number} (${scope}): ${title}` : title,
    version: '1.0.0',
    ...(summary ? { summary } : {}),
    status: upstreamStatus(upstream) ?? 'proposed',
    date: date?.value ?? '',
    ...Object.fromEntries(CARRIED.filter((k) => entry[k] !== undefined).map((k) => [k, entry[k]])),
  };

  return [
    '---',
    YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd(),
    '---',
    '',
    `{/* Generated by scripts/sync-adrs.mjs from ${repo}/${path} — do not edit here.`,
    `    Change the decision in its own repository, or adrs.overlay.yaml for the catalog links. */}`,
    '',
    `> Source: [${path}](${url})`,
    '',
    escapeForMdx(absolutize(upstreamBody(upstream), { repo, ref: entry.ref, path })),
    '',
  ].join('\n');
}

// ------------------------------------------------------------------------------------------------
// catalog side
// ------------------------------------------------------------------------------------------------

/** Every `<anything>/adrs/<name>/index.mdx` currently on disk. */
function findAdrFiles(dir = ROOT, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;

    const child = join(dir, entry.name);

    if (entry.name === 'adrs') {
      for (const adr of readdirSync(child, { withFileTypes: true })) {
        if (!adr.isDirectory()) continue;
        const file = join(child, adr.name, 'index.mdx');
        if (existsSync(file)) found.push(file);
      }
      continue;
    }

    findAdrFiles(child, found);
  }

  return found.sort();
}

const mostCommon = (values) =>
  [...values.reduce((counts, v) => counts.set(v, (counts.get(v) ?? 0) + 1), new Map())].sort(
    (a, b) => b[1] - a[1],
  )[0]?.[0];

// ------------------------------------------------------------------------------------------------
// run
// ------------------------------------------------------------------------------------------------

const overlayText = readFileSync(OVERLAY, 'utf8');
const overlay = YAML.parse(overlayText);
const results = [];
const generated = new Set();
const known = new Set();
const dirs = new Map();

for (const [id, entry] of Object.entries(overlay)) {
  const file = join(ROOT, entry.location, id, 'index.mdx');
  const label = relative(ROOT, dirname(file));

  generated.add(file);

  if (entry.origin === 'catalog') {
    results.push({ label, status: 'native' });
    continue;
  }

  const [repo, path] = entry.source.split(':');

  known.add(entry.source);

  // Remember where decisions from this upstream directory land, so a new sibling can be placed
  // without guessing.
  const key = `${repo}:${path.replace(/\/[^/]+$/, '')}`;
  const group = dirs.get(key) ?? { repo, ref: entry.ref, locations: [], prefixes: [], owners: [] };
  group.locations.push(entry.location);
  group.prefixes.push(id.match(/^(adr-.+?-)\d+/)?.[1]);
  group.owners.push(entry.owners?.[0]);
  dirs.set(key, group);

  let upstream;

  try {
    upstream = await fetchRaw({ repo, ref: entry.ref, path });
  } catch (error) {
    results.push({ label, status: 'error', detail: error.message });
    continue;
  }

  if (upstream === null) {
    results.push({ label, status: 'gone', detail: `${repo}/${path} no longer exists` });
    continue;
  }

  if (!upstreamDate(upstream) && !entry.date) {
    results.push({
      label,
      status: 'undated',
      detail: `${repo}/${path} has no Date: line — add a date to adrs.overlay.yaml`,
    });
    continue;
  }

  const content = render({ id, entry, upstream });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;

  if (current === content) {
    results.push({ label, status: 'ok' });
    continue;
  }

  if (CHECK) {
    results.push({
      label,
      status: current === null ? 'absent' : 'outdated',
      detail: current === null ? 'not generated yet' : `no longer matches ${repo}/${path}`,
    });
    continue;
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  results.push({ label, status: current === null ? 'created' : 'updated' });
}

// Files on disk that the overlay does not account for.
for (const file of findAdrFiles()) {
  if (generated.has(file)) continue;

  results.push({
    label: relative(ROOT, dirname(file)),
    status: 'orphan',
    detail: 'no entry in adrs.overlay.yaml',
  });
}

// Decisions that exist upstream with nothing in the overlay pointing at them.
const repos = new Map();

for (const group of dirs.values()) {
  repos.set(`${group.repo}@${group.ref ?? DEFAULT_REF}`, { repo: group.repo, ref: group.ref });
}

const adopted = {};

for (const repo of repos.values()) {
  let paths;

  try {
    paths = await listRepoDecisions(repo);
  } catch (error) {
    results.push({ label: repo.repo, status: 'error', detail: error.message });
    continue;
  }

  for (const path of paths) {
    const source = `${repo.repo}:${path}`;

    if (known.has(source)) continue;

    const group = dirs.get(`${repo.repo}:${path.replace(/\/[^/]+$/, '')}`);

    // A decision directory the catalog has never drawn from is not a gap. The catalog covers the
    // boundaries it chose to cover, so this is reported for the record and deliberately does not
    // fail the check — otherwise an undocumented boundary would break CI forever.
    if (!group) {
      results.push({
        label: source,
        status: 'unmapped',
        detail: 'no catalog ADR drawn from this directory yet',
      });
      continue;
    }

    const prefix = mostCommon(group.prefixes.filter(Boolean));
    const location = mostCommon(group.locations);

    if (CHECK || !prefix || !location) {
      results.push({ label: source, status: 'missing', detail: 'upstream decision not in the overlay' });
      continue;
    }

    const name = path.split('/').pop();
    const id = `${prefix}${(name.match(/^(\d+)/)?.[1] ?? '0').padStart(4, '0')}-${name.replace(/^\d+[-_]?/, '').replace(/\.md$/, '')}`;
    const entry = { source, location, owners: [mostCommon(group.owners.filter(Boolean))].filter(Boolean) };
    const upstream = await fetchRaw({ repo: repo.repo, ref: repo.ref, path });
    const file = join(ROOT, location, id, 'index.mdx');

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, render({ id, entry, upstream }));

    adopted[id] = entry;
    results.push({ label: relative(ROOT, dirname(file)), status: 'adopted', detail: 'added to the overlay — add its appliesTo' });
  }
}

// Newly adopted decisions are appended so the overlay stays the complete picture.
if (!CHECK && Object.keys(adopted).length > 0) {
  writeFileSync(OVERLAY, `${overlayText.trimEnd()}\n${YAML.stringify(adopted, { lineWidth: 110 })}`);
}

// ------------------------------------------------------------------------------------------------
// report
// ------------------------------------------------------------------------------------------------

const LABELS = {
  ok: '  ok        ',
  native: '  native    ',
  created: '  created   ',
  updated: '  updated   ',
  adopted: '  ADOPTED   ',
  outdated: '  OUTDATED  ',
  absent: '  ABSENT    ',
  missing: '  MISSING   ',
  orphan: '  ORPHAN    ',
  gone: '  GONE      ',
  undated: '  UNDATED   ',
  unmapped: '  unmapped  ',
  error: '  ERROR     ',
};

const PROBLEMS = ['outdated', 'absent', 'missing', 'orphan', 'gone', 'undated', 'error'];

for (const { label, status, detail } of results) {
  console.log(`${LABELS[status]} ${label}${detail ? ` — ${detail}` : ''}`);
}

console.log('');

const problems = results.filter((r) => PROBLEMS.includes(r.status));
const changed = results.filter((r) => ['created', 'updated', 'adopted'].includes(r.status));

if (CHECK && problems.length > 0) {
  console.error(
    `${problems.length} of ${results.length} decision record(s) are out of step with upstream.\n` +
      'Run `npm run sync:adrs`, review the diff, and commit it.',
  );
  process.exit(1);
}

if (!CHECK && problems.length > 0) {
  console.error(`${problems.length} decision record(s) need attention.`);
  process.exit(1);
}

console.log(
  CHECK
    ? `All ${results.length} decision records match upstream.`
    : changed.length > 0
      ? `${changed.length} decision record(s) written.`
      : `All ${results.length} decision records already up to date.`,
);
