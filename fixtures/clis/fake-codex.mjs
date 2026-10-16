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
if (mode === "model-rejected") {
  // Verbatim shape from codex 0.145.0 when the account cannot use the pinned model.
  say({ type: "item.completed", item: { type: "error", message: "Model metadata for `gpt-5.5` not found." } });
  say({ type: "turn.failed", error: { message: "{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.\"}}" } });
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
