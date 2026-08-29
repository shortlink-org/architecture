#!/usr/bin/env node
/**
 * Keeps the schema files copied into this catalog in sync with the repositories they came from.
 *
 *   node scripts/sync-schemas.mjs           write the catalog copies from upstream
 *   node scripts/sync-schemas.mjs --check   fail if a catalog copy differs from upstream
 *
 * Every catalog copy is *derived* from an upstream file — either verbatim, or by extracting a
 * single protobuf message, or by bundling a multi-file OpenAPI document. The derivation lives
 * here so --check and the write mode can never disagree.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const LINK = 'domains/Link/systems/link-management-system/services/LinkService';
const PROXY = 'domains/Link/systems/redirect-system/services/ProxyService';
const META = 'domains/Link/systems/metadata-system/services/MetadataService';

/**
 * repo   — owner/name on github.com
 * ref    — branch or tag to read from
 * path   — file inside that repository
 * target — where the derived file lives in this catalog
 * derive — 'verbatim' | { message: '<ProtobufMessageName>' } | 'openapi-bundle'
 */
const FILES = [
  // --- link service: one event message per catalog event -------------------------------------
  ...['LinkCreated', 'LinkUpdated', 'LinkDeleted'].map((message) => ({
    repo: 'shortlink-org/shortlink',
    path: 'boundaries/link/internal/domain/link/v1/link_events.proto',
    target: `${LINK}/events/${message}/schema.proto`,
    derive: { message },
  })),

  // --- link service: one command message per catalog command ---------------------------------
  ...['CreateLink', 'UpdateLink', 'DeleteLink'].map((message) => ({
    repo: 'shortlink-org/shortlink',
    path: 'boundaries/link/internal/domain/link/v1/link_commands.proto',
    target: `${LINK}/commands/${message}/schema.proto`,
    derive: { message },
  })),

  // --- link service: gRPC contracts, verbatim -------------------------------------------------
  {
    repo: 'shortlink-org/shortlink',
    path: 'boundaries/link/internal/infrastructure/rpc/link/v1/link_rpc.proto',
    target: `${LINK}/link_rpc.proto`,
  },
  ...['GetLinkView', 'ListLinkViews'].map((query) => ({
    repo: 'shortlink-org/shortlink',
    path: 'boundaries/link/internal/infrastructure/rpc/cqrs/link/v1/link_query.proto',
    target: `${LINK}/queries/${query}/schema.proto`,
  })),

  // --- metadata service -----------------------------------------------------------------------
  {
    repo: 'shortlink-org/shortlink',
    path: 'boundaries/metadata/internal/domain/metadata/v1/metadata_events.proto',
    target: `${META}/events/MetadataExtracted/schema.proto`,
  },

  // --- proxy: LinkRedirected is serialized as the RPC Link message, not a dedicated event -----
  {
    repo: 'shortlink-org/shortlink',
    path: 'boundaries/proxy/src/infrastructure/proto/infrastructure/rpc/link/v1/link.proto',
    target: `${PROXY}/events/LinkRedirected/schema.proto`,
  },

  // --- BFF: five cross-referencing OpenAPI files, bundled into one ----------------------------
  {
    repo: 'shortlink-org/shortlink',
    path: 'boundaries/bff/internal/infrastructure/http/api/api.yaml',
    target: 'domains/Link/systems/link-management-system/services/LinkBFF/api.yaml',
    derive: 'openapi-bundle',
    // fetched alongside api.yaml so the relative $refs resolve during bundling
    siblings: ['base.yaml', 'link.yaml', 'sitemap.yaml', 'config.yaml'],
  },
];

const DEFAULT_REF = 'main';

async function fetchRaw({ repo, ref = DEFAULT_REF, path }) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }

  return res.text();
}

/**
 * Everything above the first message declaration: syntax, package, options, imports.
 * Taken from the source rather than hardcoded, so a changed package or import is carried over.
 */
function preamble(proto) {
  const start = proto.search(/^(?:\/\/[^\n]*\n)*message\s/m);

  if (start === -1) {
    throw new Error('no message declaration found in proto file');
  }

  return proto.slice(0, start);
}

/** A single message plus the comment block directly above it. */
function extractMessage(proto, message) {
  const pattern = new RegExp(`(?:^\\/\\/[^\\n]*\\n)*^message ${message} \\{[\\s\\S]*?^\\}\\n`, 'm');
  const found = proto.match(pattern);

  if (!found) {
    throw new Error(`message ${message} not found in proto file`);
  }

  return found[0];
}

function bundleOpenAPI(entry, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'ec-openapi-'));

  try {
    writeFileSync(join(dir, 'api.yaml'), contents.main);

    for (const [name, body] of Object.entries(contents.siblings)) {
      writeFileSync(join(dir, name), body);
    }

    execFileSync(
      'npx',
      ['--yes', '@redocly/cli', 'bundle', 'api.yaml', '-o', 'bundled.yaml', '--ext', 'yaml'],
      { cwd: dir, stdio: 'pipe' },
    );

    return readFileSync(join(dir, 'bundled.yaml'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function derive(entry) {
  const source = await fetchRaw(entry);

  if (entry.derive === 'openapi-bundle') {
    const siblings = {};

    for (const name of entry.siblings) {
      siblings[name] = await fetchRaw({ ...entry, path: entry.path.replace(/[^/]+$/, name) });
    }

    return bundleOpenAPI(entry, { main: source, siblings });
  }

  if (entry.derive?.message) {
    return preamble(source) + extractMessage(source, entry.derive.message);
  }

  return source;
}

// Trailing whitespace is not a meaningful difference between a file and its source.
const normalize = (text) => text.replace(/\s+$/, '') + '\n';

const results = [];

for (const entry of FILES) {
  const target = join(ROOT, entry.target);
  let expected;

  try {
    expected = normalize(await derive(entry));
  } catch (error) {
    results.push({ entry, status: 'error', detail: error.message });
    continue;
  }

  const actual = existsSync(target) ? normalize(readFileSync(target, 'utf8')) : null;

  if (actual === expected) {
    results.push({ entry, status: 'ok' });
    continue;
  }

  if (CHECK) {
    results.push({ entry, status: actual === null ? 'missing' : 'drifted' });
    continue;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, expected);
  results.push({ entry, status: actual === null ? 'created' : 'updated' });
}

const problems = results.filter((r) => ['drifted', 'missing', 'error'].includes(r.status));
const changed = results.filter((r) => ['created', 'updated'].includes(r.status));

for (const { entry, status, detail } of results) {
  const label = { ok: '  ok      ', created: '  created ', updated: '  updated ', drifted: '  DRIFTED ', missing: '  MISSING ', error: '  ERROR   ' }[status];
  console.log(`${label} ${entry.target}${detail ? ` — ${detail}` : ''}`);
}

console.log('');

if (CHECK && problems.length > 0) {
  console.error(
    `${problems.length} of ${FILES.length} schema file(s) no longer match ${DEFAULT_REF} upstream.\n` +
      'Run `npm run sync:schemas`, review the diff, and commit the result.',
  );
  process.exit(1);
}

if (!CHECK && problems.length > 0) {
  console.error(`${problems.length} file(s) could not be fetched or derived.`);
  process.exit(1);
}

console.log(
  CHECK
    ? `All ${FILES.length} schema files match upstream.`
    : changed.length > 0
      ? `${changed.length} file(s) written.`
      : `All ${FILES.length} schema files already up to date.`,
);
