/** 지식베이스(RAG) 관리 — 공유 지식베이스 생성 + 역할 매핑 + 스냅샷
 *  관리. ProjectModal 을 admin 모드로 열어 등록 / 편집 / 삭제. */
import { useEffect, useState } from "react";
import { type Project } from "../../api/client";
import { ProjectModal } from "../../components/ProjectModal";
import { useProjects } from "../../state/ProjectsContext";
import { errorToast } from "../../lib/toast";

export function KnowledgePanel({ isAdmin }: { isAdmin: boolean }) {
  const { projects, refresh, remove } = useProjects();
  const [busyId, setBusyId] = useState<string | null>(null);
  // Modal popup state. `addOpen` = blank add form; `focusId` = open
  // the modal with that project pre-selected on the detail pane so
  // 편집 / 스냅샷 / 다시 인덱싱 are one click away.
  const [addOpen, setAddOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [snapshotFocusId, setSnapshotFocusId] = useState<string | null>(null);
  const modalOpen = addOpen || focusId !== null || snapshotFocusId !== null;

  useEffect(() => { refresh(); }, [refresh]);

  function corpusLabel(t: string): string {
    return (
      { code: "코드", document: "문서", api: "API", db: "DB" } as Record<string, string>
    )[t] || t;
  }

  function statusLabel(p: Project): string {
    switch (p.status) {
      case "ready": return "준비됨";
      case "indexing":
        return p.progress_total
          ? `인덱싱 ${Math.round((100 * p.progress_done) / p.progress_total)}%`
          : "인덱싱";
      case "pending": return "대기";
      case "failed": return "실패";
      default: return p.status;
    }
  }

  async function deleteProject(p: Project) {
    if (!window.confirm(`"${p.name}" 을(를) 삭제할까요?\n인덱스도 함께 사라집니다.`)) return;
    setBusyId(p.id);
    try {
      await remove(p.id);
    } catch (e) {
      errorToast("삭제 실패", e);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="admin-roles">
      <div className="admin-roles-head">
        <div>
          <h2>지식베이스 (RAG)</h2>
          <p>
            공유 지식베이스를 만들고 역할에 매핑하면, 권한이 있는 사용자는
            채팅에 연결하지 않아도 질문과 관련될 때 자동으로 검색해
            활용합니다.{isAdmin ? "" : " (생성·역할 매핑은 관리자만 가능)"}
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            className="admin-btn admin-btn-primary"
            onClick={() => { setFocusId(null); setAddOpen(true); }}
          >
            RAG 추가
          </button>
        )}
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>이름</th>
            <th>코퍼스</th>
            <th>소스</th>
            <th>상태</th>
            <th>공유</th>
            <th>스냅샷</th>
            <th className="admin-actions-col">작업</th>
          </tr>
        </thead>
        <tbody>
          {projects.length === 0 ? (
            <tr>
              <td colSpan={7} className="admin-cell-muted" style={{ textAlign: "center", padding: "24px" }}>
                아직 등록된 지식베이스가 없습니다. 위 <b>RAG 추가</b> 버튼으로 시작하세요.
              </td>
            </tr>
          ) : projects.map((p) => (
            <tr key={p.id} className={busyId === p.id ? "busy" : ""}>
              <td>
                <div>{p.name}</div>
                {!p.owned && <span className="admin-cell-muted">(공유 — 읽기 전용)</span>}
              </td>
              <td>
                <span className="admin-role-base base-user">
                  {corpusLabel(p.corpus_type)}
                </span>
              </td>
              <td className="admin-cell-muted" style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5 }}>
                {p.source_type}
              </td>
              <td>
                <span className={`admin-status admin-status-${p.status === "ready" ? "approved" : p.status === "failed" ? "rejected" : "pending"}`}>
                  {statusLabel(p)}
                </span>
              </td>
              <td>
                {p.is_shared
                  ? (p.role_codes.length > 0 ? `${p.role_codes.length}개 역할` : "공유 (역할 없음)")
                  : <span className="admin-cell-muted">개인</span>}
              </td>
              <td>
                <button
                  type="button"
                  className="admin-btn admin-link-btn"
                  onClick={() => {
                    setAddOpen(false);
                    setFocusId(null);
                    setSnapshotFocusId(p.id);
                  }}
                  disabled={(p.snapshots?.length ?? 0) === 0}
                  title="스냅샷 이력 보기"
                >
                  {p.snapshots?.length ?? 0}개
                </button>
              </td>
              <td className="admin-actions-col">
                <div className="admin-actions">
                  <button
                    type="button"
                    className="admin-btn"
                    onClick={() => { setAddOpen(false); setFocusId(p.id); }}
                  >
                    관리
                  </button>
                  {(p.owned || isAdmin) && (
                    <button
                      type="button"
                      className="admin-btn admin-btn-danger"
                      onClick={() => deleteProject(p)}
                      disabled={busyId === p.id}
                    >
                      삭제
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ProjectModal
        open={modalOpen}
        onClose={() => {
          setAddOpen(false);
          setFocusId(null);
          setSnapshotFocusId(null);
          refresh();
        }}
        adminMode={isAdmin}
        initialAddOpen={addOpen}
        initialProjectId={focusId || snapshotFocusId}
        initialSnapshotsOpen={snapshotFocusId !== null}
      />
    </div>
  );
}
