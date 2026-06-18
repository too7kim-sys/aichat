import { useEffect, useState } from "react";
import { api, type Prompt, type Role } from "../api/client";
import { IconAlertTriangle, IconTrash, IconX } from "./Icon";

interface Props {
  /** null = create-new; Prompt = edit existing. */
  prompt: Prompt | null;
  /** All roles, used by the share picker when admin mode is on. */
  roles?: Role[];
  /** True when the current user is an admin — exposes the "공유" toggle
   *  and role mapping. Non-admin users only manage personal prompts. */
  isAdmin?: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onDeleted?: () => void | Promise<void>;
}

/** Create / edit dialog for a single prompt template. Lives inside
 *  the Cowork pane so individuals manage their own prompts without
 *  needing the admin dashboard. Admins additionally get the share
 *  toggle + role grants. */
export function PromptEditModal({
  prompt,
  roles = [],
  isAdmin = false,
  onClose,
  onSaved,
  onDeleted,
}: Props) {
  const isNew = prompt === null;
  const [code, setCode] = useState(prompt?.code ?? "");
  const [name, setName] = useState(prompt?.name ?? "");
  const [description, setDescription] = useState(prompt?.description ?? "");
  const [body, setBody] = useState(prompt?.body ?? "");
  const [category, setCategory] = useState(prompt?.category ?? "");
  const [tags, setTags] = useState(prompt?.tags ?? "");
  const [isShared, setIsShared] = useState(prompt?.is_shared ?? false);
  const [shareRoles, setShareRoles] = useState<Set<string>>(
    new Set(prompt?.role_codes ?? []),
  );
  const [teamId, setTeamId] = useState<string>(prompt?.team_id ?? "");
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .listTeams()
      .then((r) => setTeams(r.map((t) => ({ id: t.id, name: t.name }))))
      .catch(() => setTeams([]));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (!name.trim()) {
      setErr("이름을 입력하세요");
      return;
    }
    if (!body.trim()) {
      setErr("프롬프트 본문을 입력하세요");
      return;
    }
    if (isNew && !/^[a-z0-9][a-z0-9_-]{1,59}$/.test(code.trim())) {
      setErr(
        "코드는 영문 소문자/숫자/-/_ 로 시작하고 2~60자여야 합니다 (예: code-review)",
      );
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (isNew) {
        await api.createPrompt({
          code: code.trim(),
          name: name.trim(),
          description: description.trim(),
          body,
          category: category.trim(),
          tags: tags.trim(),
          is_shared: isAdmin ? isShared : false,
          role_codes:
            isAdmin && isShared ? Array.from(shareRoles) : [],
          team_id: teamId || null,
        });
      } else {
        await api.updatePrompt(prompt!.id, {
          name: name.trim(),
          description: description.trim(),
          body,
          category: category.trim(),
          tags: tags.trim(),
          team_id: teamId || null,
          ...(isAdmin
            ? {
                is_shared: isShared,
                role_codes: isShared ? Array.from(shareRoles) : [],
              }
            : {}),
        });
      }
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!prompt) return;
    if (!window.confirm(`"${prompt.name}" 프롬프트를 삭제할까요?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deletePrompt(prompt.id);
      await onDeleted?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal cp-edit-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pm-head">
          <div className="pm-head-text">
            <h3>{isNew ? "새 프롬프트" : "프롬프트 편집"}</h3>
            <p>
              자주 쓰는 질문을 템플릿으로 저장해두면 채팅 입력창에서
              한 번에 끼울 수 있습니다.
            </p>
          </div>
          <div className="pm-head-right">
            <button
              type="button"
              className="modal-close"
              onClick={onClose}
              aria-label="닫기"
            >
              <IconX size={18} />
            </button>
          </div>
        </header>

        <div className="cp-edit-body">
          {isNew && (
            <div className="pm-field">
              <label htmlFor="prompt-code">코드 (식별자)</label>
              <input
                id="prompt-code"
                type="text"
                value={code}
                onChange={(e) =>
                  setCode(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9_-]/g, ""),
                  )
                }
                maxLength={60}
                disabled={busy}
                placeholder="code-review"
                autoFocus
              />
              <div className="pm-help">
                영문 소문자·숫자·- · _ 만 가능. 만들고 나면 바꿀 수 없습니다.
              </div>
            </div>
          )}
          <div className="pm-field">
            <label htmlFor="prompt-name">이름</label>
            <input
              id="prompt-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={busy}
              autoFocus={!isNew}
            />
          </div>
          <div className="pm-field">
            <label htmlFor="prompt-desc">설명 (선택)</label>
            <input
              id="prompt-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              disabled={busy}
              placeholder="이 프롬프트가 무엇에 쓰이는지 한 줄로"
            />
          </div>
          <div className="pm-field">
            <label htmlFor="prompt-body">본문</label>
            <textarea
              id="prompt-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={20000}
              disabled={busy}
              rows={10}
              placeholder={
                "예) 아래 코드의 잠재적 보안 문제를 찾아주세요.\n" +
                "{code} 같은 중괄호 변수는 워크플로에서 값으로 치환됩니다."
              }
            />
            <div className="pm-help">
              {"{변수명}"} 형태로 placeholder를 넣으면 워크플로 자동 실행 시
              값이 채워집니다.
            </div>
          </div>
          <div className="pm-field-row">
            <div className="pm-field">
              <label htmlFor="prompt-category">카테고리 (선택)</label>
              <input
                id="prompt-category"
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                maxLength={40}
                disabled={busy}
                placeholder="code · doc · 검토 …"
              />
            </div>
            <div className="pm-field">
              <label htmlFor="prompt-tags">태그 (선택)</label>
              <input
                id="prompt-tags"
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                maxLength={200}
                disabled={busy}
                placeholder="python, 리뷰, 사내규정"
              />
            </div>
          </div>

          <div className="pm-field">
            <label htmlFor="prompt-team">공유 팀 (선택)</label>
            <select
              id="prompt-team"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              disabled={busy}
            >
              <option value="">— 개인 프롬프트 —</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <div className="pm-help">
              팀을 지정하면 팀원의 카탈로그에도 노출됩니다.
            </div>
          </div>

          {isAdmin && (
            <div className="pm-field pm-share-field">
              <label className="pm-share-toggle">
                <input
                  type="checkbox"
                  checked={isShared}
                  onChange={(e) => setIsShared(e.target.checked)}
                  disabled={busy}
                />
                <span>
                  <b>공유 프롬프트</b>
                  <span className="pm-help">
                    선택한 역할의 사용자가 함께 사용할 수 있습니다.
                  </span>
                </span>
              </label>
              {isShared && roles.length > 0 && (
                <div className="pm-share-roles">
                  <div className="pm-share-role-grid">
                    {roles.map((r) => (
                      <label key={r.code} className="pm-share-role-chip">
                        <input
                          type="checkbox"
                          checked={shareRoles.has(r.code)}
                          onChange={(e) =>
                            setShareRoles((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(r.code);
                              else next.delete(r.code);
                              return next;
                            })
                          }
                          disabled={busy}
                        />
                        <span>{r.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {err && (
            <div className="pm-add-error">
              <IconAlertTriangle size={14} />
              <span>{err}</span>
            </div>
          )}

          <div className="cp-edit-actions">
            {!isNew && prompt?.owned && (
              <button
                type="button"
                className="pm-btn-secondary cp-edit-delete"
                onClick={remove}
                disabled={busy}
              >
                <IconTrash size={13} /> 삭제
              </button>
            )}
            <div className="cp-edit-actions-right">
              <button
                type="button"
                className="pm-btn-secondary"
                onClick={onClose}
                disabled={busy}
              >
                취소
              </button>
              <button
                type="button"
                className="pm-btn-primary"
                onClick={submit}
                disabled={busy}
              >
                {busy ? "저장 중…" : "저장"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
