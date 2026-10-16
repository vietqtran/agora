#!/usr/bin/env node
// Text-only agent (agy shape). Echoes which flags it received so tests can assert argv.
const args = process.argv.slice(2);
if (process.env.FAKE_MODE === "fail") { process.stderr.write("not logged in\n"); process.exit(1); }
if (process.env.FAKE_MODE === "silent") { process.exit(0); }
console.log(`OK args=${args.join(" ")}`);
