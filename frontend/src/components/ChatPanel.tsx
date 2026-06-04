import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, type ExtractedFile } from "../api/client";
import type { ProviderInfo, SessionDetail } from "../types";
import { MessageBubble } from "./MessageBubble";
import { useArtifacts } from "../artifact/ArtifactContext";
import { useModels } from "../state/ModelContext";
import { streamStore, useLiveStream } from "../state/streamStore";

interface Props {
  sessionId: string;
  providers: ProviderInfo[];
  onTitleSync?: () => void;
}

export interface ChatPanelHandle {
  appendToPrompt: (text: string) => void;
  addAttachmentFromText: (filename: string, text: string) => void;
}

export const ChatPanel = forwardRef<ChatPanelHandle, Props>(function ChatPanel(
  { sessionId, providers, onTitleSync },
  ref
) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [prompt, setPrompt] = useState("");
  const [activeProvider, setActiveProvider] = useState<string>("");
  const [webSearch, setWebSearch] = useState(false);
  const [attachments, setAttachments] = useState<ExtractedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const artifactsState = useArtifacts();
  const { models, selected: model, setSelected: setModel } = useModels();
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  // Subscribe to the (possibly in-flight) stream for this session.
  const liveStream = useLiveStream(sessionId);
  const streaming = !!liveStream && !liveStream.done;
  const liveAssistant = liveStream?.buffer ?? null;
  const livePrompt = liveStream?.prompt ?? null;
  const liveSources = liveStream?.sources ?? null;
  const liveSearchWarning = liveStream?.searchWarning ?? null;

  // Close dropdown on outside click.
  useEffect(() => {
    if (!modelMenuOpen) return;
    function onClick(e: MouseEvent) {
      if (!modelMenuRef.current?.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [modelMenuOpen]);

  useImperativeHandle(ref, () => ({
    appendToPrompt(text: string) {
      setPrompt((prev) => (prev ? prev + text : text));
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    },
    addAttachmentFromText(filename: string, text: string) {
      setAttachments((prev) => [
        ...prev,
        { filename, text, char_count: text.length, method: "project" },
      ]);
    },
  }));

  // Elapsed-time ticker — anchored to the live stream's startedAt so it
  // keeps counting even when the user navigated away and came back.
  useEffect(() => {
    if (!liveStream || liveStream.done) {
      setElapsedSec(0);
      return;
    }
    const startedAt = liveStream.startedAt;
    const tick = () => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [liveStream]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [prompt]);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setLoadError(null);
    setAttachments([]);
    api
      .getSession(sessionId)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setLoadError(msg);
        console.error("getSession failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, loadAttempt]);

  // When a stream for this session finishes, refetch so the persisted
  // assistant message replaces the live overlay.
  useEffect(() => {
    if (!liveStream || !liveStream.done) return;
    let cancelled = false;
    api
      .getSession(sessionId)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch(() => {});
    onTitleSync?.();
    if (liveStream.errors.length) {
      alert(`응답 실패:\n\n${liveStream.errors.join("\n")}`);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveStream?.done, sessionId]);

  useEffect(() => {
    const enabled = providers.filter((p) => p.enabled);
    if (!activeProvider && enabled.length) setActiveProvider(enabled[0].name);
  }, [providers, activeProvider]);

  // Auto-scroll only when the user is already pinned to the bottom.
  // If they've manually scrolled up to re-read the answer or browse the
  // sources, incoming tokens shouldn't yank them back down.
  const stickToBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  function onMessagesScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    const atBottom = distance < 80;
    stickToBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
  }

  function jumpToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    // 'auto' instead of 'smooth' so rapid token updates don't queue
    // animations and stutter.
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, [session, liveAssistant, liveSources]);

  // On session change, snap back to the bottom (new conversation starts
  // pinned) so the latest message is visible.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [sessionId]);

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setUploadProgress({ done: 0, total: files.length });
    const failures: string[] = [];
    const additions: ExtractedFile[] = [];
    let done = 0;

    // Pool of N workers pulling from the queue so a 50-file project
    // doesn't take 50 sequential round trips.
    const queue = [...files];
    const concurrency = 6;
    async function worker() {
      while (queue.length) {
        const f = queue.shift();
        if (!f) break;
        try {
          const ext = await api.extractFile(f);
          const rel = (f as File & { webkitRelativePath?: string })
            .webkitRelativePath;
          if (rel) ext.filename = rel;
          additions.push(ext);
        } catch (e) {
          failures.push(
            `${f.name}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
        done += 1;
        setUploadProgress({ done, total: files.length });
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, files.length) }, worker)
    );

    setAttachments((prev) => [...prev, ...additions]);
    setUploading(false);
    setUploadProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
    if (failures.length) {
      const shown = failures.slice(0, 8).join("\n");
      const more = failures.length > 8 ? `\n…외 ${failures.length - 8}개` : "";
      alert(`첨부 실패:\n\n${shown}${more}`);
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    await uploadFiles(Array.from(files));
  }

  // Skip vendor / build folders + binaries when picking a whole project.
  const _FOLDER_SKIP_DIRS = new Set([
    "node_modules", ".git", ".venv", "venv", "__pycache__",
    "dist", "build", ".next", ".cache", ".vite", ".turbo",
    ".idea", ".vscode", "target", ".pytest_cache", ".mypy_cache",
    "coverage", ".nuxt", "out",
  ]);
  const _FOLDER_ALLOWED_EXT = new Set([
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
    ".java", ".kt", ".rs", ".go", ".c", ".cpp", ".h", ".hpp",
    ".cs", ".rb", ".php", ".sh", ".bash", ".zsh", ".sql",
    ".css", ".scss", ".html", ".htm", ".xml", ".json", ".jsonl",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env",
    ".md", ".markdown", ".txt", ".log", ".csv", ".tsv",
    ".vue", ".svelte", ".astro",
  ]);
  const _FOLDER_MAX_FILES = 50;
  const _FOLDER_MAX_BYTES_PER_FILE = 200 * 1024;

  const [gitModalOpen, setGitModalOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitBusy, setGitBusy] = useState(false);

  async function submitGitClone() {
    if (!gitUrl.trim()) return;
    setGitBusy(true);
    try {
      const res = await api.cloneRepo(gitUrl.trim(), gitRef.trim() || undefined);
      if (!res.files.length) {
        alert(
          `클론은 성공했지만 분석할 코드 파일이 없습니다.\n제외: ${JSON.stringify(
            res.skipped
          )}`
        );
        return;
      }
      // Prefix attachment names with the repo path so the LLM sees them
      // as part of a single project.
      setAttachments((prev) => [
        ...prev,
        ...res.files.map((f) => ({
          ...f,
          filename: `${res.repo}/${f.filename}`,
        })),
      ]);
      setGitModalOpen(false);
      setGitUrl("");
      setGitRef("");
    } catch (e) {
      alert(
        `Git clone 실패: ${e instanceof Error ? e.message.replace(/^\d+\s/, "") : String(e)}`
      );
    } finally {
      setGitBusy(false);
    }
  }

  async function handleFolderPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const allowed: File[] = [];
    let skippedDir = 0;
    let skippedExt = 0;
    let skippedSize = 0;
    let truncated = 0;
    for (const f of Array.from(files)) {
      if (allowed.length >= _FOLDER_MAX_FILES) {
        truncated += 1;
        continue;
      }
      const rel = (f as File & { webkitRelativePath?: string })
        .webkitRelativePath || f.name;
      const segments = rel.split("/");
      if (segments.some((s) => _FOLDER_SKIP_DIRS.has(s))) {
        skippedDir += 1;
        continue;
      }
      const dot = f.name.lastIndexOf(".");
      const ext = dot >= 0 ? f.name.substring(dot).toLowerCase() : "";
      if (!_FOLDER_ALLOWED_EXT.has(ext)) {
        skippedExt += 1;
        continue;
      }
      if (f.size > _FOLDER_MAX_BYTES_PER_FILE) {
        skippedSize += 1;
        continue;
      }
      allowed.push(f);
    }
    if (allowed.length === 0) {
      alert("선택한 폴더에 분석 가능한 코드 파일이 없습니다.");
      return;
    }
    const reasons: string[] = [];
    if (skippedDir) reasons.push(`${skippedDir} 벤더/빌드 폴더`);
    if (skippedExt) reasons.push(`${skippedExt} 미지원 형식`);
    if (skippedSize) reasons.push(`${skippedSize} 200KB 초과`);
    if (truncated) reasons.push(`${truncated} 50개 한도 초과`);
    const summary = reasons.length
      ? ` (${reasons.join(", ")} 제외)`
      : "";
    const ok = window.confirm(
      `${allowed.length}개 파일을 첨부합니다${summary}.\n계속할까요?`
    );
    if (!ok) {
      if (folderInputRef.current) folderInputRef.current.value = "";
      return;
    }
    await uploadFiles(allowed);
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  function startEditTitle() {
    if (!session) return;
    setTitleDraft(session.title);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }

  async function commitTitle() {
    if (!session) return;
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!next || next === session.title) return;
    try {
      const updated = await api.updateSession(session.id, next);
      setSession({ ...session, title: updated.title });
      onTitleSync?.();
    } catch (e) {
      alert(`제목 변경 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function cancelEditTitle() {
    setEditingTitle(false);
    setTitleDraft("");
  }

  // Show the live stream right away (without waiting for the session fetch)
  // so a chat switch back to an in-flight conversation doesn't appear to
  // interrupt the response.
  if (!session) {
    return (
      <div className="chat-panel">
        {liveStream ? (
          <>
            <header className="chat-header">
              <h2 className="chat-title">대화 불러오는 중...</h2>
            </header>
            <div className="messages">
              <div className="messages-inner">
                <MessageBubble role="user" content={liveStream.prompt} />
                <MessageBubble
                  role="assistant"
                  provider="Ollama"
                  content={liveStream.buffer || "응답 생성 중..."}
                  streaming
                />
              </div>
            </div>
          </>
        ) : (
          <div className="chat-loading">
            {loadError ? (
              <>
                <p>대화를 불러오지 못했습니다.</p>
                <p className="chat-loading-detail">{loadError}</p>
                <button
                  className="primary"
                  onClick={() => setLoadAttempt((n) => n + 1)}
                >
                  다시 시도
                </button>
              </>
            ) : (
              <p>불러오는 중...</p>
            )}
          </div>
        )}
      </div>
    );
  }
  const enabledProviders = providers.filter((p) => p.enabled);
  const defaultLabel =
    enabledProviders.find((p) => p.name === activeProvider)?.label ?? "";
  // While the model picker is set to "auto" we don't know which Ollama
  // model the server will choose until the SSE `model` event lands.
  // Show the actual pick (with the routing reason) once known, and a
  // placeholder while we wait.
  const picked = liveStream?.pickedModel ?? null;
  const activeProviderLabel = (() => {
    if (model === "auto") {
      if (picked) return `Ollama (${picked.name}) · 🤖 ${picked.reason}`;
      return "Ollama · 🤖 자동 선택 중…";
    }
    return model ? `Ollama (${model})` : defaultLabel;
  })();

  function send() {
    if (!prompt.trim() || streaming || !activeProvider) return;
    const text = prompt;
    setPrompt("");
    const sentAttachments = attachments;
    setAttachments([]);
    streamStore.start({
      sessionId,
      prompt: text,
      provider: activeProvider,
      model: model || undefined,
      webSearch,
      attachments: sentAttachments.map((a) => ({
        filename: a.filename,
        text: a.text,
      })),
    });
  }

  function formatElapsed(s: number): string {
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, "0");
    return `${m}:${ss}`;
  }

  return (
    <div className="chat-panel">
      <header className="chat-header">
        {editingTitle ? (
          <input
            ref={titleInputRef}
            className="title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTitle();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEditTitle();
              }
            }}
            maxLength={200}
          />
        ) : (
          <h2
            className="chat-title"
            onClick={startEditTitle}
            title="클릭하여 제목 수정"
          >
            {session.title}
          </h2>
        )}
        <div className="chat-header-right">
          <div className="model-select" ref={modelMenuRef}>
            <button
              type="button"
              className="model-info model-trigger"
              onClick={() => setModelMenuOpen((v) => !v)}
              disabled={streaming || models.length === 0}
              title={
                models.length
                  ? `현재 모델: ${
                      model === "auto"
                        ? "🤖 자동"
                        : model || "(기본)"
                    } — 클릭해 변경`
                  : "Ollama 서버에 연결되지 않음"
              }
            >
              <span className="model-info-dot" aria-hidden>●</span>{" "}
              <span className="model-info-name">
                {model === "auto" ? "🤖 자동" : model || defaultLabel}
              </span>
              {models.length > 0 && <span className="model-info-caret">▾</span>}
            </button>
            {modelMenuOpen && (
              <div className="popover model-popover" role="menu">
                <div className="popover-header">Ollama 모델</div>
                <ul className="popover-list">
                  <li
                    className={`auto-pick${model === "auto" ? " active" : ""}`}
                    onClick={() => {
                      setModel("auto");
                      setModelMenuOpen(false);
                    }}
                  >
                    <span className="popover-check" aria-hidden>
                      {model === "auto" ? "✓" : ""}
                    </span>
                    <span className="popover-name">🤖 자동 (권장)</span>
                    <span className="popover-meta">상황 맞춤</span>
                  </li>
                  {models.map((m) => {
                    const active = m.name === model;
                    return (
                      <li
                        key={m.name}
                        className={active ? "active" : ""}
                        onClick={() => {
                          setModel(m.name);
                          setModelMenuOpen(false);
                        }}
                      >
                        <span className="popover-check" aria-hidden>
                          {active ? "✓" : ""}
                        </span>
                        <span className="popover-name">{m.name}</span>
                        <span className="popover-meta">
                          {m.parameter_size ?? formatBytes(m.size)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
          {artifactsState.artifacts.length > 0 && (
            <button
              type="button"
              className="panel-toggle"
              onClick={() => artifactsState.setOpen(!artifactsState.open)}
              title="코드 사이드 패널 토글"
            >
              {artifactsState.open ? "패널 닫기" : `패널 열기 (${artifactsState.artifacts.length})`}
            </button>
          )}
        </div>
      </header>

      <div className="messages" ref={scrollRef} onScroll={onMessagesScroll}>
        <div className="messages-inner">
          {(() => {
            let turn = 0;
            return session.messages.map((m) => {
              if (m.role === "user") turn += 1;
              return (
                <MessageBubble
                  key={m.id}
                  role={m.role}
                  provider={m.provider}
                  content={m.content}
                  artifactTitlePrefix={m.role === "assistant" ? `턴 ${turn}` : undefined}
                />
              );
            });
          })()}
          {/* Live user + assistant bubbles only while the stream is
              still running; once it's done the persisted version is in
              session.messages and we'd duplicate it. The sources box
              below stays visible regardless of done state. */}
          {streaming && livePrompt && (
            <MessageBubble role="user" content={livePrompt} />
          )}
          {streaming && liveAssistant !== null && liveAssistant === "" ? (
            <div className="bubble assistant">
              <div className="avatar">A</div>
              <div className="body">
                <div className="bubble-header">{activeProviderLabel}</div>
                <div className="content thinking">
                  <span className="spinner" />
                  응답 생성 중... {formatElapsed(elapsedSec)}
                </div>
              </div>
            </div>
          ) : (
            streaming && liveAssistant !== null && (
              <MessageBubble
                role="assistant"
                provider={`${activeProviderLabel} · ${formatElapsed(elapsedSec)}`}
                content={liveAssistant}
                streaming
              />
            )
          )}
          {liveSources && (
            <SourcesBox sources={liveSources} warning={liveSearchWarning} />
          )}
        </div>
      </div>

      {showJumpToLatest && (
        <button
          type="button"
          className="jump-to-latest"
          onClick={jumpToLatest}
          title="최신 응답으로 이동"
        >
          ⬇ 최신 응답으로
        </button>
      )}

      <div className="composer-wrap">
        <div className="composer">
          {(attachments.length > 0 || uploading) && (
            <div className="attachments">
              {attachments.length > 0 && (
                <div className="attachments-summary">
                  <span>
                    📎 {attachments.length}개 첨부 · 총{" "}
                    {attachments
                      .reduce((acc, a) => acc + a.char_count, 0)
                      .toLocaleString()}
                    자
                  </span>
                  <button
                    type="button"
                    className="attachments-clear"
                    onClick={() => setAttachments([])}
                    disabled={streaming}
                  >
                    모두 제거
                  </button>
                </div>
              )}
              <div className="attachment-chips">
                {attachments.map((a, i) => (
                  <div key={i} className="attachment-chip">
                    <span className="attachment-name" title={a.filename}>
                      {a.filename}
                    </span>
                    <span className="attachment-meta">
                      {a.method} · {a.char_count.toLocaleString()}자
                    </span>
                    <button
                      type="button"
                      className="attachment-remove"
                      onClick={() => removeAttachment(i)}
                      disabled={streaming}
                      aria-label="제거"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {uploading && (
                  <div className="attachment-chip uploading">
                    업로드 중
                    {uploadProgress &&
                      ` ${uploadProgress.done}/${uploadProgress.total}`}
                    ...
                  </div>
                )}
              </div>
            </div>
          )}
          {attachments.length > 0 && webSearch && (
            <div className="composer-notice">
              <span>
                💡 첨부 파일 분석 시 웹검색은 보통 모델을 산만하게 만들어요.
              </span>
              <button
                type="button"
                className="composer-notice-action"
                onClick={() => setWebSearch(false)}
                disabled={streaming}
              >
                웹검색 끄기
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={prompt}
            placeholder="무엇이든 물어보세요. 파일을 첨부해 요약을 요청할 수 있어요."
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={streaming}
            rows={1}
          />
          <div className="composer-actions">
            <div className="composer-left">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.gif,.bmp,.tif,.tiff,.webp,.html,.xml,.py,.js,.ts,.tsx,.jsx,.java,.go,.rs,.c,.cpp,.h,.cs,.rb,.php,.sh,.sql,.css,.scss,.toml,.yaml,.yml,.log"
                style={{ display: "none" }}
                onChange={(e) => handleFiles(e.target.files)}
              />
              <input
                ref={folderInputRef}
                type="file"
                // @ts-expect-error - non-standard but widely supported
                webkitdirectory=""
                directory=""
                multiple
                style={{ display: "none" }}
                onChange={(e) => handleFolderPick(e.target.files)}
              />
              <button
                type="button"
                className="attach-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={streaming || uploading}
                title="파일 첨부 (PDF / DOCX / 이미지 / 텍스트)"
              >
                📎 첨부
              </button>
              <button
                type="button"
                className="attach-btn"
                onClick={() => folderInputRef.current?.click()}
                disabled={streaming || uploading}
                title="프로젝트 폴더 통째 분석 (vendor·build 폴더 자동 제외, 최대 50개 파일)"
              >
                📁 폴더
              </button>
              <button
                type="button"
                className="attach-btn"
                onClick={() => setGitModalOpen(true)}
                disabled={streaming || uploading}
                title="GitHub/GitLab/Bitbucket 공개 레포 URL을 입력해 소스 분석"
              >
                🔗 Git
              </button>
              <button
                type="button"
                className={`web-toggle ${webSearch ? "on" : ""}`}
                onClick={() => setWebSearch((v) => !v)}
                disabled={streaming}
                title="웹 검색 결과를 LLM 컨텍스트에 포함"
              >
                🌐 {webSearch ? "검색 ON" : "검색"}
              </button>
            </div>
            <div className="composer-right">
              {streaming ? (
                <button
                  className="stop-btn"
                  onClick={() => liveStream?.abort()}
                  title="응답 생성을 중단"
                >
                  ■ 중단 {formatElapsed(elapsedSec)}
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={send}
                  disabled={uploading || !prompt.trim() || !activeProvider}
                >
                  전송
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {gitModalOpen && (
        <div className="git-backdrop" onClick={() => !gitBusy && setGitModalOpen(false)}>
          <div className="git-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Git 레포 분석</h3>
            <p className="git-hint">
              공개 레포의 HTTPS URL을 입력하세요. 허용 호스트: GitHub /
              GitLab / Bitbucket / Codeberg / sr.ht. 백엔드가 shallow
              clone(최대 60초, 100개 파일, 파일당 200KB)으로 받아 분석합니다.
            </p>
            <label className="git-field">
              <span>레포 URL</span>
              <input
                type="url"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                placeholder="https://github.com/user/repo"
                autoFocus
                disabled={gitBusy}
              />
            </label>
            <label className="git-field">
              <span>브랜치 / 태그 (선택)</span>
              <input
                type="text"
                value={gitRef}
                onChange={(e) => setGitRef(e.target.value)}
                placeholder="main, develop, v1.0 ..."
                disabled={gitBusy}
              />
            </label>
            <div className="git-actions">
              <button
                onClick={() => setGitModalOpen(false)}
                disabled={gitBusy}
              >
                취소
              </button>
              <button
                className="primary"
                onClick={submitGitClone}
                disabled={gitBusy || !gitUrl.trim()}
              >
                {gitBusy ? "클론 중..." : "분석 시작"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function SourcesBox({
  sources,
  warning,
}: {
  sources: import("../api/client").SearchSource[];
  warning?: string | null;
}) {
  if (sources.length === 0) {
    return (
      <div className="sources">
        <strong>검색 출처</strong>
        <span className="sources-status"> · 검색 중...</span>
        {warning && <div className="sources-warning">{warning}</div>}
      </div>
    );
  }
  const shop = sources.filter((s) => s.kind === "shop");
  const news = sources.filter((s) => s.kind === "news");
  const web = sources.filter((s) => !s.kind || s.kind === "web");
  return (
    <div className="sources">
      <strong>검색 출처</strong>
      {warning && <div className="sources-warning">⚠ {warning}</div>}
      {shop.length > 0 && (
        <>
          <div className="sources-section">쇼핑</div>
          <div className="shop-grid">
            {shop.map((s, i) => (
              <a
                key={`shop-${i}`}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shop-card"
                title={s.title}
              >
                {s.image ? (
                  <img src={s.image} alt="" loading="lazy" />
                ) : (
                  <div className="shop-card-noimage">이미지 없음</div>
                )}
                <div className="shop-card-body">
                  <div className="shop-card-title">{s.title}</div>
                  {s.lprice != null && (
                    <div className="shop-card-price">
                      {s.lprice.toLocaleString("ko-KR")}원
                    </div>
                  )}
                  {s.mall && <div className="shop-card-mall">{s.mall}</div>}
                </div>
              </a>
            ))}
          </div>
        </>
      )}
      {news.length > 0 && (
        <>
          <div className="sources-section">뉴스</div>
          <ol className="sources-list">
            {news.map((s, i) => (
              <li key={`news-${i}`}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ol>
        </>
      )}
      {web.length > 0 && (
        <>
          <div className="sources-section">웹</div>
          <ol className="sources-list">
            {web.map((s, i) => (
              <li key={`web-${i}`}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
