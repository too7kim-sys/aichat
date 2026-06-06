import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  type Prompt,
  type Transcript,
  type Workflow,
} from "../api/client";
import { queueAttachment } from "../state/attachQueue";
import { useWorkspaces } from "../state/WorkspacesContext";
import type { Session } from "../types";
import { CodeWorkspaceModal } from "./CodeWorkspaceModal";
import {
  IconChat,
  IconCheckCircle,
  IconClock,
  IconCode,
  IconFileText,
  IconFolder,
  IconGitBranch,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconUsers,
  IconX,
} from "./Icon";

export type Workspace = "chat" | "cowork" | "code";

interface Props {
  /** Extra className applied to the root <aside> — used by the parent
   *  to toggle "open" state for the mobile drawer overlay. */
  className?: string;
  workspace: Workspace;
  onWorkspaceChange: (w: Workspace) => void;
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  /** Click on a Code workspace card → create a chat named after the
   *  workspace and pre-attach a representative slice of its files. */
  onStartChatFromWorkspace: (workspaceId: string) => Promise<void> | void;
  /** Refresh the chat-session list — the Cowork pane calls this after
   *  a workflow run completes so the freshly-created session appears
   *  in the sidebar without a page reload. */
  onSessionRefresh?: () => Promise<void> | void;
}

function groupByDate(sessions: Session[]) {
  const now = Date.now();
  const today: Session[] = [];
  const yesterday: Session[] = [];
  const lastWeek: Session[] = [];
  const earlier: Session[] = [];

  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;

  for (const s of sessions) {
    const t = new Date(s.updated_at).getTime();
    if (t >= todayStart) today.push(s);
    else if (t >= yesterdayStart) yesterday.push(s);
    else if (t >= weekStart) lastWeek.push(s);
    else earlier.push(s);
  }
  return { today, yesterday, lastWeek, earlier };
}

// Cowork hosts the shared prompt library + workflow automation. RAG
// project management moved to the admin "지식베이스" panel; Cowork
// is now where users browse prompts and schedule workflow runs.
const TABS: { id: Workspace; label: string; icon: ReactNode }[] = [
  { id: "chat", label: "Chat", icon: <IconChat size={18} /> },
  { id: "cowork", label: "Cowork", icon: <IconUsers size={18} /> },
  { id: "code", label: "Code", icon: <IconCode size={18} /> },
];

export function Sidebar({
  className = "",
  workspace,
  onWorkspaceChange,
  sessions,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  onStartChatFromWorkspace,
  onSessionRefresh,
}: Props) {
  return (
    <aside className={`sidebar${className ? " " + className : ""}`}>
      <nav className="workspace-tabs" role="tablist" aria-label="Workspace">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={workspace === t.id}
            className={`workspace-tab${workspace === t.id ? " active" : ""}`}
            onClick={() => onWorkspaceChange(t.id)}
          >
            <span className="workspace-tab-icon" aria-hidden>
              {t.icon}
            </span>
            <span className="workspace-tab-label">{t.label}</span>
          </button>
        ))}
      </nav>

      {workspace === "chat" && (
        <ChatPane
          sessions={sessions}
          activeId={activeId}
          onSelect={onSelect}
          onCreate={onCreate}
          onDelete={onDelete}
        />
      )}
      {workspace === "cowork" && (
        <CoworkPane
          onSessionRefresh={onSessionRefresh}
          onOpenSession={onSelect}
        />
      )}
      {workspace === "code" && (
        <CodePane
          activeSessionId={activeId}
          onCreateSession={onCreate}
          onStartChatFromWorkspace={onStartChatFromWorkspace}
        />
      )}
    </aside>
  );
}

function ChatPane({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  const groups = groupByDate(sessions);
  return (
    <>
      <div className="sidebar-actions">
        <button className="primary" onClick={onCreate}>
          + 새 대화
        </button>
      </div>
      <div className="sidebar-sessions">
        <SessionGroup
          label="오늘"
          sessions={groups.today}
          {...{ activeId, onSelect, onDelete }}
        />
        <SessionGroup
          label="어제"
          sessions={groups.yesterday}
          {...{ activeId, onSelect, onDelete }}
        />
        <SessionGroup
          label="지난 7일"
          sessions={groups.lastWeek}
          {...{ activeId, onSelect, onDelete }}
        />
        <SessionGroup
          label="이전"
          sessions={groups.earlier}
          {...{ activeId, onSelect, onDelete }}
        />
      </div>
    </>
  );
}


function CodePane({
  activeSessionId,
  onCreateSession,
  onStartChatFromWorkspace,
}: {
  activeSessionId: string | null;
  onCreateSession: () => void;
  onStartChatFromWorkspace: (workspaceId: string) => Promise<void> | void;
}) {
  const { workspaces, refresh, sync } = useWorkspaces();
  const [modalOpen, setModalOpen] = useState(false);
  // Track which card is currently spinning up its chat, so the row
  // can disable itself + show the right status.
  const [startingId, setStartingId] = useState<string | null>(null);

  async function startChat(workspaceId: string) {
    if (startingId) return;
    setStartingId(workspaceId);
    try {
      await onStartChatFromWorkspace(workspaceId);
    } finally {
      setStartingId(null);
    }
  }

  return (
    <>
      <div className="sidebar-actions">
        <button className="primary" onClick={() => setModalOpen(true)}>
          <IconPlus size={14} />
          <span>워크스페이스</span>
        </button>
      </div>
      <div className="sidebar-sessions">
        <div className="session-section">Code workspaces</div>
        {workspaces.length === 0 ? (
          <div className="sidebar-empty">
            사내 Git 레포를 clone해 코드 분석·수정 흐름을 시작하세요. 카드를
            클릭하면 프로젝트 전체가 새 채팅에 자동 첨부됩니다.
          </div>
        ) : (
          <ul className="proj-sidebar-list">
            {workspaces.map((w) => {
              const ready = w.status === "ready";
              const starting = startingId === w.id;
              return (
                <li
                  key={w.id}
                  className={`proj-sidebar-item status-${w.status}${
                    starting ? " busy" : ""
                  }${ready ? " clickable" : ""}`}
                  onClick={() => ready && startChat(w.id)}
                  title={
                    ready
                      ? "클릭: 이 프로젝트로 새 채팅 시작 (전체 파일 자동 첨부)"
                      : undefined
                  }
                >
                  <div className="proj-sidebar-row">
                    <div className="proj-sidebar-name">
                      <span className="proj-sidebar-name-icon" aria-hidden>
                        {w.source_type === "local" ? (
                          <IconFolder size={14} />
                        ) : (
                          <IconGitBranch size={14} />
                        )}
                      </span>
                      {w.name}
                    </div>
                    <div className="proj-sidebar-row-actions">
                      <button
                        type="button"
                        className="proj-sidebar-del"
                        aria-label="파일 보기"
                        title="파일 트리 열기"
                        onClick={(e) => {
                          e.stopPropagation();
                          setModalOpen(true);
                        }}
                      >
                        <IconFileText size={12} />
                      </button>
                      <button
                        type="button"
                        className="proj-sidebar-del"
                        aria-label={
                          w.source_type === "local"
                            ? "트리 새로고침"
                            : "동기화"
                        }
                        title={
                          w.source_type === "local"
                            ? "트리 새로고침"
                            : "동기화 (git pull)"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          sync(w.id);
                        }}
                      >
                        <IconRefresh size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="proj-sidebar-meta">
                    <span className={`proj-sidebar-status ${w.status}`}>
                      {starting
                        ? "채팅 준비 중…"
                        : w.status === "ready"
                        ? "준비됨"
                        : w.status === "cloning"
                        ? "클론 중…"
                        : "실패"}
                    </span>
                    {w.status === "ready" && (
                      <span className="proj-sidebar-counts">
                        {w.file_count}f
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <CodeWorkspaceModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          refresh();
        }}
        onAttachFile={(filename, text) => {
          queueAttachment({ filename, text });
          if (!activeSessionId) {
            onCreateSession();
          }
        }}
      />
    </>
  );
}

/** Monochrome SVG glyph per session row. Code-focused sessions get
 *  the code icon; everything else gets a generic chat-bubble icon
 *  that picks up the surrounding text color via currentColor stroke.
 *  We used to render colored emojis here for topic-based variety but
 *  the saturation distracted from the title text. */
function SessionIcon({ session }: { session: Session }) {
  if (session.code_focused) return <IconCode size={14} />;
  return <IconChat size={14} />;
}

function SessionGroup({
  label,
  sessions,
  activeId,
  onSelect,
  onDelete,
}: {
  label: string;
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <>
      <div className="session-section">{label}</div>
      <ul className="session-list">
        {sessions.map((s) => (
          <li
            key={s.id}
            className={s.id === activeId ? "active" : ""}
            onClick={() => onSelect(s.id)}
          >
            <span className="session-emoji" aria-hidden="true">
              <SessionIcon session={s} />
            </span>
            <span className="session-title">{s.title}</span>
            <button
              className="delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
              aria-label="삭제"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}


function CoworkPane({
  onSessionRefresh,
  onOpenSession,
}: {
  onSessionRefresh?: () => Promise<void> | void;
  onOpenSession: (id: string) => void;
}) {
  const [tab, setTab] = useState<"meetings" | "workflows" | "prompts">("meetings");
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // MediaRecorder state for the live record button.
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const [recordStartedAt, setRecordStartedAt] = useState<number | null>(null);
  const [recordElapsedSec, setRecordElapsedSec] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function refreshAll() {
    try {
      const [p, w, t] = await Promise.all([
        api.listPrompts(),
        api.listWorkflows(),
        api.listTranscripts().catch(() => [] as Transcript[]),
      ]);
      setPrompts(p);
      setWorkflows(w);
      setTranscripts(t);
    } catch {
      /* unauthorized — empty */
    }
  }

  // Record-time tick.
  useEffect(() => {
    if (!recording || recordStartedAt === null) return;
    const id = window.setInterval(() => {
      setRecordElapsedSec(
        Math.floor((Date.now() - recordStartedAt) / 1000),
      );
    }, 500);
    return () => window.clearInterval(id);
  }, [recording, recordStartedAt]);

  // Poll while any transcript is mid-pipeline so progress / status
  // bubble up to the UI in near-real-time. Stops as soon as nothing
  // is in flight.
  useEffect(() => {
    const inFlight = transcripts.some(
      (t) => !["ok", "failed"].includes(t.status),
    );
    if (!inFlight) return;
    const id = window.setInterval(async () => {
      const next = await api.listTranscripts().catch(() => null);
      if (next) {
        setTranscripts(next);
        const stillInFlight = next.some(
          (t) => !["ok", "failed"].includes(t.status),
        );
        if (!stillInFlight) {
          await onSessionRefresh?.();
        }
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [transcripts, onSessionRefresh]);

  async function startRecording() {
    if (recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      recordChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordChunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordChunksRef.current, {
          type: recordChunksRef.current[0]?.type || "audio/webm",
        });
        recordChunksRef.current = [];
        await uploadBlob(blob, `녹음-${new Date().toISOString().slice(0, 16)}.webm`);
      };
      rec.start(1000);
      recorderRef.current = rec;
      setRecording(true);
      setRecordStartedAt(Date.now());
      setRecordElapsedSec(0);
    } catch (e) {
      window.alert(
        `마이크 접근 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  function stopRecording() {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recorderRef.current = null;
    setRecording(false);
    setRecordStartedAt(null);
  }

  async function uploadBlob(blob: Blob, filename: string) {
    if (uploading) return;
    setUploading(true);
    try {
      await api.uploadTranscript(blob, filename);
      await refreshAll();
    } catch (e) {
      window.alert(
        `업로드 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setUploading(false);
    }
  }

  async function onFilePick(files: FileList | null) {
    if (!files || files.length === 0) return;
    await uploadBlob(files[0], files[0].name);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function deleteTranscript(t: Transcript) {
    if (!window.confirm("이 전사 기록을 삭제할까요?")) return;
    setBusyId(t.id);
    try {
      await api.deleteTranscript(t.id);
      await refreshAll();
    } catch (e) {
      window.alert(`삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  function formatDuration(s: number): string {
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, "0");
    return `${m}:${ss}`;
  }

  const STATUS_LABEL: Record<Transcript["status"], string> = {
    pending: "대기",
    transcribing: "전사 중",
    diarizing: "화자 분리 중",
    summarizing: "요약 중",
    ok: "완료",
    failed: "실패",
  };

  useEffect(() => {
    refreshAll();
  }, []);

  // While any workflow is running, poll every 2s. The runner stamps
  // last_run_status="running" → "ok"/"failed"; we keep polling until
  // nothing's running and the new session is in the sidebar list.
  useEffect(() => {
    const anyRunning = workflows.some((w) => w.last_run_status === "running");
    if (!anyRunning) return;
    const id = window.setInterval(async () => {
      const w = await api.listWorkflows();
      setWorkflows(w);
      if (!w.some((x) => x.last_run_status === "running")) {
        await onSessionRefresh?.();
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [workflows, onSessionRefresh]);

  async function runWorkflow(w: Workflow) {
    setBusyId(w.id);
    try {
      const updated = await api.runWorkflow(w.id);
      setWorkflows((prev) =>
        prev.map((x) => (x.id === updated.id ? updated : x)),
      );
    } catch (e) {
      window.alert(
        `실행 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="cowork-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "meetings"}
          className={`cowork-tab${tab === "meetings" ? " active" : ""}`}
          onClick={() => setTab("meetings")}
        >
          <IconFileText size={13} /> 회의록
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "workflows"}
          className={`cowork-tab${tab === "workflows" ? " active" : ""}`}
          onClick={() => setTab("workflows")}
        >
          <IconClock size={13} /> 워크플로
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "prompts"}
          className={`cowork-tab${tab === "prompts" ? " active" : ""}`}
          onClick={() => setTab("prompts")}
        >
          <IconSparkles size={13} /> 프롬프트
        </button>
      </div>

      {tab === "meetings" && (
        <div className="sidebar-sessions">
          <div className="sidebar-actions">
            {recording ? (
              <button className="primary recording" onClick={stopRecording}>
                ● {formatDuration(recordElapsedSec)} · 중지
              </button>
            ) : (
              <button
                className="primary"
                onClick={startRecording}
                disabled={uploading}
              >
                ● 녹음 시작
              </button>
            )}
            <button
              type="button"
              className="cowork-upload-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || recording}
              title="오디오 파일 업로드 (mp3, wav, m4a, webm 등)"
            >
              파일 업로드
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,video/mp4,.webm,.ogg,.opus,.m4a,.mp3,.wav,.flac"
              style={{ display: "none" }}
              onChange={(e) => onFilePick(e.target.files)}
            />
          </div>
          <div className="session-section">최근 전사</div>
          {uploading && (
            <div className="sidebar-empty">업로드 중…</div>
          )}
          {transcripts.length === 0 && !uploading ? (
            <div className="sidebar-empty">
              회의나 강의를 녹음하거나 오디오 파일을 업로드하면 자동으로
              전사·요약해서 새 채팅 세션으로 저장합니다.
              {(!recording && transcripts.length === 0) && (
                <>
                  <br />
                  <small style={{ display: "block", marginTop: 6 }}>
                    백엔드에 <code>faster-whisper</code> 와 <code>ENABLE_TRANSCRIPTION=true</code> 설정 필요.
                  </small>
                </>
              )}
            </div>
          ) : (
            <ul className="cowork-list">
              {transcripts.map((t) => (
                <li
                  key={t.id}
                  className={`cowork-item status-${t.status}`}
                >
                  <div className="cowork-item-head">
                    <span
                      className="cowork-item-name"
                      title={t.source_filename}
                    >
                      {t.source_filename}
                    </span>
                    <button
                      type="button"
                      className="cowork-item-run"
                      onClick={() => deleteTranscript(t)}
                      disabled={busyId === t.id}
                      title="삭제"
                    >
                      <IconX size={13} />
                    </button>
                  </div>
                  <div className="cowork-item-meta">
                    <span>
                      {STATUS_LABEL[t.status]}
                      {typeof t.progress === "number" && t.status === "transcribing"
                        ? ` ${Math.round(t.progress * 100)}%`
                        : ""}
                      {t.duration_sec
                        ? ` · ${formatDuration(Math.round(t.duration_sec))}`
                        : ""}
                    </span>
                    {t.status === "ok" && t.session_id ? (
                      <button
                        type="button"
                        className="cowork-run-badge ok"
                        onClick={() =>
                          t.session_id && onOpenSession(t.session_id)
                        }
                        title="결과 세션 열기"
                      >
                        <IconCheckCircle size={11} /> 보기
                      </button>
                    ) : t.status === "failed" ? (
                      <span
                        className="cowork-run-badge failed"
                        title={t.error ?? "실패"}
                      >
                        실패
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "workflows" && (
        <div className="sidebar-sessions">
          <div className="session-section">자동화 워크플로</div>
          {workflows.length === 0 ? (
            <div className="sidebar-empty">
              프롬프트와 (선택) 지식베이스를 묶어 정해진 시각에 자동
              실행할 수 있어요. 결과는 새 채팅 세션으로 남습니다.
            </div>
          ) : (
            <ul className="cowork-list">
              {workflows.map((w) => (
                <li key={w.id} className={`cowork-item status-${w.last_run_status ?? "idle"}`}>
                  <div className="cowork-item-head">
                    <span className="cowork-item-name" title={w.description ?? undefined}>
                      {w.name}
                    </span>
                    <button
                      type="button"
                      className="cowork-item-run"
                      onClick={() => runWorkflow(w)}
                      disabled={
                        busyId === w.id || w.last_run_status === "running"
                      }
                      title="지금 실행"
                    >
                      <IconRefresh size={13} />
                    </button>
                  </div>
                  <div className="cowork-item-meta">
                    <span>
                      {w.prompt_name ?? "?"}
                      {w.project_name ? ` · ${w.project_name}` : ""}
                    </span>
                    {w.last_run_status === "running" ? (
                      <span className="cowork-run-badge running">실행 중…</span>
                    ) : w.last_run_status === "ok" ? (
                      <button
                        type="button"
                        className="cowork-run-badge ok"
                        onClick={() =>
                          w.last_session_id &&
                          onOpenSession(w.last_session_id)
                        }
                        title="마지막 결과 열기"
                      >
                        <IconCheckCircle size={11} /> 보기
                      </button>
                    ) : w.last_run_status === "failed" ? (
                      <span
                        className="cowork-run-badge failed"
                        title={w.last_error ?? "실패"}
                      >
                        실패
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="cowork-foot">
            <a
              href="#admin-knowledge"
              className="cowork-foot-hint"
              onClick={(e) => {
                e.preventDefault();
                window.alert(
                  "워크플로 생성/편집은 권한 관리 → 워크플로 탭에서 합니다.",
                );
              }}
            >
              워크플로 추가는 권한 관리 메뉴에서
            </a>
          </div>
        </div>
      )}

      {tab === "prompts" && (
        <div className="sidebar-sessions">
          <div className="session-section">프롬프트 라이브러리</div>
          {prompts.length === 0 ? (
            <div className="sidebar-empty">
              자주 쓰는 질문을 템플릿으로 저장해두면 채팅 입력창에서
              한 번에 끼울 수 있어요.
            </div>
          ) : (
            <ul className="cowork-list">
              {prompts.map((p) => (
                <li key={p.id} className="cowork-item">
                  <div className="cowork-item-head">
                    <span className="cowork-item-name" title={p.description ?? undefined}>
                      {p.name}
                    </span>
                    {!p.owned && (
                      <span className="cowork-shared-badge">공유</span>
                    )}
                  </div>
                  <div className="cowork-item-meta">
                    {p.category && <span>{p.category}</span>}
                    {p.tags && <span>{p.tags}</span>}
                  </div>
                  <div className="cowork-item-body">
                    {p.body.slice(0, 140)}
                    {p.body.length > 140 ? "…" : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
