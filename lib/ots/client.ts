import OpenTimestamps, {
  DetachedTimestampFile,
  Ops,
  Notary,
  Calendar,
  type Attestation,
  type Timestamp,
} from 'opentimestamps';
import { logger } from '../logger';

/**
 * lib/ots/client.ts — the ONLY module that imports `opentimestamps`.
 *
 * Everything OTS-library-specific lives here: digest submission, receipt
 * upgrade, and proof parsing. A future swap of the OTS library (or a move
 * to a self-hosted calendar) is a rewrite of this file + the type shim in
 * types/opentimestamps.d.ts — no route or job handler changes.
 *
 * Timeout model: the opentimestamps library drives calendar HTTP through
 * the `request` library and exposes only a single coarse socket timeout,
 * not separate connect/body phases. We therefore enforce the *sum* of the
 * intended connect (5s) + body (10s) budgets as one per-calendar deadline,
 * applied two ways for belt-and-suspenders: (a) set on the RemoteCalendar
 * so `request` aborts the socket, and (b) a Promise race so a wedged
 * library call can't pin a job worker indefinitely.
 */

const CALENDAR_CONNECT_TIMEOUT_MS = 5_000;
const CALENDAR_BODY_TIMEOUT_MS = 10_000;
const CALENDAR_DEADLINE_MS = CALENDAR_CONNECT_TIMEOUT_MS + CALENDAR_BODY_TIMEOUT_MS;

export type BitcoinAttestation = { height: number };

export type SubmitResult = {
  otsProof: Buffer;
  calendarsAccepted: string[];
};

export type UpgradeResult = {
  confirmed: boolean;
  otsProof: Buffer;
  bitcoin: BitcoinAttestation | null;
};

export type ParsedOts = {
  fileDigest: Buffer;
  bitcoin: BitcoinAttestation | null;
  pendingUris: string[];
};

/** Parse OTS_CALENDAR_URLS — comma-separated, required. */
export function calendarUrls(): string[] {
  const raw = process.env.OTS_CALENDAR_URLS ?? '';
  const urls = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (urls.length === 0) {
    throw new Error(
      'OTS_CALENDAR_URLS is not set — cannot reach OpenTimestamps calendars'
    );
  }
  return urls;
}

/** Reject a promise if it doesn't settle within `ms`. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * The opentimestamps library is chatty (console.log per calendar). Silence
 * stdout for the duration of a library call so job-runner logs stay clean —
 * our own structured logger still reports success/failure.
 */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = orig;
  }
}

/**
 * Recursively yield every attestation in a timestamp tree.
 *
 * Note: the library's `allAttestations()` returns a Map keyed by message
 * bytes, so two attestations co-located on the same node (e.g. an upgraded
 * proof that carries both the original Pending and the new Bitcoin
 * attestation) collide and one is lost. Walking `.attestations` + `.ops`
 * directly is the only reliable enumeration.
 */
function* walkAttestations(timestamp: Timestamp): Generator<Attestation> {
  for (const att of timestamp.attestations) yield att;
  for (const child of timestamp.ops.values()) yield* walkAttestations(child);
}

function findBitcoin(timestamp: Timestamp): BitcoinAttestation | null {
  for (const att of walkAttestations(timestamp)) {
    if (att instanceof Notary.BitcoinBlockHeaderAttestation) {
      return { height: att.height };
    }
  }
  return null;
}

function pendingUris(timestamp: Timestamp): string[] {
  const uris: string[] = [];
  for (const att of walkAttestations(timestamp)) {
    if (att instanceof Notary.PendingAttestation) uris.push(att.uri);
  }
  return uris;
}

/**
 * Submit a 32-byte digest to the OTS calendars in parallel. Anchoring
 * succeeds when at least one calendar accepts; the partial proof carries a
 * pending attestation per accepting calendar.
 */
export async function submitDigest(
  digest: Buffer,
  calendars: string[] = calendarUrls()
): Promise<SubmitResult> {
  const detached = DetachedTimestampFile.fromHash(new Ops.OpSHA256(), digest);
  const msg = detached.timestamp.msg;

  const settled = await Promise.allSettled(
    calendars.map(async (url) => {
      const cal = new Calendar.RemoteCalendar(url);
      cal.timeout = CALENDAR_DEADLINE_MS;
      const ts = await withDeadline(
        quiet(() => cal.submit(msg)),
        CALENDAR_DEADLINE_MS,
        `OTS submit ${url}`
      );
      return { url, ts };
    })
  );

  const accepted: string[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      detached.timestamp.merge(r.value.ts);
      accepted.push(r.value.url);
    } else {
      logger.warn('ots.calendar_submit_failed', {
        err: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  if (accepted.length === 0) {
    throw new Error('OTS submit: no calendar accepted the digest');
  }

  return {
    otsProof: Buffer.from(detached.serializeToBytes()),
    calendarsAccepted: accepted,
  };
}

/**
 * Attempt to upgrade a partial proof to a Bitcoin-confirmed receipt.
 *
 * Returns `confirmed: false` when no calendar has a block attestation yet
 * (the normal "not ready" path — a calendar 404 is swallowed by the OTS
 * library's softFail, never thrown). A genuine network/parse error DOES
 * throw, so the caller can distinguish "wait longer" from "broken".
 */
export async function upgradeOts(
  otsProof: Buffer,
  calendars: string[] = calendarUrls()
): Promise<UpgradeResult> {
  const detached = DetachedTimestampFile.deserialize(otsProof);

  // Called as a method — OpenTimestamps.upgrade internally uses `this`.
  await withDeadline(
    quiet(() => OpenTimestamps.upgrade(detached, { calendars })),
    CALENDAR_DEADLINE_MS * 2,
    'OTS upgrade'
  );

  const bitcoin = findBitcoin(detached.timestamp);
  return {
    confirmed: bitcoin !== null,
    otsProof: Buffer.from(detached.serializeToBytes()),
    bitcoin,
  };
}

/**
 * Parse a stored OTS proof without any network call — used by anchor/verify
 * to read the committed file digest and any attestations straight from the
 * bytes (i.e. not trusting our own DB columns).
 */
export function parseOtsProof(otsProof: Buffer): ParsedOts {
  const detached = DetachedTimestampFile.deserialize(otsProof);
  return {
    fileDigest: Buffer.from(detached.fileDigest()),
    bitcoin: findBitcoin(detached.timestamp),
    pendingUris: pendingUris(detached.timestamp),
  };
}

/** Re-typed alias so handlers can `instanceof`-narrow if needed. */
export type { Attestation };
