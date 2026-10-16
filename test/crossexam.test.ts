import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuestions, inbox, renderInbox } from "../src/crossexam.ts";

const ROLES = ["architect", "researcher", "domain-expert"];

test("questions under the QUESTIONS header are routed to the named roles", () => {
  const text = [
    "Phân tích của tôi...",
    "",
    "QUESTIONS",
    "@architect: Schema của bạn chịu được sửa hồi tố không?",
    "@researcher: Thị trường đang đi theo hướng nào?",
  ].join("\n");
  const { questions, unrouted } = parseQuestions(text, "domain-expert", ROLES);
  assert.deepEqual(questions.map((q) => q.to), ["architect", "researcher"]);
  assert.equal(questions[0].from, "domain-expert");
  assert.match(questions[0].text, /hồi tố/);
  assert.equal(unrouted.length, 0);
});

test("the header is recognised through markdown decoration", () => {
  for (const header of ["## QUESTIONS", "**QUESTIONS**", "QUESTIONS:", "   questions   "]) {
    const { questions } = parseQuestions(`${header}\n@architect: x?`, "researcher", ROLES);
    assert.equal(questions.length, 1, `header variant failed: ${header}`);
  }
});

test("list markers and dash separators are tolerated", () => {
  const text = "QUESTIONS\n- @architect: câu a?\n* @researcher - câu b?";
  const { questions } = parseQuestions(text, "domain-expert", ROLES);
  assert.deepEqual(questions.map((q) => q.to), ["architect", "researcher"]);
});

test("text above the header is argument, not questions", () => {
  // An "@architect" mentioned while arguing is a citation. Counting it would route a
  // sentence fragment as a question and oblige the other agent to answer prose.
  const text = ["Tôi đồng ý với @architect: thiết kế đó hợp lý.", "", "QUESTIONS", "@researcher: nguồn nào?"].join("\n");
  const { questions } = parseQuestions(text, "domain-expert", ROLES);
  assert.deepEqual(questions.map((q) => q.to), ["researcher"]);
});

test("a forgotten header still gets questions routed", () => {
  // Losing a real question to a formatting slip is worse than a rare false positive.
  const text = "Tôi muốn hỏi:\n@architect: có khả thi không?";
  const { questions } = parseQuestions(text, "domain-expert", ROLES);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].to, "architect");
});

test("the last QUESTIONS block wins when a model repeats itself", () => {
  const text = ["QUESTIONS", "@architect: cũ?", "", "Suy nghĩ lại...", "", "QUESTIONS", "@researcher: mới?"].join("\n");
  const { questions } = parseQuestions(text, "domain-expert", ROLES);
  assert.deepEqual(questions.map((q) => q.to), ["researcher"]);
});

test("asking yourself is dropped", () => {
  const { questions } = parseQuestions("QUESTIONS\n@architect: tự hỏi?", "architect", ROLES);
  assert.equal(questions.length, 0);
});

test("a question to a role not in this debate is reported, never silently dropped", () => {
  const { questions, unrouted } = parseQuestions("QUESTIONS\n@lawyer: hợp pháp chứ?", "architect", ROLES);
  assert.equal(questions.length, 0);
  assert.equal(unrouted.length, 1);
  assert.equal(unrouted[0].to, "lawyer");
});

test("duplicates are collapsed", () => {
  const text = "QUESTIONS\n@architect: Trùng?\n@architect: trùng?";
  const { questions } = parseQuestions(text, "researcher", ROLES);
  assert.equal(questions.length, 1);
});

test("the per-turn cap bounds prompt growth", () => {
  const lines = ["QUESTIONS", ...Array.from({ length: 10 }, (_, i) => `@architect: câu ${i}?`)];
  const { questions } = parseQuestions(lines.join("\n"), "researcher", ROLES, 3);
  assert.equal(questions.length, 3);
});

test("an empty question body is not a question", () => {
  const { questions } = parseQuestions("QUESTIONS\n@architect:   ", "researcher", ROLES);
  assert.equal(questions.length, 0);
});

test("no QUESTIONS block and no addressed lines yields nothing", () => {
  const { questions, unrouted } = parseQuestions("Chỉ là phân tích bình thường.", "architect", ROLES);
  assert.equal(questions.length, 0);
  assert.equal(unrouted.length, 0);
});

test("inbox filters to the addressed role", () => {
  const qs = [
    { from: "a", to: "architect", text: "x" },
    { from: "b", to: "researcher", text: "y" },
  ];
  assert.deepEqual(inbox(qs, "architect"), [qs[0]]);
  assert.deepEqual(inbox(qs, "nobody"), []);
});

test("an empty inbox renders to nothing, so no empty section reaches the prompt", () => {
  assert.equal(renderInbox([], (id) => id), "");
});

test("a rendered inbox names the asker and demands an answer", () => {
  const out = renderInbox([{ from: "domain-expert", to: "architect", text: "khả thi?" }], (id) =>
    id === "domain-expert" ? "Chuyên gia nghiệp vụ" : id,
  );
  assert.match(out, /Chuyên gia nghiệp vụ hỏi bạn/);
  assert.match(out, /khả thi\?/);
  assert.match(out, /buộc phải trả lời/);
});
