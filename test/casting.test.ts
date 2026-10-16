import { test } from "node:test";
import assert from "node:assert/strict";
import { cast, eligibleFor, type AvailableProvider } from "../src/casting.ts";
import type { Role } from "../src/roles.ts";

const role = (over: Partial<Role> & { id: string }): Role => ({
  name: over.id,
  prefer: [],
  needs: [],
  wants: [],
  summary: "",
  kind: "debater",
  body: "persona",
  source: "test",
  ...over,
});

const prov = (key: string, over: Partial<AvailableProvider> = {}): AvailableProvider => ({
  key,
  label: key,
  vendor: key,
  caps: { execute: true, web: true, reportsCost: false },
  ...over,
});

test("a role gets its first preference when that runtime is installed", () => {
  const r = cast({
    roles: [role({ id: "architect", prefer: ["claude", "codex"] })],
    available: [prov("codex"), prov("claude")],
  });
  assert.equal(r.debaters[0].provider, "claude");
  assert.match(r.debaters[0].reason, /ưu tiên #1/);
});

test("an unavailable favourite steps down the preference list, it does not fail", () => {
  const r = cast({
    roles: [role({ id: "architect", prefer: ["claude", "codex", "antigravity"] })],
    available: [prov("antigravity")],
  });
  assert.equal(r.debaters[0].provider, "antigravity");
  assert.equal(r.unfilled.length, 0);
});

test("an eligible runtime no role ever heard of is still usable", () => {
  const r = cast({
    roles: [role({ id: "architect", prefer: ["claude"] })],
    available: [prov("opencode")],
  });
  assert.equal(r.debaters[0].provider, "opencode");
  assert.match(r.debaters[0].reason, /không nằm trong danh sách ưu tiên/);
});

test("diversity first: three roles on three runtimes never double up", () => {
  const r = cast({
    roles: [
      role({ id: "architect", prefer: ["claude", "codex", "antigravity"] }),
      role({ id: "researcher", prefer: ["codex", "claude", "antigravity"] }),
      role({ id: "domain", prefer: ["antigravity", "claude", "codex"] }),
    ],
    available: [prov("claude"), prov("codex"), prov("antigravity")],
  });
  assert.deepEqual(
    r.debaters.map((b) => b.provider),
    ["claude", "codex", "antigravity"],
  );
  assert.ok(r.debaters.every((b) => !b.shared));
  assert.equal(r.warnings.length, 0);
});

test("one runtime installed degrades to a shared lineup instead of aborting", () => {
  const r = cast({
    roles: [role({ id: "architect", prefer: ["claude"] }), role({ id: "researcher", prefer: ["codex"] })],
    available: [prov("claude")],
  });
  assert.equal(r.debaters.length, 2);
  assert.ok(r.debaters.every((b) => b.provider === "claude"));
  // The first seat is not "shared" yet; the second one reuses the runtime.
  assert.equal(r.debaters[1].shared, true);
  assert.equal(r.unfilled.length, 0);
  assert.ok(r.warnings.some((w) => /kém độc lập/.test(w)), "must warn that the debate is not independent");
});

test("--no-shared leaves the extra seat empty rather than faking independence", () => {
  const r = cast({
    roles: [role({ id: "architect" }), role({ id: "researcher" })],
    available: [prov("claude")],
    allowShared: false,
  });
  assert.equal(r.debaters.length, 1);
  assert.equal(r.unfilled.length, 1);
  assert.equal(r.unfilled[0].roleId, "researcher");
});

test("an unmet hard need leaves the seat empty — a researcher with no web is a fabrication risk", () => {
  const r = cast({
    roles: [role({ id: "researcher", prefer: ["codex"], needs: ["web"] })],
    available: [prov("local", { caps: { execute: true, web: false, reportsCost: false } })],
  });
  assert.equal(r.debaters.length, 0);
  assert.equal(r.unfilled.length, 1);
  assert.match(r.unfilled[0].reason, /web/);
});

test("the most constrained role is served first", () => {
  // Only `codex` has web. If the unconstrained architect were cast first and happened
  // to take codex, the researcher — which cannot work without web — would be left out.
  const roles = [
    role({ id: "architect", prefer: ["codex", "local"] }),
    role({ id: "researcher", prefer: ["codex"], needs: ["web"] }),
  ];
  const r = cast({
    roles,
    available: [prov("codex"), prov("local", { caps: { execute: true, web: false, reportsCost: false } })],
  });
  assert.equal(r.debaters.find((b) => b.roleId === "researcher")?.provider, "codex");
  assert.equal(r.debaters.find((b) => b.roleId === "architect")?.provider, "local");
  assert.equal(r.unfilled.length, 0);
});

test("output keeps the user's declared role order even though casting reorders internally", () => {
  const r = cast({
    roles: [
      role({ id: "architect", prefer: ["codex", "local"] }),
      role({ id: "researcher", prefer: ["codex"], needs: ["web"] }),
    ],
    available: [prov("codex"), prov("local", { caps: { execute: true, web: false, reportsCost: false } })],
  });
  assert.deepEqual(r.debaters.map((b) => b.roleId), ["architect", "researcher"]);
});

test("wants are granted only when the runtime can actually deliver them", () => {
  const r = cast({
    roles: [role({ id: "domain", wants: ["web", "execute"] })],
    available: [prov("textonly", { caps: { execute: false, web: true, reportsCost: false } })],
  });
  assert.deepEqual(r.debaters[0].grants, { web: true, execute: false });
});

test("a capability neither needed nor wanted is never switched on", () => {
  const r = cast({ roles: [role({ id: "architect" })], available: [prov("claude")] });
  assert.deepEqual(r.debaters[0].grants, { web: false, execute: false });
});

test("a pin overrides the preference order", () => {
  const r = cast({
    roles: [role({ id: "domain", prefer: ["claude"] })],
    available: [prov("claude"), prov("antigravity")],
    pins: { domain: "antigravity" },
  });
  assert.equal(r.debaters[0].provider, "antigravity");
  assert.match(r.debaters[0].reason, /ghim/);
});

test("a pin to a missing runtime warns and falls back instead of dying", () => {
  const r = cast({
    roles: [role({ id: "domain", prefer: ["claude"] })],
    available: [prov("claude")],
    pins: { domain: "antigravity" },
  });
  assert.equal(r.debaters[0].provider, "claude");
  assert.ok(r.warnings.some((w) => /không khả dụng/.test(w)));
});

test("a pin that cannot satisfy the role's hard need is refused", () => {
  const r = cast({
    roles: [role({ id: "researcher", prefer: ["codex"], needs: ["web"] })],
    available: [prov("codex"), prov("local", { caps: { execute: true, web: false, reportsCost: false } })],
    pins: { researcher: "local" },
  });
  assert.equal(r.debaters[0].provider, "codex");
  assert.ok(r.warnings.some((w) => /thiếu/.test(w)));
});

test("the judge prefers a runtime that did not debate", () => {
  const r = cast({
    roles: [role({ id: "architect", prefer: ["claude"] }), role({ id: "researcher", prefer: ["codex"] })],
    judgeRole: role({ id: "judge", kind: "judge", prefer: ["claude", "codex", "antigravity"] }),
    available: [prov("claude"), prov("codex"), prov("antigravity")],
  });
  assert.equal(r.judge?.provider, "antigravity");
  assert.equal(r.judge?.shared, false);
  assert.equal(r.warnings.length, 0);
});

test("a judge forced onto a debater's runtime is flagged as grading its own argument", () => {
  const r = cast({
    roles: [role({ id: "architect", prefer: ["claude"] }), role({ id: "researcher", prefer: ["codex"] })],
    judgeRole: role({ id: "judge", kind: "judge", prefer: ["claude"] }),
    available: [prov("claude"), prov("codex")],
  });
  assert.equal(r.judge?.shared, true);
  assert.ok(r.warnings.some((w) => /thiên vị/.test(w)));
});

test("a single-vendor lineup is warned about, because that is the whole value proposition", () => {
  const r = cast({
    roles: [role({ id: "a", prefer: ["claude-a"] }), role({ id: "b", prefer: ["claude-b"] })],
    available: [prov("claude-a", { vendor: "anthropic" }), prov("claude-b", { vendor: "anthropic" })],
  });
  assert.ok(r.warnings.some((w) => /kém độc lập/.test(w)));
});

test("a lone role is called a monologue", () => {
  const r = cast({ roles: [role({ id: "a" })], available: [prov("claude")] });
  assert.ok(r.warnings.some((w) => /độc thoại/.test(w)));
});

test("retired runtimes sort last among equals", () => {
  const options = eligibleFor(role({ id: "x", prefer: [] }), [
    prov("gemini", { deprecated: "retired" }),
    prov("antigravity"),
  ]);
  assert.equal(options[0].key, "antigravity");
});

test("an empty machine yields no bindings and no crash", () => {
  const r = cast({ roles: [role({ id: "architect" })], available: [] });
  assert.equal(r.debaters.length, 0);
  assert.equal(r.unfilled.length, 1);
});
