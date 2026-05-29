# Multi-LLM Chat 기능 설계 문서

## 1. 개요

Ollama 서버(로컬 또는 사내)와 연동하여 다음 기능을 제공한다.

- **대화 히스토리 저장**: 세션/메시지를 SQLite에 영구 저장
- **스트리밍 응답**: SSE (Server-Sent Events) 기반 토큰 단위 실시간 출력
- **선택적 웹 검색**: Tavily로 실시간 정보를 가져와 LLM 컨텍스트에 주입
- **확장 가능한 Provider 추상화**: 향후 다른 LLM 추가 시 한 파일만 작성하면 됨

## 2. 아키텍처

```
┌─────────────────┐         SSE / REST          ┌──────────────────────┐
│  React Frontend │ ◄────────────────────────►  │   FastAPI Backend    │
│  (Vite + TS)    │                              │                      │
└─────────────────┘                              │  ┌────────────────┐ │
                                                 │  │ Chat Router    │ │
                                                 │  │ Session Router │ │
                                                 │  └────────┬───────┘ │
                                                 │           │         │
                                                 │  ┌────────▼───────┐ │
                                                 │  │ Provider Layer │ │
                                                 │  │  (Strategy)    │ │
                                                 │  └────────┬───────┘ │
                                                 │           │         │
                                                 │  ┌────────┼───────┐ │
                                                 │  │        │       │ │
                                                 │  ▼                  │
                                                 │ Ollama              │
                                                 │           │         │
                                                 │  ┌────────▼───────┐ │
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

### 2.2 병렬 비교 실행

```python
async def parallel_stream(prompt, history):
    queues = {name: asyncio.Queue() for name in providers}
    async def run(name, provider):
        async for tok in provider.stream(history + [user_msg]):
            await queues[name].put(tok)
        await queues[name].put(SENTINEL)
    tasks = [asyncio.create_task(run(n, p)) for n, p in providers.items()]
    # 큐에서 round-robin으로 뽑아 SSE 이벤트로 송출
```

각 모델의 토큰은 `event: <provider_name>` 으로 라벨링되어 클라이언트가 컬럼별로 매칭한다.

## 3. 데이터 모델

```
Session
├── id (UUID, PK)
├── title (str)
├── mode (enum: single | compare)
├── created_at
└── updated_at

Message
├── id (UUID, PK)
├── session_id (FK)
├── role (enum: user | assistant)
├── provider (str, nullable - user 메시지는 NULL)
├── content (text)
├── tokens_in / tokens_out (int, nullable)
├── latency_ms (int, nullable)
└── created_at
```

비교 모드에서 한 사용자 질문에 대한 3개 assistant 응답은 같은 `session_id` + 동일 시점의 `created_at`으로 묶이며 `provider` 컬럼으로 구분한다.

## 4. API 명세

| Method | Path                              | 설명                                |
|--------|-----------------------------------|-------------------------------------|
| GET    | `/api/health`                     | 서버 + 각 Provider 헬스체크         |
| GET    | `/api/providers`                  | 사용 가능한 Provider 목록           |
| GET    | `/api/sessions`                   | 세션 목록                           |
| POST   | `/api/sessions`                   | 세션 생성 (`{title, mode}`)         |
| GET    | `/api/sessions/{id}`              | 세션 + 메시지 조회                  |
| DELETE | `/api/sessions/{id}`              | 세션 삭제                           |
| POST   | `/api/sessions/{id}/chat`         | 단일 모델 스트리밍 (SSE)            |
| POST   | `/api/sessions/{id}/compare`      | 3개 모델 병렬 스트리밍 (SSE)        |

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
│   │   ├── search/             # Tavily 웹 검색
│   │   │   └── tavily.py
│   │   └── routers/
│   │       ├── chat.py
│   │       └── sessions.py
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
        │   ├── CompareView.tsx
        │   └── MessageBubble.tsx
        └── styles/app.css
```

## 6. 환경 설정

`.env`:
```
TAVILY_API_KEY=tvly-...        # 선택. 웹 검색 토글 사용 시 필요
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1
DATABASE_URL=sqlite+aiosqlite:///./aichat.db
CORS_ORIGINS=http://localhost:5173
```

`OLLAMA_BASE_URL`이 비어있으면 Provider가 `enabled: false`로 노출되고 UI에서 비활성화된다.

## 7. 시퀀스: 단일 채팅 1턴 (웹 검색 ON)

```
User → FE: "오늘 환율 알려줘" + 웹 검색 토글 ON
FE   → BE: POST /api/sessions/{id}/chat (web_search=true)
BE   → Tavily: search("오늘 환율 알려줘")
Tavily → BE: 상위 5개 결과 + 요약
BE   → FE: event: sources (UI가 출처 박스 렌더)
BE   → Ollama: stream(system=[검색 컨텍스트] + history + user)
Ollama → BE → FE: event: token (반복)
Ollama → BE: 스트림 종료
BE   → DB: INSERT user + assistant 메시지
BE   → FE: event: done
```

## 8. MVP 범위 vs 향후 확장

| 항목                    | MVP | 향후 |
|-------------------------|-----|------|
| 3개 Provider 통합       | ✓   |      |
| SSE 스트리밍            | ✓   |      |
| 세션/메시지 영속화      | ✓   |      |
| 병렬 비교 UI            | ✓   |      |
| 사용자 인증             |     | ✓    |
| 파일/이미지 첨부        |     | ✓    |
| Tool use / Function     |     | ✓    |
| 응답 평가 (좋아요)      |     | ✓    |
| 비용 집계 대시보드      |     | ✓    |

## 9. 위험 요소 및 대응

- **Ollama 미설치 환경**: `/api/providers`에서 enabled=false 처리, UI 비활성화
- **API 키 누락**: 시작 시 경고 로그만 출력, 해당 Provider만 비활성
- **Provider별 응답 속도 편차**: 큐 기반 비동기로 빠른 모델 출력이 느린 모델에 막히지 않음
- **SSE 연결 중단**: 클라이언트에서 EventSource 재연결, 서버는 진행 중 메시지를 partial로 저장
- **컨텍스트 길이 초과**: 각 Provider별 max_tokens 설정 + 메시지 히스토리 슬라이딩 윈도우 (최근 N개)
