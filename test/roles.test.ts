import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRoles, parseRoleFile } from "../src/roles.ts";

const FULL = `---
id: architect
name: Kiến trúc sư
kind: debater
prefer: claude, codex
needs: execute
wants: web
summary: Thiết kế hệ thống
---

Bạn là kiến trúc sư.
`;

test("a full role file parses every field", () => {
  const r = parseRoleFile(FULL, "test.md", "fallback");
  assert.equal(r.id, "architect");
  assert.equal(r.name, "Kiến trúc sư");
  assert.deepEqual(r.prefer, ["claude", "codex"]);
  assert.deepEqual(r.needs, ["execute"]);
  assert.deepEqual(r.wants, ["web"]);
  assert.equal(r.kind, "debater");
  assert.equal(r.body, "Bạn là kiến trúc sư.");
});

test("the filename supplies the id when frontmatter omits it", () => {
  assert.equal(parseRoleFile("---\nname: X\n---\nbody", "t.md", "my-role").id, "my-role");
});

test("defaults fill in for everything optional", () => {
  const r = parseRoleFile("---\nid: x\n---\nbody", "t.md", "x");
  assert.equal(r.kind, "debater");
  assert.deepEqual(r.prefer, []);
  assert.deepEqual(r.needs, []);
});

test("a file with no frontmatter is still a usable persona", () => {
  const r = parseRoleFile("Chỉ có nội dung.", "plain.md", "plain");
  assert.equal(r.id, "plain");
  assert.equal(r.body, "Chỉ có nội dung.");
});

test("an unknown capability is rejected rather than silently dropped", () => {
  assert.throws(() => parseRoleFile("---\nid: x\nneeds: telepathy\n---\nb", "t.md", "x"), /unknown needs telepathy/);
});

test("an invalid kind is rejected", () => {
  assert.throws(() => parseRoleFile("---\nid: x\nkind: boss\n---\nb", "t.md", "x"), /kind must be/);
});

test("an id that could escape a path is rejected", () => {
  assert.throws(() => parseRoleFile("---\nid: ../../etc\n---\nb", "t.md", "x"), /id must be lowercase/);
});

test("an empty body is rejected — there would be no persona to send", () => {
  assert.throws(() => parseRoleFile("---\nid: x\n---\n\n", "t.md", "x"), /role body is empty/);
});

test("a malformed frontmatter line names its line number", () => {
  assert.throws(() => parseRoleFile("---\nid: x\nthis is not a pair\n---\nb", "t.md", "x"), /line 2/);
});

test("comments are allowed in frontmatter", () => {
  const r = parseRoleFile("---\n# a note\nid: x\n---\nb", "t.md", "x");
  assert.equal(r.id, "x");
});

test("the shipped roles all load and the expected ones are present", async () => {
  const roles = await loadRoles(process.cwd());
  for (const id of ["architect", "researcher", "domain-expert", "judge", "product-owner"]) {
    assert.ok(roles.has(id), `missing builtin role ${id}`);
  }
  assert.equal(roles.get("judge")?.kind, "judge");
  assert.deepEqual(roles.get("researcher")?.needs, ["web"], "the researcher must hard-require web");
});
