import { useEffect, useRef, useState } from "react";
import { api, streamChat, type ExtractedFile, type SearchSource } from "../api/client";
import type { ProviderInfo, SessionDetail } from "../types";
import { MessageBubble } from "./MessageBubble";

interface Props {
  sessionId: string;
  providers: ProviderInfo[];
  onTitleSync?: (title: string) => void;
}

export function ChatPanel({ sessionId, providers, onTitleSync }: Props) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [prompt, setPrompt] = useState("");
  const [activeProvider, setActiveProvider] = useState<string>("");
  const [streaming, setStreaming] = useState(false);
  const [liveAssistant, setLiveAssistant] = useState<{
    [provider: string]: string;
  } | null>(null);
  const [livePrompt, setLivePrompt] = useState<string | null>(null);
  const [webSearch, setWebSearch] = useState(false);
  const [liveSources, setLiveSources] = useState<SearchSource[] | null>(null);
  const [attachments, setAttachments] = useState<ExtractedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  if (!session) return <div className="chat-panel">불러오는 중...</div>;
  const isCompare = session.mode === "compare";
  const enabledProviders = providers.filter((p) => p.enabled);

  async function send() {
    if (!prompt.trim() || streaming) return;
    const text = prompt;
    setPrompt("");
    setLivePrompt(text);
    setStreaming(true);

    const buffers: { [k: string]: string } = {};
    if (isCompare) enabledProviders.forEach((p) => (buffers[p.name] = ""));
    else buffers[activeProvider] = "";
    setLiveAssistant({ ...buffers });
    setLiveSources(webSearch ? [] : null);

    const errors: string[] = [];

    const sentAttachments = attachments;

    try {
      await streamChat(sessionId, text, {
        compare: isCompare,
        provider: isCompare ? undefined : activeProvider,
        webSearch,
        attachments: sentAttachments.map((a) => ({
          filename: a.filename,
          text: a.text,
        })),
        onToken: (provider, delta) => {
          buffers[provider] = (buffers[provider] ?? "") + delta;
          setLiveAssistant({ ...buffers });
        },
        onDone: () => {},
        onError: (provider, message) => {
          errors.push(`${provider}: ${message}`);
          buffers[provider] = (buffers[provider] ?? "") + `\n[error: ${message}]`;
          setLiveAssistant({ ...buffers });
        },
        onSources: (sources, error) => {
          if (error) errors.push(`web search: ${error}`);
          setLiveSources(sources);
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      const target = isCompare ? "__all__" : activeProvider;
      buffers[target] = (buffers[target] ?? "") + `\n[error: ${msg}]`;
      setLiveAssistant({ ...buffers });
      console.error(e);
    } finally {
      const refreshed = await api.getSession(sessionId);
      setSession(refreshed);
      setLiveAssistant(null);
      setLivePrompt(null);
      setLiveSources(null);
      setAttachments([]);
      setStreaming(false);
      if (refreshed.title === "New chat" && text) {
        onTitleSync?.(text.slice(0, 30));
      }
      if (errors.length) {
        alert(`응답 실패:\n\n${errors.join("\n")}`);
      }
    }
  }

  const activeProviderLabel =
    enabledProviders.find((p) => p.name === activeProvider)?.label ?? "";

  return (
    <div className="chat-panel">
      <header className="chat-header">
        <h2>{session.title}</h2>
        <span className="model-info">
          {isCompare
            ? `비교 · ${enabledProviders.map((p) => p.label).join(" / ")}`
            : activeProviderLabel}
        </span>
      </header>

      <div className="messages" ref={scrollRef}>
        <div className="messages-inner">
          {isCompare ? (
            <CompareLayout
              messages={session.messages}
              providers={enabledProviders}
              live={liveAssistant}
              livePrompt={livePrompt}
            />
          ) : (
            <SingleLayout
              messages={session.messages}
              live={liveAssistant}
              livePrompt={livePrompt}
            />
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
                🌐 웹 검색 {webSearch ? "ON" : "OFF"}
              </button>
            </div>
            <div className="composer-right">
              <button
                className="send-btn"
                onClick={send}
                disabled={streaming || uploading || !prompt.trim()}
              >
                {streaming ? "전송 중" : "전송"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SingleLayout({
  messages,
  live,
  livePrompt,
}: {
  messages: SessionDetail["messages"];
  live: { [k: string]: string } | null;
  livePrompt: string | null;
}) {
  return (
    <>
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          role={m.role}
          provider={m.provider}
          content={m.content}
        />
      ))}
      {livePrompt && <MessageBubble role="user" content={livePrompt} />}
      {live &&
        Object.entries(live).map(([provider, content]) => (
          <MessageBubble
            key={`live-${provider}`}
            role="assistant"
            provider={provider}
            content={content}
            streaming
          />
        ))}
    </>
  );
}

function CompareLayout({
  messages,
  providers,
  live,
  livePrompt,
}: {
  messages: SessionDetail["messages"];
  providers: ProviderInfo[];
  live: { [k: string]: string } | null;
  livePrompt: string | null;
}) {
  // group: array of turns. Each turn: { user, replies: {provider: content} }
  type Turn = { user: string; replies: { [k: string]: string } };
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      current = { user: m.content, replies: {} };
      turns.push(current);
    } else if (current && m.provider) {
      current.replies[m.provider] = m.content;
    }
  }

  return (
    <>
      {turns.map((t, i) => (
        <div key={i} className="turn">
          <MessageBubble role="user" content={t.user} />
          <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${providers.length}, 1fr)` }}>
            {providers.map((p) => (
              <MessageBubble
                key={p.name}
                role="assistant"
                provider={p.label}
                content={t.replies[p.name] ?? ""}
              />
            ))}
          </div>
        </div>
      ))}
      {livePrompt && (
        <div className="turn">
          <MessageBubble role="user" content={livePrompt} />
          {live && (
            <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${providers.length}, 1fr)` }}>
              {providers.map((p) => (
                <MessageBubble
                  key={p.name}
                  role="assistant"
                  provider={p.label}
                  content={live[p.name] ?? ""}
                  streaming
                />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
