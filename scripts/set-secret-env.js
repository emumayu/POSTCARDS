#!/usr/bin/env node
// scripts/set-secret-env.js
//
// Sets a SECRET Netlify environment variable (Functions scope; production, deploy previews and branch deploys)
// without the value ever being shown or typed on the command line: you paste it into a hidden prompt.
//
//   node scripts/set-secret-env.js ANTHROPIC_API_KEY
//
// Needs the Netlify CLI to be logged in (npx netlify status). Redeploy afterwards for the value to take effect.

const { spawnSync } = require("child_process");
const { getKey } = require("./prompt-key");

(async () => {
  const name = process.argv[2];
  if (!name || !/^[A-Z][A-Z0-9_]+$/.test(name)) { console.error("usage: node scripts/set-secret-env.js NAME"); process.exit(1); }
  const value = await getKey("__NO_ENV__", `Value for ${name} (hidden): `);
  if (!value) { console.error("nothing received"); process.exit(1); }
  const r = spawnSync("npx", ["--no-install", "netlify", "env:set", name, value, "--context", "production", "deploy-preview", "branch-deploy", "--secret", "--force"], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) process.exit(r.status || 1);
  console.log(`${name} saved. Push a commit (or redeploy) so the functions pick it up.`);
})();
