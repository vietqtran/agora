# Nguồn gốc các quyết định thiết kế

Tool này được viết sau khi phân rã source của các opensource cùng mục tiêu. Phần lớn
"bài học đắt giá" trong `src/spawn.ts` và `src/providers/*` **không phải tự nghĩ ra** —
chúng là các chế độ lỗi mà những project dưới đây đã gặp trong chạy thật và ghi lại.
File này ghi rõ cái gì đến từ đâu, và cái gì là mới.

> Không có dòng code nào được copy nguyên văn. Cái được lấy là **kiến thức vận hành**:
> cờ nào phải truyền, output nào không được tin, lỗi nào trông giống lỗi model nhưng
> thực ra là lỗi hạ tầng.

---

## 1. `marcomd/disputatio` (TypeScript, MIT) — nguồn chính

Repo gần nhất với yêu cầu: tranh luận có cấu trúc giữa các CLI agent thật, local-first.
Đã có kinh nghiệm chạy thật và viết lại thành research notes. Lấy từ đây:

**Tầng transport (`src/spawn.ts`)**
- stdin **phải** bị ignore: `codex exec` treo chờ EOF nếu stdin là pipe không đóng.
- child phải là **process-group leader** (`detached: true`) và timeout phải kill cả group
  (`process.kill(-pid)`). Nếu chỉ kill child trực tiếp, worker con còn giữ pipe stdout →
  event `close` không bao giờ bắn → cả phiên treo ~45 phút ở 0% CPU.
- SIGTERM rồi SIGKILL sau thời gian ân hạn, để CLI nào bắt/bỏ qua SIGTERM cũng không sống sót.
- phải báo cả `signal`, không chỉ `code`: khi bị kill thì `code === null` và signal là
  bằng chứng duy nhất về nguyên nhân.
- exit **126/127** = shell không chạy được binary (shim cũ, PATH sai) → lỗi *cài đặt*,
  không phải lỗi agent.

**Phân loại output Claude Code (`src/providers/claude.ts`)**
- tin `is_error`, **không** tin `subtype`: khi lỗi, `subtype` vẫn có thể là `"success"`
  trong lúc `is_error` bật true.
- riêng trường hợp hết ngân sách: `subtype === "error_max_budget_usd"` mới là tín hiệu
  đáng tin, và lúc đó **không có** field `result` — thông báo nằm trong mảng `errors`.
- parse envelope **kể cả khi turn bị timeout**: một lượt bị kill giữa đường vẫn đã tiêu
  tiền thật; bỏ qua nó là báo cáo chi phí sai.

**Phân loại output Codex (`src/providers/codex.ts`)**
- câu trả lời = `item.completed` **cuối cùng** có `item.type === "agent_message"`.
- thành công cần thêm `turn.completed` và không có `turn.failed` / `error`; exit 0 là chưa đủ.
- chỉ đếm `item.completed`, **không** đếm `item.started` — cùng một `item.type`, đếm cả
  hai là nhân đôi mọi lệnh.

**Giao thức tranh luận (`src/debate.ts`, `src/transcript.ts`)**
- hai view của cùng biên bản: view *artifact* giữ chi phí/lỗi, view *context* đưa vào
  prompt thì sạch (không footnote chi phí, không dump stderr).
- huỷ phiên khi có **dưới 2** phát biểu mở đầu thành công — "tranh luận" một mình tạo ra
  sản phẩm trông hợp lý nhưng không có đối chứng.
- dòng đầu `STATUS: RESOLVED` / `STATUS: NEEDS_INPUT` làm tín hiệu máy đọc được; chủ tọa
  phải **hỏi thay vì đoán** khi không kết luận được từ biên bản.
- chủ tọa chỉ đọc biên bản, không chạm repo; người tổng hợp thì được.
- cô lập mỗi lượt bằng **git worktree tạm** (detached, từ HEAD) thay vì checkout thật; và
  serialize các lệnh git vì `worktree add/remove` tranh chấp lock `.git`.

**Chẩn đoán (`src/detect.ts`)**
- canary bằng prompt "pong" chạy qua **đúng adapter thật**, để lỗi hiện ra giống y như
  lúc chạy thật (thiếu binary, shim cũ, hết hạn đăng nhập).
- dò binary thay thế khi binary trên PATH chết (shim asdf cũ che bản mới).

**Research notes** — `research/*.md` trong repo đó là tài liệu tham chiếu tốt nhất tôi tìm
được về chế độ headless của từng CLI, bao gồm thông tin **Gemini CLI đã bị khai tử**.

## 2. `JuReyms/Palabre` (TypeScript)

- **registry agent tập trung**: một chỗ duy nhất map tên lệnh → entry phát hiện, kèm
  alias (`agy` / `antigravity`), để thêm một CLI là sửa một nơi.
- xử lý **agent đã khai tử**: vẫn đọc được config cũ có `gemini`, nhưng không bao giờ đề
  xuất nó nữa. `src/providers/google.ts` theo cùng tinh thần (giữ adapter, hạ ưu tiên).

## 3. `beyond-logic-labs/bl-agent-debater` (Python)

- **persona là file, không phải code**: định nghĩa vai nằm trong file markdown, nạp theo
  thứ tự ưu tiên `project/roles` → `~/.config/.../roles` → bundled. `src/roles.ts` dùng
  đúng mô hình này, nên bạn thêm vai mới mà không cần sửa TypeScript.

## 4. `berkayturanci/ai-jury` (Python, stdlib-only)

- **prompt qua stdin thay vì argv**. Hai lý do, cả hai đều đúng với tool này:
  Linux giới hạn **một** tham số argv ở 128 KiB (`MAX_ARG_STRLEN`) — prompt vòng 3 gồm cả
  biên bản và tư liệu của bạn chạm ngưỡng đó rất dễ; và argv hiện trong `ps` nên tài liệu
  nghiệp vụ nội bộ bị lộ cho mọi account khác trên server. Xem `src/providers/delivery.ts`.
- **che secret trước khi gửi ra ngoài**: ở đây một lệnh `-m` bất cẩn gửi credential tới
  Anthropic *và* OpenAI *và* Google cùng lúc. Xem `src/sanitize.ts`.
- **quét prompt-injection theo kiểu cảnh báo, không tuân theo**: nội dung tải từ URL là
  dữ liệu không tin được; tool báo cho người dùng và nhắc agent, nhưng **không sửa** tư
  liệu — sửa thầm còn tệ hơn chính cuộc tấn công.
- kill theo process group, cùng lý do như mục 1.

## 5. `autopus-ai/autopus-adk` (Go)

- **chiến lược điều phối là khái niệm hạng nhất** (`debate` / `consensus` / `recheck`),
  và **preset số vòng** (`fast` / `standard` / `deep`) thay vì bắt người dùng đoán con số.
  Tool này lấy preset vòng; các chiến lược khác là hướng mở rộng (xem README).
- phát hiện provider đang gọi để tránh tự mình làm chủ tọa cho lập luận của mình — cùng
  mối quan tâm mà `src/casting.ts` xử lý bằng cách ưu tiên chủ tọa là runtime chưa tranh luận.

---

## Cái gì là mới ở tool này

Đây là những chỗ các opensource trên **không** làm, và cũng là lý do tool này tồn tại:

1. **Tách vai khỏi runtime + casting theo năng lực** (`src/casting.ts`).
   Mọi tool trên đều hard-code "codex là researcher" trong orchestrator, nên đổi máy là
   hỏng. Ở đây vai khai báo *ưu tiên* và *năng lực bắt buộc*, còn caster gán vào CLI đang
   thực có — ưu tiên đa dạng nhà cung cấp, và **xuống cấp chứ không chết** khi máy chỉ có
   một CLI.

2. **Chất vấn có địa chỉ** (`src/crossexam.ts`).
   Các tool kia chạy phản biện kiểu *broadcast* → sinh ra các bài độc thoại song song.
   Ở đây agent gửi câu hỏi `@vai: ...`, orchestrator định tuyến và buộc người nhận trả
   lời ở vòng sau — nên "chuyên gia nghiệp vụ hỏi kiến trúc sư có làm được không" là cơ
   chế, không phải may mắn. Chủ tọa còn được yêu cầu chỉ ra **câu hỏi bị né**.

3. **Chịu được khác biệt phiên bản CLI** (`src/providers/argplan.ts`).
   argv khai báo theo nhóm bắt buộc/không bắt buộc; CLI từ chối một cờ lạ thì thử lại một
   lần không có nhóm tuỳ chọn. Một config dùng được cho cả đội server lệch phiên bản.

4. **Khai báo CLI lạ bằng cấu hình** (`src/providers/custom.ts`).
   Cài CLI mới (opencode, cursor-agent, qwen, aider, pi, copilot, wrapper nội bộ) là khai
   báo `command` + nơi lấy câu trả lời, không phải chờ ai release.

5. **Chọn cách truyền prompt theo kích thước** (`src/providers/delivery.ts`).
   Tự chuyển sang stdin khi prompt vượt ngưỡng an toàn của argv, và báo lỗi *đọc được*
   khi runtime không hỗ trợ stdin.

6. **Hướng nghiên cứu/tiền-phát-triển thay vì code review** (`src/prompts.ts`, `roles/`).
   Các tool trên prompt theo kiểu "tìm lỗi trong diff". Ở đây rủi ro khác: một con số thị
   trường bịa đặt sẽ đi thẳng vào spec. Nên mọi pha đều buộc gắn nhãn nguồn gốc
   (`[đã kiểm chứng]` / `[kinh nghiệm]` / `[suy đoán]`) và cho phép trả lời "chưa có dữ liệu".

## Giấy phép

Các repo trên có giấy phép riêng (phần lớn MIT); không có code nào của họ nằm trong repo
này. Nếu bạn phát hành tool này, nên giữ file CREDITS này.
