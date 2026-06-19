/** 역할 코드 관리 — 기본 3개 (admin/moderator/user) 외에 사내 운영용
 *  커스텀 역할(예: editor / auditor) 을 정의. base_role 등급에 따라
 *  권한 체크가 동작. */
import { useMemo, useState } from "react";
import {
  admin,
  type AdminUser,
  type BuiltinRole,
  type Role,
} from "../../api/client";

const BASE_ROLE_BADGE: Record<BuiltinRole, string> = {
  admin: "관리자 권한",
  moderator: "운영자 권한",
  user: "일반 권한",
};

export function RolesPanel({
  roles,
  users,
  isAdmin,
  onChanged,
}: {
  roles: Role[];
  users: AdminUser[];
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{
    code: string;
    name: string;
    description: string;
    base_role: BuiltinRole;
  }>({ code: "", name: "", description: "", base_role: "user" });
  // Per-row edit buffers — keyed by code so multiple rows can be open
  // simultaneously without state collisions.
  const [editing, setEditing] = useState<
    Record<string, { name: string; description: string; base_role: BuiltinRole }>
  >({});

  const userCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const u of users) {
      m[u.role] = (m[u.role] ?? 0) + 1;
    }
    return m;
  }, [users]);

  async function create() {
    if (!isAdmin) return;
    setError(null);
    if (!draft.code.trim() || !draft.name.trim()) {
      setError("코드와 이름을 입력하세요.");
      return;
    }
    setBusy("__new__");
    try {
      await admin.createRole({
        code: draft.code.trim().toLowerCase(),
        name: draft.name.trim(),
        description: draft.description.trim(),
        base_role: draft.base_role,
      });
      setDraft({ code: "", name: "", description: "", base_role: "user" });
      setAdding(false);
      onChanged();
    } catch (e) {
      setError(
        e instanceof Error ? e.message.replace(/^\d+\s/, "") : "역할 생성 실패",
      );
    } finally {
      setBusy(null);
    }
  }

  async function save(code: string) {
    if (!isAdmin) return;
    const buf = editing[code];
    if (!buf) return;
    setBusy(code);
    setError(null);
    try {
      await admin.updateRole(code, {
        name: buf.name.trim(),
        description: buf.description.trim(),
        base_role: buf.base_role,
      });
      setEditing((prev) => {
        const next = { ...prev };
        delete next[code];
        return next;
      });
      onChanged();
    } catch (e) {
      setError(
        e instanceof Error ? e.message.replace(/^\d+\s/, "") : "저장 실패",
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove(code: string) {
    if (!isAdmin) return;
    if (!window.confirm(`'${code}' 역할을 삭제하시겠어요?`)) return;
    setBusy(code);
    setError(null);
    try {
      await admin.deleteRole(code);
      onChanged();
    } catch (e) {
      setError(
        e instanceof Error ? e.message.replace(/^\d+\s/, "") : "삭제 실패",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="admin-roles">
      <div className="admin-roles-head">
        <div>
          <h2>역할 코드</h2>
          <p>
            기본 3개(관리자/운영자/일반) 외에 운영 상황에 맞는 커스텀 역할을
            정의할 수 있습니다. base 권한 등급에 따라 권한 체크가 동작합니다.
          </p>
        </div>
        {isAdmin && !adding && (
          <button
            type="button"
            className="admin-btn admin-btn-primary"
            onClick={() => setAdding(true)}
          >
            새 역할 추가
          </button>
        )}
      </div>

      {error && <div className="admin-error">{error}</div>}

      {adding && (
        <div className="admin-role-add">
          <div className="admin-role-add-grid">
            <label>
              <span>코드</span>
              <input
                type="text"
                value={draft.code}
                onChange={(e) =>
                  setDraft({ ...draft, code: e.target.value.toLowerCase() })
                }
                placeholder="예: editor"
                pattern="[a-z][a-z0-9_\-]*"
                maxLength={40}
              />
            </label>
            <label>
              <span>이름</span>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="예: 에디터"
                maxLength={80}
              />
            </label>
            <label>
              <span>base 권한</span>
              <select
                value={draft.base_role}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    base_role: e.target.value as BuiltinRole,
                  })
                }
              >
                <option value="user">일반 권한</option>
                <option value="moderator">운영자 권한</option>
                <option value="admin">관리자 권한</option>
              </select>
            </label>
            <label className="admin-role-add-desc">
              <span>설명</span>
              <input
                type="text"
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
                placeholder="이 역할이 하는 일을 한 줄로"
                maxLength={500}
              />
            </label>
          </div>
          <div className="admin-role-add-actions">
            <button
              type="button"
              className="admin-btn admin-btn-primary"
              onClick={create}
              disabled={busy === "__new__"}
            >
              {busy === "__new__" ? "추가 중…" : "추가"}
            </button>
            <button
              type="button"
              className="admin-btn"
              onClick={() => {
                setAdding(false);
                setDraft({
                  code: "",
                  name: "",
                  description: "",
                  base_role: "user",
                });
              }}
              disabled={busy === "__new__"}
            >
              취소
            </button>
          </div>
        </div>
      )}

      <table className="admin-table">
        <thead>
          <tr>
            <th>코드</th>
            <th>이름</th>
            <th>설명</th>
            <th>base 권한</th>
            <th>사용 중</th>
            <th className="admin-actions-col">작업</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => {
            const buf = editing[r.code];
            const inEdit = !!buf;
            const baseLabel = BASE_ROLE_BADGE[r.base_role];
            return (
              <tr key={r.code} className={busy === r.code ? "busy" : ""}>
                <td>
                  <code className="admin-role-code">{r.code}</code>
                  {r.is_system && (
                    <span className="admin-role-system">시스템</span>
                  )}
                </td>
                <td>
                  {inEdit ? (
                    <input
                      type="text"
                      value={buf.name}
                      onChange={(e) =>
                        setEditing((prev) => ({
                          ...prev,
                          [r.code]: { ...buf, name: e.target.value },
                        }))
                      }
                      maxLength={80}
                    />
                  ) : (
                    r.name
                  )}
                </td>
                <td className="admin-role-desc">
                  {inEdit ? (
                    <input
                      type="text"
                      value={buf.description}
                      onChange={(e) =>
                        setEditing((prev) => ({
                          ...prev,
                          [r.code]: { ...buf, description: e.target.value },
                        }))
                      }
                      maxLength={500}
                    />
                  ) : (
                    r.description || (
                      <span className="admin-cell-muted">—</span>
                    )
                  )}
                </td>
                <td>
                  {inEdit && !r.is_system ? (
                    <select
                      value={buf.base_role}
                      onChange={(e) =>
                        setEditing((prev) => ({
                          ...prev,
                          [r.code]: {
                            ...buf,
                            base_role: e.target.value as BuiltinRole,
                          },
                        }))
                      }
                    >
                      <option value="user">일반 권한</option>
                      <option value="moderator">운영자 권한</option>
                      <option value="admin">관리자 권한</option>
                    </select>
                  ) : (
                    <span className={`admin-role-base base-${r.base_role}`}>
                      {baseLabel}
                    </span>
                  )}
                </td>
                <td className="admin-cell-muted">
                  {userCount[r.code] ?? 0}명
                </td>
                <td className="admin-actions-col">
                  {!isAdmin ? (
                    <span className="admin-cell-muted">읽기 전용</span>
                  ) : inEdit ? (
                    <div className="admin-actions">
                      <button
                        className="admin-btn admin-btn-primary"
                        onClick={() => save(r.code)}
                        disabled={busy === r.code}
                      >
                        저장
                      </button>
                      <button
                        className="admin-btn"
                        onClick={() =>
                          setEditing((prev) => {
                            const next = { ...prev };
                            delete next[r.code];
                            return next;
                          })
                        }
                        disabled={busy === r.code}
                      >
                        취소
                      </button>
                    </div>
                  ) : (
                    <div className="admin-actions">
                      <button
                        className="admin-btn"
                        onClick={() =>
                          setEditing((prev) => ({
                            ...prev,
                            [r.code]: {
                              name: r.name,
                              description: r.description || "",
                              base_role: r.base_role,
                            },
                          }))
                        }
                      >
                        편집
                      </button>
                      {!r.is_system && (
                        <button
                          className="admin-btn admin-btn-danger"
                          onClick={() => remove(r.code)}
                          disabled={(userCount[r.code] ?? 0) > 0}
                          title={
                            (userCount[r.code] ?? 0) > 0
                              ? "이 역할을 가진 사용자가 있어 삭제할 수 없습니다"
                              : undefined
                          }
                        >
                          삭제
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
