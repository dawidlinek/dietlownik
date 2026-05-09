// start.js — Combined entrypoint for the dietlownik web server + daily scraper scheduler.
//
// Runs both:
//   1. Next.js standalone server (node server.js)
//   2. Daily scraper scheduler (tsx scraper/index.ts --repeat)
//
// Usage:
//   node start.js
//
// Environment variables:
//   SCRAPE_SCHEDULER=0   — disable the scraper scheduler (web server only)

import { spawn } from "node:child_process";

const serverProc = spawn("node", ["server.js"], {
  env: { ...process.env },
  stdio: "inherit",
});

const schedulerProc = spawn(
  "node",
  ["node_modules/.bin/tsx", "scraper/index.ts", "--repeat"],
  {
    env: { ...process.env, SCRAPE_SCHEDULER: "1" },
    stdio: "inherit",
  }
);

const shutdown = (signal) => {
  console.log(`\n[start] Received ${signal} — shutting down...`);
  serverProc.kill("SIGTERM");
  schedulerProc.kill("SIGTERM");
};

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});

serverProc.on("exit", (code) => {
  if (code !== 0) {
    console.error(`[start] server.js exited with code ${code}`);
  }
  schedulerProc.kill("SIGTERM");
  process.exit(code ?? 1);
});

schedulerProc.on("exit", (code) => {
  console.error(`[start] scraper scheduler exited with code ${code}`);
  serverProc.kill("SIGTERM");
  process.exit(code ?? 1);
});
