// Write-elision fingerprints for `ticker_latest`.
//
// 2026-09-23 — this used to be the payload itself. `d1UpsertTickerLatest`
// cached `${stage}|${len}|${payloadJson}` per ticker so it could skip a D1
// write when the row had not changed, which is worth doing (the TV ingest
// path would otherwise rewrite the same row on every bar). But the cache is
// module-scope, so it outlives the invocation that filled it, and production
// `ticker_latest` is 332 rows averaging 157 KB — 52 MB of strings resident in
// a 128 MB isolate before any invocation starts work. That is what made two
// otherwise identical `*/5` ticks differ: one crossed the cap, one did not.
//
// A fingerprint only has to answer "is this byte-identical to the row I last
// wrote for this ticker in this isolate?", and a digest answers it in ~40
// bytes. Same elision, ~4000x less memory.
//
// A collision would skip one D1 write and self-heal on the next differing
// payload. Each ticker is only ever compared against its OWN previous value,
// so this is ~332 independent pairwise comparisons per tick and not a
// birthday problem; at 128 bits plus the exact length, the probability is nil.

// cyrb128 — four 32-bit lanes mixed together. Pure `charCodeAt`, so it reads
// the string in place instead of encoding it into a byte buffer first.
function hash128(str) {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

// Length stays in the clear: it is free, it is the cheapest possible
// discriminator, and it keeps the fingerprint readable in a log.
export function d1PayloadFingerprint(stage, payloadJson) {
  const s = typeof payloadJson === "string" ? payloadJson : "";
  const [a, b, c, d] = hash128(s);
  const digest =
    a.toString(36) + b.toString(36) + c.toString(36) + d.toString(36);
  return `${stage || ""}|${s.length}|${digest}`;
}
