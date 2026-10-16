#!/usr/bin/env node
// Thin launcher: keeps `agora` on PATH while the implementation stays plain
// TypeScript that Node runs directly (type-stripping, no build step).
// Node >= 22.18 strips types natively; older Node needs --experimental-strip-types.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, "..", "src", "index.ts"));
