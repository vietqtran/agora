# agora

**Tranh luận có cấu trúc giữa các AI agent CLI bạn đang thực có trên máy** — để nghiên cứu,
làm rõ nghiệp vụ và chuẩn bị kiến thức trước khi phát triển phần mềm.

Mỗi CLI vào một vai chuyên gia: Claude Code làm kiến trúc sư, Codex làm chuyên viên
nghiên cứu, Antigravity/Gemini làm chuyên gia nghiệp vụ ngành. Chúng phát biểu độc lập,
rồi **chất vấn lẫn nhau có địa chỉ** ("chuyên gia nghiệp vụ hỏi kiến trúc sư: nghiệp vụ
này có làm được không?"), cuối cùng một chủ tọa chốt và một hồ sơ nghiên cứu được soạn ra.

Khác biệt chính so với các tool cùng loại: **danh sách người tranh luận là KẾT QUẢ dò
tìm, không phải điều kiện tiên quyết.** Server có `claude` thì dùng `claude`, có `codex`
thì dùng `codex`, chỉ có một cái thì vẫn chạy được (và nói thẳng rằng nó kém độc lập).

---

## Yêu cầu

- **Node >= 22.18** (chạy TypeScript trực tiếp, không cần build). Máy này đang có Node 26.
- **Không có runtime dependency nào.** `typescript` chỉ là devDependency để type-check.
- Ít nhất một agent CLI đã cài **và đã đăng nhập**. Tool không quản lý việc đăng nhập.
  - `claude` — `npm i -g @anthropic-ai/claude-code`
  - `codex` — `npm i -g @openai/codex`
  - `agy` (Antigravity) — https://antigravity.google
  - `gemini` — đã khai tử cho tier tiêu dùng từ 2026-06-18; chỉ còn dùng được với giấy
    phép Code Assist Standard/Enterprise hoặc `GEMINI_API_KEY`/Vertex. Tool vẫn hỗ trợ
    nhưng tự động hạ ưu tiên.
  - CLI khác (opencode, cursor-agent, qwen, aider, pi, copilot, wrapper nội bộ) → khai báo
    trong config, xem [CLI tự khai báo](#cli-tự-khai-báo).

> **Để tranh luận có giá trị, cần >= 2 CLI KHÁC HÃNG.** Hai persona trên cùng một model
> là model đang tự nói với chính nó; tool sẽ cảnh báo khi điều đó xảy ra.

## Cài

```bash
cd agents-debate
npm install          # chỉ để có typescript cho `npm run typecheck`; runtime không cần
npm link             # hoặc: alias agora="node $PWD/src/index.ts"
```

## Bắt đầu

```bash
# 1. Máy này chạy được gì?  (dò --version, miễn phí, không tốn token)
agora doctor

# 2. Kiểm tra cả việc đăng nhập (tốn vài token)
agora doctor --health

# 3. Xem toàn bộ giao thức mà không tốn đồng nào
agora --dry-run "Phần mềm quản lý tiến độ thi công cần những chức năng gì?"

# 4. Chạy thật
agora "Module quản lý khối lượng cho ERP xây dựng cần những gì?" --rounds standard

# 5. Nạp tư liệu nghiệp vụ của bạn vào
agora -f ./brief.md -m ./quy-trinh-hien-tai.md -m https://example.com/tieu-chuan
```

`stdout` là **hồ sơ kết quả**, `stderr` là tiến trình — nên `agora "..." > ho-so.md` dùng được ngay.

## Giao thức tranh luận

```
1. MỞ ĐẦU        mỗi chuyên gia trả lời độc lập, song song, KHÔNG thấy ý kiến người khác
                 (mỗi lượt chạy trong thư mục tạm riêng → không thể "nhìn bài" nhau)
                        ↓
2. CHẤT VẤN      N vòng. Mỗi agent: trả lời câu hỏi gửi riêng cho mình trước, rồi
   (có địa chỉ)  phản biện cụ thể, rồi gửi câu hỏi mới dạng  @vai: câu hỏi
                 → orchestrator định tuyến câu hỏi tới đúng người ở vòng sau
                        ↓
3. PHÁN QUYẾT    chủ tọa đọc TOÀN BỘ biên bản (không được chạm repo, phải hỏi nếu
                 không kết luận được), chỉ ra cả những CÂU HỎI BỊ NÉ
                 → dòng đầu: STATUS: RESOLVED  |  STATUS: NEEDS_INPUT
                        ↓
4. TỔNG HỢP      chỉ chạy khi RESOLVED. Soạn hồ sơ nghiên cứu tự chứa:
                 bối cảnh → nghiệp vụ cốt lõi → danh mục chức năng → phác thảo dữ liệu
                 → rủi ro → điểm còn mở → bước tiếp theo
```

Khi chủ tọa trả về `NEEDS_INPUT`, tool **không** soạn hồ sơ — vì như vậy sẽ chôn các câu
hỏi còn mở vào một văn bản đọc như đã chốt. Bạn trả lời rồi chạy lại kèm câu trả lời:

```bash
agora -f ./brief.md -m .agora/runs/<run>/verdict.md -m ./tra-loi-cua-toi.md "..."
```

## Cơ chế "có gì dùng nấy"

Mỗi vai khai báo **ưu tiên** và **năng lực bắt buộc**, không khai báo CLI cụ thể:

```
---
id: researcher
prefer: codex, claude, antigravity, gemini   # thứ tự mong muốn
needs: web                                   # thiếu cái này thì KHÔNG nhận vai
wants: execute                               # có thì bật, không có thì thôi
---
```

Caster (`src/casting.ts`) quyết định theo thứ tự:

| Tình huống | Hành vi |
|---|---|
| Có đủ CLI khác hãng | mỗi vai một runtime, **ưu tiên đa dạng hãng** |
| Ưu tiên #1 không có | tự xuống ưu tiên #2, #3... |
| Có CLI tool chưa biết tên | vẫn dùng được nếu đủ năng lực |
| Chỉ có 1 CLI | vẫn chạy, các vai **dùng chung** runtime + cảnh báo kém độc lập |
| `--no-shared` | thà **để trống vai** còn hơn giả vờ có đối chất |
| Vai thiếu năng lực bắt buộc | **để trống vai** + chỉ cách cài (researcher không có web = nguy cơ bịa số liệu) |
| Chủ tọa | ưu tiên runtime **chưa tranh luận**; nếu buộc dùng lại thì cảnh báo thiên vị |

Ghim tay khi cần: `--pin domain-expert=antigravity` hoặc `"cast"` trong config.

## Các vai

```bash
agora roles
```

Có sẵn: `architect`, `researcher`, `domain-expert`, `product-owner`, `judge`.

**Thêm vai của bạn** — tạo file markdown, không cần sửa code:

```bash
mkdir -p roles && cat > roles/legal.md <<'ROLE'
---
id: legal
name: Chuyên gia pháp chế
kind: debater
prefer: claude, antigravity, codex
wants: web
summary: Tuân thủ, hợp đồng, quy định ngành
---

Bạn là chuyên gia pháp chế...
ROLE

agora --roles architect,domain-expert,legal "..."
```

Thứ tự nạp: `<pkg>/roles` → `~/.config/agora/roles` → `./roles` (sau ghi đè trước theo `id`).

## CLI tự khai báo

Cài CLI mới mà tool chưa biết? Khai báo, đừng chờ release:

```json
{
  "custom": [{
    "provider": "custom",
    "id": "opencode",
    "label": "OpenCode",
    "vendor": "opencode",
    "command": "opencode",
    "args": ["run", "--format", "json", "{prompt}"],
    "promptMode": "arg",
    "parse": "json",
    "textPath": "response",
    "web": true
  }]
}
```

- `promptMode`: `arg` (thay `{prompt}`) · `stdin` · `append` (prompt là tham số cuối)
- `parse`: `text` (stdout là câu trả lời) · `json` · `jsonl` (lấy dòng cuối có câu trả lời)
- `textPath`: đường dẫn kiểu `a.b.c` tới câu trả lời

## Cấu hình

Xem `agora.config.example.json` (có comment đầy đủ). Thứ tự ưu tiên:

```
mặc định built-in → ~/.config/agora/config.json → ./agora.config.json → cờ CLI
```

`agora init` sinh file theo đúng những gì máy hiện tại có.

> **Đừng commit `bin`** vào config dùng chung: đường dẫn tuyệt đối chỉ đúng trên một máy.
> Đó là lỗi khiến config của các tool khác chạy được trên laptop tác giả và chết trên server.

## Kết quả mỗi lần chạy

```
.agora/runs/<thời-gian>-<chủ-đề>/
├── dossier.md      ← hồ sơ nghiên cứu (cái bạn đọc và đem đi dùng)
├── transcript.md   ← toàn bộ biên bản + chi phí + lượt lỗi (cái bạn kiểm khi hồ sơ nói điều lạ)
├── verdict.md      ← phán quyết của chủ tọa
└── run.json        ← phân vai, chi phí, thời gian, câu hỏi đã định tuyến, lượt nào lỗi
```

`--json` in toàn bộ ra stdout dạng máy đọc được, để agent khác gọi tool này.

## An toàn & riêng tư

Tool gửi tư liệu của bạn tới **2-3 nhà cung cấp khác nhau trong cùng một lần chạy**, nên:

- **Che secret**: tư liệu `-m` được quét và che credential (API key, private key, mật khẩu
  trong URL, biến `*_SECRET`) **trước khi** vào bất kỳ prompt nào. Tool báo rõ đã che gì.
- **Cảnh báo prompt-injection**: nội dung tải từ URL là dữ liệu không tin được. Tool **báo
  cho bạn và nhắc agent coi đó là dữ liệu**, nhưng *không sửa* tư liệu — sửa thầm còn tệ
  hơn chính cuộc tấn công.
- **Chỉ đọc**: adapter Claude chặn cứng `Edit,Write,NotebookEdit`; Codex chạy trong sandbox
  `read-only` của OS. Với `--repo`, agent làm việc trong **git worktree tạm từ HEAD**, không
  phải checkout thật của bạn.
- **Cô lập từng lượt**: mỗi lượt một thư mục tạm riêng, xoá sau khi xong.
- **Không hút context của bạn**: adapter Claude truyền `--bare` để không tự nạp `CLAUDE.md`,
  hooks, skills, MCP — persona phải là persona tool giao, không lẫn quy tắc dự án của bạn.
- **Prompt dài tự chuyển sang stdin** (ngưỡng 96 KB), vì Linux giới hạn 1 tham số argv ở
  128 KB và argv hiện trong `ps` cho mọi user trên máy.

## Giới hạn cần biết

- **Chưa được chạy thử với CLI thật.** Máy phát triển không có `claude`/`codex`/`agy` nào
  được cài, nên 155 test chạy trên **CLI giả** mô phỏng đúng format output đã nghiên cứu.
  Mọi logic phân loại, định tuyến, phân vai, cô lập, timeout đều có test; nhưng **cờ dòng
  lệnh thật của từng phiên bản CLI thì chỉ `agora doctor --health` trên máy bạn mới xác nhận
  được**. Chạy lệnh đó trước khi tin kết quả. Nếu một cờ không được hỗ trợ, tầng
  `argplan.ts` sẽ tự thử lại không có cờ tuỳ chọn.
- **Chi phí USD chỉ Claude báo.** Codex/Gemini/Antigravity báo token hoặc không báo gì;
  tổng chi phí luôn ghi rõ có bao nhiêu lượt *không* nằm trong con số đó.
- **Chất lượng tranh luận phụ thuộc vai có thật sự khác nhau.** Ba persona trên cùng một
  model sẽ đồng thuận giả tạo.
- Chưa có: chế độ `consensus`/`recheck`, giao diện web, lưu session để tiếp tục giữa các
  lần chạy (hiện phải nối bằng `-m verdict.md`).

## Phát triển

```bash
npm test             # 155 test, không cần CLI nào
npm run typecheck    # tsc --noEmit
```

Kiến trúc và nguồn gốc từng quyết định thiết kế: [`docs/CREDITS.md`](docs/CREDITS.md).
