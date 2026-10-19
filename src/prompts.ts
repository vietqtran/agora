// Prompt construction.
//
// Shaped for the actual job: gathering and stress-testing knowledge BEFORE building
// software. The reference tools we studied all prompt for code review ("find issues in
// this diff"), which is a different task with a different failure mode — there, an
// agent that invents a bug wastes an hour; here, an agent that invents a market
// statistic or a regulatory requirement ends up in a product spec. So every phase
// prompt carries an explicit no-fabrication contract and demands that claims be
// labelled by provenance.

import type { Role } from "./roles.ts";
import { renderInbox, type Question } from "./crossexam.ts";

export type Phase = "opening" | "cross-exam" | "verdict" | "synthesis";

const LANGUAGES: Record<string, string> = {
  vi: "Tiếng Việt",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  zh: "中文",
  fr: "Français",
};

export function languageName(code: string): string {
  return LANGUAGES[code.toLowerCase()] ?? code;
}

export type PromptCtx = {
  role: Role;
  phase: Phase;
  /** The research question the debate exists to answer. */
  topic: string;
  /** Background visible to EVERY participant (reaches others via the transcript too). */
  material?: string;
  /** Background only this role can see. Never enters the shared transcript. */
  privateMaterial?: string;
  /** Transcript so far, context view (no cost footnotes, no raw error dumps). */
  transcript?: string;
  /** Questions this role must answer this round. */
  inbox?: Question[];
  /** Role ids that can be addressed with @id. */
  peers: string[];
  nameOf: (roleId: string) => string;
  language: string;
  maxQuestions: number;
  round?: number;
  /**
   * Last cross-examination round. Questions asked here can never be routed — the next
   * phase is the verdict — so asking for them burns tokens AND hands the judge a pile of
   * unanswerable questions under a heading that reads "dodged".
   */
  lastRound?: boolean;
  /** Judge's determination, for the synthesis phase. */
  verdict?: string;
};

/** Machine-readable trailer: lets the in-process mock runtime and logs identify a turn. */
function marker(ctx: PromptCtx): string {
  // ASK says whether this turn was invited to pose questions. The mock runtime reads
  // markers, not prose, so a mock that answers a last-round prompt stays faithful to it
  // instead of volunteering questions the real prompt forbade.
  const ask = ctx.phase === "opening" || (ctx.phase === "cross-exam" && !ctx.lastRound) ? 1 : 0;
  return `<!-- [AGORA-PHASE:${ctx.phase}] [AGORA-ROLE:${ctx.role.id}] [AGORA-PEERS:${ctx.peers.join(",")}] [AGORA-ASK:${ask}] -->`;
}

/** The provenance contract. Repeated in every phase because it is the whole ballgame. */
function honesty(lang: string): string {
  return [
    `## Quy tắc bắt buộc về tính trung thực`,
    ``,
    `- Gắn nhãn rõ ràng cho từng khẳng định: \`[đã kiểm chứng]\` (có nguồn/bằng chứng cụ thể),`,
    `  \`[kinh nghiệm]\` (dựa trên thực tiễn nghề, không có nguồn trích dẫn), hoặc \`[suy đoán]\`.`,
    `- **Không bịa** số liệu, tên sản phẩm, điều khoản quy định, hay tiêu chuẩn ngành.`,
    `  Nếu không biết, hãy viết "chưa có dữ liệu" — đó là một câu trả lời hợp lệ và hữu ích.`,
    `- Nếu bạn đang nói về một ngành cụ thể, nêu rõ phạm vi áp dụng (quốc gia, quy mô doanh nghiệp),`,
    `  vì nghiệp vụ khác nhau rất nhiều giữa các bối cảnh.`,
    `- Viết toàn bộ câu trả lời bằng **${languageName(lang)}**.`,
  ].join("\n");
}

function questionsContract(ctx: PromptCtx): string {
  const others = ctx.peers.filter((p) => p !== ctx.role.id);
  if (others.length === 0) return "";
  return [
    `## Chất vấn các chuyên gia khác`,
    ``,
    `Kết thúc câu trả lời bằng đúng định dạng sau (tối đa ${ctx.maxQuestions} câu hỏi,`,
    `gửi tới các vai: ${others.map((o) => `\`@${o}\``).join(", ")}):`,
    ``,
    "```",
    `QUESTIONS`,
    `@${others[0]}: <câu hỏi cụ thể, nhắm vào một điểm bạn thực sự cần họ làm rõ>`,
    "```",
    ``,
    `Chỉ hỏi những câu mà câu trả lời sẽ **thay đổi kết luận** của bạn. Không hỏi lịch sự,`,
    `không hỏi chung chung. Nếu không có gì cần hỏi, bỏ hẳn khối QUESTIONS.`,
  ].join("\n");
}

function persona(ctx: PromptCtx): string {
  return [`# Vai của bạn: ${ctx.role.name}`, ``, ctx.role.body].join("\n");
}

function materialBlock(ctx: PromptCtx): string {
  if (!ctx.material) return "";
  return [`## Tư liệu do người dùng cung cấp`, ``, ctx.material].join("\n");
}

/**
 * Private material needs one extra instruction, and it is load-bearing.
 *
 * Asymmetric evidence is the point — the domain expert reads the industry process, the
 * architect reads the schema — but an agent arguing from a document nobody else can see
 * breaks the debate: the others cannot rebut what they cannot read, so the judge weighs
 * an unchallenged claim as if it had survived scrutiny. So a role that uses its private
 * material must QUOTE the relevant part into its answer, which puts it in the shared
 * transcript where it can be attacked.
 */
function privateMaterialBlock(material: string): string {
  return [
    `## Tư liệu riêng cấp cho vai của bạn`,
    ``,
    `Các chuyên gia khác **không đọc được** phần tư liệu này.`,
    ``,
    material,
    ``,
    `> **Bắt buộc:** nếu bạn dùng tư liệu riêng này để lập luận, hãy **trích lại đoạn liên quan**`,
    `> vào câu trả lời của bạn. Người khác không thấy tài liệu này, nên một lập luận dựa vào nó`,
    `> mà không trích dẫn là lập luận không ai phản biện được — và chủ tọa sẽ tính nó như đã`,
    `> được kiểm chứng trong khi thực tế thì không.`,
  ].join("\n");
}

function join(parts: (string | undefined)[]): string {
  return parts.filter((p) => p && p.trim()).join("\n\n");
}

export function buildPrompt(ctx: PromptCtx): string {
  if (ctx.phase === "opening") return openingPrompt(ctx);
  if (ctx.phase === "cross-exam") return crossExamPrompt(ctx);
  if (ctx.phase === "verdict") return verdictPrompt(ctx);
  return synthesisPrompt(ctx);
}

function openingPrompt(ctx: PromptCtx): string {
  return join([
    persona(ctx),
    [
      `# Chủ đề cần làm rõ`,
      ``,
      ctx.topic,
    ].join("\n"),
    materialBlock(ctx),
    ctx.privateMaterial ? privateMaterialBlock(ctx.privateMaterial) : undefined,
    [
      `# Nhiệm vụ của bạn trong lượt này`,
      ``,
      `Đây là lượt mở đầu. Bạn **chưa thấy ý kiến của ai khác** — hãy trả lời độc lập,`,
      `đúng góc nhìn chuyên môn của vai bạn. Đừng cố bao quát mọi khía cạnh; hãy đi sâu`,
      `vào phần bạn giỏi nhất và nói thẳng quan điểm, kể cả khi nó gây tranh cãi.`,
      ``,
      `Cấu trúc câu trả lời:`,
      `1. **Kết luận ngắn** — 3-5 câu nêu quan điểm cốt lõi của bạn về chủ đề.`,
      `2. **Phân tích** — các điểm chính, mỗi điểm nói rõ cơ sở và hệ quả thực tế.`,
      `3. **Rủi ro / điều kiện** — cái gì phải đúng thì phân tích của bạn mới đứng vững.`,
      `4. **Điều bạn chưa biết** — những khoảng trống bạn cần vai khác bù vào.`,
      ``,
      `Viết gọn và dày thông tin. Không lặp lại đề bài.`,
    ].join("\n"),
    honesty(ctx.language),
    questionsContract(ctx),
    marker(ctx),
  ]);
}

function crossExamPrompt(ctx: PromptCtx): string {
  const inboxBlock = renderInbox(ctx.inbox ?? [], ctx.nameOf);
  return join([
    persona(ctx),
    [`# Chủ đề cần làm rõ`, ``, ctx.topic].join("\n"),
    [`# Biên bản tranh luận tới thời điểm này`, ``, ctx.transcript ?? "(trống)"].join("\n"),
    // Shared material already arrived inside the transcript header; private material
    // never does, by design, so it has to be re-attached on every turn.
    ctx.privateMaterial ? privateMaterialBlock(ctx.privateMaterial) : undefined,
    inboxBlock,
    [
      `# Nhiệm vụ của bạn trong lượt này (vòng chất vấn ${ctx.round ?? 1})`,
      ``,
      inboxBlock
        ? `1. **Trả lời trước tiên** từng câu hỏi gửi trực tiếp cho bạn ở trên.`
        : `1. Không có câu hỏi nào gửi riêng cho bạn trong vòng này.`,
      `2. **Chỗ bạn đồng ý** — nêu ngắn, và nói rõ bạn đồng ý vì lý do nào.`,
      `3. **Chỗ bạn phản đối** — chỉ ra lỗi **cụ thể** trong lập luận của người khác:`,
      `   giả định sai, số liệu không có nguồn, nghiệp vụ không khớp thực tế, chi phí bị bỏ sót.`,
      `   Trích lại đúng phần bạn phản đối rồi mới phản biện.`,
      `4. **Chỗ còn thiếu** — điều quan trọng mà chưa ai nhắc tới.`,
      ``,
      `**Không lặp lại** những gì đã được nói. Nếu bạn không có gì mới để bổ sung ở một`,
      `mục nào, hãy bỏ qua mục đó thay vì diễn đạt lại ý cũ.`,
      ...(ctx.lastRound
        ? [
            ``,
            `**Đây là vòng chất vấn CUỐI.** Sau lượt này là phán quyết, nên **không hỏi thêm**`,
            `câu nào nữa — sẽ không còn ai trả lời. Thay vào đó, kết lại: điểm nào bạn vẫn giữ`,
            `nguyên sau khi nghe phản biện, điểm nào bạn nhượng, và điều gì còn chưa đủ cơ sở`,
            `để kết luận.`,
          ]
        : []),
    ].join("\n"),
    honesty(ctx.language),
    // No QUESTIONS block in the last round: an unroutable question is not a cheap
    // leftover, it reaches the judge looking like a question someone refused to answer.
    ctx.lastRound ? undefined : questionsContract(ctx),
    marker(ctx),
  ]);
}

function verdictPrompt(ctx: PromptCtx): string {
  return join([
    persona(ctx),
    [`# Chủ đề đã được tranh luận`, ``, ctx.topic].join("\n"),
    [`# Toàn bộ biên bản`, ``, ctx.transcript ?? "(trống)"].join("\n"),
    ctx.privateMaterial ? privateMaterialBlock(ctx.privateMaterial) : undefined,
    [
      `# Nhiệm vụ của bạn`,
      ``,
      `Chốt phiên tranh luận. Bạn chỉ được suy luận **trên biên bản ở trên**.`,
      ``,
      `Quy tắc định dạng — bắt buộc:`,
      `1. **Dòng đầu tiên** phải là đúng một trong hai: \`STATUS: RESOLVED\` hoặc \`STATUS: NEEDS_INPUT\`.`,
      `   Không viết gì khác trên dòng đó.`,
      `2. \`## Đã thống nhất\` — những điều mọi bên đều chấp nhận.`,
      `3. \`## Phán quyết từng điểm tranh chấp\` — với mỗi điểm: các bên nói gì, bạn chọn phía nào, **vì sao**.`,
      `   Ưu tiên lập luận có bằng chứng (\`[đã kiểm chứng]\`) hơn lập luận hùng biện.`,
      `4. \`## Câu hỏi bị né\` — câu hỏi nào được gửi trực tiếp mà người nhận không trả lời thẳng.`,
      `   Đây là tín hiệu quan trọng, đừng bỏ qua.`,
      `5. Nếu — và chỉ nếu — có điểm **không thể** kết luận từ biên bản mà không bịa thêm,`,
      `   dùng \`STATUS: NEEDS_INPUT\`, vẫn ghi phần đã thống nhất, rồi thêm`,
      `   \`## Câu hỏi cho người dùng\` liệt kê đúng những gì cần họ quyết.`,
      `   **Không tự phán quyết điều bạn không thể bảo vệ bằng biên bản.**`,
    ].join("\n"),
    honesty(ctx.language),
    marker(ctx),
  ]);
}

function synthesisPrompt(ctx: PromptCtx): string {
  return join([
    [
      `# Vai của bạn: Người tổng hợp`,
      ``,
      `Bạn soạn **sản phẩm cuối cùng** mà phiên tranh luận tồn tại để tạo ra: một hồ sơ`,
      `nghiên cứu dùng được ngay để bắt đầu phát triển phần mềm. Đây **không phải** biên bản`,
      `tóm tắt ai nói gì.`,
    ].join("\n"),
    [`# Chủ đề ban đầu`, ``, ctx.topic].join("\n"),
    materialBlock(ctx),
    ctx.privateMaterial ? privateMaterialBlock(ctx.privateMaterial) : undefined,
    [`# Biên bản tranh luận`, ``, ctx.transcript ?? "(trống)"].join("\n"),
    ctx.verdict ? [`# Phán quyết của chủ tọa`, ``, ctx.verdict].join("\n") : undefined,
    [
      `# Yêu cầu đối với hồ sơ`,
      ``,
      `Viết hồ sơ **tự chứa**: người chỉ đọc file này phải có đủ thông tin để bắt đầu làm việc.`,
      `Không viết "như đã thảo luận ở trên". Lấy các quyết định **đã được chốt** trong phán quyết`,
      `làm xương sống; bỏ những phương án đã bị loại.`,
      ``,
      `Cấu trúc:`,
      ``,
      `## 1. Bối cảnh & phạm vi`,
      `Bài toán là gì, cho ai, ranh giới ở đâu.`,
      ``,
      `## 2. Kiến thức nghiệp vụ cốt lõi`,
      `Quy trình thực tế của ngành, vai diễn, chứng từ, kỳ hạn, thuật ngữ. Đây là phần`,
      `đội phát triển không tự biết được — viết đủ chi tiết để họ không phải đoán.`,
      ``,
      `## 3. Danh mục chức năng đề xuất`,
      `Dạng bảng: | Chức năng | Người dùng | Giá trị | Độ ưu tiên (MVP/Sau) | Độ phức tạp | Ghi chú |`,
      ``,
      `## 4. Phác thảo dữ liệu & kiến trúc`,
      `Các thực thể chính và quan hệ, những quyết định kiến trúc đã chốt kèm lý do.`,
      ``,
      `## 5. Rủi ro & ẩn số`,
      `Mỗi rủi ro kèm: dấu hiệu nhận biết sớm, và cách giảm thiểu.`,
      ``,
      `## 6. Điểm còn mở`,
      `Những gì chưa kết luận được — kèm việc cần làm để kết luận (hỏi ai, kiểm chứng gì).`,
      ``,
      `## 7. Bước tiếp theo`,
      `Danh sách việc cụ thể, theo thứ tự, mỗi việc có thể giao được cho một người.`,
      ``,
      `Giữ nguyên nhãn nguồn gốc (\`[đã kiểm chứng]\` / \`[kinh nghiệm]\` / \`[suy đoán]\`) ở những`,
      `khẳng định quan trọng, để người đọc biết chỗ nào cần kiểm tra lại trước khi tin.`,
    ].join("\n"),
    honesty(ctx.language),
    marker(ctx),
  ]);
}
