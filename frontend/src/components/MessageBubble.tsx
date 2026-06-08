import { forwardRef, useEffect, useRef, useState } from "react";
import { api, type AttachmentSummary } from "../api/client";
import { BubbleContent } from "./BubbleContent";
import { IconChevronDown, IconChevronRight, IconEdit, IconFileText, IconImage, IconX } from "./Icon";

interface Props {
  role: "user" | "assistant";
  provider?: string | null;
  content: string;
  streaming?: boolean;
  artifactTitlePrefix?: string;
  /** Compact list of files that travelled with this user message —
   *  rendered as small chips above the prompt text so the bubble
   *  preserves "I attached report.pdf + chart.png" context on
   *  reload. No-op for assistant bubbles. */
  attachments?: AttachmentSummary[] | null;
  /** When set, the bubble shows a select checkbox so the user can
   *  pick it for the "export to document" flow. The parent owns the
   *  selection state — the bubble just toggles the bound flag. */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  /** Persisted message id — surfaced as a data-message-id attribute
   *  on the bubble root so the global search dialog can scroll the
   *  matching bubble into view after navigating. */
  messageId?: string;
  /** Session id, threaded through so the inline edit can PATCH the
   *  right URL. When set together with messageId, the bubble shows
   *  a pencil button + a hidden-collapse affordance. */
  sessionId?: string;
  /** True when this message is the raw transcript (or any other
   *  body the backend chose to keep but not show by default).
   *  Renders as a collapsed "원문 보기" placeholder until clicked. */
  hidden?: boolean;
  /** Called after a successful edit so the parent can refresh
   *  session.messages. The bubble updates its own local content
   *  optimistically too. */
  onEdited?: (newContent: string) => void;
}

function bubbleAttachmentBasename(filename: string): string {
  const slash = filename.lastIndexOf("/");
  return slash >= 0 ? filename.slice(slash + 1) : filename;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  return (
    <button
      type="button"
      className={`copy-btn ${copied ? "copied" : ""}`}
      onClick={handleCopy}
      aria-label="복사"
      title={copied ? "복사됨" : "복사"}
    >
      {copied ? "✓ 복사됨" : "📋 복사"}
    </button>
  );
}

export function MessageBubble({
  role,
  provider,
  content,
  streaming,
  artifactTitlePrefix,
  attachments,
  selectionMode,
  selected,
  onToggleSelect,
  messageId,
  sessionId,
  hidden = false,
  onEdited,
}: Props) {
  // Local optimistic content + collapsed/edit state. Re-seeds when
  // the parent's `content` changes (e.g., after streaming completes
  // or the parent re-fetches the session).
  const [body, setBody] = useState(content);
  const [collapsed, setCollapsed] = useState(hidden);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    setBody(content);
    if (!editing) setDraft(content);
  }, [content, editing]);
  useEffect(() => {
    // Honor the parent's hidden flag whenever it flips (e.g., parent
    // refetched after an edit and the row is now visible).
    setCollapsed(hidden);
  }, [hidden]);
  useEffect(() => {
    if (editing) {
      editRef.current?.focus();
      // Place caret at the end so a long body is editable without
      // selecting everything.
      const len = editRef.current?.value.length ?? 0;
      editRef.current?.setSelectionRange(len, len);
    }
  }, [editing]);

  const canEdit =
    !!sessionId && !!messageId && !streaming && !selectionMode;

  async function commitEdit() {
    if (!sessionId || !messageId) return;
    const next = draft.trim();
    if (!next || next === body) {
      setEditing(false);
      setDraft(body);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateMessage(sessionId, messageId, next);
      setBody(updated.content);
      setEditing(false);
      setCollapsed(false);
      onEdited?.(updated.content);
    } catch (e) {
      window.alert(
        `메시지 수정 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSaving(false);
    }
  }
  function cancelEdit() {
    setEditing(false);
    setDraft(body);
  }

  const selectCheckbox = selectionMode ? (
    <label
      className={`bubble-select${selected ? " checked" : ""}`}
      onClick={(e) => e.stopPropagation()}
      title={selected ? "선택 해제" : "문서 포함 대상으로 선택"}
    >
      <input
        type="checkbox"
        checked={!!selected}
        onChange={() => onToggleSelect?.()}
      />
    </label>
  ) : null;

  // Collapsed banner — shown for messages the backend marked hidden
  // (typically the raw whisper transcript). One click expands the
  // full body. Edit/copy actions become available once expanded.
  if (collapsed && body && !editing) {
    const lines = body.split("\n").length;
    return (
      <div
        className={`bubble-row ${role}-row bubble-collapsed`}
        data-message-id={messageId || undefined}
      >
        {selectCheckbox}
        <button
          type="button"
          className="bubble-collapse-toggle"
          onClick={() => setCollapsed(false)}
          title="원문 펼치기"
        >
          <IconChevronRight size={12} />
          <span>
            {role === "user" ? "원문 전사 펼치기" : "전체 응답 펼치기"}
          </span>
          <span className="bubble-collapse-meta">{lines}줄</span>
        </button>
      </div>
    );
  }

  if (role === "user") {
    const showAttachments = attachments && attachments.length > 0;
    return (
      <div
        className="bubble-row user-row"
        data-message-id={messageId || undefined}
      >
        {selectCheckbox}
        <div className="bubble user">
          {showAttachments && (
            <div className="bubble-attachments">
              {attachments!.map((a, i) => (
                <span key={i} className="bubble-attachment" title={a.filename}>
                  <span className="bubble-attachment-icon" aria-hidden="true">
                    {a.kind === "image" ? (
                      <IconImage size={13} />
                    ) : (
                      <IconFileText size={13} />
                    )}
                  </span>
                  <span className="bubble-attachment-name">
                    {bubbleAttachmentBasename(a.filename)}
                  </span>
                </span>
              ))}
            </div>
          )}
          {editing ? (
            <MessageEditor
              ref={editRef}
              draft={draft}
              onChange={setDraft}
              onCommit={commitEdit}
              onCancel={cancelEdit}
              saving={saving}
            />
          ) : (
            <>
              {body}
              {streaming && <span className="cursor">▍</span>}
            </>
          )}
        </div>
        {!streaming && body && !editing && (
          <div className="bubble-action-row">
            {hidden && (
              <button
                type="button"
                className="bubble-tiny-btn"
                onClick={() => setCollapsed(true)}
                title="원문 다시 접기"
              >
                <IconChevronDown size={11} />
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                className="bubble-tiny-btn"
                onClick={() => setEditing(true)}
                title="메시지 수정"
              >
                <IconEdit size={11} />
              </button>
            )}
            <CopyButton text={body} />
          </div>
        )}
      </div>
    );
  }
  const showAssistantAttachments = attachments && attachments.length > 0;
  return (
    <div className="bubble assistant" data-message-id={messageId || undefined}>
      {selectCheckbox}
      <div className="avatar">A</div>
      <div className="body">
        {provider && <div className="bubble-header">{provider}</div>}
        <div className="content">
          {editing ? (
            <MessageEditor
              ref={editRef}
              draft={draft}
              onChange={setDraft}
              onCommit={commitEdit}
              onCancel={cancelEdit}
              saving={saving}
            />
          ) : (
            <BubbleContent
              content={body}
              streaming={!!streaming}
              artifactTitlePrefix={artifactTitlePrefix}
            />
          )}
          {showAssistantAttachments && (
            <div className="bubble-attachments assistant-side">
              {attachments!.map((a, i) => (
                <span key={i} className="bubble-attachment" title={a.filename}>
                  <span className="bubble-attachment-icon" aria-hidden="true">
                    {a.kind === "image" ? (
                      <IconImage size={13} />
                    ) : (
                      <IconFileText size={13} />
                    )}
                  </span>
                  <span className="bubble-attachment-name">
                    {bubbleAttachmentBasename(a.filename)}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
        {!streaming && body && !editing && (
          <div className="bubble-actions">
            {canEdit && (
              <button
                type="button"
                className="bubble-tiny-btn"
                onClick={() => setEditing(true)}
                title="요약 수정"
              >
                <IconEdit size={11} /> 수정
              </button>
            )}
            <CopyButton text={body} />
          </div>
        )}
      </div>
    </div>
  );
}


/** Textarea-based inline editor used by both user + assistant
 *  bubbles. Auto-grows with content, Enter+Ctrl/Cmd commits, Esc
 *  cancels. */
const MessageEditor = forwardRef<
  HTMLTextAreaElement,
  {
    draft: string;
    onChange: (next: string) => void;
    onCommit: () => void;
    onCancel: () => void;
    saving: boolean;
  }
>(function MessageEditorImpl(
  { draft, onChange, onCommit, onCancel, saving },
  ref,
) {
  return (
    <div className="bubble-edit">
      <textarea
        ref={ref}
        className="bubble-edit-text"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onCommit();
          }
        }}
        rows={Math.min(20, Math.max(3, draft.split("\n").length + 1))}
        disabled={saving}
        spellCheck={false}
      />
      <div className="bubble-edit-actions">
        <button
          type="button"
          className="bubble-edit-cancel"
          onClick={onCancel}
          disabled={saving}
        >
          <IconX size={11} /> 취소
        </button>
        <button
          type="button"
          className="bubble-edit-save"
          onClick={onCommit}
          disabled={saving || !draft.trim()}
        >
          {saving ? "저장 중…" : "저장 (Ctrl+Enter)"}
        </button>
      </div>
    </div>
  );
});
