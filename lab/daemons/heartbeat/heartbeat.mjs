// The smallest useful daemon: one structured log line per minute, and a last
// line on SIGTERM. stdout is all it emits; Vercel forwards it to the runtime logs.
let beats = 0;
const log = (msg, extra = {}) =>
  console.log(JSON.stringify({ msg, region: process.env.VERCEL_REGION, beats, ...extra }));

log("daemon started");
const timer = setInterval(() => {
  beats += 1;
  log("heartbeat", { rssBytes: process.memoryUsage().rss });
}, 60_000);

process.on("SIGTERM", () => {
  clearInterval(timer);
  log("daemon stopping");
  process.exit(0);
});
