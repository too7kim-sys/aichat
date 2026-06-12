from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # protected_namespaces=() lets us use MODEL_AUTO_* field names
    # without pydantic v2 warning about the reserved "model_" prefix.
    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
        protected_namespaces=(),
    )

    naver_client_id: str = ""
    naver_client_secret: str = ""
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.1"
    # Ollama's server default is num_ctx=2048, which silently truncates
    # any non-trivial code attachment and makes the model claim "the
    # provided code is limited." We pass num_ctx explicitly: the floor
    # is used for short chats, and we grow up to the cap when the
    # message payload demands it. 32k covers most attached projects on
    # modern models; raise OLLAMA_NUM_CTX_MAX in .env if your model
    # supports more (llama3.1 = 128k, qwen3 = 32k, etc.).
    ollama_num_ctx: int = 8192
    ollama_num_ctx_max: int = 32768

    # Generation knobs. Lower temperature + top_p reduces "creative"
    # hallucinations (made-up function names, fake CVE numbers,
    # confident-but-wrong claims), which is what we want for code
    # review / vulnerability analysis. Set to a negative number to fall
    # back to the model's built-in default.
    ollama_temperature: float = 0.3
    ollama_top_p: float = 0.9
    ollama_repeat_penalty: float = 1.05

    # Always prepend the strict accuracy / anti-hallucination system
    # prompt (see chat.py:_ACCURACY_SYSTEM). Set to false only if you
    # are running a model that already follows the rules and the extra
    # tokens are eating into your context budget.
    accuracy_strict: bool = True

    # Free-form text appended as an additional system message on every
    # request. Use this to add house style, domain glossary, escalation
    # rules, or any other instruction you'd otherwise paste at the top
    # of each prompt. Leave blank for none.
    system_prompt_extra: str = ""

    # Auto model routing. When the chat request sends `model="auto"`,
    # the chat router classifies the prompt + attachments and picks
    # one of the names below. Leave any of these blank to fall back
    # to OLLAMA_MODEL — the auto-pick still happens, the chosen
    # category just maps to the default.
    #
    # Suggested values for an MSI EdgeXpert (128 GB unified memory):
    #   MODEL_AUTO_CODE=qwen2.5-coder:32b
    #   MODEL_AUTO_REASONING=deepseek-r1:32b
    #   MODEL_AUTO_GENERAL=llama3.1:8b      # or any fast generalist
    model_auto_code: str = ""
    model_auto_reasoning: str = ""
    model_auto_general: str = ""
    # Vision-capable model for image attachments. When set and the
    # user attaches an image, auto routing sends the image bytes to
    # this model instead of falling back to OCR-only. Examples:
    #   qwen2.5vl:7b  /  llama3.2-vision:11b  /  gemma3:12b
    model_auto_vision: str = ""

    # ── Code workspaces (Phase 1 of the in-app Code/IDE feature) ──
    workspace_dir: str = "./workspaces"
    # Secret used to encrypt-at-rest per-workspace git credentials.
    # When blank, falls back to JWT_SECRET. Keep stable — rotating
    # this invalidates every stored token.
    workspace_secret: str = ""
    # Comma-separated host allow-list for git URLs. Empty = any host
    # allowed (suitable for closed-net deployments where the entire
    # LAN is trusted). For external use, restrict to internal hosts.
    workspace_allowed_hosts: str = ""
    workspace_max_size_mb: int = 500
    workspace_max_files: int = 5000
    workspace_clone_depth: int = 50
    # Chat auto-attach budget — every code-focused turn re-walks the
    # workspace and stuffs the top-ranked files (controllers + DAOs +
    # configs first, tests / examples last) into the prompt. The
    # walker stops once any of the three caps is hit. Defaults: 300
    # files / 300 KB per file / 8 MB total — comfortable for a
    # mid-size monorepo on a 32K-context model. Bump these for
    # bigger projects on a model with a larger context window.
    workspace_bundle_max_files: int = 300
    workspace_bundle_max_bytes_per_file: int = 300 * 1024
    workspace_bundle_max_total_bytes: int = 8 * 1024 * 1024
    # Comma-separated allow-list of root directories the "local folder"
    # workspace source can register paths under. Empty = the feature is
    # disabled (creating a local-folder workspace will return a clear
    # error). For closed-net deployments, set this to the directories
    # the backend process can already see — e.g. WORKSPACE_LOCAL_ROOTS=
    # /home/user/projects,/srv/work. Symlinks are resolved before the
    # allow-list check.
    workspace_local_roots: str = ""

    # ── RAG / 코드 검색 ────────────────────────────────────────────
    # Toggle the whole feature. When false, project routes still
    # respond (so the UI doesn't break) but no indexing/retrieval
    # work happens.
    rag_enabled: bool = True
    # Embedding model served by Ollama. bge-m3 is multilingual
    # (strong in Korean), 1024-dim, 8K context. Install once with:
    #   ollama pull bge-m3
    rag_embed_model: str = "bge-m3"
    rag_embed_dim: int = 1024
    # Qdrant local persistent mode — no docker, no separate server.
    # Path is a directory the backend may create. Switch to a remote
    # url like http://localhost:6333 to point at a real Qdrant server
    # later without code changes.
    rag_qdrant_path: str = "./qdrant_data"
    rag_qdrant_url: str = ""  # if set, uses HTTP client instead of local
    # Chunking: line-based with overlap. 200 / 30 fits ~3-6 KB of
    # source per chunk which embeds cleanly under bge-m3's 8K cap.
    rag_chunk_lines: int = 200
    rag_chunk_overlap: int = 30
    # Retrieval: Top-K chunks per query. 12 keeps token cost sane
    # while covering ~6-8 files of relevant code.
    rag_top_k: int = 12
    # Minimum cosine score a chunk must clear to be injected during
    # question-driven auto-search across shared knowledge bases (the
    # "연결 안 해도 자동 활용" path). Explicit per-session links skip
    # this gate. Tuned conservative so an unrelated knowledge base
    # doesn't bleed noise into every answer; lower it if relevant
    # bases are being missed.
    rag_auto_min_score: float = 0.45
    # Per-project file limits (separate from the git/folder upload
    # caps because the corpus is meant to be larger).
    rag_max_files: int = 5000
    # Per-file size cap the indexer enforces during the corpus walk —
    # files larger than this are skipped entirely (no chunks, no
    # embeddings). The default lands at 50 MB so typical PDF /
    # DOCX manuals fit; bump it for atlases / e-books / huge log
    # files. Note this also covers code / api / db corpora which
    # rarely need anything close to this much per file.
    rag_max_bytes_per_file: int = 50 * 1024 * 1024
    # Where the "upload" document source stores user-supplied files —
    # one subdirectory per project, written by the upload endpoint and
    # walked by the indexer like a regular folder source.
    rag_upload_dir: str = "./rag_uploads"
    # Per-upload file cap (bytes). Matched to rag_max_bytes_per_file
    # by default — letting a user upload a 200 MB file that the
    # indexer would immediately skip just wastes bandwidth + disk.
    # Set this BELOW rag_max_bytes_per_file when you want to allow
    # only certain admins to push huge files via a server folder.
    rag_upload_max_bytes: int = 200 * 1024 * 1024
    # Auto-refresh scheduling. Sub-day intervals fire on wall-clock
    # boundaries (e.g. a 60-min interval runs at :00 every hour, a
    # 30-min one at :00 and :30) instead of drifting from the last
    # run. Day-or-longer intervals fire once at rag_daily_refresh_hour
    # local time ("새벽"), every N days. rag_tz_offset_hours converts
    # the server's UTC clock to local for these boundary checks
    # (default 9 = KST).
    rag_daily_refresh_hour: int = 3
    rag_tz_offset_hours: int = 9

    # 회의록·강의 전사 (선택 기능). 의존성이 무거워서 기본 off.
    # pip install faster-whisper pyannote.audio + HF 토큰 + 모델 다운로드
    # 후 ENABLE_TRANSCRIPTION=true 로 켭니다.
    enable_transcription: bool = False
    # faster-whisper 모델: tiny | base | small | medium | large-v2 | large-v3
    whisper_model: str = "large-v3"
    # cuda | cpu | auto
    whisper_device: str = "auto"
    # float16 | int8_float16 | int8 (CPU 는 자동으로 int8)
    whisper_compute_type: str = "float16"
    # Whisper 모델 캐시 디렉토리 (모델 ~3GB)
    whisper_model_dir: str = "./models/whisper"
    # 폐쇄망(오프라인) 모드 — true 면 HF 허브 접속을 차단하고 로컬에
    # 미리 받아둔 모델만 사용합니다. 인터넷 되는 PC에서 모델을 받아
    # WHISPER_MODEL 에 로컬 폴더 경로를 지정한 뒤 이 값을 켜세요.
    transcription_offline: bool = False
    # 화자 분리(pyannote.audio) — HF 토큰 + 모델 약관 동의 필요.
    # 비활성화 시 전사만 진행하고 SPEAKER 라벨은 붙지 않습니다.
    enable_diarization: bool = False
    hf_token: str = ""
    # 업로드 오디오 최대 크기 (MB). 한 시간 mp3 ~60MB.
    transcription_max_upload_mb: int = 200
    # 요약 시 사용할 모델 — 비우면 OLLAMA_MODEL 폴백.
    transcription_summary_model: str = ""
    database_url: str = "sqlite+aiosqlite:///./aichat.db"
    # Auth — change JWT_SECRET in .env for any non-local deployment.
    jwt_secret: str = "dev-only-change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_hours: int = 24 * 14

    # Email delivery. Leave SMTP_HOST empty for a stdout-only fallback
    # so the verification / reset links still print during dev without
    # any account setup.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_use_tls: bool = True
    smtp_use_ssl: bool = False  # use this when port == 465

    # Where verification + reset links should land in the browser.
    app_base_url: str = "http://localhost:5173"

    verify_token_hours: int = 24
    reset_token_hours: int = 1

    # Signup approval policy. `require_approval` here is only an
    # *initial* seed value — once the app boots, the source of truth
    # lives in the app_settings table (key: auto_approve_signups) so
    # admins can flip it at runtime from the dashboard.
    #
    # Default False = auto-approval ON (anyone who signs up is
    # immediately active). Set REQUIRE_APPROVAL=true in the env to
    # seed a fresh install into manual-approval mode instead.
    require_approval: bool = False
    admin_email: str = ""

    cors_origins: str = "http://localhost:5173"

    # When set to a non-empty path, the backend also serves the built
    # frontend (`frontend/dist/index.html` + assets) from `/`. Lets a
    # single uvicorn host both the API and the SPA — handy on
    # closed-network single-server deploys that don't put nginx in
    # front. Leave empty in dev so vite handles HMR.
    #   Example (production):
    #     FRONTEND_DIST_DIR=/data/projects/aichat/frontend/dist
    frontend_dist_dir: str = ""

    # Sliding window: only the most recent N messages (user + assistant)
    # are sent to the LLM. System messages (attachments, web search)
    # are always kept and don't count against this limit.
    max_history_messages: int = 30

    # 워크플로 자동 실행이 만들어내는 채팅 세션은 시간이 지나면 무한히
    # 쌓인다 (스케줄이 10분 간격이면 하루 144개). 워크플로별로 최근
    # N개만 보존하고 그보다 오래된 자동 세션은 매 실행 직후 정리.
    # 0 으로 두면 보존(=정리 안 함).
    workflow_auto_session_retention: int = 10

    # RAG SFTP 소스의 허용 호스트 목록 (콤마 구분). 비어 있으면 SSRF
    # 가드가 자동으로 동작 — 내부망/loopback/link-local 거부. 사내
    # SFTP 서버를 정당하게 쓰려면 그 호스트만 명시 (예:
    # `files.intra.example.com,sftp.intra.example.com`).
    rag_sftp_host_allowlist: str = ""

    tesseract_cmd: str = ""  # e.g. C:\\Program Files\\Tesseract-OCR\\tesseract.exe
    ocr_languages: str = "eng+kor"
    max_upload_bytes: int = 5 * 1024 * 1024  # 5 MB
    max_attachment_chars: int = 50_000

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def workspace_allowed_host_list(self) -> list[str]:
        return [
            h.strip()
            for h in self.workspace_allowed_hosts.split(",")
            if h.strip()
        ]

    @property
    def workspace_local_root_list(self) -> list[str]:
        """Allow-list roots, with `~` expanded and normalised to
        absolute paths. Used by the local-folder workspace source to
        constrain which directories the user can register."""
        import os
        roots: list[str] = []
        for raw in self.workspace_local_roots.split(","):
            cleaned = raw.strip()
            if not cleaned:
                continue
            expanded = os.path.abspath(os.path.expanduser(cleaned))
            roots.append(expanded)
        return roots


settings = Settings()
