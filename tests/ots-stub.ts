/**
 * tests/ots-stub.ts — in-process stub of an OpenTimestamps calendar server
 * plus an Esplora-shaped Bitcoin block explorer.
 *
 * Phase 7 anchoring talks to remote Bitcoin calendars we obviously can't
 * reach (or wait a week on) in CI. This stub speaks just enough of both
 * protocols for the real `opentimestamps` client library to parse its
 * responses, so the submit/upgrade/verify state machine is exercised
 * end-to-end, offline and deterministically.
 *
 * Calendar endpoints:
 *   POST /digest               → serialized Timestamp with a PendingAttestation
 *   GET  /timestamp/<hex>      → 404 (pending) | Timestamp with a Bitcoin
 *                                block attestation (confirmed)
 *
 * Explorer endpoints (Esplora shape):
 *   GET  /block-height/<n>     → block hash (text)
 *   GET  /block/<hash>         → block JSON { height, timestamp, ... }
 */

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Timestamp, Notary, Context, DetachedTimestampFile, Ops } from 'opentimestamps';

export type StubMode = 'pending' | 'confirmed';

export type OtsStub = {
  /** Base URL — use for both OTS_CALENDAR_URLS and BITCOIN_EXPLORER_URL. */
  url: string;
  /** Flip the upgrade response. 'confirmed' attaches a Bitcoin attestation. */
  setMode: (mode: StubMode) => void;
  /** Set the block height the confirmed attestation + explorer report. */
  setBlockHeight: (height: number) => void;
  /** Raw digests received on POST /digest, in order. */
  digestSubmissions: Buffer[];
  /** Count of GET /timestamp polls. */
  upgradePolls: () => number;
  close: () => Promise<void>;
};

function serializeTimestamp(ts: Timestamp): Buffer {
  const ctx = new Context.StreamSerialization();
  ts.serialize(ctx);
  return Buffer.from(ctx.getOutput());
}

/** A calendar's POST /digest response: a Timestamp with one PendingAttestation. */
export function buildPendingResponse(digest: Buffer, calendarUrl: string): Buffer {
  const ts = new Timestamp([...digest]);
  ts.attestations.push(new Notary.PendingAttestation(calendarUrl));
  return serializeTimestamp(ts);
}

/** A calendar's GET /timestamp response once Bitcoin-confirmed. */
export function buildConfirmedResponse(commitment: Buffer, height: number): Buffer {
  const ts = new Timestamp([...commitment]);
  ts.attestations.push(new Notary.BitcoinBlockHeaderAttestation(height));
  return serializeTimestamp(ts);
}

/**
 * Build a serialized DetachedTimestampFile suitable for the
 * ProofAnchor.otsProof column — what a real submit (and optionally a real
 * upgrade) would have stored. Attestations are merged in (not pushed) so
 * the serialized form survives a deserialize roundtrip.
 */
export function buildStoredOtsProof(
  digest: Buffer,
  opts: { confirmed?: boolean; height?: number } = {}
): Buffer {
  const detached = DetachedTimestampFile.fromHash(new Ops.OpSHA256(), digest);

  const pending = new Timestamp([...digest]);
  pending.attestations.push(new Notary.PendingAttestation('http://stub-calendar'));
  detached.timestamp.merge(pending);

  if (opts.confirmed) {
    const btc = new Timestamp([...digest]);
    btc.attestations.push(
      new Notary.BitcoinBlockHeaderAttestation(opts.height ?? 800_000)
    );
    detached.timestamp.merge(btc);
  }

  return Buffer.from(detached.serializeToBytes());
}

function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Deterministic fake block hash for a height. */
function fakeBlockHash(height: number): string {
  return height.toString(16).padStart(64, '0');
}

export async function startOtsStub(): Promise<OtsStub> {
  let mode: StubMode = 'pending';
  let blockHeight = 800_000;
  const digestSubmissions: Buffer[] = [];
  let pollCount = 0;

  let baseUrl = '';

  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    try {
      // ── Calendar: submit ────────────────────────────────────────────
      if (req.method === 'POST' && url === '/digest') {
        const digest = await readBody(req);
        digestSubmissions.push(digest);
        const body = buildPendingResponse(digest, baseUrl);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(body);
        return;
      }

      // ── Calendar: upgrade poll ──────────────────────────────────────
      if (req.method === 'GET' && url.startsWith('/timestamp/')) {
        pollCount += 1;
        if (mode === 'pending') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        const hex = url.slice('/timestamp/'.length);
        const commitment = Buffer.from(hex, 'hex');
        const body = buildConfirmedResponse(commitment, blockHeight);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(body);
        return;
      }

      // ── Explorer: height → hash ─────────────────────────────────────
      if (req.method === 'GET' && url.startsWith('/block-height/')) {
        const h = Number(url.slice('/block-height/'.length));
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(fakeBlockHash(h));
        return;
      }

      // ── Explorer: hash → block JSON ─────────────────────────────────
      if (req.method === 'GET' && url.startsWith('/block/')) {
        const hash = url.slice('/block/'.length);
        const height = parseInt(hash, 16);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: hash,
            height,
            timestamp: 1_700_000_000 + height,
          })
        );
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err instanceof Error ? err.message : String(err));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    url: baseUrl,
    setMode: (m) => {
      mode = m;
    },
    setBlockHeight: (h) => {
      blockHeight = h;
    },
    digestSubmissions,
    upgradePolls: () => pollCount,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}
