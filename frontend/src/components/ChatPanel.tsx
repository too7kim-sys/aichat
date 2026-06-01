import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  api,
  streamChat,
  type ExtractedFile,
  type OllamaModel,
  type SearchSource,
} from "../api/client";
import type { ProviderInfo, SessionDetail } from "../types";
import { MessageBubble } from "./MessageBubble";
import { useArtifacts } from "../artifact/ArtifactContext";
import { useProject, type ProjectTreeNode } from "../project/ProjectContext";
import { readFileText, type ProjectFile } from "../project/fsAccess";

interface Props {
  sessionId: string;
  providers: ProviderInfo[];
  onTitleSync?: () => void;
  onApplyFiles?: (
    files: { path: string; language: string; content: string }[]
  ) => void;
}

export interface ChatPanelHandle {
  appendToPrompt: (text: string) => void;
  addAttachmentFromText: (filename: string, text: string) => void;
}

export const ChatPanel = forwardRef<ChatPanelHandle, Props>(function ChatPanel(
  { sessionId, providers, onTitleSync, onApplyFiles },
  ref
) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [prompt, setPrompt] = useState("");
  const [activeProvider, setActiveProvider] = useState<string>("");
  const [streaming, setStreaming] = useState(false);
  const [liveAssistant, setLiveAssistant] = useState<string | null>(null);
  const [livePrompt, setLivePrompt] = useState<string | null>(null);
  const [webSearch, setWebSearch] = useState(false);
  const [liveSources, setLiveSources] = useState<SearchSource[] | null>(null);
  const [attachments, setAttachments] = useState<ExtractedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const artifactsState = useArtifacts();
  const project = useProject();
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [model, setModel] = useState<string>("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);

  // Fetch the live model list from the Ollama server once.
  useEffect(() => {
    let cancelled = false;
    api
      .listOllamaModels()
      .then((res) => {
        if (cancelled) return;
        setModels(res.models);
        if (!model) setModel(res.current);
      })
      .catch(() => {
        /* Ollama may be unreachable; leave the menu empty. */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

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

  useEffect(() => {
    if (streamStartedAt === null) {
      setElapsedSec(0);
      return;
    }
    const tick = () =>
      setElapsedSec(Math.floor((Date.now() - streamStartedAt) / 1000));
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [streamStartedAt]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [prompt]);

  useEffect(() => {
    api.getSession(sessionId).then(setSession);
    setLiveAssistant(null);
    setLivePrompt(null);
    setLiveSources(null);
    setAttachments([]);
  }, [sessionId]);

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

  async function attachProjectFile(file: ProjectFile) {
    try {
      const text = await readFileText(file);
      setAttachments((prev) => [
        ...prev,
        { filename: file.path, text, char_count: text.length, method: "project" },
      ]);
      setFilePickerOpen(false);
    } catch (e) {
      alert(`첨부 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function clearConversation() {
    if (!session) return;
    const ok = window.confirm(
      `이 세션의 메시지를 모두 삭제할까요?\n(세션 자체는 유지됩니다)`
    );
    if (!ok) return;
    try {
      await api.clearMessages(session.id);
      const refreshed = await api.getSession(session.id);
      setSession(refreshed);
    } catch (e) {
      alert(`삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function saveConversation() {
    if (!session) return;
    const lines: string[] = [`# ${session.title}`, ""];
    for (const m of session.messages) {
      const who =
        m.role === "user" ? "**User**" : `**Assistant (${m.provider ?? "?"})**`;
      lines.push(who, "", m.content, "");
    }
    const blob = new Blob([lines.join("\n")], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${session.title.replace(/[^\w가-힣.\-]+/g, "-").slice(0, 60) || "chat"}.md`;
    a.click();
    URL.revokeObjectURL(url);
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

  if (!session) return <div className="chat-panel">불러오는 중...</div>;
  const enabledProviders = providers.filter((p) => p.enabled);
  const defaultLabel =
    enabledProviders.find((p) => p.name === activeProvider)?.label ?? "";
  const activeProviderLabel = model ? `Ollama (${model})` : defaultLabel;

  async function send() {
    if (!prompt.trim() || streaming || !activeProvider) return;
    const text = prompt;
    setPrompt("");
    setLivePrompt(text);
    setStreaming(true);
    setLiveAssistant("");
    setLiveSources(webSearch ? [] : null);
    setStreamStartedAt(Date.now());

    const errors: string[] = [];
    const sentAttachments = attachments;
    let buffer = "";
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    try {
      await streamChat(sessionId, text, {
        provider: activeProvider,
        model: model || undefined,
        webSearch,
        signal: controller.signal,
        attachments: sentAttachments.map((a) => ({
          filename: a.filename,
          text: a.text,
        })),
        onToken: (_provider, delta) => {
          buffer += delta;
          setLiveAssistant(buffer);
        },
        onDone: () => {},
        onError: (_provider, message) => {
          errors.push(message);
          buffer += `\n[error: ${message}]`;
          setLiveAssistant(buffer);
        },
        onSources: (sources, error) => {
          if (error) errors.push(`web search: ${error}`);
          setLiveSources(sources);
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      buffer += `\n[error: ${msg}]`;
      setLiveAssistant(buffer);
      console.error(e);
    } finally {
      abortRef.current = null;
      if (!aliveRef.current) return;
      try {
        const refreshed = await api.getSession(sessionId);
        if (!aliveRef.current) return;
        setSession(refreshed);
        if (refreshed.title === "New chat" || text) {
          onTitleSync?.();
        }
      } catch {
        // ignore refetch failure - already showed errors above
      }
      setLiveAssistant(null);
      setLivePrompt(null);
      setLiveSources(null);
      setAttachments([]);
      setStreaming(false);
      setStreamStartedAt(null);
      if (errors.length) {
        alert(`응답 실패:\n\n${errors.join("\n")}`);
      }
    }
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
          <span className="model-info">{activeProviderLabel}</span>
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
                  onApplyFiles={m.role === "assistant" ? onApplyFiles : undefined}
                />
              );
            });
          })()}
          {livePrompt && <MessageBubble role="user" content={livePrompt} />}
          {liveAssistant !== null && liveAssistant === "" ? (
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
            liveAssistant !== null && (
              <MessageBubble
                role="assistant"
                provider={`${activeProviderLabel} · ${formatElapsed(elapsedSec)}`}
                content={liveAssistant}
                streaming
              />
            )
          )}
          {liveSources && (
            <div className="sources">
              <strong>웹 검색 출처</strong>
              {liveSources.length === 0 ? (
                <span className="sources-status"> · 검색 중...</span>
              ) : (
                <ol>
                  {liveSources.map((s, i) => (
                    <li key={i}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.title || s.url}
                      </a>
                    </li>
                  ))}
                </ol>
              )}
            </div>
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
              <div className="composer-popover-wrap">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setFilePickerOpen((v) => !v)}
                  disabled={streaming || !project.root}
                  title={
                    project.root
                      ? "프로젝트 파일 첨부"
                      : "사이드바에서 프로젝트 폴더를 먼저 선택하세요"
                  }
                >
                  📁
                </button>
                {filePickerOpen && project.root && (
                  <ProjectFilePopover
                    onClose={() => setFilePickerOpen(false)}
                    onPick={attachProjectFile}
                  />
                )}
              </div>
              <div className="composer-popover-wrap">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setModelMenuOpen((v) => !v)}
                  disabled={streaming || models.length === 0}
                  title={
                    models.length
                      ? `현재: ${model || "(기본)"}`
                      : "Ollama 서버에 연결되지 않음"
                  }
                >
                  🤖 {model ? truncMid(model, 16) : "모델"} ▾
                </button>
                {modelMenuOpen && (
                  <ModelMenu
                    models={models}
                    current={model}
                    onPick={(m) => {
                      setModel(m);
                      setModelMenuOpen(false);
                    }}
                    onClose={() => setModelMenuOpen(false)}
                  />
                )}
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={clearConversation}
                disabled={streaming || !session?.messages.length}
                title="현재 세션의 메시지 모두 삭제"
              >
                🧹
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={saveConversation}
                disabled={!session?.messages.length}
                title="대화 전체를 .md 파일로 다운로드"
              >
                💾
              </button>
            </div>
            <div className="composer-right">
              {streaming ? (
                <button
                  className="stop-btn"
                  onClick={() => abortRef.current?.abort()}
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

function truncMid(s: string, n: number): string {
  if (s.length <= n) return s;
  const half = Math.floor((n - 1) / 2);
  return s.slice(0, half) + "…" + s.slice(s.length - half);
}

function ModelMenu({
  models,
  current,
  onPick,
  onClose,
}: {
  models: OllamaModel[];
  current: string;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="popover" role="menu">
      <div className="popover-header">Ollama 모델</div>
      <ul className="popover-list">
        {models.map((m) => (
          <li
            key={m.name}
            className={m.name === current ? "active" : ""}
            onClick={() => onPick(m.name)}
          >
            <span className="popover-name">{m.name}</span>
            <span className="popover-meta">
              {m.parameter_size ?? formatBytes(m.size)}
            </span>
          </li>
        ))}
      </ul>
      <button className="popover-close" onClick={onClose}>
        닫기
      </button>
    </div>
  );
}

function ProjectFilePopover({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (file: ProjectFile) => void;
}) {
  const { tree } = useProject();
  return (
    <div className="popover popover-tree" role="menu">
      <div className="popover-header">프로젝트 파일 선택</div>
      <div className="popover-tree-body">
        <PopoverTree nodes={tree} onPick={onPick} />
      </div>
      <button className="popover-close" onClick={onClose}>
        닫기
      </button>
    </div>
  );
}

function PopoverTree({
  nodes,
  onPick,
  depth = 0,
}: {
  nodes: ProjectTreeNode[];
  onPick: (file: ProjectFile) => void;
  depth?: number;
}) {
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());
  return (
    <ul className="popover-tree-list">
      {nodes.map((n) => {
        if (n.kind === "dir") {
          const open = openDirs.has(n.path);
          return (
            <li key={n.path}>
              <div
                className="tree-row"
                style={{ paddingLeft: depth * 12 + 6 }}
                onClick={() => {
                  setOpenDirs((prev) => {
                    const next = new Set(prev);
                    if (next.has(n.path)) next.delete(n.path);
                    else next.add(n.path);
                    return next;
                  });
                }}
              >
                <span className="tree-caret">{open ? "▾" : "▸"}</span>
                <span className="tree-name">{n.name}</span>
              </div>
              {open && n.children && (
                <PopoverTree nodes={n.children} onPick={onPick} depth={depth + 1} />
              )}
            </li>
          );
        }
        return (
          <li key={n.path}>
            <div
              className="tree-row"
              style={{ paddingLeft: depth * 12 + 6 }}
              onClick={() => n.file && onPick(n.file)}
              title={n.path}
            >
              <span className="tree-caret" />
              <span className="tree-name">{n.name}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
