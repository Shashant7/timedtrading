// worker/lib/regime-hmm-compute.js
//
// Phase C compute job — trains a Gaussian-emission HMM on the daily
// emission series (regime-hmm-features.js) and persists the model +
// the latest Viterbi-decoded latent state to KV.
//
// Cron cadence:
//   Train  — once per week (Sundays 05:00 UTC, light enough for D1)
//   Decode — once per day (tucked into runDataLifecycle after the
//            Markov P matrix rebuild, so trail_5m_facts breadth is
//            fresh)
//
// KV keys:
//   timed:regime:hmm:model:v1     full serialized HMM
//   timed:regime:hmm:latest        most recent decoded state + posterior
//
// Latent state labels:
//   We don't manually label the K=3 states — Baum-Welch finds them
//   from data. After training we POST-LABEL by sorting the learned
//   states by their mean SPY 1-day return:
//     highest mean return → "BULL_TREND"
//     middle               → "CHOP"
//     lowest  mean return  → "BEAR_TREND"
//   Stable, reproducible. The article's §6 stresses that the math
//   doesn't care about labels — only relative ordering of regimes.
//
// AI CIO surface:
//   `latent_regime` is read by buildCIOMemory() so every CIO
//   evaluation has the macro context. We don't change the prompt
//   template — the field just appears in the memory object and the
//   prompt naturally includes whatever memory carries.

import { baumWelchMultiStart, viterbi, serializeHMM, deserializeHMM, forwardBackward } from "./regime-hmm.js";
import { buildEmissionSeries, HMM_FEATURE_NAMES, HMM_D } from "./regime-hmm-features.js";

const HMM_K = 3;
const HMM_NUM_STARTS = 6;
const HMM_MAX_ITER = 150;
const HMM_TOL = 1e-4;

const MODEL_KV_KEY = "timed:regime:hmm:model:v1";
const LATENT_KV_KEY = "timed:regime:hmm:latest";
const MODEL_TTL_SECONDS = 60 * 24 * 3600; // 60 days — weekly refresh
const LATENT_TTL_SECONDS = 14 * 24 * 3600; // 14 days

// In-isolate cache so the scoring path can attach `latent_regime` to
// trade evaluations without per-tick KV round-trips.
let _cachedLatent = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

const LABEL_BULL = "BULL_TREND";
const LABEL_CHOP = "CHOP";
const LABEL_BEAR = "BEAR_TREND";

function _labelStates(model) {
  // SPY 1-day return is the first feature. Sort state indices by it.
  const ranked = model.means
    .map((mu, i) => ({ i, retMean: mu[0] }))
    .sort((a, b) => b.retMean - a.retMean);
  const labels = new Array(model.startProbs.length);
  if (ranked.length === 3) {
    labels[ranked[0].i] = LABEL_BULL;
    labels[ranked[1].i] = LABEL_CHOP;
    labels[ranked[2].i] = LABEL_BEAR;
  } else {
    // For K != 3 fall back to numeric labels; should never happen
    // unless someone changes HMM_K.
    for (let i = 0; i < labels.length; i++) labels[ranked[i].i] = `REGIME_${i}`;
  }
  return labels;
}

/**
 * trainAndPersistHMM — full retrain.
 *
 * @param {object} env
 * @param {object} [opts]
 * @returns {Promise<{ ok, ... }>}
 */
export async function trainAndPersistHMM(env, opts = {}) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, error: "no_kv_binding" };

  const featuresRes = await buildEmissionSeries(env, { windowDays: opts.windowDays || 365 });
  if (!featuresRes.rows || featuresRes.rows.length < 60) {
    return {
      ok: false,
      error: "insufficient_features",
      rows: featuresRes.rows?.length || 0,
      dropped: featuresRes.dropped,
      sources: featuresRes.sources,
    };
  }
  const observations = featuresRes.rows.map(r => r.features);
  const t0 = Date.now();
  const best = baumWelchMultiStart(observations, HMM_K, opts.numStarts || HMM_NUM_STARTS, {
    maxIter: opts.maxIter || HMM_MAX_ITER,
    tol: opts.tol || HMM_TOL,
    seed: opts.seed != null ? opts.seed : 1,
  });
  const trainMs = Date.now() - t0;
  if (!best || !Number.isFinite(best.logLikelihood)) {
    return { ok: false, error: "baum_welch_failed" };
  }

  const labels = _labelStates(best.model);
  const blob = serializeHMM(best.model, {
    K: HMM_K,
    feature_names: HMM_FEATURE_NAMES.slice(),
    labels,
    train_rows: observations.length,
    train_log_lik: best.logLikelihood,
    train_iterations: best.iterations,
    train_ms: trainMs,
    window_days: featuresRes.window_days,
    trained_at: Date.now(),
  });

  try {
    await KV.put(MODEL_KV_KEY, JSON.stringify(blob), { expirationTtl: MODEL_TTL_SECONDS });
  } catch (e) {
    return { ok: false, error: "kv_put_failed", details: String(e?.message || e).slice(0, 300) };
  }
  // Decode the latest sequence immediately so consumers don't have to
  // wait for the daily decode cron.
  const decodeRes = await decodeAndPersistLatentRegime(env, { observations, labels, model: best.model });

  console.log(`[HMM] Trained K=${HMM_K} on ${observations.length} rows in ${trainMs}ms (logLik=${best.logLikelihood.toFixed(2)}, iters=${best.iterations})`);
  return {
    ok: true,
    train_rows: observations.length,
    train_log_lik: best.logLikelihood,
    train_iterations: best.iterations,
    train_ms: trainMs,
    labels,
    sources: featuresRes.sources,
    decode: decodeRes,
  };
}

/**
 * decodeLatestLatentRegime — runs Viterbi against the current model
 * + latest features and returns the result. Used by the daily decode
 * cron and the manual admin endpoint.
 *
 * `inProcess` form (passes already-loaded model + observations) avoids
 * redundant work when called immediately after training.
 */
export async function decodeAndPersistLatentRegime(env, inProcess = null) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, error: "no_kv_binding" };

  let model, labels, observations;
  if (inProcess && inProcess.model && inProcess.observations && inProcess.labels) {
    model = inProcess.model;
    labels = inProcess.labels;
    observations = inProcess.observations;
  } else {
    const blob = await KV.get(MODEL_KV_KEY, "json");
    if (!blob) return { ok: false, error: "no_model" };
    const m = deserializeHMM(blob);
    if (!m) return { ok: false, error: "bad_model_blob" };
    model = m;
    labels = Array.isArray(blob.labels) ? blob.labels : _labelStates(m);
    const featuresRes = await buildEmissionSeries(env, { windowDays: 180 });
    observations = featuresRes.rows.map(r => r.features);
    if (observations.length < 30) return { ok: false, error: "insufficient_features_for_decode" };
  }

  const fb = forwardBackward(model, observations);
  const vit = viterbi(model, observations);
  const tLast = observations.length - 1;
  const posteriorLast = fb.logPosterior[tLast].map(Math.exp);
  const posteriorByLabel = {};
  for (let i = 0; i < model.startProbs.length; i++) {
    posteriorByLabel[labels[i]] = +posteriorLast[i].toFixed(4);
  }
  const stateIdx = vit.path[tLast];
  const label = labels[stateIdx];

  const payload = {
    schema_version: 1,
    state: label,
    state_idx: stateIdx,
    posterior: posteriorByLabel,
    log_likelihood: fb.logLikelihood,
    sequence_length: observations.length,
    decoded_at: Date.now(),
    feature_snapshot: observations[tLast],
    feature_names: HMM_FEATURE_NAMES.slice(),
  };
  try {
    await KV.put(LATENT_KV_KEY, JSON.stringify(payload), { expirationTtl: LATENT_TTL_SECONDS });
  } catch (e) {
    return { ok: false, error: "kv_put_failed", details: String(e?.message || e).slice(0, 300) };
  }
  // Update in-isolate cache so the next scoring tick reads instantly.
  _cachedLatent = payload;
  _cachedAt = Date.now();
  console.log(`[HMM] Decoded latent regime: ${label} (posterior=${JSON.stringify(posteriorByLabel)}, T=${observations.length})`);
  return { ok: true, ...payload };
}

/**
 * loadLatentRegime — convenience read for the scoring path / CIO.
 * Returns null when no model has been trained yet.
 */
export async function loadLatentRegime(env, opts = {}) {
  const force = !!opts.force;
  const now = Date.now();
  if (!force && _cachedLatent && (now - _cachedAt) < CACHE_TTL_MS) return _cachedLatent;
  const KV = env?.KV_TIMED;
  if (!KV) return null;
  try {
    const v = await KV.get(LATENT_KV_KEY, "json");
    if (v && v.state) {
      _cachedLatent = v;
      _cachedAt = now;
      return v;
    }
  } catch (e) {
    console.warn("[HMM] loadLatentRegime failed:", String(e?.message || e).slice(0, 150));
  }
  return null;
}

export { MODEL_KV_KEY, LATENT_KV_KEY };
