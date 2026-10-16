// How a prompt physically reaches the CLI.
//
// Passing the prompt as an argv string is the simplest path and what every reference
// implementation does, but it breaks at exactly the point this tool gets interesting:
//
//   * Linux caps a SINGLE argv entry at 128 KiB (MAX_ARG_STRLEN), regardless of the
//     much larger total ARG_MAX. A round-3 prompt carries the whole transcript plus the
//     user's background documents, so 128 KiB is reachable in ordinary use — and the
//     failure is an opaque E2BIG from spawn, three rounds deep into a paid run.
//   * argv is world-readable in `ps`. On a shared build server, the user's internal
//     business material would be visible to every other account on the box.
//
// So: argv while the prompt is comfortably small (the well-trodden path), stdin once it
// is not. Both forms are documented for claude, codex and gemini — stdin is read as
// additional context alongside the `-p` instruction, and `codex exec -` takes the whole
// prompt from stdin.

/**
 * Switch to stdin above this many bytes. Set well under Linux's 131 072-byte per-arg
 * limit: the prompt is not the only argv entry, and multi-byte UTF-8 (Vietnamese text
 * averages well over one byte per character) makes the byte count the only safe measure.
 */
export const PROMPT_ARGV_LIMIT = 96_000;

/** Short instruction left in argv when the body moves to stdin. */
export const STDIN_POINTER =
  "Nội dung yêu cầu đầy đủ được truyền qua stdin. Hãy đọc toàn bộ nội dung đó và thực hiện đúng yêu cầu trong đó.";

export type Delivery = {
  /** The prompt text to place in argv, or null when it goes to stdin instead. */
  argvPrompt: string | null;
  /** Text to feed on stdin, or undefined to leave stdin at /dev/null. */
  stdin?: string;
  /** True when the prompt had to move off argv — surfaced in diagnostics. */
  viaStdin: boolean;
};

/**
 * Decide the delivery for one prompt. `force` lets a config pin stdin for every turn
 * (worth doing on a shared host, where argv visibility is the concern rather than size).
 */
export function deliverPrompt(prompt: string, force?: "argv" | "stdin"): Delivery {
  const bytes = Buffer.byteLength(prompt, "utf8");
  const useStdin = force === "stdin" || (force !== "argv" && bytes > PROMPT_ARGV_LIMIT);
  if (!useStdin) return { argvPrompt: prompt, viaStdin: false };
  return { argvPrompt: STDIN_POINTER, stdin: prompt, viaStdin: true };
}

/**
 * Explain an argv-too-long failure in terms the user can act on. Node surfaces E2BIG
 * as a spawn error, which otherwise reads as a mysterious "binary not runnable".
 */
export function argvTooLongHint(prompt: string, providerLabel: string): string {
  const kb = Math.round(Buffer.byteLength(prompt, "utf8") / 1024);
  return (
    `prompt dài ${kb} KB vượt giới hạn tham số dòng lệnh của hệ điều hành, và ${providerLabel} ` +
    `không hỗ trợ nhận prompt qua stdin. Hãy giảm --rounds, bớt tư liệu -m, hoặc chọn runtime khác cho vai này.`
  );
}

/** Did the OS refuse the argv because it was too long? */
export function isArgvTooLong(stderr: string): boolean {
  return /E2BIG|argument list too long/i.test(stderr);
}
