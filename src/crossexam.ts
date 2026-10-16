// Directed cross-examination.
//
// Every debate tool we studied runs BROADCAST reactions: each agent is handed the
// transcript and told "react". That produces parallel monologues, and the thing the
// user actually described — the domain expert asking the architect "is this feasible?",
// the researcher answering with where the market is heading — happens only by luck.
//
// So questions are first-class and ROUTED. An agent ends its turn with:
//
//     QUESTIONS
//     @architect: Khối lượng phát sinh phải sửa hồi tố — schema của bạn chịu được không?
//     @researcher: Các ERP xây dựng khác đang xử lý việc này thế nào?
//
// The orchestrator parses those lines and delivers each question to the addressed role
// in the next round as an explicit obligation to answer. That turns a pile of opinions
// into an actual exchange, and makes "who dodged the question" visible in the artifact.

export type Question = { from: string; to: string; text: string };

export type Parsed = {
  questions: Question[];
  /** Questions aimed at a role that is not in this debate — reported, never dropped. */
  unrouted: Question[];
};

const HEADER = /^\s*(?:[#*_\s]*)questions(?:\s*\(.*\))?\s*:?\s*(?:[#*_\s]*)$/i;
// "@architect: text" — also tolerates "- @architect:" and "* @architect -".
const ADDRESSED = /^\s*(?:[-*+]\s*)?@([a-z0-9][a-z0-9_-]*)\s*[:\-–—]\s*(.+?)\s*$/i;

export const DEFAULT_MAX_QUESTIONS = 3;

/**
 * Pull routed questions out of one agent reply.
 *
 * Two passes on purpose. A model that follows the format exactly puts its questions
 * under the header, and only those count — text above it is argument, and an "@name"
 * mentioned mid-sentence there is a citation, not a question. A model that forgets the
 * header still gets its questions routed by the whole-text fallback, because losing a
 * real question to a formatting slip is worse than the occasional false positive.
 */
export function parseQuestions(
  text: string,
  from: string,
  knownRoles: readonly string[],
  maxQuestions = DEFAULT_MAX_QUESTIONS,
): Parsed {
  const lines = text.split(/\r?\n/);
  const headerAt = lines.map((l) => HEADER.test(l)).lastIndexOf(true);

  const collect = (from_: number, to: number): Question[] => {
    const out: Question[] = [];
    for (let i = from_; i < to; i++) {
      const m = lines[i].match(ADDRESSED);
      if (m) out.push({ from, to: m[1].toLowerCase(), text: m[2].trim() });
    }
    return out;
  };

  let found = headerAt >= 0 ? collect(headerAt + 1, lines.length) : [];
  if (found.length === 0) found = collect(0, lines.length);

  const known = new Set(knownRoles);
  const seen = new Set<string>();
  const questions: Question[] = [];
  const unrouted: Question[] = [];

  for (const q of found) {
    if (!q.text || q.to === from) continue; // asking yourself is noise
    const dedupKey = `${q.to}::${q.text.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    // Cap per turn: an agent that emits twenty questions would blow up every
    // downstream prompt, and the first few are reliably the sharpest.
    if (known.has(q.to)) {
      if (questions.length < maxQuestions) questions.push(q);
    } else {
      unrouted.push(q);
    }
  }

  return { questions, unrouted };
}

/** Questions addressed to one role, as a prompt-ready block. */
export function inbox(questions: readonly Question[], roleId: string): Question[] {
  return questions.filter((q) => q.to === roleId);
}

/** Render a role's inbox for injection into its next prompt. */
export function renderInbox(questions: readonly Question[], nameOf: (roleId: string) => string): string {
  if (questions.length === 0) return "";
  const lines = questions.map((q) => `- **${nameOf(q.from)} hỏi bạn:** ${q.text}`);
  return [
    "## Câu hỏi gửi trực tiếp cho bạn",
    "",
    ...lines,
    "",
    "Bạn **buộc phải trả lời từng câu hỏi trên một cách trực tiếp và cụ thể**. Nếu không trả lời được, nói rõ vì sao chưa trả lời được và cần thêm thông tin gì — không được im lặng bỏ qua.",
  ].join("\n");
}

/** Every question raised in a round, for the transcript's audit trail. */
export function renderQuestionLog(questions: readonly Question[], nameOf: (roleId: string) => string): string {
  if (questions.length === 0) return "";
  return questions.map((q) => `- ${nameOf(q.from)} → ${nameOf(q.to)}: ${q.text}`).join("\n");
}
