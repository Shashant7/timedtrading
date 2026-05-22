// worker/lib/regime-hmm.js
//
// Hidden Markov Model — Tier 3.6 of the Markov framework. The observable
// Markov in regime-markov.js reverse-engineers the latent regime from
// price (HTF_BULL = above the 21 EMA). That's tractable but it lags
// the true regime — credit conditions, monetary policy, risk appetite
// usually shift before price confirms.
//
// This module is the math primitives for a Gaussian-emission HMM that
// learns BOTH the regime transitions AND the per-regime emission
// distributions from a multi-feature daily sequence, without us
// labeling a single day by hand.
//
// Algorithms:
//   • forwardBackward()   — α and β probability passes (E-step)
//   • viterbi()           — most likely hidden state sequence
//   • baumWelch()         — full EM training (multi-start in
//                           baumWelchMultiStart for local-maxima safety)
//   • multivariateGaussianPDF() — emission likelihood
//
// Reference: Rabiner 1989 ("A tutorial on hidden Markov models…"),
// the Roan article §6, and our 2026-05-22 conversation.
//
// Pure JS, no native dependencies. Vector / matrix ops use plain
// nested arrays — fine for the small models we run (3 states × 4
// emission features × ~365 daily observations).

const LOG_2PI = Math.log(2 * Math.PI);
const MIN_PROB = 1e-12;   // floor to avoid log(0) and div-by-zero
const RIDGE_EPS = 1e-6;   // covariance ridge for numerical stability

// ────────────────────────────────────────────────────────────────────
// Linear algebra primitives (kept minimal; we never exceed 4×4)
// ────────────────────────────────────────────────────────────────────

function _vecAdd(a, b) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}
function _vecSub(a, b) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}
function _vecScale(a, s) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * s;
  return out;
}
function _matZero(n, m) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = new Array(m).fill(0);
  return out;
}
function _outerProduct(u, v) {
  const out = _matZero(u.length, v.length);
  for (let i = 0; i < u.length; i++) {
    for (let j = 0; j < v.length; j++) {
      out[i][j] = u[i] * v[j];
    }
  }
  return out;
}
function _matAddScaled(A, B, scale) {
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < A[0].length; j++) {
      A[i][j] += B[i][j] * scale;
    }
  }
  return A;
}
function _matScale(A, s) {
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < A[0].length; j++) A[i][j] *= s;
  }
  return A;
}

// Determinant + inverse via LU decomposition with partial pivoting.
// Robust enough for the small (≤4×4) covariance matrices we use.
function _luDecompose(A) {
  const n = A.length;
  const L = _matZero(n, n);
  const U = _matZero(n, n);
  const perm = new Array(n);
  for (let i = 0; i < n; i++) { perm[i] = i; L[i][i] = 1; }
  const M = A.map(r => r.slice());
  let sign = 1;
  for (let k = 0; k < n; k++) {
    // pivot
    let maxV = Math.abs(M[k][k]);
    let maxR = k;
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(M[i][k]);
      if (v > maxV) { maxV = v; maxR = i; }
    }
    if (maxV < 1e-14) return null; // singular
    if (maxR !== k) {
      const tmp = M[k]; M[k] = M[maxR]; M[maxR] = tmp;
      const t2 = perm[k]; perm[k] = perm[maxR]; perm[maxR] = t2;
      sign = -sign;
    }
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k];
      L[i][k] = f;
      for (let j = k; j < n; j++) M[i][j] -= f * M[k][j];
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) U[i][j] = M[i][j];
  }
  return { L, U, perm, sign };
}

function _matDeterminant(A) {
  const lu = _luDecompose(A);
  if (!lu) return 0;
  let det = lu.sign;
  for (let i = 0; i < A.length; i++) det *= lu.U[i][i];
  return det;
}

function _matInverse(A) {
  const n = A.length;
  const lu = _luDecompose(A);
  if (!lu) return null;
  const { L, U, perm } = lu;
  const inv = _matZero(n, n);
  for (let col = 0; col < n; col++) {
    // permuted identity column
    const b = new Array(n).fill(0);
    for (let i = 0; i < n; i++) if (perm[i] === col) b[i] = 1;
    // forward solve Ly=b
    const y = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (let j = 0; j < i; j++) s -= L[i][j] * y[j];
      y[i] = s;
    }
    // backward solve Ux=y
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      for (let j = i + 1; j < n; j++) s -= U[i][j] * x[j];
      x[i] = s / U[i][i];
    }
    for (let i = 0; i < n; i++) inv[i][col] = x[i];
  }
  return inv;
}

// Add small ridge to diagonal to keep covariance matrices invertible
// across all training iterations.
function _ridgeCovariance(C, eps = RIDGE_EPS) {
  const n = C.length;
  const out = C.map(r => r.slice());
  for (let i = 0; i < n; i++) out[i][i] += eps;
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Multivariate Gaussian PDF — log-form for numerical stability
// ────────────────────────────────────────────────────────────────────
//
// log p(x | μ, Σ) = -½ [ d·log(2π) + log|Σ| + (x-μ)ᵀ Σ⁻¹ (x-μ) ]
//
// Returns log-density. Caller exponentiates when needed.
export function logMultivariateGaussianPDF(x, mu, covariance) {
  const d = x.length;
  const cov = _ridgeCovariance(covariance);
  const det = _matDeterminant(cov);
  if (!Number.isFinite(det) || det <= 0) return -Infinity;
  const inv = _matInverse(cov);
  if (!inv) return -Infinity;
  const diff = _vecSub(x, mu);
  // diff^T · inv · diff
  let quad = 0;
  for (let i = 0; i < d; i++) {
    let row = 0;
    for (let j = 0; j < d; j++) row += inv[i][j] * diff[j];
    quad += diff[i] * row;
  }
  return -0.5 * (d * LOG_2PI + Math.log(det) + quad);
}

// ────────────────────────────────────────────────────────────────────
// Forward / Backward / Viterbi
// ────────────────────────────────────────────────────────────────────
//
// All implemented in LOG SPACE to handle long sequences without
// underflowing to zero. logSumExp() is the standard trick.

function logSumExp(arr) {
  let maxV = -Infinity;
  for (const v of arr) if (v > maxV) maxV = v;
  if (!Number.isFinite(maxV)) return -Infinity;
  let s = 0;
  for (const v of arr) s += Math.exp(v - maxV);
  return maxV + Math.log(s);
}

/**
 * Forward-backward pass.
 *
 * Inputs:
 *   model.startProbs[]      length K
 *   model.transitionMatrix  K×K
 *   model.means[K]          each length D
 *   model.covariances[K]    each D×D
 *
 *   observations            T×D (each row is an emission vector)
 *
 * Output:
 *   logAlpha       T×K
 *   logBeta        T×K
 *   logPosterior   T×K (γ_t(i) = log P(state=i | observations, model))
 *   logLikelihood  scalar — log P(observations | model)
 *   logXi          (T-1)×K×K  ξ_t(i,j) used by Baum-Welch
 */
export function forwardBackward(model, observations) {
  const K = model.startProbs.length;
  const T = observations.length;
  const D = observations[0].length;

  // Precompute log-emissions
  const logB = _matZero(T, K);
  for (let t = 0; t < T; t++) {
    for (let i = 0; i < K; i++) {
      logB[t][i] = logMultivariateGaussianPDF(observations[t], model.means[i], model.covariances[i]);
    }
  }
  // Forward
  const logAlpha = _matZero(T, K);
  for (let i = 0; i < K; i++) {
    logAlpha[0][i] = Math.log(Math.max(model.startProbs[i], MIN_PROB)) + logB[0][i];
  }
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < K; j++) {
      const terms = new Array(K);
      for (let i = 0; i < K; i++) {
        terms[i] = logAlpha[t - 1][i] + Math.log(Math.max(model.transitionMatrix[i][j], MIN_PROB));
      }
      logAlpha[t][j] = logSumExp(terms) + logB[t][j];
    }
  }
  // Backward
  const logBeta = _matZero(T, K);
  for (let i = 0; i < K; i++) logBeta[T - 1][i] = 0;
  for (let t = T - 2; t >= 0; t--) {
    for (let i = 0; i < K; i++) {
      const terms = new Array(K);
      for (let j = 0; j < K; j++) {
        terms[j] = Math.log(Math.max(model.transitionMatrix[i][j], MIN_PROB)) + logB[t + 1][j] + logBeta[t + 1][j];
      }
      logBeta[t][i] = logSumExp(terms);
    }
  }
  // Likelihood (logSumExp over last α)
  const logLikelihood = logSumExp(logAlpha[T - 1]);

  // γ — log posterior of being in state i at time t
  const logPosterior = _matZero(T, K);
  for (let t = 0; t < T; t++) {
    const terms = new Array(K);
    for (let i = 0; i < K; i++) terms[i] = logAlpha[t][i] + logBeta[t][i];
    const denom = logSumExp(terms);
    for (let i = 0; i < K; i++) logPosterior[t][i] = terms[i] - denom;
  }

  // ξ — log joint of being in (i, j) at (t, t+1)
  const logXi = new Array(T - 1);
  for (let t = 0; t < T - 1; t++) {
    logXi[t] = _matZero(K, K);
    const flat = new Array(K * K);
    for (let i = 0; i < K; i++) {
      for (let j = 0; j < K; j++) {
        const v = logAlpha[t][i]
          + Math.log(Math.max(model.transitionMatrix[i][j], MIN_PROB))
          + logB[t + 1][j]
          + logBeta[t + 1][j];
        logXi[t][i][j] = v;
        flat[i * K + j] = v;
      }
    }
    const denom = logSumExp(flat);
    for (let i = 0; i < K; i++) {
      for (let j = 0; j < K; j++) logXi[t][i][j] -= denom;
    }
  }

  return { logAlpha, logBeta, logPosterior, logXi, logB, logLikelihood };
}

/**
 * Viterbi — most likely hidden state sequence given observations.
 *
 * Returns:
 *   path   length T (state indices)
 *   logProb scalar (log probability of that path)
 */
export function viterbi(model, observations) {
  const K = model.startProbs.length;
  const T = observations.length;
  const logTrans = model.transitionMatrix.map(r =>
    r.map(v => Math.log(Math.max(v, MIN_PROB)))
  );
  const delta = _matZero(T, K);
  const psi = _matZero(T, K);
  for (let i = 0; i < K; i++) {
    delta[0][i] = Math.log(Math.max(model.startProbs[i], MIN_PROB))
      + logMultivariateGaussianPDF(observations[0], model.means[i], model.covariances[i]);
  }
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < K; j++) {
      let best = -Infinity;
      let bestI = 0;
      for (let i = 0; i < K; i++) {
        const v = delta[t - 1][i] + logTrans[i][j];
        if (v > best) { best = v; bestI = i; }
      }
      const emit = logMultivariateGaussianPDF(observations[t], model.means[j], model.covariances[j]);
      delta[t][j] = best + emit;
      psi[t][j] = bestI;
    }
  }
  // Termination
  let best = -Infinity;
  let bestI = 0;
  for (let i = 0; i < K; i++) {
    if (delta[T - 1][i] > best) { best = delta[T - 1][i]; bestI = i; }
  }
  // Backtrack
  const path = new Array(T);
  path[T - 1] = bestI;
  for (let t = T - 2; t >= 0; t--) {
    path[t] = psi[t + 1][path[t + 1]];
  }
  return { path, logProb: best };
}

// ────────────────────────────────────────────────────────────────────
// Baum-Welch (EM)
// ────────────────────────────────────────────────────────────────────
//
// One run from a single initialization. Returns the trained model
// and its log-likelihood. Caller should call this multiple times
// from different inits (baumWelchMultiStart) and keep the best.

export function baumWelch(initModel, observations, opts = {}) {
  const maxIter = Number.isFinite(opts.maxIter) ? opts.maxIter : 80;
  const tol = Number.isFinite(opts.tol) ? opts.tol : 1e-4;
  let model = _cloneModel(initModel);
  const K = model.startProbs.length;
  const T = observations.length;
  const D = observations[0].length;

  let prevLL = -Infinity;
  let lastLL = -Infinity;
  let iters = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    const fb = forwardBackward(model, observations);
    lastLL = fb.logLikelihood;
    if (!Number.isFinite(lastLL)) break;
    iters = iter + 1;
    if (iter > 0 && Math.abs(lastLL - prevLL) < tol) break;

    // M-step
    const newStart = new Array(K).fill(0);
    const newTransNum = _matZero(K, K);
    const newTransDen = new Array(K).fill(0);
    const newMeansNum = new Array(K);
    const newMeansDen = new Array(K).fill(0);
    const newCovsNum = new Array(K);
    for (let i = 0; i < K; i++) {
      newMeansNum[i] = new Array(D).fill(0);
      newCovsNum[i] = _matZero(D, D);
    }

    // Start probs from γ_0
    for (let i = 0; i < K; i++) newStart[i] = Math.exp(fb.logPosterior[0][i]);

    // Transition / Emission updates from γ + ξ
    for (let t = 0; t < T; t++) {
      const gamma = fb.logPosterior[t].map(Math.exp);
      for (let i = 0; i < K; i++) {
        newMeansNum[i] = _vecAdd(newMeansNum[i], _vecScale(observations[t], gamma[i]));
        newMeansDen[i] += gamma[i];
      }
      if (t < T - 1) {
        for (let i = 0; i < K; i++) {
          const denom = Math.exp(fb.logPosterior[t][i]);
          newTransDen[i] += denom;
          for (let j = 0; j < K; j++) {
            newTransNum[i][j] += Math.exp(fb.logXi[t][i][j]);
          }
        }
      }
    }
    // Means
    for (let i = 0; i < K; i++) {
      if (newMeansDen[i] > MIN_PROB) {
        for (let d = 0; d < D; d++) newMeansNum[i][d] /= newMeansDen[i];
      } else {
        newMeansNum[i] = model.means[i].slice();
      }
    }
    // Covariances (second pass with updated means)
    for (let t = 0; t < T; t++) {
      const gamma = fb.logPosterior[t].map(Math.exp);
      for (let i = 0; i < K; i++) {
        const diff = _vecSub(observations[t], newMeansNum[i]);
        const op = _outerProduct(diff, diff);
        _matAddScaled(newCovsNum[i], op, gamma[i]);
      }
    }
    for (let i = 0; i < K; i++) {
      if (newMeansDen[i] > MIN_PROB) {
        _matScale(newCovsNum[i], 1 / newMeansDen[i]);
      } else {
        newCovsNum[i] = model.covariances[i].map(r => r.slice());
      }
    }
    // Transitions
    const newTrans = _matZero(K, K);
    for (let i = 0; i < K; i++) {
      const denom = newTransDen[i] > MIN_PROB ? newTransDen[i] : 1;
      for (let j = 0; j < K; j++) newTrans[i][j] = newTransNum[i][j] / denom;
      // Re-normalize defensively
      const rowSum = newTrans[i].reduce((a, b) => a + b, 0);
      if (rowSum > 0) for (let j = 0; j < K; j++) newTrans[i][j] /= rowSum;
    }
    const startSum = newStart.reduce((a, b) => a + b, 0);
    if (startSum > 0) for (let i = 0; i < K; i++) newStart[i] /= startSum;

    model = {
      startProbs: newStart,
      transitionMatrix: newTrans,
      means: newMeansNum,
      covariances: newCovsNum,
    };
    prevLL = lastLL;
  }
  return { model, logLikelihood: lastLL, iterations: iters };
}

/**
 * baumWelchMultiStart — run Baum-Welch from N random initializations
 * and keep the model with the highest final log-likelihood. The
 * article's §6 warning: a single init frequently lands in a local
 * maximum that misassigns the regimes.
 */
export function baumWelchMultiStart(observations, K, numStarts = 5, opts = {}) {
  let best = null;
  for (let s = 0; s < numStarts; s++) {
    const init = randomInitModel(observations, K, opts.seed != null ? opts.seed + s : null);
    const res = baumWelch(init, observations, opts);
    if (!best || res.logLikelihood > best.logLikelihood) best = res;
  }
  return best;
}

/**
 * randomInitModel — k-means-style init using random observation
 * picks as initial means + a shared empirical covariance.
 */
export function randomInitModel(observations, K, seed) {
  const T = observations.length;
  const D = observations[0].length;
  // Mean + covariance of full sample for init covariance
  const sampleMean = new Array(D).fill(0);
  for (const x of observations) for (let d = 0; d < D; d++) sampleMean[d] += x[d];
  for (let d = 0; d < D; d++) sampleMean[d] /= T;
  const sampleCov = _matZero(D, D);
  for (const x of observations) {
    const diff = _vecSub(x, sampleMean);
    _matAddScaled(sampleCov, _outerProduct(diff, diff), 1 / T);
  }
  // Deterministic when seed provided (LCG)
  const rand = _seededRandom(seed);
  // Pick K distinct observation indices
  const idxs = new Set();
  while (idxs.size < K && idxs.size < T) {
    idxs.add(Math.floor(rand() * T));
  }
  const means = [...idxs].map(i => observations[i].slice());
  const covariances = means.map(() => sampleCov.map(r => r.slice()));
  const startProbs = new Array(K).fill(1 / K);
  // Slightly diagonal-heavy initial transition matrix encourages
  // regime persistence rather than 1-bar flips.
  const transitionMatrix = _matZero(K, K);
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) transitionMatrix[i][j] = i === j ? 0.7 : 0.3 / (K - 1);
  }
  return { startProbs, transitionMatrix, means, covariances };
}

function _seededRandom(seed) {
  // Mulberry32 — small, decent quality, deterministic for given seed
  let t = (Number.isFinite(seed) ? Math.floor(seed) : Date.now()) >>> 0;
  return function () {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function _cloneModel(m) {
  return {
    startProbs: m.startProbs.slice(),
    transitionMatrix: m.transitionMatrix.map(r => r.slice()),
    means: m.means.map(r => r.slice()),
    covariances: m.covariances.map(M => M.map(r => r.slice())),
  };
}

/**
 * Convert a trained model + the latest viterbi path to a compact
 * persistable shape (used by regime-hmm-compute.js when writing to KV).
 */
export function serializeHMM(model, meta = {}) {
  return {
    schema_version: 1,
    K: model.startProbs.length,
    startProbs: model.startProbs,
    transitionMatrix: model.transitionMatrix,
    means: model.means,
    covariances: model.covariances,
    ...meta,
  };
}

export function deserializeHMM(blob) {
  if (!blob || !Array.isArray(blob.startProbs)) return null;
  return {
    startProbs: blob.startProbs,
    transitionMatrix: blob.transitionMatrix,
    means: blob.means,
    covariances: blob.covariances,
  };
}
