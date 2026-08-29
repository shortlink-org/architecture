#!/usr/bin/env node
/**
 * Keeps the architecture decision records in this catalog tied to the upstream decisions they
 * were written from.
 *
 *   node scripts/sync-adrs.mjs           refresh the derived fields and scaffold new upstream ADRs
 *   node scripts/sync-adrs.mjs --check   fail if anything drifted, went missing, or vanished
 *
 * The catalog's ADRs are *not* copies of their upstream files. They are condensed rewrites that
 * carry a graph the source repositories do not have — appliesTo, related, amendedBy, and the
 * [[resource|id]] links between decisions. A generator cannot produce that, so it does not try.
 *
 * What the script owns:
 *
 *   x-source   the upstream repo, path, and a hash of the file the rewrite was made from
 *   date       upstream `Date:` line
 *   status     upstream `## Status` section
 *
 * What stays hand-written: the id, name, summary, owners, appliesTo, related, badges, the
 * `> Source:` line (several carry editorial notes after the link), and the body.
 *
 * So the hash is the whole point. When an upstream decision is edited, `--check` fails and names
 * the ADR whose rewrite is now out of date. Nothing is silently overwritten.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const DEFAULT_REF = 'main';

/** Directories that never contain catalog resources. */
const SKIP = new Set(['node_modules', 'dist', '.git', '.astro', '.eventcatalog-core', 'public']);

/** Upstream files in an ADR directory that are not themselves decisions. */
const NOT_A_DECISION = /^(readme|template|index)\b/i;

// ------------------------------------------------------------------------------------------------
// catalog side
// ------------------------------------------------------------------------------------------------

/** Every `<anything>/adrs/<name>/index.mdx` in the catalog. */
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

function splitFrontmatter(text, file) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);

  if (!match) {
    throw new Error(`${relative(ROOT, file)} has no frontmatter`);
  }

  return { yaml: match[1], body: text.slice(match[0].length) };
}

const scalar = (yaml, key) => yaml.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm'))?.[1];

/** The `x-source` block this script maintains. Custom properties must be prefixed `x-`. */
const X_SOURCE_BLOCK = /^x-source:\n(?:[ \t]+[^\n]*\n?)*/m;

function readXSource(yaml) {
  const block = yaml.match(X_SOURCE_BLOCK)?.[0];

  if (!block) return null;

  const field = (key) => block.match(new RegExp(`^[ \\t]+${key}:[ \\t]*(.+?)[ \\t]*$`, 'm'))?.[1];

  return {
    origin: field('origin'),
    repo: field('repo'),
    ref: field('ref') ?? DEFAULT_REF,
    path: field('path'),
    sha256: field('sha256'),
  };
}

function renderXSource({ repo, ref, path, sha256 }) {
  const lines = [`x-source:`, `  repo: ${repo}`];

  if (ref && ref !== DEFAULT_REF) lines.push(`  ref: ${ref}`);

  lines.push(`  path: ${path}`, `  sha256: ${sha256}`);

  return lines.join('\n') + '\n';
}

/**
 * The first GitHub blob link on the `> Source:` line. Used to adopt an ADR that predates this
 * script — after the first write the `x-source` block is authoritative.
 */
function xSourceFromBody(body) {
  const line = body.split('\n').find((l) => l.startsWith('> Source:'));
  const match = line?.match(/https:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\/blob\/([^/\s)]+)\/([^\s)]+)/);

  return match ? { repo: match[1], ref: match[2], path: match[3] } : null;
}

// ------------------------------------------------------------------------------------------------
// upstream side
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

/** Any `docs/ADR/decisions/*.md`, at the repository root or under a boundary. */
const DECISION_PATH = /(?:^|\/)docs\/ADR\/decisions\/([^/]+\.md)$/;

/**
 * Every decision file in a repository, in one request. Listing directory by directory would only
 * ever find the directories the catalog already knows about, which is precisely the blind spot
 * worth closing — `shortlink` alone keeps decisions in nine separate places.
 */
async function listRepoDecisions({ repo, ref = DEFAULT_REF }) {
  const url = `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`;
  const headers = { accept: 'application/vnd.github+json' };

  // Only to lift the unauthenticated rate limit; the repositories are public.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });

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

/** Line endings and trailing whitespace are not a change worth reporting. */
const normalize = (text) => text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n';

const digest = (text) => createHash('sha256').update(normalize(text)).digest('hex');

const upstreamTitle = (md) => md.match(/^#[ \t]+(?:\d+\.[ \t]*)?(.+?)[ \t]*$/m)?.[1];
/**
 * The upstream `Date:` line. One decision is dated `2025-01-XX`, so a date can be approximate:
 * good enough to scaffold a file with (EventCatalog requires the field) but never good enough to
 * overwrite a date a person chose.
 */
function upstreamDate(md) {
  const raw = md.match(/^Date:[ \t]*(\S+)/m)?.[1];

  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { value: raw, exact: true };

  const month = raw.match(/^(\d{4}-\d{2})(?:-\D+)?$/)?.[1];

  return month ? { value: `${month}-01`, exact: false } : null;
}

/**
 * The first recognised status word in the `## Status` section. One upstream ADR states its status
 * in a sentence rather than a bare word, and one has no Status section at all — hence the search
 * rather than an exact match, and the undefined return.
 */
function upstreamStatus(md) {
  const section = md.match(/^##[ \t]+Status[ \t]*\n([\s\S]*?)(?=\n#{1,2}[ \t]|$(?![\s\S]))/m);

  return section?.[1].match(/\b(accepted|proposed|rejected|deprecated|superseded)\b/i)?.[1].toLowerCase();
}

// ------------------------------------------------------------------------------------------------
// scaffolding a decision that exists upstream but not here
// ------------------------------------------------------------------------------------------------

/** `adr-platform-0042-link-privacy-control` -> `adr-platform-` */
const idPrefix = (id) => id.match(/^(adr-[a-z0-9]+-)\d+/)?.[1];

const mostCommon = (values) =>
  [...values.reduce((counts, v) => counts.set(v, (counts.get(v) ?? 0) + 1), new Map())].sort(
    (a, b) => b[1] - a[1],
  )[0]?.[0];

function scaffold({ upstream, source, prefix, owners }) {
  const file = source.path.split('/').pop();
  const number = file.match(/^(\d+)/)?.[1].padStart(4, '0') ?? '0000';
  const slug = file.replace(/^\d+[-_]?/, '').replace(/\.md$/, '');
  const scope = prefix.replace(/^adr-/, '').replace(/-$/, '');
  const title = upstreamTitle(upstream) ?? slug.replace(/-/g, ' ');
  const date = upstreamDate(upstream);
  const todo =
    'TODO — one sentence. Scaffolded from upstream; condense the body and add appliesTo.' +
    (date && !date.exact ? ' The upstream date is approximate — confirm it.' : '');
  const url = `https://github.com/${source.repo}/blob/${source.ref ?? DEFAULT_REF}/${source.path}`;

  // The heading, the Date line and the Status section become frontmatter, so they are dropped from
  // the body rather than repeated on the page.
  const body = normalize(upstream)
    .replace(/^#[ \t]+.+\n/m, '')
    .replace(/^Date:[ \t]*.*\n/m, '')
    .replace(/^##[ \t]+Status[ \t]*\n[\s\S]*?(?=\n#{1,2}[ \t])/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const frontmatter = [
    '---',
    `id: ${prefix}${number}-${slug}`,
    `name: "ADR-${number} (${scope}): ${title}"`,
    'version: 1.0.0',
    `summary: ${todo}`,
    `status: ${upstreamStatus(upstream) ?? 'proposed'}`,
    `date: ${date?.value ?? ''}`,
    ...(owners ? ['owners:', `  - ${owners}`] : []),
    renderXSource({ ...source, sha256: digest(upstream) }).trimEnd(),
    '---',
  ].join('\n');

  return `${frontmatter}\n\n> Source: [${source.path}](${url})\n\n${body}\n`;
}

// ------------------------------------------------------------------------------------------------
// run
// ------------------------------------------------------------------------------------------------

const results = [];
const known = new Set();
const dirs = new Map();

for (const file of findAdrFiles()) {
  const label = relative(ROOT, dirname(file));
  const text = readFileSync(file, 'utf8');

  let yaml;
  let body;

  try {
    ({ yaml, body } = splitFrontmatter(text, file));
  } catch (error) {
    results.push({ label, status: 'error', detail: error.message });
    continue;
  }

  const declared = readXSource(yaml);

  if (declared?.origin === 'catalog') {
    results.push({ label, status: 'native' });
    continue;
  }

  const source = declared?.path ? declared : xSourceFromBody(body);

  if (!source) {
    results.push({
      label,
      status: 'unlinked',
      detail: 'no x-source block and no GitHub link on the "> Source:" line',
    });
    continue;
  }

  known.add(`${source.repo}#${source.path}`);

  // Remember where decisions from this upstream directory land, so a new one can be scaffolded
  // beside its siblings instead of guessing.
  const dir = source.path.replace(/\/[^/]+$/, '');
  const key = `${source.repo}#${dir}`;
  const group = dirs.get(key) ?? { repo: source.repo, ref: source.ref, dir, targets: [], prefixes: [], owners: [] };
  group.targets.push(dirname(dirname(file)));
  group.prefixes.push(idPrefix(scalar(yaml, 'id') ?? ''));
  group.owners.push(yaml.match(/^owners:\n[ \t]+-[ \t]*(.+?)[ \t]*$/m)?.[1]);
  dirs.set(key, group);

  let upstream;

  try {
    upstream = await fetchRaw(source);
  } catch (error) {
    results.push({ label, status: 'error', detail: error.message });
    continue;
  }

  if (upstream === null) {
    results.push({ label, status: 'gone', detail: `${source.repo}/${source.path} no longer exists` });
    continue;
  }

  const sha256 = digest(upstream);
  const date = upstreamDate(upstream)?.exact ? upstreamDate(upstream).value : null;
  const status = upstreamStatus(upstream);

  const drifted = declared?.sha256 && declared.sha256 !== sha256;
  const stale = [
    date && scalar(yaml, 'date') !== date ? `date ${scalar(yaml, 'date')} -> ${date}` : null,
    status && scalar(yaml, 'status') !== status ? `status ${scalar(yaml, 'status')} -> ${status}` : null,
  ].filter(Boolean);

  const adopting = !declared;

  if (!drifted && !stale.length && !adopting) {
    results.push({ label, status: 'ok' });
    continue;
  }

  if (CHECK) {
    if (drifted) {
      results.push({ label, status: 'drifted', detail: `${source.repo}/${source.path} changed upstream` });
    } else if (adopting) {
      results.push({ label, status: 'unlinked', detail: 'x-source block not written yet' });
    } else {
      results.push({ label, status: 'stale', detail: stale.join(', ') });
    }
    continue;
  }

  // Write mode. The body is never touched — only the fields upstream owns.
  let updated = yaml;

  if (date) updated = updated.replace(/^date:[ \t]*.+$/m, `date: ${date}`);
  if (status) updated = updated.replace(/^status:[ \t]*.+$/m, `status: ${status}`);

  const block = renderXSource({ ...source, sha256 });

  updated = X_SOURCE_BLOCK.test(updated)
    ? updated.replace(X_SOURCE_BLOCK, block)
    : `${updated.trimEnd()}\n${block}`;

  writeFileSync(file, `---\n${updated.trimEnd()}\n---\n${body}`);

  results.push({
    label,
    status: drifted ? 'rehashed' : adopting ? 'adopted' : 'updated',
    detail: drifted
      ? `upstream changed — review the rewrite against ${source.repo}/${source.path}`
      : stale.join(', ') || undefined,
  });
}

// Decisions that exist upstream with nothing in the catalog pointing at them.
const repos = new Map();

for (const group of dirs.values()) {
  repos.set(`${group.repo}@${group.ref ?? DEFAULT_REF}`, { repo: group.repo, ref: group.ref });
}

for (const repo of repos.values()) {
  let paths;

  try {
    paths = await listRepoDecisions(repo);
  } catch (error) {
    results.push({ label: repo.repo, status: 'error', detail: error.message });
    continue;
  }

  for (const path of paths) {
    if (known.has(`${repo.repo}#${path}`)) continue;

    const group = dirs.get(`${repo.repo}#${path.replace(/\/[^/]+$/, '')}`);

    // A decision directory no catalog ADR was ever written from is not a gap. The catalog covers
    // the decisions it chose to cover, so this is reported for the record and deliberately does
    // not fail the check — otherwise every undocumented boundary would break CI forever.
    if (!group) {
      results.push({
        label: `${repo.repo}/${path}`,
        status: 'unmapped',
        detail: 'no catalog ADR drawn from this directory yet',
      });
      continue;
    }

    const prefix = mostCommon(group.prefixes.filter(Boolean));
    const target = mostCommon(group.targets);
    const owners = mostCommon(group.owners.filter(Boolean));
    const source = { repo: repo.repo, ref: repo.ref, path };

    if (CHECK || !prefix || !target) {
      results.push({
        label: `${repo.repo}/${path}`,
        status: 'missing',
        detail: 'upstream decision with no catalog counterpart',
      });
      continue;
    }

    const upstream = await fetchRaw(source);
    const content = scaffold({ upstream, source, prefix, owners });
    const id = content.match(/^id:[ \t]*(.+)$/m)[1];
    const file = join(target, id, 'index.mdx');

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);

    results.push({
      label: relative(ROOT, dirname(file)),
      status: 'scaffolded',
      detail: 'condense the body, add appliesTo, then commit',
    });
  }
}

// ------------------------------------------------------------------------------------------------
// report
// ------------------------------------------------------------------------------------------------

const LABELS = {
  ok: '  ok        ',
  native: '  native    ',
  adopted: '  adopted   ',
  updated: '  updated   ',
  rehashed: '  REHASHED  ',
  scaffolded: '  SCAFFOLD  ',
  drifted: '  DRIFTED   ',
  stale: '  STALE     ',
  missing: '  MISSING   ',
  unmapped: '  unmapped  ',
  gone: '  GONE      ',
  unlinked: '  UNLINKED  ',
  error: '  ERROR     ',
};

const PROBLEMS = ['drifted', 'stale', 'missing', 'gone', 'unlinked', 'error'];

for (const { label, status, detail } of results) {
  console.log(`${LABELS[status]} ${label}${detail ? ` — ${detail}` : ''}`);
}

console.log('');

const problems = results.filter((r) => PROBLEMS.includes(r.status));
const changed = results.filter((r) => ['adopted', 'updated', 'rehashed', 'scaffolded'].includes(r.status));

if (CHECK && problems.length > 0) {
  console.error(
    `${problems.length} of ${results.length} decision record(s) are out of step with upstream.\n` +
      'Run `npm run sync:adrs`, review what it reports, update the affected rewrites, and commit.',
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
