#!/usr/bin/env node
// Stands in for `claude -p ... --output-format json`. MODE picks the envelope shape.
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "success";

// Simulates a CLI version that never heard of a flag we pass as optional.
if (mode === "unknown-flag" && args.includes("--no-session-persistence")) {
  process.stderr.write("error: unknown option '--no-session-persistence'\n");
  process.exit(1);
}
if (mode === "exit127") process.exit(127);
if (mode === "hang") { setTimeout(() => {}, 120_000); }
else if (mode === "budget") {
  // Budget exhaustion: NO `result` field at all, message in `errors`, subtype flips.
  console.log(JSON.stringify({
    is_error: true, subtype: "error_max_budget_usd",
    errors: ["Max budget of $2.00 exceeded"], total_cost_usd: 2.0031, num_turns: 7,
  }));
  process.exit(1);
} else if (mode === "liar") {
  // The counterintuitive case: subtype still says "success" while is_error is true.
  console.log(JSON.stringify({ is_error: true, subtype: "success", result: "nửa vời", total_cost_usd: 0.12 }));
  process.exit(0);
} else if (mode === "empty") {
  console.log(JSON.stringify({ is_error: false, subtype: "success", result: "   ", total_cost_usd: 0.01 }));
} else if (mode === "garbage") {
  console.log("not json at all");
} else {
  console.log(JSON.stringify({
    is_error: false, subtype: "success",
    result: `ĐÃ TRẢ LỜI. tools=${args[args.indexOf("--allowedTools") + 1] ?? "none"} model=${args[args.indexOf("--model") + 1] ?? "none"}`,
    total_cost_usd: 0.0425, num_turns: 3, permission_denials: [],
  }));
}
