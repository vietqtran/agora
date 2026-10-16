#!/usr/bin/env node
// Reads the prompt from stdin, proving the stdin prompt mode wires up.
let buf = "";
process.stdin.on("data", (d) => { buf += d; });
process.stdin.on("end", () => console.log(JSON.stringify({ reply: `nhận được: ${buf.trim()}` })));
