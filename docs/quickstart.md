# Quickstart

## 1. Backend

**Windows (PowerShell)**

```powershell
cd backend
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env   # OPENAI_API_KEY / ANTHROPIC_API_KEY 채우기
uvicorn app.main:app --reload --port 9000
```

> PowerShell 스크립트 실행이 차단되면 한 번만:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

**macOS / Linux**

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 9000
```

- `OLLAMA_BASE_URL` 기본값 `http://localhost:11434`. 별도 호스트면 .env에 명시.
- 키가 비어있으면 해당 Provider만 비활성화되고 서버는 정상 기동된다.

## 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

브라우저에서 http://localhost:5173 접속. Vite dev 서버가 `/api`를 9000번으로 프록시한다.

## 3. 사용 흐름

1. 사이드바에서 **+ 단일 채팅** 또는 **+ 비교 채팅** 생성
2. 단일 모드: 헤더 드롭다운에서 Ollama / ChatGPT / Claude 선택
3. 비교 모드: 활성화된 모든 Provider에 동시에 질의되어 컬럼별로 응답 비교
4. 메시지는 자동으로 SQLite (`backend/aichat.db`)에 저장되어 새로고침 후에도 유지

## 4. VSCode 디버그 (F5)

`.vscode/`에 디버그 구성이 포함되어 있다. 처음 한 번만 의존성 설치:

```
Ctrl+Shift+P → "Tasks: Run Task" → "backend: install deps"
Ctrl+Shift+P → "Tasks: Run Task" → "frontend: install deps"
```

이후 F5 → 실행할 구성 선택:

| 구성 | 설명 |
|------|------|
| **Full Stack: Backend + Frontend (Chrome)** | uvicorn + Vite + Chrome 자동 기동 (권장) |
| Full Stack: Backend + Frontend (Edge) | Chrome 대신 Edge로 디버그 |
| Full Stack: Backend + Vite (no browser) | 서버만 띄우고 브라우저는 수동 열기 |
| Backend: FastAPI (uvicorn) | 백엔드만 디버그 (`.venv\Scripts\python.exe` 자동 선택) |
| Frontend: Chrome / Edge | 브라우저만 디버그 (Vite 자동 시작) |
| Frontend: Vite dev server | npm run dev를 Node 디버거로 실행 |

브레이크포인트: Python은 `backend/app/**/*.py`, TS는 `frontend/src/**/*.tsx`에 그대로 설정 가능.

## 5. 동작 검증

```bash
# 서버 헬스
curl localhost:9000/api/health

# Provider 상태
curl localhost:9000/api/providers

# 세션 생성
curl -X POST localhost:9000/api/sessions \
     -H 'Content-Type: application/json' \
     -d '{"title":"test","mode":"compare"}'
```
