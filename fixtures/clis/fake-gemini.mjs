#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "success";
// Lets a test read the argv the adapter built, without changing the answer the other
// tests assert on.
if (mode === "echo-args") { console.log(JSON.stringify({ response: args.join(" ") })); process.exit(0); }
// Sandbox asked for on a host that cannot provide one.
if (mode === "sandbox-missing" && args.includes("--sandbox")) {
  process.stderr.write("Error: Sandbox is enabled but docker is not running\n");
  process.exit(1);
}
if (mode === "error") {
  console.log(JSON.stringify({ error: { type: "ApiError", message: "quota exceeded", code: 429 } }));
  process.exit(1);
}
if (mode === "text-only") { console.log("trả lời dạng văn bản thuần"); process.exit(0); }
if (mode === "turn-limit") { console.log(JSON.stringify({ response: "" })); process.exit(53); }
console.log(JSON.stringify({
  session_id: "s1", response: "trả lời từ gemini",
  stats: { total_tokens: 900, tool_calls: 2 },
}));
