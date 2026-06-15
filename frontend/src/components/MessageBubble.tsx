import { forwardRef, useEffect, useRef, useState } from "react";
import { api, type AttachmentSummary } from "../api/client";
import { BrandLogo } from "./BrandLogo";
import { BubbleContent } from "./BubbleContent";
import { IconChevronDown, IconChevronRight, IconEdit, IconFileText, IconImage, IconStar, IconThumbsDown, IconThumbsUp, IconX } from "./Icon";

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
   *  right URL. When set together with messageId + editable, the
   *  bubble shows a pencil button + a hidden-collapse affordance. */
  sessionId?: string;
  /** Gate for the inline edit affordance. Only the 회의록(transcript)
   *  chat enables this — regular chats stay read-only so the model
   *  history isn't accidentally rewritten. */
  editable?: boolean;
  /** True when this message is the raw transcript (or any other
   *  body the backend chose to keep but not show by default).
   *  Renders as a collapsed "원문 보기" placeholder until clicked. */
  hidden?: boolean;
  /** Called after a successful edit so the parent can refresh
   *  session.messages. The bubble updates its own local content
   *  optimistically too. */
  onEdited?: (newContent: string) => void;
  /** 별표 + 답변 평가 초기값. 본문이 아니라 메타라 별도 prop 으로. */
  starred?: boolean;
  feedback?: number;
  feedbackNote?: string | null;
  /** 별표/평가 토글 — 부모가 session.messages 를 갱신할 수 있게.
   *  meta 만 PATCH 하는 가벼운 API 가 따로 있다 (api.updateMessageMeta). */
  onMetaChanged?: (next: {
    starred?: boolean;
    feedback?: number;
    feedback_note?: string | null;
    tags?: string[] | null;
  }) => void;
  /** 정확 시각 — 어시스턴트는 답변 받은 시각, 사용자는 발송 시각. */
  createdAt?: string | null;
  /** 어시스턴트 응답 메타 (provider · latency · tokens). */
  latencyMs?: number | null;
  tokensOut?: number | null;
  /** 분기·삭제 등 트리 액션을 부모가 처리 — 새 세션 ID 로 전환 등. */
  onBranchFrom?: () => void | Promise<void>;
  /** 잠금 모드 — 편집/별표/평가/분기 등 메타 변경 차단 (#21). */
  locked?: boolean;
  /** 메시지 자유 태그 (#32). */
  tags?: string[] | null;
  /** 세션 내 검색 (#46) 의 활성 쿼리.  비어 있지 않으면 본문에
   *  매칭되는 부분을 <mark> 으로 강조. */
  searchQuery?: string;
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
  editable = false,
  hidden = false,
  onEdited,
  starred = false,
  feedback = 0,
  feedbackNote = null,
  onMetaChanged,
  createdAt = null,
  latencyMs = null,
  tokensOut = null,
  onBranchFrom,
  locked = false,
  tags = null,
  searchQuery = "",
}: Props) {
  // Local optimistic content + collapsed/edit state. Re-seeds when
  // the parent's `content` changes (e.g., after streaming completes
  // or the parent re-fetches the session).
  const [body, setBody] = useState(content);
  const [collapsed, setCollapsed] = useState(hidden);
  const [editing, setEditing] = useState(false);
  // 사용자 메시지의 "수정 후 다시 보내기" 모드 — 일반 editing 과 같은
  // textarea 를 재사용하되 commit 시 PATCH 대신 rewind + 재전송.
  const [rewindMode, setRewindMode] = useState(false);
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  // 별표 / 평가 / 메모 (낙관적 토글 — 서버 round-trip 이 끝나기 전에
  // UI 가 먼저 바뀐다. 실패 시 롤백).
  const [starredLocal, setStarredLocal] = useState(starred);
  const [feedbackLocal, setFeedbackLocal] = useState<number>(feedback);
  const [noteLocal, setNoteLocal] = useState<string | null>(feedbackNote);
  const [showNoteEditor, setShowNoteEditor] = useState(false);
  const [noteDraft, setNoteDraft] = useState(feedbackNote ?? "");
  // 자유 태그 (#32). 낙관적 갱신.
  const [tagsLocal, setTagsLocal] = useState<string[]>(tags ?? []);
  const [tagInputOpen, setTagInputOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  useEffect(() => setTagsLocal(tags ?? []), [tags]);
  async function saveTags(next: string[]) {
    if (!sessionId || !messageId) return;
    const prev = tagsLocal;
    setTagsLocal(next);
    try {
      await api.updateMessageMeta(sessionId, messageId, { tags: next });
      onMetaChanged?.({ tags: next });
    } catch (e) {
      setTagsLocal(prev);
      window.alert(
        `태그 저장 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  function addTag() {
    const t = tagDraft.trim().slice(0, 24);
    if (!t) return;
    if (tagsLocal.includes(t)) {
      setTagDraft("");
      return;
    }
    if (tagsLocal.length >= 8) {
      window.alert("태그는 메시지당 최대 8개까지 붙일 수 있어요.");
      return;
    }
    void saveTags([...tagsLocal, t]);
    setTagDraft("");
  }
  function removeTag(t: string) {
    void saveTags(tagsLocal.filter((x) => x !== t));
  }
  // 번역 (#40) — 답변 본문 아래 번역 결과 표시.  null = 안 함,
  // {target, text} = 표시. 'loading' 은 호출 중.
  const [translation, setTranslation] = useState<
    { target: string; text: string } | "loading" | null
  >(null);
  async function translateTo(target: "ko" | "en" | "ja" | "zh") {
    if (!sessionId || !messageId) return;
    setTranslation("loading");
    try {
      const r = await api.translateMessage(sessionId, messageId, target);
      setTranslation({ target, text: r.text });
    } catch (e) {
      setTranslation(null);
      window.alert(`번역 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // 세션 내 검색 강조 (#46) — 어시스턴트 본문에 매칭 텍스트를
  // <mark> 으로 감쌈.  마크다운 HTML 이 이미 렌더된 뒤 TreeWalker 로
  // 텍스트 노드를 돌며 처리하므로 마크다운 구조를 깨지 않음.
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    // 기존 mark 풀기 (이전 쿼리 또는 빈 쿼리 시).
    root.querySelectorAll("mark.bubble-search-mark").forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize?.();
    });
    const q = searchQuery.trim();
    if (q.length < 2) return;
    const re = new RegExp(
      q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        // 코드 / 입력 / 이미 mark 처리된 곳은 패스.
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "MARK") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets: Text[] = [];
    let n: Node | null = walker.nextNode();
    while (n) {
      targets.push(n as Text);
      n = walker.nextNode();
    }
    for (const t of targets) {
      const text = t.textContent || "";
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) {
          frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        }
        const mark = document.createElement("mark");
        mark.className = "bubble-search-mark";
        mark.textContent = m[0];
        frag.appendChild(mark);
        last = m.index + m[0].length;
      }
      if (last < text.length) {
        frag.appendChild(document.createTextNode(text.slice(last)));
      }
      t.parentNode?.replaceChild(frag, t);
    }
  }, [searchQuery, body]);

  // 인용 [N] 클릭 = 출처 카드로 점프 (#42).  검색 강조와 별개로 한 번 더
  // TreeWalker 를 돌려 [\d+] 패턴을 button 으로 감싼다.  코드 블록 안
  // (PRE/CODE) 은 패스 — 코드의 배열 인덱스가 잘못 클릭 가능해질 수 있음.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    // 기존 chip 제거.
    root.querySelectorAll("button.bubble-citation").forEach((b) => {
      const parent = b.parentNode;
      if (!parent) return;
      const t = document.createTextNode(b.textContent || "");
      parent.replaceChild(t, b);
      parent.normalize?.();
    });
    const re = /\[(\d+)\]/g;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (
          tag === "CODE" || tag === "PRE" || tag === "SCRIPT" ||
          tag === "STYLE" || tag === "MARK" || tag === "BUTTON"
        )
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets: Text[] = [];
    let n: Node | null = walker.nextNode();
    while (n) {
      targets.push(n as Text);
      n = walker.nextNode();
    }
    for (const t of targets) {
      const text = t.textContent || "";
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) {
          frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "bubble-citation";
        btn.dataset.idx = m[1];
        btn.textContent = `[${m[1]}]`;
        btn.title = `출처 #${m[1]} 보기`;
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          window.dispatchEvent(
            new CustomEvent("chat:show-citation", {
              detail: { index: Number(btn.dataset.idx) },
            }),
          );
        });
        frag.appendChild(btn);
        last = m.index + m[0].length;
      }
      if (last < text.length) {
        frag.appendChild(document.createTextNode(text.slice(last)));
      }
      t.parentNode?.replaceChild(frag, t);
    }
  }, [body]);
  // 액션 행 ⋯ 오버플로우 메뉴 + 빠른 답장 칩 접기 (UI 최적화).
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return;
    function onDocClick(e: MouseEvent) {
      const el = moreRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      setMoreOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [moreOpen]);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState<boolean>(() => {
    return localStorage.getItem("chat:quick-replies-open") === "1";
  });
  function toggleQuickReplies() {
    setQuickRepliesOpen((cur) => {
      const next = !cur;
      if (next) localStorage.setItem("chat:quick-replies-open", "1");
      else localStorage.removeItem("chat:quick-replies-open");
      return next;
    });
  }
  useEffect(() => setStarredLocal(starred), [starred]);
  useEffect(() => setFeedbackLocal(feedback), [feedback]);
  useEffect(() => {
    setNoteLocal(feedbackNote);
    if (!showNoteEditor) setNoteDraft(feedbackNote ?? "");
  }, [feedbackNote, showNoteEditor]);

  async function toggleStar() {
    if (!sessionId || !messageId) return;
    if (locked) return;
    const next = !starredLocal;
    setStarredLocal(next);
    try {
      await api.updateMessageMeta(sessionId, messageId, { starred: next });
      onMetaChanged?.({ starred: next });
    } catch (e) {
      setStarredLocal(!next);
      window.alert(
        `별표 토글 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function setFeedback(value: 1 | -1) {
    if (!sessionId || !messageId) return;
    if (locked) return;
    const next = feedbackLocal === value ? 0 : value;
    setFeedbackLocal(next);
    try {
      await api.updateMessageMeta(sessionId, messageId, { feedback: next as -1 | 0 | 1 });
      onMetaChanged?.({ feedback: next });
      if (next === 0) {
        setNoteLocal(null);
        onMetaChanged?.({ feedback_note: null });
        setShowNoteEditor(false);
      } else if (next === -1 && !noteLocal) {
        // 👎 누른 직후 메모 폼 자동 열기 — 사용자가 한 번 더 클릭하지
        // 않아도 사유를 적을 수 있게.
        setNoteDraft("");
        setShowNoteEditor(true);
      }
    } catch (e) {
      setFeedbackLocal(feedback);
      window.alert(
        `평가 저장 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function commitNote() {
    if (!sessionId || !messageId) return;
    const next = noteDraft.trim() || null;
    try {
      await api.updateMessageMeta(sessionId, messageId, {
        feedback_note: next,
      });
      setNoteLocal(next);
      onMetaChanged?.({ feedback_note: next });
      setShowNoteEditor(false);
    } catch (e) {
      window.alert(
        `메모 저장 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // Sync local body only when the parent's `content` prop actually
  // changes (e.g., after a refetch). Closing the editor used to be
  // in this dep list, which reset body to the *stale* prop value
  // right after a successful save and wiped the optimistic update.
  useEffect(() => {
    setBody(content);
  }, [content]);
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
    editable && !!sessionId && !!messageId && !streaming && !selectionMode && !locked;
  const canMeta = !!sessionId && !!messageId && !locked;

  function startEditing(rewind = false) {
    // Seed the draft from the displayed body so re-opening after a
    // successful save starts from the *new* content, not from the
    // stale `content` prop.
    setDraft(body);
    setRewindMode(rewind);
    setEditing(true);
  }

  async function commitEdit() {
    if (!sessionId || !messageId) return;
    const next = draft.trim();
    if (!next) {
      setEditing(false);
      setRewindMode(false);
      setDraft(body);
      return;
    }
    setSaving(true);
    try {
      if (rewindMode) {
        // 본문 수정 + 이후 메시지 삭제 + 새 텍스트로 재전송.
        if (next !== body) {
          await api.updateMessage(sessionId, messageId, next);
          setBody(next);
          onEdited?.(next);
        }
        await api.rewindSessionAfter(sessionId, messageId);
        window.dispatchEvent(
          new CustomEvent("chat:rewind-resend", {
            detail: { text: next },
          }),
        );
      } else {
        if (next === body) {
          setEditing(false);
          setRewindMode(false);
          setDraft(body);
          return;
        }
        const updated = await api.updateMessage(sessionId, messageId, next);
        setBody(updated.content);
        setCollapsed(false);
        onEdited?.(updated.content);
      }
      setEditing(false);
      setRewindMode(false);
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
    setRewindMode(false);
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
        title={createdAt ? new Date(createdAt).toLocaleString() : undefined}
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
              saveLabel={rewindMode ? "수정 후 재전송" : undefined}
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
                onClick={() => startEditing(false)}
                title="메시지 수정"
              >
                <IconEdit size={11} />
              </button>
            )}
            {sessionId && messageId && !locked && (
              <button
                type="button"
                className="bubble-tiny-btn"
                onClick={() => startEditing(true)}
                title="이 메시지를 수정한 뒤 다시 보내기 (이후 답변은 새로 생성)"
              >
                ✏ 재전송
              </button>
            )}
            {onBranchFrom && !locked && (
              <button
                type="button"
                className="bubble-tiny-btn"
                onClick={() => onBranchFrom()}
                title="이 시점에서 새 세션으로 분기"
              >
                🌿 분기
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
    <div
      className="bubble assistant"
      data-message-id={messageId || undefined}
      title={createdAt ? new Date(createdAt).toLocaleString() : undefined}
    >
      {selectCheckbox}
      <div
        className={`avatar avatar-brand${streaming ? " thinking" : ""}`}
        aria-hidden="true"
      >
        <BrandLogo size={20} />
      </div>
      <div className="body">
        {provider && <div className="bubble-header">{provider}</div>}
        <div className="content" ref={contentRef}>
          {editing ? (
            <MessageEditor
              ref={editRef}
              draft={draft}
              onChange={setDraft}
              onCommit={commitEdit}
              onCancel={cancelEdit}
              saving={saving}
              saveLabel={rewindMode ? "수정 후 재전송" : undefined}
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
        {!streaming && body && !editing && (provider || latencyMs || tokensOut) && (
          <div className="bubble-meta">
            {provider && <span>{provider}</span>}
            {typeof latencyMs === "number" && latencyMs > 0 && (
              <span>· {(latencyMs / 1000).toFixed(1)}s</span>
            )}
            {typeof tokensOut === "number" && tokensOut > 0 && (
              <span>· {tokensOut.toLocaleString()} 토큰</span>
            )}
            {createdAt && (
              <span className="bubble-meta-time">
                · {relativeTime(createdAt)}
              </span>
            )}
          </div>
        )}
        {!streaming && body && !editing && (
          <div className={`bubble-actions${moreOpen ? " pinned" : ""}`}>
            {sessionId && messageId && (
              <>
                <button
                  type="button"
                  className={`bubble-tiny-btn${feedbackLocal === 1 ? " active" : ""}`}
                  onClick={() => setFeedback(1)}
                  disabled={locked}
                  title={locked ? "대화 잠금 중" : feedbackLocal === 1 ? "좋아요 취소" : "좋아요"}
                >
                  <IconThumbsUp size={11} />
                </button>
                <button
                  type="button"
                  className={`bubble-tiny-btn${feedbackLocal === -1 ? " active" : ""}`}
                  onClick={() => setFeedback(-1)}
                  disabled={locked}
                  title={locked ? "대화 잠금 중" : feedbackLocal === -1 ? "싫어요 취소" : "싫어요"}
                >
                  <IconThumbsDown size={11} />
                </button>
                {feedbackLocal !== 0 && (
                  <button
                    type="button"
                    className={`bubble-tiny-btn${noteLocal ? " active" : ""}`}
                    onClick={() => {
                      setNoteDraft(noteLocal ?? "");
                      setShowNoteEditor((v) => !v);
                    }}
                    title={noteLocal ? "메모 보기/수정" : "메모 추가"}
                  >
                    📝
                  </button>
                )}
                <button
                  type="button"
                  className={`bubble-tiny-btn${starredLocal ? " active starred" : ""}`}
                  onClick={toggleStar}
                  disabled={locked}
                  title={locked ? "대화 잠금 중" : starredLocal ? "별표 해제" : "별표"}
                >
                  <IconStar size={11} />
                </button>
                {!locked && (
                  <button
                    type="button"
                    className="bubble-tiny-btn"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("chat:regenerate-last", {}),
                      )
                    }
                    title="같은 질문으로 답변 다시 받기"
                  >
                    🔁
                  </button>
                )}
                <TtsButton text={body} />
                <div className="bubble-more-wrap" ref={moreRef}>
                  <button
                    type="button"
                    className={`bubble-tiny-btn${moreOpen ? " active" : ""}`}
                    onClick={() => setMoreOpen((v) => !v)}
                    title="추가 작업"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                  >
                    ⋯
                  </button>
                  {moreOpen && (
                    <div className="bubble-more-menu" role="menu">
                      {!locked && (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMoreOpen(false);
                              window.dispatchEvent(
                                new CustomEvent("chat:choice-picked", {
                                  detail: { text: "위 답변을 더 짧게 요약해 주세요." },
                                }),
                              );
                            }}
                          >
                            📏 더 짧게
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMoreOpen(false);
                              window.dispatchEvent(
                                new CustomEvent("chat:choice-picked", {
                                  detail: { text: "위 답변을 더 자세히 설명해 주세요." },
                                }),
                              );
                            }}
                          >
                            📏 더 자세히
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMoreOpen(false);
                              const sel =
                                window.getSelection()?.toString().trim() || "";
                              const pick =
                                sel.length > 0 && sel.length < 500
                                  ? sel
                                  : body.slice(0, 200).trim();
                              const quote = pick
                                .split("\n")
                                .map((l) => "> " + l)
                                .join("\n");
                              window.dispatchEvent(
                                new CustomEvent("chat:quote-pick", {
                                  detail: { text: quote + "\n\n" },
                                }),
                              );
                            }}
                          >
                            💬 인용해서 묻기
                          </button>
                          <div className="bubble-more-sep" />
                        </>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMoreOpen(false);
                          if (!sessionId || !messageId) return;
                          const u = new URL(window.location.href);
                          u.search = "";
                          u.searchParams.set("session", sessionId);
                          u.searchParams.set("message", messageId);
                          const link = u.toString();
                          navigator.clipboard
                            .writeText(link)
                            .then(() =>
                              window.dispatchEvent(
                                new CustomEvent("chat:toast", {
                                  detail: { text: "🔗 공유 링크가 복사됐어요" },
                                }),
                              ),
                            )
                            .catch(() =>
                              window.prompt("아래 링크를 복사하세요", link),
                            );
                        }}
                      >
                        🔗 공유 링크 복사
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMoreOpen(false);
                          printSingleMessage(provider, body);
                        }}
                      >
                        🖨 인쇄 / PDF
                      </button>
                      {!locked && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMoreOpen(false);
                            setTagInputOpen(true);
                          }}
                        >
                          🏷 태그 붙이기
                        </button>
                      )}
                      <div className="bubble-more-sep" />
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMoreOpen(false);
                          translateTo("ko");
                        }}
                      >
                        🌐 한국어로 번역
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMoreOpen(false);
                          translateTo("en");
                        }}
                      >
                        🌐 영어로 번역
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
            {canEdit && (
              <button
                type="button"
                className="bubble-tiny-btn"
                onClick={() => startEditing(false)}
                title="요약 수정"
              >
                <IconEdit size={11} /> 수정
              </button>
            )}
            <CopyButton text={body} />
          </div>
        )}
        {translation && (
          <div className="bubble-translation">
            {translation === "loading" ? (
              <div className="bubble-translation-loading">
                번역 중…
              </div>
            ) : (
              <>
                <div className="bubble-translation-head">
                  🌐 {translation.target === "ko" ? "한국어" : translation.target === "en" ? "English" : translation.target} 번역
                  <button
                    type="button"
                    className="bubble-translation-close"
                    onClick={() => setTranslation(null)}
                    aria-label="번역 접기"
                  >
                    ✕
                  </button>
                </div>
                <div className="bubble-translation-body">{translation.text}</div>
              </>
            )}
          </div>
        )}
        {(tagsLocal.length > 0 || tagInputOpen) && !streaming && (
          <div className="bubble-tags">
            {tagsLocal.map((t) => (
              <span key={t} className="bubble-tag">
                #{t}
                {!locked && (
                  <button
                    type="button"
                    className="bubble-tag-remove"
                    onClick={() => removeTag(t)}
                    aria-label="태그 제거"
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {tagInputOpen && !locked && (
              <input
                className="bubble-tag-input"
                placeholder="태그 입력 후 Enter"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  } else if (e.key === "Escape") {
                    setTagDraft("");
                    setTagInputOpen(false);
                  }
                }}
                onBlur={() => {
                  if (!tagDraft.trim()) setTagInputOpen(false);
                }}
                maxLength={24}
                autoFocus
              />
            )}
          </div>
        )}
        {!streaming && body && !editing && !locked && sessionId && messageId && (
          <div className="bubble-quick-wrap">
            <button
              type="button"
              className="bubble-quick-toggle"
              onClick={toggleQuickReplies}
              aria-expanded={quickRepliesOpen}
            >
              {quickRepliesOpen ? "▾ 더 묻기 접기" : "▸ 더 묻기"}
            </button>
            {quickRepliesOpen && (
            <div className="bubble-quick-replies" aria-label="빠른 후속 질문">
            {(
              [
                ["예시 더", "위 답변에 대한 구체적인 예시를 2~3개 더 들어 주세요."],
                ["표로", "위 내용을 표(Markdown) 로 정리해 주세요."],
                ["다른 방법", "위와 다른 접근 방법이 있다면 알려 주세요."],
                ["핵심만", "위 답변의 핵심만 3줄 이내로 요약해 주세요."],
                ["출처는?", "이 답변의 근거나 출처를 알려 주세요."],
                ["다음 단계", "다음으로 무엇을 해야 할지 단계별로 알려 주세요."],
              ] as const
            ).map(([label, prompt]) => (
              <button
                key={label}
                type="button"
                className="bubble-quick-chip"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("chat:choice-picked", {
                      detail: { text: prompt },
                    }),
                  )
                }
                title={prompt}
              >
                {label}
              </button>
            ))}
            </div>
            )}
          </div>
        )}
        {showNoteEditor && sessionId && messageId && (
          <div className="bubble-feedback-note">
            {feedbackLocal === -1 && (
              <div className="bubble-feedback-reasons">
                {[
                  "부정확함",
                  "동문서답",
                  "너무 길다",
                  "너무 짧다",
                  "맥락 무시",
                  "출처 부족",
                ].map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`bubble-reason-chip${noteDraft.includes(r) ? " picked" : ""}`}
                    onClick={() => {
                      setNoteDraft((cur) => {
                        if (cur.includes(r)) {
                          return cur
                            .replace(new RegExp(`${r}[,\\s]*`), "")
                            .trim();
                        }
                        return cur ? `${r}, ${cur}` : r;
                      });
                    }}
                  >
                    {r}
                  </button>
                ))}
              </div>
            )}
            <textarea
              className="bubble-feedback-note-input"
              value={noteDraft}
              maxLength={500}
              rows={2}
              placeholder={
                feedbackLocal === -1
                  ? "어떤 점이 아쉬웠는지 — 위 사유 클릭 또는 자유 메모"
                  : "어떤 점이 좋았는지 / 아쉬웠는지 (선택)"
              }
              onChange={(e) => setNoteDraft(e.target.value)}
              autoFocus
            />
            <div className="bubble-feedback-note-actions">
              <button
                type="button"
                className="bubble-edit-cancel"
                onClick={() => setShowNoteEditor(false)}
              >
                닫기
              </button>
              <button
                type="button"
                className="bubble-edit-save"
                onClick={commitNote}
              >
                저장
              </button>
            </div>
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
    saveLabel?: string;
  }
>(function MessageEditorImpl(
  { draft, onChange, onCommit, onCancel, saving, saveLabel },
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
          {saving ? "저장 중…" : (saveLabel ?? "저장") + " (Ctrl+Enter)"}
        </button>
      </div>
    </div>
  );
});


/** 사람 친화적 상대 시간. 30초 미만 = "방금 전", 그 외는 "N분/시간/일 전". */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 30_000) return "방금 전";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  return new Date(t).toLocaleDateString();
}


/** 🔊 답변 읽어주기 — 브라우저 SpeechSynthesis 그대로 사용. 한국어
 *  음성이 있으면 우선 선택. 다시 누르면 멈춤. 다른 메시지 재생 시
 *  자동 cancel. */
function TtsButton({ text }: { text: string }) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    // 컴포넌트 unmount 시 자동 cancel.
    return () => {
      try { window.speechSynthesis.cancel(); } catch { /* not supported */ }
    };
  }, []);
  if (typeof window === "undefined" || !window.speechSynthesis) return null;

  function speak() {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      u.pitch = 1.0;
      u.lang = /[가-힣]/.test(text) ? "ko-KR" : "en-US";
      // 한국어 음성이 있으면 그걸 우선 사용.
      const voices = window.speechSynthesis.getVoices();
      const ko = voices.find((v) => v.lang.startsWith("ko"));
      if (ko && u.lang.startsWith("ko")) u.voice = ko;
      u.onend = () => setPlaying(false);
      u.onerror = () => setPlaying(false);
      window.speechSynthesis.speak(u);
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  }
  function stop() {
    try { window.speechSynthesis.cancel(); } catch {}
    setPlaying(false);
  }

  return (
    <button
      type="button"
      className={`bubble-tiny-btn${playing ? " active" : ""}`}
      onClick={playing ? stop : speak}
      title={playing ? "읽기 중지" : "답변 읽어주기 🔊"}
    >
      {playing ? "⏹" : "🔊"}
    </button>
  );
}


/** 🖨 한 답변만 인쇄 — 새 창에 print-friendly HTML 띄우고 print()
 *  호출. 사용자가 PDF 로 저장하든 종이로 뽑든 자유. 답변 본문은
 *  textContent 로 안전하게 삽입 (HTML 인젝션 방지). */
function printSingleMessage(provider: string | null | undefined, body: string) {
  const w = window.open("", "_blank", "noopener,noreferrer,width=720,height=900");
  if (!w) {
    window.alert("팝업이 차단됐어요. 브라우저 팝업 허용 후 다시 시도해 주세요.");
    return;
  }
  const safe = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const ts = new Date().toLocaleString();
  w.document.write(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8" />
<title>AI 답변 인쇄</title>
<style>
  body { font-family: 'Noto Sans KR', system-ui, sans-serif;
         padding: 24px; line-height: 1.6; color: #222; max-width: 720px;
         margin: 0 auto; }
  header { border-bottom: 1px solid #ccc; padding-bottom: 8px;
           margin-bottom: 16px; color: #555; font-size: 12px; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: inherit;
        font-size: 14px; }
  @media print { header { color: #888; } }
</style></head><body>
<header>${provider ?? "AI"} · ${ts}</header>
<pre>${safe}</pre>
<script>window.onload = () => setTimeout(() => window.print(), 200);</script>
</body></html>`);
  w.document.close();
}
