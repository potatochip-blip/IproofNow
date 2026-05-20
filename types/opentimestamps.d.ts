/**
 * Minimal type shim for the `opentimestamps` npm package (v0.4.9), which
 * ships no types of its own.
 *
 * This covers exactly the surface lib/ots/* calls — nothing more. If the
 * OTS library is ever swapped, this file and lib/ots/client.ts are
 * rewritten together; no other call site imports `opentimestamps`.
 */
declare module 'opentimestamps' {
  export interface Attestation {
    /** PendingAttestation — the calendar URI still being waited on. */
    uri?: string;
    /** BitcoinBlockHeaderAttestation — the confirmed block height. */
    height?: number;
  }

  export interface Timestamp {
    msg: number[] | Uint8Array;
    /** Attestations directly on this node. */
    attestations: Attestation[];
    /** Child timestamps keyed by the op that produced them. */
    ops: Map<unknown, Timestamp>;
    merge(other: Timestamp): void;
    /** Map keyed by msg — co-located attestations collide; walk `ops` instead. */
    allAttestations(): Map<unknown, Attestation>;
    getAttestations(): Set<Attestation>;
    serialize(ctx: StreamSerialization): void;
    isTimestampComplete(): boolean;
  }

  export class DetachedTimestampFile {
    timestamp: Timestamp;
    static fromHash(
      fileHashOp: Ops.Op,
      hash: Buffer | number[] | Uint8Array
    ): DetachedTimestampFile;
    static deserialize(bytes: Buffer | Uint8Array): DetachedTimestampFile;
    serializeToBytes(): Uint8Array;
    fileDigest(): Uint8Array;
  }

  export namespace Ops {
    export class Op {}
    export class OpSHA256 extends Op {}
  }

  export namespace Notary {
    export class TimeAttestation {}
    export class PendingAttestation extends TimeAttestation {
      uri: string;
      constructor(uri: string);
    }
    export class BitcoinBlockHeaderAttestation extends TimeAttestation {
      height: number;
      constructor(height: number);
    }
  }

  export class StreamSerialization {
    getOutput(): Uint8Array;
  }
  export class StreamDeserialization {
    constructor(bytes: Buffer | Uint8Array);
  }
  export namespace Context {
    export { StreamSerialization, StreamDeserialization };
  }

  export namespace Calendar {
    export class RemoteCalendar {
      url: string;
      /** `request`-library socket timeout in ms; unset by default. */
      timeout?: number;
      constructor(url: string);
      submit(digest: Buffer | number[] | Uint8Array): Promise<Timestamp>;
      getTimestamp(
        commitment: Buffer | number[] | Uint8Array
      ): Promise<Timestamp>;
    }
  }

  export class Timestamp {
    constructor(msg: number[] | Uint8Array);
  }

  /**
   * `stamp` / `upgrade` / `verify` are methods on the module object — they
   * call `this.upgradeTimestamp(...)` internally, so they must be invoked
   * as `OpenTimestamps.upgrade(...)`, never as a destructured free function
   * (that loses `this`). They live on the default export only.
   */
  interface OpenTimestampsModule {
    stamp(
      detached: DetachedTimestampFile,
      options?: { calendars?: string[]; m?: number }
    ): Promise<void>;
    upgrade(
      detached: DetachedTimestampFile,
      options?: { calendars?: string[] }
    ): Promise<boolean>;
  }

  const OpenTimestamps: OpenTimestampsModule;
  export default OpenTimestamps;
}
