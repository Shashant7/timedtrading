#!/usr/bin/env node
/**
 * Admin helper: ingest a local PDF into the CRO pipeline via
 * POST /timed/admin/cro/ingest-from-blob → extract → optional apply.
 *
 * Usage:
 *   TIMED_API_KEY=... node scripts/cro-ingest-pdf-blob.js \
 *     --pdf docs/reference-pdfs/20260611-Sector-Allocation-June.pdf \
 *     --title "June 2026 Sector Allocation Update" \
 *     --base https://timed-trading-ingest.shashant.workers.dev \
 *     --extract --apply
 */
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    pdf: null,
    title: null,
    base: process.env.TIMED_WORKER_URL || "https://timed-trading-ingest.shashant.workers.dev",
    extract: false,
    apply: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pdf") out.pdf = argv[++i];
    else if (a === "--title") out.title = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--extract") out.extract = true;
    else if (a === "--apply") out.apply = true;
  }
  return out;
}

async function postJson(base, route, body, apiKey) {
  const resp = await fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Timed-Key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  if (!resp.ok) throw new Error(`${route} -> HTTP ${resp.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.TIMED_API_KEY;
  if (!apiKey) {
    console.error("TIMED_API_KEY is required");
    process.exit(1);
  }
  if (!args.pdf) {
    console.error("--pdf is required");
    process.exit(1);
  }
  const abs = path.resolve(args.pdf);
  const bytes = fs.readFileSync(abs);
  const body_bytes_b64 = Buffer.from(bytes).toString("base64");
  const title = args.title || path.basename(abs, path.extname(abs));

  console.log(`Ingesting ${abs} (${bytes.length} bytes) ...`);
  const ingest = await postJson(args.base, "/timed/admin/cro/ingest-from-blob", {
    title,
    source_url: `file://${abs}`,
    content_type: "application/pdf",
    body_bytes_b64,
  }, apiKey);
  console.log("ingest:", ingest);

  const pubId = ingest.pub_id;
  if (!pubId) process.exit(1);

  if (args.extract) {
    console.log(`Extracting pub_id=${pubId} ...`);
    const ext = await postJson(args.base, "/timed/admin/cro/extract", {
      pub_id: pubId,
      force: true,
    }, apiKey);
    console.log("extract:", ext);

    if (args.apply && ext.proposal_id) {
      console.log(`Approving proposal ${ext.proposal_id} ...`);
      const app = await postJson(args.base, "/timed/admin/cro/proposal/approve", {
        proposal_id: ext.proposal_id,
      }, apiKey);
      console.log("approve:", app);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
