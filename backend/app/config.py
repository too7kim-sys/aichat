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
    # Per-project file limits (separate from the git/folder upload
    # caps because the corpus is meant to be larger).
    rag_max_files: int = 5000
    rag_max_bytes_per_file: int = 1024 * 1024
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

    cors_origins: str = "http://localhost:5173"

    # Sliding window: only the most recent N messages (user + assistant)
    # are sent to the LLM. System messages (attachments, web search)
    # are always kept and don't count against this limit.
    max_history_messages: int = 30

    tesseract_cmd: str = ""  # e.g. C:\\Program Files\\Tesseract-OCR\\tesseract.exe
    ocr_languages: str = "eng+kor"
    max_upload_bytes: int = 5 * 1024 * 1024  # 5 MB
    max_attachment_chars: int = 50_000

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
