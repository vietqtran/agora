#!/usr/bin/env node
// A CLI that leaks a grandchild holding stdout open. Killing only the direct child
// leaves the pipe open, `close` never fires, and the orchestrator hangs at 0% CPU.
// This fake exists to prove the process-GROUP kill actually closes the tree.
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setTimeout(()=>{}, 120000)"], { stdio: "inherit" });
setTimeout(() => {}, 120_000);
