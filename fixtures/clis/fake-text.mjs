#!/usr/bin/env node
// Text-only agent (agy shape). Echoes which flags it received so tests can assert argv.
const args = process.argv.slice(2);
if (process.env.FAKE_MODE === "fail") { process.stderr.write("not logged in\n"); process.exit(1); }
// Flag understood, backend missing. NOT an unknown-flag error, so only an adapter that
// opted into the sandbox retry trigger recovers from this.
if (process.env.FAKE_MODE === "sandbox-missing" && args.includes("--sandbox")) {
  process.stderr.write("failed to start sandbox: podman not found\n");
  process.exit(1);
}
if (process.env.FAKE_MODE === "silent") { process.exit(0); }
console.log(`OK args=${args.join(" ")}`);
