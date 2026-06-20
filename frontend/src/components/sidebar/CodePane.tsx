/** Code 워크스페이스 사이드바 패널 — 워크스페이스 카드 그리드 +
 *  CodeWorkspaceModal 열기. Sidebar.tsx 다이어트의 일부. */
import { useState } from "react";
import { errorToast } from "../../lib/toast";
import { queueAttachment } from "../../state/attachQueue";
import { useWorkspaces } from "../../state/WorkspacesContext";
import { CodeWorkspaceModal } from "../CodeWorkspaceModal";
import {
  IconFileText,
  IconFolder,
  IconGitBranch,
  IconPlus,
  IconRefresh,
} from "../Icon";

export function CodePane({
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
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="primary"
                onClick={() => setModalOpen(true)}
              >
                <IconPlus size={14} /> 첫 워크스페이스 추가
              </button>
            </div>
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
