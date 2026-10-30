/**
 * Test preload (see bunfig.toml). `config` reads required variables at import
 * time, so they must exist before any test file loads a module that uses it.
 * Values already present in the environment win.
 */
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.SESSION_SECRET ??= "test-only-session-secret";
// A path that doesn't exist: tests start from the defaults, never from a real file.
process.env.CONFIG_FILE ??= "./does-not-exist/punchlist.yaml";
process.env.TZ ??= "America/Los_Angeles";
