#!/usr/bin/env node
// Stands in for `codex exec --json`: JSONL on stdout.
const mode = process.env.FAKE_MODE ?? "success";
const say = (o) => console.log(JSON.stringify(o));

if (mode === "turn-failed") {
  say({ type: "item.completed", item: { type: "agent_message", text: "một phần" } });
  say({ type: "turn.failed", error: { message: "rate limit reached" } });
  process.exit(0);
}
if (mode === "no-turn-completed") {
  say({ type: "item.completed", item: { type: "agent_message", text: "câu trả lời" } });
  process.exit(0);
}
if (mode === "error-event") {
  say({ type: "error", message: "stream broke" });
  process.exit(0);
}
// Happy path: started events MUST NOT be counted, only completed ones.
say({ type: "item.started", item: { type: "command_execution", command: "ls" } });
say({ type: "item.completed", item: { type: "command_execution", command: "ls" } });
say({ type: "item.completed", item: { type: "web_search", query: "xu hướng ERP" } });
say({ type: "item.completed", item: { type: "reasoning", text: "nghĩ" } });
say({ type: "item.completed", item: { type: "agent_message", text: "bản nháp" } });
console.log("plain noise line that is not json");
say({ type: "item.completed", item: { type: "agent_message", text: "CÂU TRẢ LỜI CUỐI" } });
say({ type: "turn.completed", usage: { total_tokens: 1234 } });
