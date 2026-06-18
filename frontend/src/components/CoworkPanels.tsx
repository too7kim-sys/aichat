import { useEffect, useState } from "react";
import { api } from "../api/client";
import { errorToast } from "../lib/toast";

/** cowork 89~94 2차 UI — 팀 관리 / 워크플로 실행 이력 / 액션아이템
 *  칸반 / 메시지 코멘트 스레드.  컴포넌트 한 파일에 모아 import 줄 단축. */


// ── #89 팀 관리 패널 ────────────────────────────────────────
export function TeamsPanel({ onClose }: { onClose: () => void }) {
  type Team = Awaited<ReturnType<typeof api.listTeams>>[number];
  const [teams, setTeams] = useState<Team[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setTeams(await api.listTeams());
    } catch (e) {
      errorToast("팀 목록 실패", e);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createTeam(name.trim(), desc.trim());
      setName("");
      setDesc("");
      await refresh();
    } catch (e) {
      errorToast("팀 생성 실패", e);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    if (!window.confirm("이 팀을 삭제할까요?  팀과 함께 공유 관계가 풀립니다.")) return;
    try {
      await api.deleteTeam(id);
      await refresh();
    } catch (e) {
      errorToast("삭제 실패", e);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>👥 팀 관리</h3>
          <button type="button" className="modal-close" onClick={onClose}>×</button>
        </header>
        <div className="patch-preview-body">
          <div className="ws-crud-row">
            <input placeholder="새 팀 이름" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            <input placeholder="설명 (선택)" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} />
            <button type="button" className="primary" onClick={create} disabled={busy || !name.trim()}>
              + 생성
            </button>
          </div>
          {teams.length === 0 ? (
            <div className="patch-preview-empty">아직 팀이 없어요</div>
          ) : (
            <ul className="ws-branch-list">
              {teams.map((t) => (
                <li key={t.id}>
                  <span>
                    <b>{t.name}</b>
                    <em style={{ marginLeft: 8, color: "var(--text-muted)" }}>
                      {t.member_count}명{t.description ? ` · ${t.description}` : ""}
                    </em>
                  </span>
                  <span style={{ display: "inline-flex", gap: 4 }}>
                    <button type="button" onClick={() => setOpen(t.id === open ? null : t.id)}>
                      멤버
                    </button>
                    {t.is_owner && (
                      <button type="button" onClick={() => remove(t.id)}>×</button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {open && <TeamMembersPanel teamId={open} />}
        </div>
      </div>
    </div>
  );
}

function TeamMembersPanel({ teamId }: { teamId: string }) {
  type M = { user_id: string; email: string; name: string; role: string };
  const [members, setMembers] = useState<M[]>([]);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"owner" | "member">("member");

  async function refresh() {
    try {
      const r = await api.listTeamMembers(teamId);
      setMembers(r.members);
    } catch {
      setMembers([]);
    }
  }
  useEffect(() => {
    void refresh();
  }, [teamId]);

  async function add() {
    if (!userId.trim()) return;
    try {
      await api.addTeamMember(teamId, userId.trim(), role);
      setUserId("");
      await refresh();
    } catch (e) {
      errorToast("추가 실패", e);
    }
  }
  async function remove(uid: string) {
    try {
      await api.removeTeamMember(teamId, uid);
      await refresh();
    } catch (e) {
      errorToast("삭제 실패", e);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="ws-stats-sec">멤버 {members.length}명</div>
      <div className="ws-crud-row">
        <input placeholder="사용자 ID (uuid)" value={userId} onChange={(e) => setUserId(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value as "owner" | "member")}>
          <option value="member">멤버</option>
          <option value="owner">owner</option>
        </select>
        <button type="button" onClick={add}>+</button>
      </div>
      <ul className="ws-branch-list">
        {members.map((m) => (
          <li key={m.user_id}>
            <span>
              <b>{m.name}</b>
              <em style={{ marginLeft: 8, color: "var(--text-muted)" }}>{m.email} · {m.role}</em>
            </span>
            <button type="button" onClick={() => remove(m.user_id)}>×</button>
          </li>
        ))}
      </ul>
    </div>
  );
}


// ── #90 + #91 워크플로 실행 이력 + 승인 ──────────────────────
export function WorkflowRunsPanel({
  workflowId,
  onClose,
}: {
  workflowId: string;
  onClose: () => void;
}) {
  type Run = Awaited<ReturnType<typeof api.listWorkflowRuns>>["items"][number];
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const r = await api.listWorkflowRuns(workflowId, 80);
      setRuns(r.items);
    } catch {
      setRuns([]);
    }
  }
  useEffect(() => {
    void refresh();
    const t = window.setInterval(refresh, 5000);
    return () => window.clearInterval(t);
  }, [workflowId]);

  async function approve(id: string) {
    setBusy(true);
    try {
      await api.approveWorkflowRun(id);
      await refresh();
    } catch (e) {
      errorToast("승인 실패", e);
    } finally {
      setBusy(false);
    }
  }
  async function reject(id: string) {
    const reason = window.prompt("거부 사유 (선택):") || "";
    setBusy(true);
    try {
      await api.rejectWorkflowRun(id, reason);
      await refresh();
    } catch (e) {
      errorToast("거부 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>📜 워크플로 실행 이력</h3>
          <button type="button" className="modal-close" onClick={onClose}>×</button>
        </header>
        <div className="patch-preview-body">
          {runs.length === 0 ? (
            <div className="patch-preview-empty">실행 기록이 없어요</div>
          ) : (
            <table className="ws-stats-table">
              <thead>
                <tr><th>시작</th><th>상태</th><th>소요</th><th></th></tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const dur =
                    r.started_at && r.finished_at
                      ? `${Math.round(
                          (new Date(r.finished_at).getTime() -
                            new Date(r.started_at).getTime()) /
                            1000,
                        )}s`
                      : "—";
                  return (
                    <tr key={r.id}>
                      <td>
                        {r.started_at
                          ? new Date(r.started_at).toLocaleString()
                          : "—"}
                      </td>
                      <td>
                        <span className={`run-status status-${r.status}`}>
                          {r.status}
                        </span>
                        {r.error && (
                          <div style={{ fontSize: 11, color: "#b91c1c" }}>
                            {r.error.slice(0, 100)}
                          </div>
                        )}
                      </td>
                      <td>{dur}</td>
                      <td>
                        {r.status === "pending_approval" && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => approve(r.id)}
                            >
                              ✓ 승인
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => reject(r.id)}
                              style={{ marginLeft: 4 }}
                            >
                              ✕ 거부
                            </button>
                          </>
                        )}
                        {r.session_id && r.status === "ok" && (
                          <button
                            type="button"
                            onClick={() => {
                              window.dispatchEvent(
                                new CustomEvent("chat:switch-session", {
                                  detail: { sessionId: r.session_id },
                                }),
                              );
                              onClose();
                            }}
                          >
                            세션 열기
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}


// ── #99 승인 대기 큐 ─────────────────────────────────────────
export function ApprovalsPanel({ onClose }: { onClose: () => void }) {
  type Pending = Awaited<
    ReturnType<typeof api.listPendingApprovals>
  >["items"][number];
  const [items, setItems] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const r = await api.listPendingApprovals();
      setItems(r.items);
    } catch {
      setItems([]);
    }
  }
  useEffect(() => {
    void refresh();
    const t = window.setInterval(refresh, 8000);
    return () => window.clearInterval(t);
  }, []);

  async function approve(id: string) {
    setBusy(true);
    try {
      await api.approveWorkflowRun(id);
      await refresh();
    } catch (e) {
      errorToast("승인 실패", e);
    } finally {
      setBusy(false);
    }
  }
  async function reject(id: string) {
    const reason = window.prompt("거부 사유 (선택):") || "";
    setBusy(true);
    try {
      await api.rejectWorkflowRun(id, reason);
      await refresh();
    } catch (e) {
      errorToast("거부 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal patch-preview-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3>🛂 승인 대기 큐</h3>
          <button type="button" className="modal-close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="patch-preview-body">
          {items.length === 0 ? (
            <div className="patch-preview-empty">
              승인 대기 중인 워크플로 실행이 없어요
            </div>
          ) : (
            <table className="ws-stats-table">
              <thead>
                <tr>
                  <th>워크플로</th>
                  <th>요청 시각</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <b>{r.workflow_name}</b>
                      {r.team_id && (
                        <div style={{ fontSize: 11, opacity: 0.7 }}>
                          team: {r.team_id.slice(0, 8)}…
                        </div>
                      )}
                    </td>
                    <td>
                      {r.started_at
                        ? new Date(r.started_at).toLocaleString()
                        : "—"}
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => approve(r.id)}
                      >
                        ✓ 승인
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => reject(r.id)}
                        style={{ marginLeft: 4 }}
                      >
                        ✕ 거부
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}


// ── #92 액션아이템 칸반 ─────────────────────────────────────
export function ActionKanbanPanel({
  transcriptId,
  onClose,
}: {
  transcriptId: string | null;
  onClose: () => void;
}) {
  type Item = Awaited<ReturnType<typeof api.listActionItems>>[number];
  const [items, setItems] = useState<Item[]>([]);
  const [title, setTitle] = useState("");

  async function refresh() {
    try {
      setItems(await api.listActionItems(transcriptId ?? undefined));
    } catch {
      setItems([]);
    }
  }
  useEffect(() => {
    void refresh();
  }, [transcriptId]);

  async function add() {
    if (!title.trim()) return;
    try {
      await api.createActionItem({
        title: title.trim(),
        transcript_id: transcriptId,
      });
      setTitle("");
      await refresh();
    } catch (e) {
      errorToast("추가 실패", e);
    }
  }
  async function move(id: string, status: "todo" | "doing" | "done") {
    try {
      await api.updateActionItem(id, { status });
      await refresh();
    } catch (e) {
      errorToast("상태 변경 실패", e);
    }
  }
  async function remove(id: string) {
    try {
      await api.deleteActionItem(id);
      await refresh();
    } catch (e) {
      errorToast("삭제 실패", e);
    }
  }

  const cols = ["todo", "doing", "done"] as const;
  const labels: Record<(typeof cols)[number], string> = {
    todo: "📋 할 일",
    doing: "⚙ 진행 중",
    done: "✅ 완료",
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal patch-preview-modal ws-log-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3>✅ 액션아이템</h3>
          <button type="button" className="modal-close" onClick={onClose}>×</button>
        </header>
        <div className="patch-preview-body">
          <div className="ws-crud-row">
            <input
              placeholder="할 일 추가"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button type="button" className="primary" onClick={add}>+ 추가</button>
          </div>
          <div className="kanban">
            {cols.map((c) => (
              <div key={c} className="kanban-col">
                <div className="kanban-head">
                  {labels[c]} <span>({items.filter((i) => i.status === c).length})</span>
                </div>
                <ul>
                  {items.filter((i) => i.status === c).map((it) => (
                    <li key={it.id}>
                      <div className="kanban-title">{it.title}</div>
                      {it.assignee_text && (
                        <div className="kanban-meta">👤 {it.assignee_text}</div>
                      )}
                      {it.due_at && (
                        <div className="kanban-meta">
                          📅 {new Date(it.due_at).toLocaleDateString()}
                        </div>
                      )}
                      <div className="kanban-actions">
                        {c !== "todo" && (
                          <button type="button" onClick={() => move(it.id, "todo")}>←</button>
                        )}
                        {c !== "doing" && (
                          <button
                            type="button"
                            onClick={() =>
                              move(it.id, c === "todo" ? "doing" : "doing")
                            }
                          >
                            진행
                          </button>
                        )}
                        {c !== "done" && (
                          <button type="button" onClick={() => move(it.id, "done")}>→</button>
                        )}
                        <button type="button" onClick={() => remove(it.id)}>×</button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}


// ── #93 메시지 코멘트 스레드 ────────────────────────────────
export function CommentThread({
  targetType,
  targetId,
  onClose,
}: {
  targetType:
    | "message"
    | "chunk"
    | "workflow"
    | "transcript"
    | "action"
    | "session";
  targetId: string;
  onClose: () => void;
}) {
  type Comment = Awaited<ReturnType<typeof api.listComments>>["items"][number];
  const [items, setItems] = useState<Comment[]>([]);
  const [draft, setDraft] = useState("");

  async function refresh() {
    try {
      const r = await api.listComments(targetType, targetId);
      setItems(r.items);
    } catch {
      setItems([]);
    }
  }
  useEffect(() => {
    void refresh();
  }, [targetType, targetId]);

  async function add() {
    if (!draft.trim()) return;
    try {
      // @mention 추출 — 단순히 @<id> 패턴.  실 user picker 는 follow-up.
      const mentions = Array.from(
        draft.matchAll(/@([\w-]{8,})/g),
        (m) => m[1],
      );
      await api.createComment({
        target_type: targetType,
        target_id: targetId,
        body: draft.trim(),
        mentions: mentions.length ? mentions : undefined,
      });
      setDraft("");
      await refresh();
    } catch (e) {
      errorToast("등록 실패", e);
    }
  }
  async function resolve(id: string, cur: boolean) {
    try {
      await api.resolveComment(id, !cur);
      await refresh();
    } catch (e) {
      errorToast("해결 토글 실패", e);
    }
  }
  async function remove(id: string) {
    try {
      await api.deleteComment(id);
      await refresh();
    } catch (e) {
      errorToast("삭제 실패", e);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal patch-preview-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>💬 코멘트</h3>
          <code className="patch-preview-path">{targetType}:{targetId.slice(0, 12)}…</code>
          <button type="button" className="modal-close" onClick={onClose}>×</button>
        </header>
        <div className="patch-preview-body">
          {items.length === 0 ? (
            <div className="patch-preview-empty">아직 코멘트가 없어요</div>
          ) : (
            <ul className="comment-thread">
              {items.map((c) => (
                <li key={c.id} className={c.resolved ? "resolved" : ""}>
                  <div className="comment-head">
                    <strong>{c.user_name}</strong>
                    <span className="comment-time">
                      {new Date(c.created_at).toLocaleString()}
                    </span>
                    <span className="comment-actions">
                      <button type="button" onClick={() => resolve(c.id, c.resolved)}>
                        {c.resolved ? "↩ 미해결" : "✓ 해결"}
                      </button>
                      <button type="button" onClick={() => remove(c.id)}>×</button>
                    </span>
                  </div>
                  <div className="comment-body">{c.body}</div>
                </li>
              ))}
            </ul>
          )}
          <div className="ws-crud-row" style={{ marginTop: 8 }}>
            <textarea
              placeholder="코멘트 추가 (Enter=등록, Shift+Enter=줄바꿈, @<id> 로 멘션)"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void add();
                }
              }}
              rows={2}
            />
            <button type="button" className="primary" onClick={add} disabled={!draft.trim()}>
              등록
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
