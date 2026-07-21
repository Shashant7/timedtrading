import { describe, it, expect } from "vitest";
import {
  randomCodeVerifier,
  codeChallengeS256,
  parseProtectedResourceMetadata,
  parseAuthServerMetadata,
  authServerMetadataUrls,
  buildAuthorizeUrl,
  buildTokenForm,
  mcpResource,
} from "./bridge-robinhood-auth.js";

describe("PKCE", () => {
  it("code_verifier is URL-safe and long enough (RFC 7636)", () => {
    const v = randomCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("S256 challenge matches the RFC 7636 test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await codeChallengeS256(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("discovery metadata parsing", () => {
  it("parses Protected Resource Metadata (RFC 9728)", () => {
    const prm = parseProtectedResourceMetadata({
      resource: "https://agent.robinhood.com/mcp/trading",
      authorization_servers: ["https://auth.robinhood.com"],
      scopes_supported: ["agentic.read", "agentic.trade"],
    });
    expect(prm.authorization_servers[0]).toBe("https://auth.robinhood.com");
    expect(prm.scopes_supported).toContain("agentic.trade");
  });

  it("builds path-aware well-known URLs (RH serves the path-based form)", () => {
    // RH issuer carries a path; the path-based well-known must come FIRST
    // (the issuer-suffix form 404s on RH).
    const urls = authServerMetadataUrls("https://agent.robinhood.com/mcp/trading");
    expect(urls[0]).toBe("https://agent.robinhood.com/.well-known/oauth-authorization-server/mcp/trading");
    expect(urls).toContain("https://agent.robinhood.com/.well-known/oauth-authorization-server");
    // issuer-suffix form (which 404s on RH) is present only as a last resort.
    expect(urls[urls.length - 1]).toBe("https://agent.robinhood.com/mcp/trading/.well-known/oauth-authorization-server");
  });

  it("parses Authorization Server Metadata (RFC 8414)", () => {
    const as = parseAuthServerMetadata({
      issuer: "https://auth.robinhood.com",
      authorization_endpoint: "https://auth.robinhood.com/authorize",
      token_endpoint: "https://auth.robinhood.com/token",
      registration_endpoint: "https://auth.robinhood.com/register",
      code_challenge_methods_supported: ["S256"],
    });
    expect(as.token_endpoint).toBe("https://auth.robinhood.com/token");
    expect(as.code_challenge_methods_supported).toContain("S256");
  });
});

describe("authorize URL", () => {
  const asMeta = { authorization_endpoint: "https://auth.robinhood.com/authorize" };
  it("includes PKCE S256 + the RFC 8707 resource indicator", () => {
    const url = new URL(buildAuthorizeUrl({
      asMeta, clientId: "cid", redirectUri: "https://bridge/cb",
      scope: "agentic.trade", state: "st", codeChallenge: "chal",
      resource: "https://agent.robinhood.com/mcp/trading",
    }));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://agent.robinhood.com/mcp/trading");
    expect(url.searchParams.get("client_id")).toBe("cid");
  });
});

describe("token form — RFC 8707 resource on EVERY request", () => {
  const resource = "https://agent.robinhood.com/mcp/trading";
  it("authorization_code carries code_verifier + resource", () => {
    const f = buildTokenForm({
      grant: "authorization_code", code: "abc", codeVerifier: "ver",
      clientId: "cid", redirectUri: "https://bridge/cb", resource,
    });
    expect(f.get("grant_type")).toBe("authorization_code");
    expect(f.get("code_verifier")).toBe("ver");
    expect(f.get("resource")).toBe(resource);
  });
  it("refresh_token ALSO carries resource (the common client bug)", () => {
    const f = buildTokenForm({
      grant: "refresh_token", refreshToken: "rt", clientId: "cid", resource,
    });
    expect(f.get("grant_type")).toBe("refresh_token");
    expect(f.get("refresh_token")).toBe("rt");
    expect(f.get("resource")).toBe(resource);
  });
  it("includes client_secret only when confidential", () => {
    const pub = buildTokenForm({ grant: "refresh_token", refreshToken: "rt", clientId: "cid", resource });
    expect(pub.get("client_secret")).toBeNull();
    const conf = buildTokenForm({ grant: "refresh_token", refreshToken: "rt", clientId: "cid", clientSecret: "sec", resource });
    expect(conf.get("client_secret")).toBe("sec");
  });
});

describe("mcpResource", () => {
  it("defaults to the RH agentic MCP URL, env-overridable", () => {
    expect(mcpResource({})).toBe("https://agent.robinhood.com/mcp/trading");
    expect(mcpResource({ RH_MCP_RESOURCE: "https://x/mcp" })).toBe("https://x/mcp");
  });
});
