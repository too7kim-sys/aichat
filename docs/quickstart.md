# Quickstart

## 1. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # OPENAI_API_KEY / ANTHROPIC_API_KEY 채우기
uvicorn app.main:app --reload --port 8000
```

- `OLLAMA_BASE_URL` 기본값 `http://localhost:11434`. 별도 호스트면 .env에 명시.
- 키가 비어있으면 해당 Provider만 비활성화되고 서버는 정상 기동된다.

## 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

브라우저에서 http://localhost:5173 접속. Vite dev 서버가 `/api`를 8000번으로 프록시한다.

## 3. 사용 흐름

1. 사이드바에서 **+ 단일 채팅** 또는 **+ 비교 채팅** 생성
2. 단일 모드: 헤더 드롭다운에서 Ollama / ChatGPT / Claude 선택
3. 비교 모드: 활성화된 모든 Provider에 동시에 질의되어 컬럼별로 응답 비교
4. 메시지는 자동으로 SQLite (`backend/aichat.db`)에 저장되어 새로고침 후에도 유지

## 4. 동작 검증

```bash
# 서버 헬스
curl localhost:8000/api/health

# Provider 상태
curl localhost:8000/api/providers

# 세션 생성
curl -X POST localhost:8000/api/sessions \
     -H 'Content-Type: application/json' \
     -d '{"title":"test","mode":"compare"}'
```
