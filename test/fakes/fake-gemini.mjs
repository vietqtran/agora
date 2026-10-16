#!/usr/bin/env node
const mode = process.env.FAKE_MODE ?? "success";
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
