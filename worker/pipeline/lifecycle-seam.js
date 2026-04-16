import { buildTradeContext } from "./trade-context.js";
import { evaluateExit } from "./exit-engine.js";

function syncTradeRefPendingCounters(openPosition) {
  if (!openPosition?.__tradeRef || typeof openPosition.__tradeRef !== "object") return;
  openPosition.__tradeRef.ripster_pending_5_12 = openPosition.ripster_pending_5_12 || 0;
  openPosition.__tradeRef.ripster_pending_34_50 = openPosition.ripster_pending_34_50 || 0;
}

function annotatePipelineDecision(tickerData, exitResult) {
  if (!tickerData || !exitResult) return;
  const stage = String(exitResult.stage || "");
  const reason = exitResult.reason || stage;
  tickerData.__pipeline_lifecycle_stage = stage;
  tickerData.__pipeline_lifecycle_reason = reason;
  tickerData.__pipeline_lifecycle_family = exitResult.family || "";
}

function applyHandledLifecycleDecision(tickerData, exitResult) {
  if (!tickerData || !exitResult) return;
  const stage = String(exitResult.stage || "");
  const reason = exitResult.reason || stage;
  tickerData.__exit_reason = reason;
  tickerData.__exit_family = exitResult.family || "";
  if (stage === "trim") tickerData.__trim_reason = reason;
  if (stage === "defend") tickerData.__defend_reason = reason;
}

function applyInlineFallbackHints(tickerData, exitResult, isSoftFuseDeferredReason) {
  if (!tickerData || !exitResult) return;
  const stage = String(exitResult.stage || "");
  const reason = exitResult.reason || stage;
  if (stage === "defend") {
    tickerData.__defend_reason = reason;
    if (typeof isSoftFuseDeferredReason === "function" && isSoftFuseDeferredReason(reason)) {
      tickerData.__force_defend_stage = true;
      tickerData.__exit_family = exitResult.family || "tt_context";
    }
    return;
  }
  if (stage === "trim") tickerData.__pipeline_trim_reason_hint = reason;
  if (stage === "exit") tickerData.__pipeline_exit_reason_hint = reason;
}

export function runLifecycleEngineSeam({
  tickerData,
  openPosition,
  now,
  managementEngine,
  isSoftFuseDeferredReason,
}) {
  const supportsPipeline = managementEngine === "tt_core" || managementEngine === "ripster_core";
  const allowInlineFallback = managementEngine === "tt_core";
  const continueInlineFallback = managementEngine === "ripster_core" || allowInlineFallback;
  if (!supportsPipeline) {
    return {
      handled: false,
      continueInlineFallback: false,
      result: null,
      error: null,
    };
  }

  try {
    const exitCtx = buildTradeContext(tickerData, now);
    const exitResult = evaluateExit(exitCtx, openPosition);
    syncTradeRefPendingCounters(openPosition);
    if (!exitResult?.stage) {
      return {
        handled: false,
        continueInlineFallback,
        result: null,
        error: null,
      };
    }

    annotatePipelineDecision(tickerData, exitResult);
    if (!allowInlineFallback) {
      applyHandledLifecycleDecision(tickerData, exitResult);
      return {
        handled: true,
        continueInlineFallback: false,
        stage: String(exitResult.stage || ""),
        result: exitResult,
        error: null,
      };
    }

    applyInlineFallbackHints(tickerData, exitResult, isSoftFuseDeferredReason);
    return {
      handled: false,
      continueInlineFallback: true,
      stage: String(exitResult.stage || ""),
      result: exitResult,
      error: null,
    };
  } catch (error) {
    return {
      handled: false,
      continueInlineFallback,
      result: null,
      error,
    };
  }
}
