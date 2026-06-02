# Chat 기능 설계 문서

## 1. 개요

Ollama 서버(로컬 또는 사내)와 연동하여 다음 기능을 제공한다.

- **대화 히스토리 저장**: 세션/메시지를 SQLite에 영구 저장
- **스트리밍 응답**: SSE (Server-Sent Events) 기반 토큰 단위 실시간 출력
- **선택적 웹 검색**: Naver Open API(webkr + news 동시)로 실시간 정보를 가져와 LLM 컨텍스트에 주입
- **파일 첨부 + OCR**: PDF/DOCX/이미지를 텍스트로 추출해 컨텍스트 주입 (스캔 PDF·이미지는 Tesseract OCR)
- **확장 가능한 Provider 추상화**: 향후 다른 LLM 추가 시 한 파일만 작성하면 됨

## 2. 아키텍처

```
┌─────────────────┐         SSE / REST          ┌──────────────────────┐
│  React Frontend │ ◄────────────────────────►  │   FastAPI Backend    │
│  (Vite + TS)    │                              │                      │
└─────────────────┘                              │  ┌────────────────┐ │
                                                 │  │ Chat / Session │ │
                                                 │  │ Files Routers  │ │
                                                 │  └────────┬───────┘ │
                                                 │  ┌────────▼───────┐ │
                                                 │  │ Provider Layer │ │
                                                 │  │  (Strategy)    │ │
                                                 │  └────────┬───────┘ │
                                                 │           ▼         │
                                                 │      Ollama         │
                                                 │  ┌────────────────┐ │
                                                 │  │ SQLite (async) │ │
                                                 │  └────────────────┘ │
                                                 └──────────────────────┘
```

### 2.1 Provider 추상화 (Strategy 패턴)

```python
class LLMProvider(ABC):
    name: str
    @abstractmethod
    async def stream(self, messages: list[Message]) -> AsyncIterator[str]: ...
```

현재 구현체:
- `OllamaProvider`  → `{OLLAMA_BASE_URL}/api/chat`, `OLLAMA_MODEL`로 모델 지정

Provider는 공통 메시지 포맷(`{role, content}`)을 받아 자체 포맷으로 변환하여 호출하고, 응답 청크를 평문 문자열로 yield 한다. 새 Provider 추가 시 `LLMProvider`를 상속한 클래스 1개 작성 + `registry.py`에 등록만 하면 된다.

## 3. 데이터 모델

```
Session
├── id (UUID, PK)
├── title (str)
├── created_at
└── updated_at

Message
├── id (UUID, PK)
├── session_id (FK)
├── role (enum: user | assistant)
├── provider (str, nullable - user 메시지는 NULL)
├── content (text)
├── tokens_out (int, nullable)
├── latency_ms (int, nullable)
└── created_at
```

## 4. API 명세

| Method | Path                              | 설명                              |
|--------|-----------------------------------|-----------------------------------|
| GET    | `/api/health`                     | 서버 헬스체크                     |
| GET    | `/api/providers`                  | 사용 가능한 Provider 목록         |
| GET    | `/api/sessions`                   | 세션 목록                         |
| POST   | `/api/sessions`                   | 세션 생성 (`{title}`)             |
| GET    | `/api/sessions/{id}`              | 세션 + 메시지 조회                |
| DELETE | `/api/sessions/{id}`              | 세션 삭제                         |
| POST   | `/api/sessions/{id}/chat`         | LLM 스트리밍 응답 (SSE)           |
| POST   | `/api/files/extract`              | 첨부 파일 텍스트 추출 (multipart) |

### SSE 이벤트 포맷

```
event: sources
data: {"sources":[{"title":"...","url":"..."}],"error":null}

event: token
data: {"provider":"ollama","delta":"안녕"}

event: done
data: {"provider":"ollama","tokens_out":42,"latency_ms":1280}

event: error
data: {"provider":"ollama","message":"connection refused"}
```

## 5. 디렉터리 구조

```
aichat/
├── docs/design.md
├── backend/
│   ├── app/
│   │   ├── main.py             # FastAPI app + CORS
│   │   ├── config.py           # 환경변수 (pydantic-settings)
│   │   ├── database.py         # async SQLAlchemy engine
│   │   ├── models.py           # ORM 모델
│   │   ├── schemas.py          # Pydantic I/O 스키마
│   │   ├── providers/
│   │   │   ├── base.py
│   │   │   ├── ollama.py
│   │   │   └── registry.py
│   │   ├── search/             # Naver Open API 웹 검색
│   │   │   └── naver.py
│   │   ├── files/              # PDF/DOCX/OCR 추출
│   │   │   └── extract.py
│   │   └── routers/
│   │       ├── chat.py
│   │       ├── sessions.py
│   │       └── files.py
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api/client.ts
        ├── components/
        │   ├── Sidebar.tsx
        │   ├── ChatPanel.tsx
        │   └── MessageBubble.tsx
        └── styles/app.css
```

## 6. 환경 설정

`.env`:
```
NAVER_CLIENT_ID=...            # 선택. 웹 검색 토글 사용 시 필요
NAVER_CLIENT_SECRET=...
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1
DATABASE_URL=sqlite+aiosqlite:///./aichat.db
CORS_ORIGINS=http://localhost:5173

TESSERACT_CMD=                  # OCR: Windows는 tesseract.exe 절대경로
OCR_LANGUAGES=eng+kor
MAX_UPLOAD_BYTES=5242880
MAX_ATTACHMENT_CHARS=50000
```

`OLLAMA_BASE_URL`이 비어있으면 Provider가 `enabled: false`로 노출되고 UI에서 비활성화된다.

## 7. 시퀀스: 1턴 (웹 검색 ON + 파일 첨부)

```
User → FE: "이 파일 요약해줘" + 📎 PDF + 🌐 ON
FE   → BE: POST /api/files/extract  (PDF → 텍스트)
FE   → BE: POST /api/sessions/{id}/chat
            { prompt, attachments:[{filename, text}], web_search:true }
BE   → Naver: webkr + news 병렬 호출
BE   → FE: event: sources
BE   → Ollama: stream(system=[search context] + system=[attached files] + history + user)
Ollama → BE → FE: event: token (반복)
BE   → DB: INSERT user + assistant 메시지
BE   → FE: event: done
```

## 8. 향후 확장

- 사용자 인증 / 멀티 사용자
- 이미지 입력 모델 (LLaVA 등)로 첨부 이미지를 텍스트 변환 없이 직접 전달
- Tool use / Function calling
- 응답 평가 (좋아요/싫어요) + 히스토리 검색
- 메시지 히스토리 슬라이딩 윈도우 (긴 대화의 컨텍스트 길이 제한 대응)

## 9. 위험 요소 및 대응

- **Ollama 미설치/원격 다운**: `/api/providers`에서 enabled=false, UI 비활성
- **모델 미존재 (404)**: provider 에러를 SSE error 이벤트로 사용자에게 전달
- **컨텍스트 길이 초과**: 첨부 텍스트는 `MAX_ATTACHMENT_CHARS`로 자르고, 메시지 히스토리는 슬라이딩 윈도우 도입 (미구현)
- **SSE 연결 중단**: 클라이언트 catch + 화면 표시. partial 응답도 DB에 저장
- **Tesseract 미설치**: OCR 시도 시 명확한 에러 메시지로 폴백
