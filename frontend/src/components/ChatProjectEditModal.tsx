import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ChatProject } from "../types";
import { IconAlertTriangle, IconTrash, IconX } from "./Icon";

interface Props {
  /** null = create-new mode; ChatProject = edit existing. */
  project: ChatProject | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  /** Only called from edit mode. After a successful delete the
   *  parent should refresh both the chat-project list and the
   *  session list (member sessions become unassigned). */
  onDeleted?: () => void | Promise<void>;
}

/** Create / edit dialog for a sidebar chat-project folder. Edits
 *  three fields: name, optional description, and an optional
 *  `instructions` body — the chat router prepends instructions as
 *  a system message on every turn for sessions filed under this
 *  project. */
export function ChatProjectEditModal({
  project,
  onClose,
  onSaved,
  onDeleted,
}: Props) {
  const isNew = project === null;
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [instructions, setInstructions] = useState(
    project?.instructions ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    setBusy(true);
    setErr(null);
    try {
      if (isNew) {
        await api.createChatProject({
          name: name.trim(),
          description: description.trim(),
          instructions,
        });
      } else {
        await api.updateChatProject(project!.id, {
          name: name.trim(),
          description: description.trim(),
          instructions,
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
    if (!project) return;
    const sessionCount = project.session_count;
    const msg =
      sessionCount > 0
        ? `"${project.name}" 프로젝트를 삭제할까요?\n` +
          `이 프로젝트 안의 대화 ${sessionCount}개는 삭제되지 않고 일반 목록으로 돌아갑니다.`
        : `"${project.name}" 프로젝트를 삭제할까요?`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteChatProject(project.id);
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
            <h3>{isNew ? "새 프로젝트" : "프로젝트 편집"}</h3>
            <p>
              관련 대화를 폴더로 묶고, 공통 시스템 프롬프트(지침)를 함께
              설정할 수 있습니다.
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
          <div className="pm-field">
            <label htmlFor="cp-name">이름</label>
            <input
              id="cp-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={busy}
              autoFocus
              placeholder="예: 사내 규정 검토"
            />
          </div>
          <div className="pm-field">
            <label htmlFor="cp-desc">설명 (선택)</label>
            <input
              id="cp-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              disabled={busy}
              placeholder="이 프로젝트가 무엇에 관한지 짧게 메모"
            />
          </div>
          <div className="pm-field">
            <label htmlFor="cp-instr">지침 (선택)</label>
            <textarea
              id="cp-instr"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              maxLength={8000}
              disabled={busy}
              rows={8}
              placeholder={
                "이 프로젝트의 모든 대화에 적용할 공통 지침을 입력하세요.\n" +
                "예) 답변은 존댓말로, 코드 예시는 TypeScript 우선,\n" +
                "    회사 내부 용어 ABC는 항상 대문자로 표기"
              }
            />
            <div className="pm-help">
              저장하면 이 프로젝트 안의 모든 대화에서 매 턴 시스템 메시지로
              자동 주입됩니다.
            </div>
          </div>

          {err && (
            <div className="pm-add-error">
              <IconAlertTriangle size={14} />
              <span>{err}</span>
            </div>
          )}

          <div className="cp-edit-actions">
            {!isNew && (
              <button
                type="button"
                className="pm-btn-secondary cp-edit-delete"
                onClick={remove}
                disabled={busy}
                title="프로젝트 삭제"
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
