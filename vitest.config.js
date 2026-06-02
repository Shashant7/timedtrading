// vitest configuration for the trading worker.
//
// We use Node-mode tests (not the @cloudflare/vitest-pool-workers
// runtime) for two reasons:
//   1) The modules under test (worker/discovery/*, worker/coo/*) are
//      plain ES modules that operate on injected env objects. Mocking
//      D1 + KV with stubs gives us full coverage without spinning up
//      a Workers runtime per test.
//   2) Tests must run on the cloud-agent runner without wrangler
//      access, so we cannot depend on the miniflare-backed pool.
//
// Tests live alongside the modules they cover as `*.test.js`. The
// build script (scripts/build-frontend.js) does NOT run tests; the
// `npm test` script does, and CI/deploy invokes `npm test` before
// `npm run deploy`.

export default {
  test: {
    include: ["worker/**/*.test.js", "scripts/**/*.test.js", "tests/**/*.test.js"],
    environment: "node",
    environmentMatchGlobs: [
      // React component tests need a DOM (jsdom). All other tests run
      // in the lighter node environment. See react-hooks-discovery.test.js.
      ["tests/react-*.test.js", "jsdom"],
    ],
    globals: true,
    testTimeout: 20000,
    reporters: ["default"],
  },
};
