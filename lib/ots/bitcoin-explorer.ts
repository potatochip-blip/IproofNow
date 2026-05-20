/**
 * lib/ots/bitcoin-explorer.ts — thin read-only Bitcoin block lookup.
 *
 * Used by anchor/verify (and best-effort by the upgrade handler) to confirm
 * that the block an OTS receipt attests to actually exists, and to recover
 * the block hash + time from a height. This is the "lite verification"
 * half: we trust a public explorer for block existence rather than running
 * a full node. The OTS receipt itself remains independently verifiable with
 * the `ots` CLI by anyone wanting the full cryptographic merkle check.
 *
 * Default endpoint is the Esplora API shape (blockstream.info), overridable
 * via BITCOIN_EXPLORER_URL so a self-hosted Esplora can be swapped in.
 */

const DEFAULT_EXPLORER = 'https://blockstream.info/api';
const EXPLORER_TIMEOUT_MS = 10_000;

export type BitcoinBlock = {
  height: number;
  blockHash: string;
  /** Block header time, unix seconds. */
  time: number;
};

function explorerBase(): string {
  return (process.env.BITCOIN_EXPLORER_URL ?? DEFAULT_EXPLORER).replace(/\/+$/, '');
}

async function explorerFetch(path: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPLORER_TIMEOUT_MS);
  try {
    return await fetch(`${explorerBase()}${path}`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a Bitcoin block by height. Returns null when the explorer has no
 * block at that height (or the lookup fails) — callers treat null as
 * "could not confirm" rather than "tampered".
 */
export async function getBlockByHeight(height: number): Promise<BitcoinBlock | null> {
  try {
    const hashRes = await explorerFetch(`/block-height/${height}`);
    if (!hashRes.ok) return null;
    const blockHash = (await hashRes.text()).trim();
    if (!/^[0-9a-f]{64}$/.test(blockHash)) return null;

    const blockRes = await explorerFetch(`/block/${blockHash}`);
    if (!blockRes.ok) return null;
    const block = (await blockRes.json()) as { height?: number; timestamp?: number };
    if (typeof block.height !== 'number' || typeof block.timestamp !== 'number') {
      return null;
    }
    return { height: block.height, blockHash, time: block.timestamp };
  } catch {
    return null;
  }
}
