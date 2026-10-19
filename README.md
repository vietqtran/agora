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
git clone git@github.com:vietqtran/agora.git
cd agora
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

## Giao diện web

```bash
agora serve                               # http://127.0.0.1:7777 — chỉ máy này vào được
agora serve --host 0.0.0.0 --port 8080    # mở ra ngoài; tự sinh token và in ra terminal
```

Dùng để: xem **pipeline tranh luận chạy trực tiếp**, chọn CLI + model + effort cho từng vai,
dán tư liệu riêng cho từng vai, và đọc lại các phiên trước.

Màn hình trái là thiết lập: chủ đề, chọn agent tham gia, mỗi agent có dropdown chọn runtime
(chỉ hiện CLI thực có trên máy), ô nhập model, chọn effort, và một khối gập để dán **tư liệu
riêng**. Dưới cùng là ước lượng số lượt gọi CLI trước khi bạn bấm chạy — vì chi phí tăng theo
`số agent × (1 + số vòng)`.

Màn hình phải là pipeline dọc theo thời gian thật: từng pha (mở đầu → chất vấn vòng N →
phán quyết → tổng hợp), trong mỗi pha là từng agent với trạng thái đang chạy / xong / lỗi,
thời gian, số ký tự, số câu hỏi. Giữa các pha hiện **các câu hỏi được định tuyến**
(`A → B: câu hỏi`) — đây là thứ đáng xem nhất, vì nó cho thấy các agent có thực sự đối chất
hay chỉ nói song song. Xong phiên thì có tab Hồ sơ / Phán quyết / Biên bản / Dữ liệu phiên.

**Về bảo mật.** Ai vào được cổng này thì tiêu được quota model của bạn và bắt server đọc file
trên máy làm tư liệu. Nên mặc định chỉ bind `127.0.0.1`; bind ra ngoài thì **buộc có token**
— tool tự sinh nếu bạn không truyền `--token`. Cách an toàn nhất khi server ở xa là không mở
cổng mà forward qua SSH:

```bash
ssh -L 7777:127.0.0.1:7777 user@server    # rồi chạy `agora serve` trên server
```

Không có bước build, không có dependency: một file HTML tĩnh và `node:http` + SSE.

## Giao thức tranh luận

```
1. MỞ ĐẦU        mỗi chuyên gia trả lời độc lập, song song, KHÔNG thấy ý kiến người khác
                 (mỗi lượt chạy trong thư mục tạm riêng → không thể "nhìn bài" nhau)
                        ↓
2. CHẤT VẤN      N vòng. Mỗi agent: trả lời câu hỏi gửi riêng cho mình trước, rồi
   (có địa chỉ)  phản biện cụ thể, rồi gửi câu hỏi mới dạng  @vai: câu hỏi
                 → orchestrator định tuyến câu hỏi tới đúng người ở vòng sau
                 → VÒNG CUỐI không hỏi nữa (sẽ không còn ai trả lời): mỗi vai
                   chốt lại giữ gì, nhượng gì, còn gì chưa đủ cơ sở
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

## Mỗi agent có context riêng tới mức nào

| Thành phần | Riêng từng agent? |
|---|---|
| Process + thư mục làm việc | **Riêng** — `mkdtemp` mỗi lượt, xoá sau khi xong |
| Persona | **Riêng** — file `roles/*.md` |
| Model / effort / năng lực (web, shell) | **Riêng** theo vai |
| Câu hỏi gửi trực tiếp | **Riêng** |
| **Tư liệu nền** | **Riêng được** — xem dưới |
| Chủ đề + biên bản tranh luận | Chung (phải chung mới tranh luận được) |

Không có state hội thoại nào nằm trong CLI: mỗi lượt là một process mới, "ký ức" do
orchestrator giữ bằng biên bản. Vì thế hai vai chạy trên **cùng một** CLI vẫn không thấy
được prompt của nhau.

> **Lưu ý quan trọng:** persona **không tạo ra kiến thức**. File `domain-expert.md` chỉ ra
> lệnh cho model *suy luận theo góc nhìn* chuyên gia ngành. Kiến thức thật đến từ ba nguồn:
> tri thức sẵn có của model (đây là lý do **khác hãng** mới có giá trị), web search
> (`needs: web`), và **tư liệu bạn nạp vào**. Muốn agent thật sự biết nghiệp vụ của bạn
> thì phải nạp tài liệu của bạn, không phải chỉ sửa persona.

### Tư liệu riêng theo vai

`-m <path>` nạp tư liệu cho **mọi** vai. Thêm tiền tố tên vai để tư liệu đó chỉ một vai đọc:

```bash
agora "Thiết kế module nghiệm thu khối lượng" \
  -m ./boi-canh-chung.md \                    # mọi vai đều đọc
  -m domain-expert:./quy-trinh-nghiem-thu.pdf \  # chỉ chuyên gia nghiệp vụ
  -m domain-expert:./tieu-chuan-TCVN.md \
  -m architect:./schema-hien-tai.sql \           # chỉ kiến trúc sư
  -m architect:./quy-uoc-code.md
```

Đây là thứ làm cho "một agent biết nghiệp vụ, một agent biết lập trình" thành thật thay vì
hình thức. Nếu cả hai đọc cùng một đống tài liệu, chúng sẽ diễn giải lại giống nhau —
**đồng thuận đó không chứng minh điều gì**, vì không bên nào có cơ sở độc lập để phản đối.

Hai bảo đảm đi kèm:

- **Không rò rỉ:** nội dung tư liệu riêng **không** vào biên bản chung, nên vai khác không
  đọc được kể cả qua biên bản. Chỉ **tên nguồn** được ghi lại (trong `transcript.md` và
  `run.json`) để bạn biết ai lập luận dựa trên cái gì.
- **Phải trích dẫn khi dùng:** vai nào dùng tư liệu riêng thì được yêu cầu **trích lại đoạn
  liên quan** vào câu trả lời. Một lập luận dựa trên tài liệu không ai đọc được là lập luận
  không ai phản biện được — và chủ tọa sẽ tính nó như đã kiểm chứng trong khi thực tế thì chưa.

Tiền tố chỉ được hiểu là tên vai khi nó **đúng là một vai trong phiên đó**, nên
`-m https://...` và `-m C:\docs\spec.md` vẫn hoạt động bình thường.

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
- **"Chỉ đọc" KHÔNG đồng đều giữa các CLI.** Đây là chỗ dễ tin quá mức nhất, nên nói thẳng
  từng runtime chặn việc ghi bằng cái gì:

  | Runtime | Chặn ghi bằng | Mức bảo đảm |
  |---|---|---|
  | Codex | `-s read-only` | **sandbox của OS cưỡng chế** |
  | Claude Code | `--disallowedTools Edit,Write,NotebookEdit` + allowlist công cụ, cả hai là **cờ bắt buộc** (không chạy được thì để lượt đó lỗi) | tầng công cụ của CLI, không phải OS |
  | Antigravity (`agy`) | `--sandbox` **khi máy có backend** (seatbelt trên macOS, hoặc docker/podman) | sandbox OS nếu có backend, nếu không thì **ghi rõ là không có** |
  | Gemini CLI | `--sandbox` như trên, cộng `--approval-mode yolo` (**tự duyệt mọi lời gọi công cụ**) + `GEMINI_CLI_TRUST_WORKSPACE=true` | như trên — và yolo nghĩa là **sandbox là lớp chặn duy nhất còn lại** |

  Với `--repo`, agent làm việc trong **git worktree tạm từ HEAD**, không phải checkout thật
  của bạn.

  Hai cờ `--sandbox` đó là **yêu cầu, không phải bảo đảm**: CLI cần backend mới làm được.
  Nên tool **dò máy trước** — có backend thì xin sandbox, không có thì vẫn chạy nhưng **ghi
  thẳng vào lượt đó là đã chạy không sandbox** (xem [Khi một lượt chạy yếu hơn
  quảng cáo](#khi-một-lượt-chạy-yếu-hơn-quảng-cáo)). Ép tay cho `antigravity`/`gemini`:
  `"sandbox": true | false` trong `providers` — cấu hình luôn thắng kết quả dò.
- **Cô lập ở đây là cô lập THƯ MỤC LÀM VIỆC, không phải sandbox hệ thống file.** Mỗi lượt một
  thư mục tạm riêng, xoá sau khi xong — đủ để không lượt nào "nhìn bài" lượt khác. Nhưng
  **không có code nào giới hạn đường dẫn ĐỌC**: trừ Codex (sandbox OS), một vai được cấp
  `Read`/shell vẫn đọc được mọi file mà user của bạn đọc được, kể cả ngoài thư mục tạm. Env
  của process cha cũng được kế thừa nguyên vẹn. Đừng chạy tool này dưới user có quyền bạn
  không muốn một model dùng tới.
- **Không hút context của bạn — nhưng chỉ khi máy có API key.** Adapter Claude truyền
  `--bare` để không tự nạp `CLAUDE.md`, hooks, skills, MCP. Vấn đề là `claude --help`
  (bản 2.1.301) nói thẳng: với `--bare`, *"Anthropic auth is strictly ANTHROPIC_API_KEY
  or apiKeyHelper via --settings (OAuth and keychain are never read)"*. Nghĩa là **đăng
  nhập bằng tài khoản thì `--bare` làm mọi lượt lỗi auth** — mà đó là cách đăng nhập phổ
  biến nhất. Nên tool dò trước, giống `--sandbox`:

  | Máy có gì | Hành vi |
  |---|---|
  | `ANTHROPIC_API_KEY`, hoặc Bedrock/Vertex | xin `--bare` → persona sạch |
  | chỉ đăng nhập OAuth (`claude /login`) | **không** xin `--bare` → lượt vẫn chạy, nhưng **bị đánh dấu hạ cấp** kèm câu "persona có thể đã nạp CLAUDE.md/hooks/skills/MCP của dự án" |

  Ép tay: `"bare": true` (dùng `apiKeyHelper`/Foundry mà tool không dò được) hoặc
  `"bare": false`. Cả hai hướng đều được ghi vào lượt.
- **Prompt dài tự chuyển sang stdin** (ngưỡng 96 KB), vì Linux giới hạn 1 tham số argv ở
  128 KB và argv hiện trong `ps` cho mọi user trên máy.

## Khi một lượt chạy yếu hơn quảng cáo

Các CLI đổi cờ giữa các bản, nên khi một CLI từ chối một cờ, `argplan.ts` bỏ **nhóm cờ tuỳ
chọn** và chạy lại một lần — đó là thứ giúp một cấu hình dùng được trên cả dàn máy có phiên
bản khác nhau. Nhưng trong nhóm tuỳ chọn có cả cờ **an toàn** (`--bare`, `--sandbox`) và cờ
**năng lực** (`tools.web_search`), nên "chạy lại cho xong" có thể âm thầm biến một lượt thành
một lượt khác hẳn: hết sandbox, persona bị trộn quy tắc dự án, hoặc researcher mất khả năng
tra cứu mà vẫn trả lời bằng số liệu.

Lượt như thế gọi là **hạ cấp**, và nó được ghi ở **bốn** chỗ, vì một lượt hạ cấp đọc giống
y một lượt bình thường:

```
terminal       ⚠ hạ cấp: không có --bare (máy chỉ đăng nhập OAuth…) — persona có thể…
               + dòng tổng kết đếm: "5 lượt OK, 3 lượt hạ cấp"
transcript.md  > ⚠️ HẠ CẤP: … ngay trên câu trả lời của lượt đó (từng lượt, đầy đủ)
               + chân trang đếm: "3 lượt hạ cấp"
run.json       turns[].notes: [...]  ·  cost.degradedTurns: 3
giao diện web  thẻ của vai đó viền vàng, kèm dòng cảnh báo
```

Trong terminal, mỗi ghi chú **chỉ in một lần cho cả phiên**: "máy này không có API key" là
sự thật về *máy*, không phải về *lượt*, nên in lại dưới từng lượt chỉ là tiếng ồn. Số lượt
hạ cấp thì vẫn nằm ở dòng tổng kết, còn `transcript.md` và `run.json` vẫn giữ đủ theo từng
lượt — đó là bản kiểm toán.

Những mất mát được gọi tên, không phải chỉ liệt kê cờ:

| Cờ không có / bị bỏ | Câu ghi vào lượt |
|---|---|
| `--bare` (claude) — bị CLI từ chối, **hoặc không xin vì máy chỉ có OAuth** | persona có thể đã nạp `CLAUDE.md`/hooks/skills/MCP của dự án |
| `--sandbox` (agy, gemini) — bị từ chối, **hoặc không xin vì máy không có backend** | không còn lớp chặn ghi nào ở mức OS |
| `tools.web_search` (codex) | vai này mất khả năng tra cứu, **số liệu có thể là bịa** |

Lỗi sandbox cũng được tính là lý do thử lại, không chỉ lỗi "cờ không hỗ trợ": máy không có
docker/podman thì lượt vẫn chạy (không sandbox, có ghi chú) thay vì chết.
**Biên bản gửi cho agent khác thì không chứa các ghi chú này** — chúng là thông tin kiểm
toán cho bạn, không phải thứ để agent quay sang bàn về cờ dòng lệnh.

## Xử lý sự cố

Những lỗi dưới đây **gặp thật** khi chạy trên Ubuntu 24.04 (claude 2.1.292 và 2.1.301,
codex 0.145.0). Không có cái nào là lỗi tool — nhưng từ xa chúng trông giống nhau và cần
những cách sửa trái ngược, nên `doctor --health` phân biệt rồi in thẳng cách sửa.

**`auth: OAuth session expired and could not be refreshed`**
CLI có đó nhưng chưa đăng nhập. Kiểm tra: `claude auth status` → `"loggedIn": false`.
Sửa: chạy `claude` trên **đúng máy đó** rồi `/login`. Tool không quản lý đăng nhập.

**`model: The '<model>' model is not supported when using Codex with a ChatGPT account`**
`~/.codex/config.toml` đang ghim một model mà gói tài khoản không được dùng — `codex exec`
của chính bạn cũng lỗi y vậy. Đừng sửa `config.toml` (ảnh hưởng mọi thứ khác), hãy ghi đè
riêng cho agora:

```json
{ "providers": { "codex": { "model": "gpt-5.6-sol" } } }
```

**`auth: ...` nhưng `claude auth status` nói đã đăng nhập**
Đây là `--bare`, và đã **kiểm chứng bằng thực nghiệm** — cùng một máy, cùng tài khoản
claude.ai, chỉ khác một cờ:

```
claude        -p "..."  →  chạy thật, duration_api_ms=1656, total_cost_usd=0.0749
claude --bare -p "..."  →  exit 1, is_error=true, 0 token,
                           result = "Not logged in · Please run /login"
```

Khớp với chính tài liệu của cờ đó — `claude --help` (2.1.301): *"Anthropic auth is strictly
ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)"*. Bình thường bạn **không gặp lỗi này**: không thấy API key thì tool tự bỏ `--bare`
và ghi chú lượt đó là hạ cấp. Lỗi này chỉ xảy ra khi `--bare` *có* được truyền:

- bạn đặt `"bare": true` mà máy không có key dùng được, hoặc
- có `ANTHROPIC_API_KEY`/`apiKeyHelper` nhưng key đó bị từ chối.

Hai cách sửa, chọn theo thứ bạn coi trọng hơn:

```json
{ "providers": { "claude": { "bare": false } } }   // chạy được, nhưng persona lẫn context dự án
```
```bash
export ANTHROPIC_API_KEY=sk-...                     # giữ persona sạch, không dùng quota tài khoản
```

Cơ chế thử lại trong `argplan.ts` **không cứu** được ca này: nó chỉ bắt lỗi "cờ không hỗ trợ"
và lỗi sandbox, còn đây là một lỗi auth đúng khuôn dạng. Vì vậy thông báo lỗi và
`doctor --health` tự nhắc hai dòng trên thay vì để bạn tắc ở đó.

**`exceeded retry limit, last status: 429 Too Many Requests`**
Tài khoản bị giới hạn tần suất, và nguyên nhân thường là **thiết kế của chính tool**: pha mở
đầu gọi tất cả các vai **song song** (để không vai nào nhìn bài vai khác). Nếu nhiều vai dùng
chung một tài khoản, đó là nhiều request đồng thời trên cùng một hạn mức. Đã tái hiện trần:
hai `codex exec` chạy song song trên một tài khoản ChatGPT → một cái trả lời, một cái 429.

Và 429 ở pha mở đầu thường **huỷ cả phiên**, vì dưới 2 chuyên gia phát biểu được thì tool
không dựng tranh luận giả. Cách xử lý:

- **Đúng nhất:** mỗi vai một CLI **khác hãng** — vừa hết đụng hạn mức, vừa là điều kiện để
  tranh luận có giá trị ngay từ đầu.
- Hoặc giảm số vai (`--roles architect,domain-expert`), hoặc chờ vài phút rồi chạy lại.

Tool **không tự thử lại** khi gặp 429: thêm backoff vào một pha song song sẽ kéo dài phiên
một cách khó đoán, nên nó báo đúng tên lỗi và để bạn quyết.

**Kiểm tra nhanh trước mỗi lần dùng nghiêm túc**

```bash
node src/index.ts doctor            # miễn phí: CLI nào có mặt, vai nào vào CLI nào
node src/index.ts doctor --health   # tốn ít token: từng cặp (CLI, model) có trả lời được không
```

`doctor --health` canary **từng cặp (runtime, model)**, không phải mỗi runtime một lần —
vì các vai ghim model khác nhau trên cùng một CLI, và một model ngoài gói tài khoản sẽ
lỗi riêng nó.

## Giới hạn cần biết

- **Đã kiểm chứng tới đâu.** 198 test chạy trên **CLI giả**, không cần cài agent nào.
  Ngoài ra đã chạy thật trên Ubuntu 24.04 / Node 22.22 với **codex 0.145.0**: trọn giao
  thức mở đầu → chất vấn → phán quyết, định tuyến câu hỏi đúng, `STATUS: NEEDS_INPUT` chặn
  việc soạn hồ sơ đúng như thiết kế, và đường huỷ phiên khi dưới 2 chuyên gia phát biểu
  được cũng đúng. **Adapter Claude Code đã được xác nhận**: trên Ubuntu 24.04 với
  claude 2.1.301 đăng nhập bằng tài khoản claude.ai, đã chạy trọn một phiên **hai hãng
  thật** (Claude Code làm kiến trúc sư, Codex làm chuyên viên nghiên cứu, Claude làm chủ
  tọa): 5 lượt OK, 12 câu hỏi định tuyến đúng địa chỉ, `STATUS: NEEDS_INPUT` chặn việc soạn
  hồ sơ, chi phí USD báo đúng ($0.5087 cho 3 lượt Claude, 2 lượt Codex ghi rõ là không báo
  giá). Chạy
  `doctor --health` trên máy bạn trước khi tin kết quả; nếu một cờ không được hỗ trợ,
  `argplan.ts` tự thử lại không có nhóm cờ tuỳ chọn — nhưng **chỉ** với lỗi "cờ không hỗ
  trợ" và lỗi sandbox, mọi lỗi khác (kể cả auth do `--bare`) không được thử lại.
  Hành vi của `--bare` thì **đã xác minh**: đọc trực tiếp `claude --help` của bản 2.1.301
  trên Ubuntu 24.04 — "OAuth and keychain are never read". Đó là lý do nó thành có điều kiện
  thay vì mặc định bật.
- **Antigravity (`agy`) và Gemini CLI chưa được chạy thử lần nào** — viết theo tài liệu
  headless, chưa có máy nào cài để xác nhận.
- **Chi phí USD chỉ Claude báo.** Codex/Gemini/Antigravity báo token hoặc không báo gì;
  tổng chi phí luôn ghi rõ có bao nhiêu lượt *không* nằm trong con số đó.
- **Chất lượng tranh luận phụ thuộc vai có thật sự khác nhau.** Ba persona trên cùng một
  model sẽ đồng thuận giả tạo.
- **Sandbox vẫn không đồng đều giữa các CLI**, kể cả sau khi đã xin `--sandbox` cho hai CLI
  Google: Codex được OS cưỡng chế, Claude chỉ bị chặn ở tầng công cụ, còn Google phụ thuộc
  máy có backend sandbox hay không. Tool không san phẳng được khác biệt đó — nó chỉ bảo đảm
  bạn **biết** lượt nào chạy ở mức nào. Bảng đầy đủ: [An toàn & riêng tư](#an-toàn--riêng-tư).
- **Dò sandbox chỉ kiểm tra binary có tồn tại**, không gọi `docker info` (sẽ cộng vài giây
  vào mọi lượt). Máy có `docker` nhưng daemon chết thì lượt đầu lỗi, rồi được thử lại không
  sandbox kèm ghi chú — đúng, nhưng tốn một lượt gọi CLI.
- **Phần hạ cấp mới chỉ chạy trên CLI giả.** Luồng dò máy + thử lại + ghi chú được kiểm bằng
  fake CLI và một phiên chạy thật end-to-end với adapter Gemini trỏ vào fake; chuỗi thông báo
  lỗi của `gemini`/`agy` **thật** khi thiếu docker thì vẫn chưa ai xác nhận — nếu CLI báo bằng
  câu khác, `sandboxUnavailable` trong `argplan.ts` là chỗ cần thêm mẫu.
- Chưa có: chế độ `consensus`/`recheck`, lưu session để tiếp tục giữa các lần chạy (hiện phải
  nối bằng `-m verdict.md`), và kiểm soát đường dẫn **đọc** của agent (đọc vẫn không bị giới
  hạn — xem [An toàn & riêng tư](#an-toàn--riêng-tư)).

## Phát triển

```bash
npm test             # 198 test, không cần CLI nào
npm run typecheck    # tsc --noEmit
```

Kiến trúc và nguồn gốc từng quyết định thiết kế: [`docs/CREDITS.md`](docs/CREDITS.md).
