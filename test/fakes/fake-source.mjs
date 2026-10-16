#!/usr/bin/env node
// Reports HOW it received the prompt, in a claude-shaped envelope, so delivery tests
// can assert argv-vs-stdin without guessing. Emits exactly once.
const args = process.argv.slice(2);
const pIdx = args.indexOf("-p");
const argvPrompt = pIdx >= 0 ? (args[pIdx + 1] ?? "") : "";
let stdin = "";
let done = false;
const emit = () => {
  if (done) return;
  done = true;
  console.log(JSON.stringify({
    is_error: false, subtype: "success",
    result: `argv=${Buffer.byteLength(argvPrompt)} stdin=${Buffer.byteLength(stdin)} dash=${args.includes("-")}`,
  }));
};
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", emit);
process.stdin.on("error", emit);
setTimeout(emit, 1500); // stdio "ignore" can leave the stream without an end event
