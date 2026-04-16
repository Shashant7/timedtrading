export async function handleCandleReplayRoute({
  req,
  env,
  url,
  requireKeyOrAdmin,
  executeCandleReplayStep,
} = {}) {
  const authFail = await requireKeyOrAdmin(req, env);
  if (authFail) return authFail;
  const body = await req.json().catch(() => ({}));
  return executeCandleReplayStep({ req, env, url, body });
}

export async function handleIntervalReplayRoute({
  req,
  env,
  url,
  requireKeyOrAdmin,
  executeIntervalReplayStep,
} = {}) {
  const authFail = await requireKeyOrAdmin(req, env);
  if (authFail) return authFail;
  return executeIntervalReplayStep({ req, env, url });
}
