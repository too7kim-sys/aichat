import { useEffect, useRef, useState } from "react";
import { api, streamChat } from "../api/client";
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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getSession(sessionId).then(setSession);
    setLiveAssistant(null);
    setLivePrompt(null);
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

    try {
      await streamChat(sessionId, text, {
        compare: isCompare,
        provider: isCompare ? undefined : activeProvider,
        onToken: (provider, delta) => {
          buffers[provider] = (buffers[provider] ?? "") + delta;
          setLiveAssistant({ ...buffers });
        },
        onDone: () => {},
        onError: (provider, message) => {
          buffers[provider] = (buffers[provider] ?? "") + `\n[error: ${message}]`;
          setLiveAssistant({ ...buffers });
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const target = isCompare ? "__all__" : activeProvider;
      buffers[target] = (buffers[target] ?? "") + `\n[error: ${msg}]`;
      setLiveAssistant({ ...buffers });
      console.error(e);
    } finally {
      const refreshed = await api.getSession(sessionId);
      setSession(refreshed);
      setLiveAssistant(null);
      setLivePrompt(null);
      setStreaming(false);
      if (refreshed.title === "New chat" && text) {
        onTitleSync?.(text.slice(0, 30));
      }
    }
  }

  return (
    <div className="chat-panel">
      <header className="chat-header">
        <h2>{session.title}</h2>
        {!isCompare && (
          <select
            value={activeProvider}
            onChange={(e) => setActiveProvider(e.target.value)}
            disabled={streaming}
          >
            {enabledProviders.map((p) => (
              <option key={p.name} value={p.name}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        {isCompare && (
          <span className="badge">
            비교 모드 · {enabledProviders.map((p) => p.label).join(" / ")}
          </span>
        )}
      </header>

      <div className="messages" ref={scrollRef}>
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
      </div>

      <div className="composer">
        <textarea
          value={prompt}
          placeholder="메시지를 입력하세요... (Shift+Enter 줄바꿈)"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={streaming}
        />
        <button onClick={send} disabled={streaming || !prompt.trim()}>
          {streaming ? "전송 중..." : "전송"}
        </button>
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
