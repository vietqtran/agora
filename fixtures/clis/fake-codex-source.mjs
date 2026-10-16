#!/usr/bin/env node
// Codex-shaped JSONL fake that reports how the prompt was delivered. Emits once.
const args = process.argv.slice(2);
let stdin = "";
let done = false;
const emit = () => {
  if (done) return;
  done = true;
  const say = (o) => console.log(JSON.stringify(o));
  say({ type: "item.completed", item: { type: "agent_message", text: `dash=${args.includes("-")} stdin=${Buffer.byteLength(stdin)}` } });
  say({ type: "turn.completed", usage: { total_tokens: 1 } });
};
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", emit);
process.stdin.on("error", emit);
setTimeout(emit, 1500);
