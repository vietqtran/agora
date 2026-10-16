import { test } from "node:test";
import assert from "node:assert/strict";
import { all, bool, num, one, parseArgs, pins, rounds, ROUND_PRESETS } from "../src/args.ts";

test("a bare topic implies the debate command, so the common case needs no subcommand", () => {
  const p = parseArgs(["Phần mềm ERP cần gì?"]);
  assert.equal(p.command, "debate");
  assert.deepEqual(p.rest, ["Phần mềm ERP cần gì?"]);
});

test("an explicit command is recognised", () => {
  assert.equal(parseArgs(["doctor", "--health"]).command, "doctor");
  assert.equal(parseArgs(["roles"]).command, "roles");
});

test("a topic that starts with a command-like word is still a topic", () => {
  // "roles" first is the command; a topic mentioning it later must not be swallowed.
  const p = parseArgs(["Hệ thống", "roles", "và", "quyền"]);
  assert.equal(p.command, "debate");
  assert.deepEqual(p.rest, ["Hệ thống", "roles", "và", "quyền"]);
});

test("--key value and --key=value are equivalent", () => {
  assert.equal(one(parseArgs(["--lang", "en"]), "lang"), "en");
  assert.equal(one(parseArgs(["--lang=en"]), "lang"), "en");
});

test("short aliases map to long names", () => {
  assert.equal(one(parseArgs(["-f", "brief.md"]), "file"), "brief.md");
  assert.equal(one(parseArgs(["-r", "3"]), "rounds"), "3");
  assert.equal(bool(parseArgs(["-q"]), "quiet"), true);
});

test("boolean flags do not eat the next argument", () => {
  const p = parseArgs(["--dry-run", "chủ đề"]);
  assert.equal(bool(p, "dry-run"), true);
  assert.deepEqual(p.rest, ["chủ đề"]);
});

test("repeatable flags collect every value", () => {
  const p = parseArgs(["-m", "a.md", "-m", "b.md", "--material", "c.md"]);
  assert.deepEqual(all(p, "material"), ["a.md", "b.md", "c.md"]);
});

test("a value-taking flag with no value is an error, not a silent empty string", () => {
  assert.throws(() => parseArgs(["--lang"]), /cần một giá trị/);
  assert.throws(() => parseArgs(["--lang", "--quiet"]), /cần một giá trị/);
});

test("a negative number is still accepted as a value", () => {
  // `-1` must not be mistaken for a flag.
  assert.equal(one(parseArgs(["--timeout", "-1"]), "timeout"), "-1");
});

test("everything after -- is a free argument", () => {
  const p = parseArgs(["debate", "--", "--not-a-flag"]);
  assert.deepEqual(p.rest, ["--not-a-flag"]);
});

test("--pin parses role=provider and rejects malformed input", () => {
  assert.deepEqual(pins(parseArgs(["--pin", "judge=codex", "--pin", "architect=claude"])), {
    judge: "codex",
    architect: "claude",
  });
  assert.throws(() => pins(parseArgs(["--pin", "nonsense"])), /role=provider/);
  assert.throws(() => pins(parseArgs(["--pin", "=codex"])), /role=provider/);
});

test("round presets resolve to counts", () => {
  assert.equal(rounds(parseArgs(["-r", "fast"])), ROUND_PRESETS.fast);
  assert.equal(rounds(parseArgs(["-r", "DEEP"])), ROUND_PRESETS.deep);
  assert.equal(rounds(parseArgs(["-r", "3"])), 3);
  assert.equal(rounds(parseArgs(["-r", "0"])), 0);
  assert.equal(rounds(parseArgs([])), undefined);
});

test("an unusable round value is rejected with the valid options named", () => {
  assert.throws(() => rounds(parseArgs(["-r", "lots"])), /preset/);
  assert.throws(() => rounds(parseArgs(["-r", "-2"])), /số nguyên/);
  assert.throws(() => rounds(parseArgs(["-r", "1.5"])), /số nguyên/);
});

test("num rejects non-numeric values", () => {
  assert.throws(() => num(parseArgs(["--timeout", "x"]), "timeout"), /cần một con số/);
  assert.equal(num(parseArgs(["--timeout", "15"]), "timeout"), 15);
});

test("the last occurrence of a single-value flag wins", () => {
  assert.equal(one(parseArgs(["--lang", "en", "--lang", "vi"]), "lang"), "vi");
});
