// scripts/prompt-key.js — asks for a Stripe key in the terminal without showing it.
// Terminal echo is switched off (stty -echo) while you paste, so the key never appears on screen and never goes
// into the shell history; it is not written anywhere. Only the first 8 characters (the key type, e.g. "rk_test_")
// are shown back to you.

const { spawnSync } = require("child_process");
const readline = require("readline");

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const tty = process.stdin.isTTY;
    const echo = (on) => { if (tty) spawnSync("stty", [on ? "echo" : "-echo"], { stdio: "inherit" }); };
    echo(false);
    const restore = () => echo(true);
    process.on("exit", restore);
    process.on("SIGINT", () => { restore(); process.stdout.write("\n"); process.exit(130); });
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.once("line", (line) => {
      restore();
      rl.close();
      process.stdout.write("\n");
      resolve(String(line).trim());
    });
  });
}

async function getKey(envName, question) {
  let key = (process.env[envName] || "").trim();
  if (!key) {
    key = await askHidden(question);
    console.log(key ? `received a key starting with "${key.slice(0, 8)}" (${key.length} characters)` : "no key received");
  }
  return key;
}

module.exports = { getKey };
