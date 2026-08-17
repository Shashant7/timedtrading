// worker/review/trade-review-github.js
//
// File a one-pager as a GitHub issue and, when the operator marks it
// agent-ready, hand it to a coding agent.
//
// Reuses the GITHUB_TOKEN / GITHUB_REPO pair already configured for the
// screener workflow dispatch. Requires the token to carry issues:write.

const AGENT_READY_LABEL = "agent-ready";
const SOURCE_LABEL = "trade-review";

function githubApiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "timed-trading-trade-review",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function normalizeGithubRepo(raw) {
  const s = String(raw || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  return /^[\w.-]+\/[\w.-]+$/.test(s) ? s : "";
}

const flagOn = (v) => v === true || String(v ?? "").toLowerCase() === "true";

export function githubFilingEnabled(env) {
  const cfg = env?._deepAuditConfig || {};
  return flagOn(cfg.trade_review_github_enabled ?? env?.TRADE_REVIEW_GITHUB_ENABLED ?? false);
}

/**
 * Create the issue. Labels are best-effort: a repo without the label
 * defined still gets the issue, because losing the requirement is worse
 * than losing the tag.
 */
export async function createGithubIssue(env, { title, body, labels = [] }) {
  const token = env?.GITHUB_TOKEN || env?.GITHUB_PAT;
  const repo = normalizeGithubRepo(env?.GITHUB_REPO);
  if (!token || !repo) {
    return { ok: false, error: "github_not_configured", hint: "Set GITHUB_TOKEN (secret) + GITHUB_REPO (owner/repo)" };
  }
  if (!title || !body) return { ok: false, error: "missing_title_or_body" };

  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: githubApiHeaders(token),
      body: JSON.stringify({
        title: String(title).slice(0, 250),
        body: String(body).slice(0, 60_000),
        labels: Array.from(new Set([SOURCE_LABEL, ...labels])).slice(0, 10),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `github_http_${resp.status}`, detail: text.slice(0, 300) };
    }
    const data = await resp.json();
    return { ok: true, number: data?.number ?? null, url: data?.html_url || null };
  } catch (e) {
    const aborted = e?.name === "AbortError" || e?.name === "TimeoutError";
    return { ok: false, error: aborted ? "github_timeout" : String(e?.message || e).slice(0, 200) };
  }
}

export async function addIssueLabel(env, issueNumber, label) {
  const token = env?.GITHUB_TOKEN || env?.GITHUB_PAT;
  const repo = normalizeGithubRepo(env?.GITHUB_REPO);
  if (!token || !repo || !issueNumber) return { ok: false, error: "github_not_configured" };
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/issues/${Number(issueNumber)}/labels`, {
      method: "POST",
      headers: githubApiHeaders(token),
      body: JSON.stringify({ labels: [String(label)] }),
      signal: AbortSignal.timeout(10_000),
    });
    return resp.ok ? { ok: true } : { ok: false, error: `github_http_${resp.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Hand an agent-ready one-pager to a Cursor background agent.
 *
 * Optional: only fires when CURSOR_API_KEY is present. Without it the
 * issue simply carries the agent-ready label and a human (or a scheduled
 * automation watching that label) picks it up — the label is the contract,
 * the dispatch is an accelerator.
 */
export async function dispatchAgent(env, { title, body, issueUrl }) {
  const key = env?.CURSOR_API_KEY;
  if (!key) return { ok: false, error: "cursor_api_key_missing", skipped: true };
  const repo = normalizeGithubRepo(env?.GITHUB_REPO);
  if (!repo) return { ok: false, error: "github_repo_missing" };

  const prompt = [
    `Implement the following one-page requirement filed by the Trade Review Agent.`,
    issueUrl ? `Source issue: ${issueUrl}` : null,
    ``,
    `# ${title}`,
    ``,
    body,
    ``,
    `Follow AGENTS.md: plan in tasks/ first, flag-gate the behaviour default OFF, add unit tests pinning the cited trade, validate with a replay arm, and open a PR.`,
  ].filter(Boolean).join("\n");

  try {
    const resp = await fetch("https://api.cursor.com/v0/agents", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: { text: prompt.slice(0, 20_000) },
        source: { repository: `https://github.com/${repo}`, ref: "main" },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `cursor_http_${resp.status}`, detail: text.slice(0, 300) };
    }
    const data = await resp.json().catch(() => ({}));
    return { ok: true, agent_id: data?.id || null, agent_url: data?.target?.url || data?.url || null };
  } catch (e) {
    const aborted = e?.name === "AbortError" || e?.name === "TimeoutError";
    return { ok: false, error: aborted ? "cursor_timeout" : String(e?.message || e).slice(0, 200) };
  }
}

/**
 * File a stored one-pager: create the issue, apply agent-ready when asked,
 * optionally dispatch the coding agent, and record all of it on the row.
 */
export async function fileProposal(env, { proposalId, agentReady = false, dispatch = false }) {
  if (!env?.DB || !proposalId) return { ok: false, error: "bad_args" };
  const row = await env.DB.prepare(
    `SELECT * FROM trade_review_proposals WHERE proposal_id = ?1`
  ).bind(String(proposalId)).first().catch(() => null);
  if (!row) return { ok: false, error: "proposal_not_found" };
  if (!githubFilingEnabled(env)) {
    return { ok: false, error: "github_filing_disabled", hint: "Set model_config trade_review_github_enabled=true" };
  }

  const now = Date.now();
  let issue = { ok: true, number: row.github_issue_number, url: row.github_url };
  if (!row.github_issue_number) {
    issue = await createGithubIssue(env, {
      title: row.title,
      body: row.body_md,
      labels: agentReady ? [AGENT_READY_LABEL] : [],
    });
    if (!issue.ok) {
      await env.DB.prepare(
        `UPDATE trade_review_proposals SET status = 'error', github_error = ?2, updated_at = ?3 WHERE proposal_id = ?1`
      ).bind(String(proposalId), String(issue.error || "").slice(0, 200), now).run().catch(() => {});
      return { ok: false, error: issue.error, detail: issue.detail || null };
    }
  } else if (agentReady) {
    await addIssueLabel(env, row.github_issue_number, AGENT_READY_LABEL);
  }

  let dispatched = null;
  if (agentReady && dispatch) {
    dispatched = await dispatchAgent(env, { title: row.title, body: row.body_md, issueUrl: issue.url });
  }

  const status = agentReady ? "agent_ready" : "filed";
  await env.DB.prepare(
    `UPDATE trade_review_proposals
        SET status = ?2, github_issue_number = ?3, github_url = ?4, github_error = NULL,
            agent_dispatched_at = ?5, agent_dispatch_ref = ?6, updated_at = ?7
      WHERE proposal_id = ?1`
  ).bind(
    String(proposalId), status, issue.number ?? null, issue.url ?? null,
    dispatched?.ok ? now : null, dispatched?.agent_id || dispatched?.agent_url || null, now,
  ).run().catch(() => {});

  return {
    ok: true,
    proposal_id: proposalId,
    status,
    issue_number: issue.number ?? null,
    issue_url: issue.url ?? null,
    agent: dispatched,
  };
}

export { AGENT_READY_LABEL };
