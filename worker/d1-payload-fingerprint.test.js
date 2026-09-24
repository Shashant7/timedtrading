// The write-elision fingerprint for `ticker_latest`.
//
// Production `ticker_latest` on 2026-09-23: 332 rows, 52,291,932 bytes of
// payload_json, averaging 157 KB and peaking at 196 KB. The fingerprint cache
// is module-scope and holds one entry per ticker, so storing the payload put
// 52 MB of the isolate's 128 MB permanently out of reach. These tests pin both
// halves of the fix: the digest still discriminates, and it is small.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { d1PayloadFingerprint } from "./d1-payload-fingerprint.js";

const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");

describe("d1PayloadFingerprint", () => {
  it("is stable for the same input", () => {
    const pl = JSON.stringify({ ticker: "NBIS", score: 7.2, bars: [1, 2, 3] });
    expect(d1PayloadFingerprint("ranked", pl)).toBe(
      d1PayloadFingerprint("ranked", pl),
    );
  });

  it("changes when the payload changes", () => {
    const a = JSON.stringify({ ticker: "NBIS", score: 7.2 });
    const b = JSON.stringify({ ticker: "NBIS", score: 7.3 });
    expect(d1PayloadFingerprint("ranked", a)).not.toBe(
      d1PayloadFingerprint("ranked", b),
    );
  });

  it("changes when only the stage changes", () => {
    // A stage flip has to force a write even when the payload is byte-identical
    // — kanban_stage is its own column.
    const pl = JSON.stringify({ ticker: "NBIS", score: 7.2 });
    expect(d1PayloadFingerprint("ranked", pl)).not.toBe(
      d1PayloadFingerprint("watch", pl),
    );
  });

  it("discriminates a single flipped character deep inside a 157 KB payload", () => {
    // The average production row. A hash that only sampled the head or tail
    // would pass every other test here and silently stop electing writes.
    const big = "x".repeat(157000);
    const mutated = `${big.slice(0, 90000)}y${big.slice(90001)}`;
    expect(big.length).toBe(mutated.length);
    expect(d1PayloadFingerprint("ranked", big)).not.toBe(
      d1PayloadFingerprint("ranked", mutated),
    );
  });

  it("discriminates transposed characters", () => {
    // Additive hashes (a plain checksum) miss this; cyrb128 mixes position in.
    expect(d1PayloadFingerprint("s", "ab")).not.toBe(
      d1PayloadFingerprint("s", "ba"),
    );
  });

  it("keeps the exact length in the clear as a first-pass discriminator", () => {
    const fp = d1PayloadFingerprint("ranked", "z".repeat(1234));
    expect(fp.startsWith("ranked|1234|")).toBe(true);
  });

  it("treats a missing stage and a missing payload as usable input", () => {
    expect(d1PayloadFingerprint(null, null)).toBe(d1PayloadFingerprint("", ""));
    expect(() => d1PayloadFingerprint(undefined, undefined)).not.toThrow();
  });

  it("does not collide across a realistic universe of distinct payloads", () => {
    // 332 tickers, each a distinct payload. Any collision here would mean a
    // ticker's row silently stops being written.
    const seen = new Set();
    for (let i = 0; i < 332; i++) {
      seen.add(
        d1PayloadFingerprint(
          "ranked",
          JSON.stringify({ ticker: `T${i}`, score: i / 7, pad: "p".repeat(500) }),
        ),
      );
    }
    expect(seen.size).toBe(332);
  });

  it("does not collide across payloads that differ only in one numeric field", () => {
    // The realistic tick-to-tick delta: same shape, one price moved.
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      seen.add(
        d1PayloadFingerprint("ranked", JSON.stringify({ t: "NBIS", px: 100 + i * 0.01 })),
      );
    }
    expect(seen.size).toBe(2000);
  });

  it("is a fixed small size regardless of payload size", () => {
    // The whole point. 196 KB was the production max.
    const small = d1PayloadFingerprint("ranked", "{}");
    const huge = d1PayloadFingerprint("ranked", "x".repeat(196416));
    expect(small.length).toBeLessThan(48);
    expect(huge.length).toBeLessThan(48);
  });

  it("holds the whole production universe in kilobytes, not tens of megabytes", () => {
    // 332 rows x 157 KB was 52 MB resident in a 128 MB isolate. Same cache,
    // same key count, measured on the fingerprint strings alone.
    let bytes = 0;
    for (let i = 0; i < 332; i++) {
      bytes += d1PayloadFingerprint("ranked", "x".repeat(157000) + i).length;
    }
    expect(bytes).toBeLessThan(64 * 1024);
  });
});

describe("index.js uses the digest at every fingerprint site", () => {
  it("imports the helper", () => {
    expect(src).toContain(
      'import { d1PayloadFingerprint } from "./d1-payload-fingerprint.js";',
    );
  });

  it("never rebuilds a fingerprint by interpolating the payload", () => {
    // The exact shape of the leak, in both the single-row upsert and the
    // deferred batch sync. If either comes back the isolate goes back to
    // carrying the universe.
    expect(src).not.toContain("|${payloadJson ? payloadJson.length : 0}|${payloadJson || \"\"}");
    expect(src).not.toContain("|${_pj.length}|${_pj}");
  });

  it("builds the single-row upsert fingerprint from the helper, twice", () => {
    // Once to compare before writing, once to record after a successful write.
    const uses = src.split("d1PayloadFingerprint(stage, payloadJson)").length - 1;
    expect(uses).toBe(2);
  });

  it("builds the batch-sync fingerprint from the helper", () => {
    expect(src).toContain("d1PayloadFingerprint(_stage, _pj)");
  });

  it("keeps the batch path's recorded fingerprints as digests", () => {
    // `_bindFps` is pushed per ticker and held until the D1 batch resolves, so
    // payload-valued entries were a transient spike on top of the resident cost.
    const i = src.indexOf("_bindFps.push(_fp);");
    expect(i).toBeGreaterThan(0);
    const fpDecl = src.lastIndexOf("const _fp = ", i);
    expect(src.slice(fpDecl, i)).toContain("d1PayloadFingerprint(");
  });

  it("still bounds the cache by entry count", () => {
    // Smaller entries are not a licence to keep unbounded keys.
    expect(src).toContain("if (_d1LatestFingerprintCache.size > 500) {");
    expect(src).toContain("while (_d1LatestFingerprintCache.size > 500) {");
  });
});
