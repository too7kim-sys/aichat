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
  const [elapsedSec, setElapsedSec] = useState(0);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [session, liveAssistant]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    const failures: string[] = [];
    const additions: ExtractedFile[] = [];
    for (const f of Array.from(files)) {
      try {
        additions.push(await api.extractFile(f));
      } catch (e) {
        failures.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setAttachments((prev) => [...prev, ...additions]);
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (failures.length) alert(`첨부 실패:\n\n${failures.join("\n")}`);
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
  const activeProviderLabel = model ? `Ollama (${model})` : defaultLabel;

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
                  ? `현재 모델: ${model || "(기본)"} — 클릭해 변경`
                  : "Ollama 서버에 연결되지 않음"
              }
            >
              <span className="model-info-dot" aria-hidden>●</span>{" "}
              <span className="model-info-name">{model || defaultLabel}</span>
              {models.length > 0 && <span className="model-info-caret">▾</span>}
            </button>
            {modelMenuOpen && (
              <div className="popover model-popover" role="menu">
                <div className="popover-header">Ollama 모델</div>
                <ul className="popover-list">
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

      <div className="messages" ref={scrollRef}>
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
            <SourcesBox sources={liveSources} />
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          {(attachments.length > 0 || uploading) && (
            <div className="attachments">
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
                <div className="attachment-chip uploading">업로드 중...</div>
              )}
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
    </div>
  );
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function SourcesBox({ sources }: { sources: import("../api/client").SearchSource[] }) {
  if (sources.length === 0) {
    return (
      <div className="sources">
        <strong>Naver 검색 출처</strong>
        <span className="sources-status"> · 검색 중...</span>
      </div>
    );
  }
  const shop = sources.filter((s) => s.kind === "shop");
  const news = sources.filter((s) => s.kind === "news");
  const google = sources.filter((s) => s.kind === "google");
  const web = sources.filter((s) => !s.kind || s.kind === "web");
  return (
    <div className="sources">
      <strong>Naver 검색 출처</strong>
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
          <div className="sources-section">웹 (Naver)</div>
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
      {google.length > 0 && (
        <>
          <div className="sources-section">웹 (Google)</div>
          <ul className="sources-list google-list">
            {google.map((s, i) => (
              <li key={`google-${i}`}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.image && (
                    <img
                      src={s.image}
                      alt=""
                      className="google-thumb"
                      loading="lazy"
                    />
                  )}
                  <span className="google-body">
                    <span className="google-title">{s.title || s.url}</span>
                    {s.displayLink && (
                      <span className="google-link">{s.displayLink}</span>
                    )}
                    {s.snippet && (
                      <span className="google-snippet">{s.snippet}</span>
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
