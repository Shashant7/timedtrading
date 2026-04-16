export function createReplayExecutors({
  runCandleReplayStepImpl,
  runIntervalReplayStepImpl,
} = {}) {
  if (typeof runCandleReplayStepImpl !== "function") {
    throw new Error("runCandleReplayStepImpl is required");
  }
  if (typeof runIntervalReplayStepImpl !== "function") {
    throw new Error("runIntervalReplayStepImpl is required");
  }

  return {
    async executeCandleReplayStep(args) {
      return runCandleReplayStepImpl(args);
    },
    async executeIntervalReplayStep(args) {
      return runIntervalReplayStepImpl(args);
    },
  };
}
