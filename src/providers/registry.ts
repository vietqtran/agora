// The known-runtime registry. Adding a CLI here makes it visible everywhere at once:
// detection, doctor, role casting, config generation. Nothing else needs to change.

import { claudeProvider } from "./claude.ts";
import { codexProvider } from "./codex.ts";
import { antigravityProvider, geminiProvider } from "./google.ts";
import { customProvider } from "./custom.ts";
import { mockProvider } from "./mock.ts";
import type { Agent, ProviderDef, ProviderSpec } from "./types.ts";

export const PROVIDERS: ProviderDef[] = [
  claudeProvider,
  codexProvider,
  antigravityProvider,
  geminiProvider,
  customProvider,
  mockProvider,
];

/** Runtimes we can go looking for on a machine. `custom` is declared, not discovered; */
/** `mock` is in-process. Both are excluded from discovery. */
export const DISCOVERABLE = PROVIDERS.filter((p) => p.key !== "custom" && p.key !== "mock");

const BY_KEY = new Map(PROVIDERS.map((p) => [p.key, p]));

export function providerDef(key: string): ProviderDef {
  const def = BY_KEY.get(key);
  if (!def) {
    throw new Error(`unknown provider "${key}" (known: ${PROVIDERS.map((p) => p.key).join(", ")})`);
  }
  return def;
}

export function isKnownProvider(key: string): boolean {
  return BY_KEY.has(key);
}

/** Instantiate a runnable agent, applying run-wide defaults the spec did not set. */
export function buildAgent(spec: ProviderSpec, defaults: Partial<ProviderSpec> = {}): Agent {
  const merged: ProviderSpec = { ...defaults, ...spec };
  return providerDef(merged.provider).make(merged);
}
