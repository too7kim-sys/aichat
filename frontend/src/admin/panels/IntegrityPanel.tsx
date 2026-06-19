/** 데이터 정합성 패널 (#112~#115) — 백업 무결성 sha256+SQLite check,
 *  고아 Comment 행, 고아 업로드 디렉터리.  각 섹션마다 정리 버튼.
 *  정리 작업은 audit_log 에 actor 기록. */
import { useEffect, useState } from "react";
import { admin } from "../../api/client";
import { errorToast, infoToast } from "../../lib/toast";
import { fmtBytes } from "./_shared";

export function IntegrityPanel() {
  type Backup = Awaited<
    ReturnType<typeof admin.checkBackupIntegrity>
  >["files"][number];
  type Orphans = Awaited<ReturnType<typeof admin.listOrphans>>;
  type Files = Awaited<ReturnType<typeof admin.checkFileIntegrity>>;
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [backupDir, setBackupDir] = useState("");
  const [orphans, setOrphans] = useState<Orphans | null>(null);
  const [files, setFiles] = useState<Files | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refreshAll() {
    setBusy(true);
    setErr(null);
    try {
      const [b, o, f] = await Promise.all([
        admin.checkBackupIntegrity(),
        admin.listOrphans(),
        admin.checkFileIntegrity(),
      ]);
      setBackups(b.files);
      setBackupDir(b.backup_dir);
      setOrphans(o);
      setFiles(f);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { refreshAll(); }, []);

  async function cleanupCommentOrphans(targetType: string) {
    if (!window.confirm(
      `${targetType} 카테고리의 고아 코멘트를 모두 삭제할까요?`,
    )) return;
    try {
      const r = await admin.cleanupOrphans("comments", targetType);
      infoToast(`${r.deleted}건 삭제됨`);
      await refreshAll();
    } catch (e) {
      errorToast("작업 실패", e);
    }
  }

  async function cleanupOrphanDirs(ids: string[]) {
    if (ids.length === 0) return;
    if (!window.confirm(
      `${ids.length}개 고아 디렉터리를 영구 삭제할까요?  되돌릴 수 없습니다.`,
    )) return;
    try {
      const r = await admin.cleanupOrphanDirs(ids);
      infoToast(`${r.deleted_dirs}개 디렉터리, ${fmtBytes(r.freed_bytes)} 회수`);
      await refreshAll();
    } catch (e) {
      errorToast("작업 실패", e);
    }
  }

  return (
    <div className="admin-errors">
      <div className="admin-errors-head">
        <div>
          <h2>데이터 정합성</h2>
          <p>
            백업이 실제로 살아있는지 검증하고 고아 행·디렉터리를 한 화면
            에서 정리합니다. 정리 작업은 감사 로그에 actor 가 남습니다.
          </p>
        </div>
        <button
          type="button"
          className="admin-btn"
          onClick={refreshAll}
          disabled={busy}
        >
          {busy ? "검사 중…" : "🔄 다시 검사"}
        </button>
      </div>

      {err && <div className="admin-empty admin-error">오류: {err}</div>}

      <h3 style={{ marginTop: 18 }}>1️⃣ 백업 무결성 (#112)</h3>
      <div className="pm-help" style={{ marginBottom: 6 }}>
        디렉터리: <code>{backupDir || "(미설정)"}</code>
      </div>
      {backups === null ? (
        <div className="admin-empty">검사 전</div>
      ) : backups.length === 0 ? (
        <div className="admin-empty">백업 파일 없음</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>이름</th>
              <th>크기</th>
              <th>sha256 (앞 16자)</th>
              <th>integrity_check</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.name}>
                <td><code>{b.name}</code></td>
                <td>{fmtBytes(b.size_bytes ?? 0)}</td>
                <td>
                  <code style={{ fontSize: 10 }}>
                    {b.sha256?.slice(0, 16) ?? "—"}
                  </code>
                </td>
                <td>
                  <span style={{ color: b.ok ? "#15803d" : "#b91c1c" }}>
                    {b.ok ? "✓ ok" : `✗ ${b.error || b.integrity || "fail"}`}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: 18 }}>2️⃣ 고아 행 (#113)</h3>
      {orphans === null ? (
        <div className="admin-empty">검사 전</div>
      ) : (
        <table className="admin-table admin-error-table">
          <thead>
            <tr>
              <th>카테고리</th>
              <th>개수</th>
              <th>예시 id</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(orphans.comments).map(([k, v]) => (
              <tr key={k}>
                <td><code>comments / {k}</code></td>
                <td>{v.count}</td>
                <td>
                  <code style={{ fontSize: 10 }}>
                    {v.sample.slice(0, 3).join(", ") || "—"}
                  </code>
                </td>
                <td>
                  {v.count > 0 && (
                    <button
                      type="button"
                      className="admin-btn admin-btn-danger"
                      onClick={() => cleanupCommentOrphans(k)}
                    >
                      정리
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: 18 }}>3️⃣ 고아 파일 (#114)</h3>
      {files === null ? (
        <div className="admin-empty">검사 전</div>
      ) : (
        <>
          <div className="pm-help" style={{ marginBottom: 6 }}>
            업로드 루트: <code>{files.upload_root}</code>
          </div>
          {files.orphan_dirs.length === 0 ? (
            <div className="admin-empty">고아 디렉터리 없음</div>
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>
                <button
                  type="button"
                  className="admin-btn admin-btn-danger"
                  onClick={() =>
                    cleanupOrphanDirs(files.orphan_dirs.map((d) => d.project_id))
                  }
                >
                  🗑 모두 정리 ({files.orphan_dirs.length}개)
                </button>
              </div>
              <table className="admin-table admin-error-table">
                <thead>
                  <tr>
                    <th>project_id</th>
                    <th>파일 수</th>
                    <th>크기</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {files.orphan_dirs.map((d) => (
                    <tr key={d.project_id}>
                      <td><code>{d.project_id}</code></td>
                      <td>{d.file_count}</td>
                      <td>{fmtBytes(d.size_bytes)}</td>
                      <td>
                        <button
                          type="button"
                          className="admin-btn admin-btn-danger"
                          onClick={() => cleanupOrphanDirs([d.project_id])}
                        >
                          정리
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {files.missing_dirs.length > 0 && (
            <>
              <h4 style={{ marginTop: 12 }}>
                ⚠️ 디렉터리가 사라진 upload 프로젝트
              </h4>
              <div className="pm-help">
                DB 행은 있지만 디스크에 디렉터리가 없습니다.  업로드 / 검색이
                실패할 수 있어요.
              </div>
              <ul className="audit-list">
                {files.missing_dirs.map((m) => (
                  <li key={m.project_id}>
                    <span className="audit-meta">
                      <code>{m.project_id}</code> — {m.name}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
