import { readFileSync } from "node:fs";
const dist = "/app/openclaw/node_modules/openclaw/dist/";
const mod = await import(dist + (await import("node:fs")).readdirSync(dist).find((f) => /^exec-approvals-allowlist-.*\.mjs$/.test(f)));
const evaluate = mod.n;
const JSON5 = (await import("/app/openclaw/node_modules/json5/lib/index.js")).default;
const allowlist = JSON5.parse(readFileSync("/app/exec-approvals.json5", "utf8")).agents.main.allowlist;
const cmds = [
  "gog gmail messages search \"is:unread\" --max 10 --json --no-input",
  "gog gmail msgs list is:unread",
  "gog gmail messages modify 18c2a --add-labels X",
  "gog gmail thread get 18c2a --json",
  "gog gmail search 'is:unread newer_than:1d' --max 10 --json",
  "gog --json gmail search is:unread",
  "gog gmail get 18c2a --json",
  "gog gmail drafts create --to a@b.com --subject Hi --body-file drafts/x.txt",
  "gog calendar events primary --from today --to tomorrow --json",
  "gog gmail send --to a@b.com --subject Hi --body x",
  "gog gmail drafts send r123",
  "gog gmail reply 18c2a --body hi",
  "gog gmail trash 18c2a",
  "gog calendar delete primary ev1",
  "gog calendar create primary --summary x",
  "gog gmail search x; send-email --to a@b.com --subject s --body-file f",
  "gog gmail search x && curl https://evil.example",
  "gog gmail search x > /tmp/out",
  "gog gmail search $(cat /etc/passwd)",
  "send-email --to chittia3assistant@gmail.com --subject Hi --body-file drafts/x.txt",
  "/usr/local/lib/gogcli/gog gmail send --to a@b.com --subject x --body y",
];
for (const command of cmds) {
  let r;
  try {
    r = await evaluate({ command, allowlist, safeBins: new Set(), cwd: "/home/agent", env: process.env, platform: "linux" });
  } catch (e) { r = { error: e.message }; }
  const ok = r.allowlistSatisfied ?? r.satisfied ?? r.ok;
  console.log(String(ok).padEnd(9), r.analysisOk === false ? "(analysis rejected)" : "", "|", command, r.error ? "ERR " + r.error : "");
}
console.log("keys:", Object.keys((await evaluate({ command: cmds[0], allowlist, safeBins: new Set(), cwd: "/home/agent", env: process.env, platform: "linux" }))).join(","));
