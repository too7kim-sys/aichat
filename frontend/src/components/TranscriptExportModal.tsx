import { useEffect, useMemo, useState } from "react";
import { api, type Transcript } from "../api/client";
import { IconAlertTriangle, IconChat, IconCheck, IconX } from "./Icon";

/** Selection modal opened by the 회의록 row's 📄 button. Lists the
 *  linked chat session's messages with a checkbox per row so the
 *  user can hand-pick which ones land in the DOCX. Defaults match
 *  the "전사 숨김, 요약만" common case — every assistant message is
 *  ticked, the raw user transcript starts unticked. Iterating on
 *  the content itself happens in the chat surface (open via the
 *  "채팅에서 수정" button) so this modal stays read-only. */
interface Props {
  transcript: Transcript;
  onClose: () => void;
  /** Opens the underlying chat session so the user can ask the AI
   *  to rewrite / expand the summary before re-opening this modal. */
  onOpenChat: (sessionId: string) => void;
}

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export function TranscriptExportModal({
  transcript,
  onClose,
  onOpenChat,
}: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [maskPii, setMaskPii] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Fetch the linked session's messages. The transcript already
  // confirms session_id non-null before this modal opens.
  useEffect(() => {
    if (!transcript.session_id) {
      setErr("연결된 채팅 세션을 찾을 수 없습니다");
      return;
    }
    setLoading(true);
    setErr(null);
    api
      .getSession(transcript.session_id)
      .then((res) => {
        const ms: Msg[] = (res.messages ?? []).map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content || "",
          created_at: m.created_at,
        }));
        setMsgs(ms);
        // Default: every assistant message ticked, user messages
        // unticked. Matches "전사 숨김" — only the polished summary
        // ends up in the file unless the operator opts back in.
        const initial = new Set<string>();
        for (const m of ms) {
          if (m.role === "assistant") initial.add(m.id);
        }
        setPicked(initial);
      })
      .catch((e) => {
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, [transcript.session_id]);

  const counts = useMemo(() => {
    let a = 0;
    let u = 0;
    for (const m of msgs) {
      if (m.role === "assistant") a += 1;
      else u += 1;
    }
    return { assistant: a, user: u };
  }, [msgs]);

  function toggleAll(role: "assistant" | "user", on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const m of msgs) {
        if (m.role !== role) continue;
        if (on) next.add(m.id);
        else next.delete(m.id);
      }
      return next;
    });
  }

  async function download() {
    if (picked.size === 0) {
      setErr("내려받을 항목을 1개 이상 선택하세요");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Pass the ids in chronological order so the DOCX renders in
      // the same order the user sees in the modal.
      const orderedIds = msgs
        .filter((m) => picked.has(m.id))
        .map((m) => m.id);
      await api.exportTranscriptDocx(transcript.id, transcript.source_filename, {
        messageIds: orderedIds,
        maskPii,
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function preview(text: string): string {
    const cleaned = text
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/```[\s\S]*?```/g, "[코드]")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned.length > 280 ? cleaned.slice(0, 280) + "…" : cleaned;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal tx-export-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pm-head">
          <div className="pm-head-text">
            <h3>회의록 다운로드</h3>
            <p>
              포함할 메시지를 선택하세요. 기본값은 <b>요약만</b>이며,
              원문 전사를 첨부하려면 직접 체크하세요. 내용을 다듬고 싶으면
              채팅에서 먼저 AI에게 수정 요청을 보낸 뒤 다시 여세요.
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

        <div className="tx-export-body">
          {loading ? (
            <div className="pm-help">불러오는 중…</div>
          ) : msgs.length === 0 ? (
            <div className="pm-help">메시지가 없습니다.</div>
          ) : (
            <>
              <div className="tx-export-tools">
                <div className="tx-export-counts">
                  <span>
                    선택됨 <b>{picked.size}</b> / {msgs.length}
                  </span>
                </div>
                <div className="tx-export-tool-actions">
                  <button
                    type="button"
                    className="pm-btn-secondary"
                    onClick={() => toggleAll("assistant", true)}
                    disabled={busy}
                  >
                    요약 전체 선택 ({counts.assistant})
                  </button>
                  <button
                    type="button"
                    className="pm-btn-secondary"
                    onClick={() => toggleAll("user", true)}
                    disabled={busy || counts.user === 0}
                    title="원문 전사 + 추가 메모를 포함"
                  >
                    전사 포함 ({counts.user})
                  </button>
                  <button
                    type="button"
                    className="pm-btn-secondary"
                    onClick={() => setPicked(new Set())}
                    disabled={busy}
                  >
                    모두 해제
                  </button>
                </div>
              </div>

              <ul className="tx-export-list">
                {msgs.map((m, idx) => {
                  const checked = picked.has(m.id);
                  return (
                    <li
                      key={m.id}
                      className={`tx-export-row role-${m.role}${
                        checked ? " checked" : ""
                      }`}
                    >
                      <label className="tx-export-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setPicked((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(m.id);
                              else next.delete(m.id);
                              return next;
                            })
                          }
                          disabled={busy}
                        />
                      </label>
                      <div className="tx-export-meta">
                        <span className={`tx-export-role role-${m.role}`}>
                          {m.role === "assistant"
                            ? `요약 ${idx + 1}`
                            : idx === 0
                            ? "원문 전사"
                            : `메모 ${idx}`}
                        </span>
                        <span className="tx-export-time">
                          {new Date(m.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="tx-export-text">{preview(m.content)}</div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {err && (
            <div className="pm-add-error">
              <IconAlertTriangle size={14} />
              <span>{err}</span>
            </div>
          )}

          <div className="cp-edit-actions">
            <button
              type="button"
              className="pm-btn-secondary"
              onClick={() =>
                transcript.session_id && onOpenChat(transcript.session_id)
              }
              disabled={busy || !transcript.session_id}
              title="채팅에서 AI에게 내용 수정 요청 후 다시 열기"
            >
              <IconChat size={13} /> 채팅에서 수정
            </button>
            <div className="cp-edit-actions-right">
              <label
                className="export-menu-toggle"
                style={{ marginRight: 8 }}
                title="주민번호 · 전화 · 이메일 · 카드 · 여권번호 자동 마스킹"
              >
                <input
                  type="checkbox"
                  checked={maskPii}
                  onChange={(e) => setMaskPii(e.target.checked)}
                  disabled={busy}
                />
                <span>개인정보 마스킹</span>
              </label>
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
                onClick={download}
                disabled={busy || picked.size === 0}
              >
                <IconCheck size={13} />{" "}
                {busy ? "생성 중…" : "한글 파일 다운로드"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
