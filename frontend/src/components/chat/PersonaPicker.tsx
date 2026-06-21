/** 페르소나 픽커 (#125) — 채팅 헤더에서 세션에 적용된 페르소나 확인 +
 *  선택 + 편집.  PromptEditModal 스타일을 참고해 만든 가벼운 dropdown
 *  + 인라인 CRUD. */
import { useEffect, useRef, useState } from "react";
import { api, type Persona } from "../../api/client";
import { errorToast, infoToast } from "../../lib/toast";

interface Props {
  sessionId: string;
  /** 현재 적용된 페르소나 id (null = 기본). */
  currentPersonaId: string | null;
  /** PATCH 성공 후 부모가 session 객체를 갱신할 수 있도록. */
  onPersonaChanged: (personaId: string | null) => void;
}

export function PersonaPicker({
  sessionId,
  currentPersonaId,
  onPersonaChanged,
}: Props) {
  const [open, setOpen] = useState(false);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [editingPersona, setEditingPersona] = useState<Persona | "new" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api.listPersonas().then(setPersonas).catch(() => setPersonas([]));
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // 외부 부모가 personaId 를 바꿀 때 픽커도 새로고침.
  const current = personas.find((p) => p.id === currentPersonaId);

  async function apply(personaId: string | null) {
    try {
      await api.updateSession(sessionId, { persona_id: personaId });
      onPersonaChanged(personaId);
      setOpen(false);
      const name = personaId
        ? personas.find((p) => p.id === personaId)?.name ?? "?"
        : "기본";
      infoToast(`페르소나: ${name}`);
    } catch (e) {
      errorToast("페르소나 적용 실패", e);
    }
  }

  return (
    <div className="persona-picker-wrap" ref={ref}>
      <button
        type="button"
        className="panel-toggle"
        onClick={() => setOpen((v) => !v)}
        title="챗봇 페르소나 — 클릭해 변경 / 추가"
      >
        {current ? (
          <>
            {current.emoji || "🎭"} {current.name}
          </>
        ) : (
          <>🎭 페르소나</>
        )}
      </button>
      {open && (
        <div className="persona-picker-pop" role="dialog" aria-label="페르소나">
          <div className="persona-picker-head">
            <strong>페르소나 선택</strong>
            <button
              type="button"
              className="persona-picker-add-btn"
              onClick={() => setEditingPersona("new")}
              title="새 페르소나 만들기"
            >
              + 새로 만들기
            </button>
          </div>
          <ul className="persona-picker-list">
            <li>
              <button
                type="button"
                className={`persona-picker-row${currentPersonaId === null ? " active" : ""}`}
                onClick={() => apply(null)}
              >
                <span className="persona-picker-emoji">⚪</span>
                <span className="persona-picker-name">기본 (페르소나 없음)</span>
              </button>
            </li>
            {personas.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`persona-picker-row${currentPersonaId === p.id ? " active" : ""}`}
                  onClick={() => apply(p.id)}
                  title={p.description || p.system_prompt.slice(0, 200)}
                >
                  <span className="persona-picker-emoji">{p.emoji || "🎭"}</span>
                  <span className="persona-picker-name">
                    {p.name}
                    {p.is_shared && <span className="persona-picker-badge">공유</span>}
                  </span>
                </button>
                {p.owned && (
                  <button
                    type="button"
                    className="persona-picker-edit"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingPersona(p);
                    }}
                    title="편집"
                  >
                    ✎
                  </button>
                )}
              </li>
            ))}
            {personas.length === 0 && (
              <li className="persona-picker-empty">
                저장된 페르소나가 없어요.  '새로 만들기' 로 첫 페르소나를
                추가하세요.
              </li>
            )}
          </ul>
        </div>
      )}
      {editingPersona !== null && (
        <PersonaEditModal
          persona={editingPersona === "new" ? null : editingPersona}
          onClose={() => setEditingPersona(null)}
          onSaved={async (saved) => {
            setEditingPersona(null);
            // 저장 직후 픽커 리스트 갱신.
            try {
              setPersonas(await api.listPersonas());
            } catch {
              /* ignore */
            }
            if (saved) await apply(saved.id);
          }}
          onDeleted={async () => {
            setEditingPersona(null);
            try {
              setPersonas(await api.listPersonas());
            } catch {
              /* ignore */
            }
            if (editingPersona !== "new" && editingPersona.id === currentPersonaId) {
              await apply(null);
            }
          }}
        />
      )}
    </div>
  );
}


/** 페르소나 CRUD 모달.  null = 새로 만들기. */
function PersonaEditModal({
  persona,
  onClose,
  onSaved,
  onDeleted,
}: {
  persona: Persona | null;
  onClose: () => void;
  onSaved: (saved: Persona | null) => Promise<void> | void;
  onDeleted: () => Promise<void> | void;
}) {
  const isNew = persona === null;
  const [name, setName] = useState(persona?.name ?? "");
  const [emoji, setEmoji] = useState(persona?.emoji ?? "");
  const [description, setDescription] = useState(persona?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(persona?.system_prompt ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || !systemPrompt.trim()) {
      errorToast("이름과 system_prompt 는 필수");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        emoji: emoji.trim(),
        system_prompt: systemPrompt,
        is_shared: persona?.is_shared ?? false,
      };
      const saved = isNew
        ? await api.createPersona(payload)
        : await api.updatePersona(persona.id, payload);
      await onSaved(saved);
    } catch (e) {
      errorToast(isNew ? "생성 실패" : "수정 실패", e);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (isNew || !persona) return;
    if (!window.confirm(`"${persona.name}" 페르소나를 삭제할까요?`)) return;
    setBusy(true);
    try {
      await api.deletePersona(persona.id);
      await onDeleted();
    } catch (e) {
      errorToast("삭제 실패", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal cp-edit-modal" onClick={(e) => e.stopPropagation()}>
        <header className="pm-head">
          <h3>{isNew ? "새 페르소나" : "페르소나 편집"}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </header>
        <div className="cp-edit-body">
          <div className="pm-field">
            <label htmlFor="persona-name">이름</label>
            <input
              id="persona-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={busy}
              placeholder="예: 코드 리뷰어"
              autoFocus
            />
          </div>
          <div className="pm-field">
            <label htmlFor="persona-emoji">이모지 (선택)</label>
            <input
              id="persona-emoji"
              type="text"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              maxLength={8}
              disabled={busy}
              placeholder="🔍"
              style={{ width: 80 }}
            />
          </div>
          <div className="pm-field">
            <label htmlFor="persona-desc">한 줄 설명 (선택)</label>
            <input
              id="persona-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              disabled={busy}
              placeholder="이 페르소나가 어떤 역할인지"
            />
          </div>
          <div className="pm-field">
            <label htmlFor="persona-prompt">system_prompt</label>
            <textarea
              id="persona-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              maxLength={10_000}
              disabled={busy}
              rows={10}
              placeholder="당신은 ... 입니다.  모든 답변에서 ... 를 우선하세요."
            />
            <div className="pm-help">
              세션의 모든 메시지 앞에 prepend 되어 모델의 톤·역할을 결정.
              마크다운 / 줄바꿈 그대로 들어갑니다.
            </div>
          </div>
          <div className="cp-edit-actions">
            {!isNew && persona && persona.owned && (
              <button
                type="button"
                className="pm-btn-secondary cp-edit-delete"
                onClick={remove}
                disabled={busy}
              >
                🗑 삭제
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
                onClick={save}
                disabled={busy || !name.trim() || !systemPrompt.trim()}
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
