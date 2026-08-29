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

const ADMIN = 'domains/Shop/systems/catalog-system/services/AdminService';
const OMS = 'domains/Shop/systems/order-system/services/OMSService';
const PRICER = 'domains/Shop/systems/order-system/services/PricerService';
const DELIVERY = 'domains/Delivery/systems/delivery-system/services/DeliveryService';

/**
 * Catalog event id -> protobuf message name, where the two differ.
 * The delivery-related order events carry an `Event` suffix in the proto; the catalog does not repeat it.
 */
const OMS_ORDER_EVENTS = {
  OrderCreated: 'OrderCreated',
  OrderCancelled: 'OrderCancelled',
  OrderCompleted: 'OrderCompleted',
  OrderDeliveryRequested: 'OrderDeliveryRequestedEvent',
  OrderDeliveryStatusUpdated: 'OrderDeliveryStatusUpdatedEvent',
  OrderDeliveryCompleted: 'OrderDeliveryCompletedEvent',
  OrderDeliveryFailed: 'OrderDeliveryFailedEvent',
};

/**
 * Source proto -> the commands and queries it defines, as [serviceDir, collection, catalogId].
 * A command or query gets the whole file: the request message alone does not describe the contract.
 */
const RPC_CONTRACTS = {
  'oms/internal/infrastructure/rpc/cart/v1/model/v1/model.proto': [
    [OMS, 'commands', 'AddCartItem'],
    [OMS, 'commands', 'RemoveCartItem'],
    [OMS, 'commands', 'ResetCart'],
    [OMS, 'queries', 'GetCart'],
  ],
  'oms/internal/infrastructure/rpc/order/v1/model/v1/model.proto': [
    [OMS, 'commands', 'CreateOrder'],
    [OMS, 'commands', 'CancelOrder'],
    [OMS, 'commands', 'CheckoutOrder'],
    [OMS, 'commands', 'UpdateOrderDeliveryInfo'],
    [OMS, 'queries', 'GetOrder'],
    [OMS, 'queries', 'ListOrders'],
    [OMS, 'queries', 'GetGoodsLeaderboard'],
  ],
  'pricer/internal/infrastructure/rpc/cart/v1/policy.proto': [
    [PRICER, 'queries', 'CalculateCartTotal'],
  ],
  // Commands that have a dedicated *Command message in the domain model.
  'delivery/src/domain/model/delivery/commands/v1/commands.proto': [
    [DELIVERY, 'commands', 'AcceptOrder'],
    [DELIVERY, 'commands', 'AssignOrder'],
    [DELIVERY, 'commands', 'DeliverOrder'],
    [DELIVERY, 'commands', 'RegisterCourier'],
    [DELIVERY, 'commands', 'UpdateCourierLocation'],
  ],
  // Queries that have a dedicated *Query message in the domain model.
  'delivery/src/domain/model/delivery/queries/v1/queries.proto': [
    [DELIVERY, 'queries', 'GetPackagePool'],
    [DELIVERY, 'queries', 'GetCourierPool'],
  ],
  // The rest exist only as RPCs on the gRPC service.
  'delivery/src/infrastructure/rpc/delivery.proto': [
    [DELIVERY, 'commands', 'PickUpOrder'],
    [DELIVERY, 'commands', 'ActivateCourier'],
    [DELIVERY, 'commands', 'DeactivateCourier'],
    [DELIVERY, 'commands', 'ArchiveCourier'],
    [DELIVERY, 'commands', 'UpdateCourierContactInfo'],
    [DELIVERY, 'commands', 'UpdateCourierWorkSchedule'],
    [DELIVERY, 'commands', 'ChangeCourierTransportType'],
    [DELIVERY, 'queries', 'GetCourier'],
    [DELIVERY, 'queries', 'GetCourierDeliveries'],
    [DELIVERY, 'queries', 'GetOrderTracking'],
    [DELIVERY, 'queries', 'SubscribeOrderTracking'],
    [DELIVERY, 'queries', 'GetRandomAddress'],
  ],
};

const DELIVERY_EVENTS = {
  PackageAccepted: 'PackageAcceptedEvent',
  PackageAssigned: 'PackageAssignedEvent',
  PackageInTransit: 'PackageInTransitEvent',
  PackageDelivered: 'PackageDeliveredEvent',
  PackageNotDelivered: 'PackageNotDeliveredEvent',
  PackageRequiresHandling: 'PackageRequiresHandlingEvent',
  CourierRegistered: 'CourierRegisteredEvent',
  CourierStatusChanged: 'CourierStatusChangedEvent',
  CourierLocationUpdated: 'CourierLocationUpdatedEvent',
};

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

  // ============================================================================================
  // shop repository — Shop and Delivery domains
  // ============================================================================================

  // --- OMS: one event message per catalog event ----------------------------------------------
  ...Object.entries(OMS_ORDER_EVENTS).map(([id, message]) => ({
    repo: 'shortlink-org/shop',
    path: 'oms/internal/domain/order/v1/events/v1/events.proto',
    target: `${OMS}/events/${id}/schema.proto`,
    derive: { message },
  })),

  // Declared but never published or consumed — documented with a "Not implemented" badge.
  {
    repo: 'shortlink-org/shop',
    path: 'oms/internal/domain/stock/v1/stock_event.proto',
    target: `${OMS}/events/StockChange/schema.proto`,
    derive: { message: 'StockChangeEvent' },
  },

  // --- OMS: gRPC contracts, verbatim ----------------------------------------------------------
  {
    repo: 'shortlink-org/shop',
    path: 'oms/internal/infrastructure/rpc/cart/v1/cart_rpc.proto',
    target: `${OMS}/cart_rpc.proto`,
  },
  {
    repo: 'shortlink-org/shop',
    path: 'oms/internal/infrastructure/rpc/order/v1/order_rpc.proto',
    target: `${OMS}/order_rpc.proto`,
  },

  // --- pricer ---------------------------------------------------------------------------------
  {
    repo: 'shortlink-org/shop',
    path: 'pricer/internal/infrastructure/rpc/cart/v1/policy.proto',
    target: `${PRICER}/policy.proto`,
  },

  // --- admin: OpenAPI is a single self-contained file, so no bundling ---------------------------
  {
    repo: 'shortlink-org/shop',
    path: 'admin/docs/public/Shop Admin API.yaml',
    target: `${ADMIN}/api.yaml`,
  },

  // --- delivery: one event message per catalog event -------------------------------------------
  ...Object.entries(DELIVERY_EVENTS).map(([id, message]) => ({
    repo: 'shortlink-org/shop',
    path: 'delivery/src/domain/model/delivery/events/v1/events.proto',
    target: `${DELIVERY}/events/${id}/schema.proto`,
    derive: { message },
  })),

  // --- delivery: gRPC and domain contracts, verbatim --------------------------------------------
  {
    repo: 'shortlink-org/shop',
    path: 'delivery/src/infrastructure/rpc/delivery.proto',
    target: `${DELIVERY}/delivery.proto`,
  },
  {
    repo: 'shortlink-org/shop',
    path: 'delivery/src/domain/model/delivery/commands/v1/commands.proto',
    target: `${DELIVERY}/commands.proto`,
  },
  {
    repo: 'shortlink-org/shop',
    path: 'delivery/src/domain/model/delivery/queries/v1/queries.proto',
    target: `${DELIVERY}/queries.proto`,
  },

  // --- commands and queries: the proto that actually defines each one, copied verbatim ----------
  // Same approach as the Link queries above: the whole contract file rather than one extracted
  // message, because a request message is meaningless without the service and types around it.
  ...Object.entries(RPC_CONTRACTS).flatMap(([path, resources]) =>
    resources.map(([service, kind, id]) => ({
      repo: 'shortlink-org/shop',
      path,
      target: `${service}/${kind}/${id}/schema.proto`,
    })),
  ),
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
