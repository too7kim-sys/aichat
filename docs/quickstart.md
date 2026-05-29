# Quickstart

## 1. Backend

**Windows (PowerShell)**

```powershell
cd backend
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env   # TAVILY_API_KEY (선택) · OLLAMA 설정 확인
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
- `OLLAMA_MODEL`은 그 서버에 `ollama pull`로 받아둔 모델명과 일치해야 한다.

## 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

브라우저에서 http://localhost:5173 접속. Vite dev 서버가 `/api`를 9000번으로 프록시한다.

## 3. 사용 흐름

1. 사이드바에서 **+ 단일 채팅** 또는 **+ 비교 채팅** 생성
2. 단일 모드: 헤더에 Ollama 모델명 표시
3. 비교 모드: 현재 Ollama 단일 Provider라 단일 모드와 동일하게 표시 (향후 Provider 추가 시 컬럼별 비교)
4. 메시지는 자동으로 SQLite (`backend/aichat.db`)에 저장되어 새로고침 후에도 유지
5. **웹 검색**: 입력창 좌측의 `웹 검색 OFF/ON` 토글. ON이면 메시지 전송 시 Tavily에서 검색 → 결과를 LLM 컨텍스트로 주입 → 답변 위에 출처 링크 표시. `TAVILY_API_KEY` 필요 ([app.tavily.com](https://app.tavily.com), 월 1,000회 무료).
6. **파일 첨부 & 요약**: 입력창의 `📎 첨부` 버튼으로 PDF / DOCX / 이미지 / 텍스트 업로드. 백엔드가 텍스트 추출(스캔 PDF·이미지는 Tesseract OCR) → system 메시지로 LLM에 주입. 첨부는 다음 메시지에만 적용되고 전송 후 자동 제거된다 (세션 동안 클라이언트 메모리 보관).

### OCR 사전 설치 (Windows)

이미지·스캔 PDF의 텍스트를 읽으려면 Tesseract 바이너리가 필요하다. 관리자 PowerShell:

```powershell
winget install UB-Mannheim.TesseractOCR
```

설치 후 `.env`:

```env
TESSERACT_CMD=C:\Program Files\Tesseract-OCR\tesseract.exe
OCR_LANGUAGES=eng+kor
```

한국어 인식은 설치 마법사의 "Additional script data → Korean" 체크 후 가능.

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
