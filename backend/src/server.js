require("dotenv").config();
const config = require("./config");
const { createApp } = require("./app");

// Settings a production server must have. In development they have safe
// defaults (or are optional), so local setup needs no config — there we only
// warn. See config.js.
const { secrets: secretProblems, production: productionProblems } = config.startupProblems();

if (config.production) {
  const problems = [...secretProblems, ...productionProblems];
  if (problems.length > 0) {
    throw new Error(`Refusing to start: ${problems.join("; ")}.`);
  }
} else if (secretProblems.length > 0) {
  console.warn(`[warn] ${secretProblems.join("; ")}. Generate one with: openssl rand -base64 48`);
}

// In production set HOST=127.0.0.1 so the app is only reachable through
// Caddy (which terminates HTTPS), never directly on this port.
createApp().listen(config.port, config.host, () => {
  console.log(`Cutout website backend listening on ${config.host}:${config.port}`);
});
