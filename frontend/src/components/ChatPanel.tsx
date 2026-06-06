import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { ProviderInfo, SessionDetail } from "../types";
import {
  IconCode,
  IconDownload,
  IconFolder,
  IconPaperclip,
  IconSearch,
  IconSend,
  IconSparkles,
  IconX,
} from "./Icon";
import { ExportDocumentDialog } from "../export/ExportDocumentDialog";
import type { LocalAttachment } from "../export/MergeAttachmentsDialog";
import { MessageBubble } from "./MessageBubble";
import { WorkspaceChangesPanel } from "./WorkspaceChangesPanel";
import { WorkspaceTree } from "./WorkspaceTree";
import { useArtifacts } from "../artifact/ArtifactContext";
import { ChatWorkspaceProvider } from "../state/ChatWorkspaceContext";
import { useModels } from "../state/ModelContext";
import { drainAttachments } from "../state/attachQueue";
import { streamStore, useLiveStream } from "../state/streamStore";

interface Props {
  sessionId: string;
  providers: ProviderInfo[];
  onTitleSync?: () => void;
  /** When non-null, ChatPanel scrolls the matching message into view
   *  and briefly highlights it — used by the global search dialog
   *  after the parent flipped activeId. Cleared via onScrollHandled
   *  once the effect ran so a re-render doesn't re-trigger. */
  scrollToMessageId?: string | null;
  onScrollHandled?: () => void;
  /** Open the global chat search modal. Owned by App. */
  onOpenSearch?: () => void;
}

export interface ChatPanelHandle {
  appendToPrompt: (text: string) => void;
  addAttachmentFromText: (filename: string, text: string) => void;
}

/** Concise type label rendered below the filename in the attachment
 *  chip. Mirrors Claude's compact "PDF / Word / Image" style instead
 *  of the verbose "ocr · 12,345자" we used to show. */
function attachmentTypeLabel(filename: string, isImage: boolean): string {
  if (isImage) return "이미지";
  const lower = filename.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  const map: Record<string, string> = {
    pdf: "PDF",
    docx: "Word",
    doc: "Word",
    xlsx: "Excel",
    xls: "Excel",
    pptx: "PowerPoint",
    ppt: "PowerPoint",
    hwpx: "한글",
    hwp: "한글",
    md: "Markdown",
    markdown: "Markdown",
    txt: "텍스트",
    log: "로그",
    csv: "CSV",
    tsv: "TSV",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    xml: "XML",
    html: "HTML",
    htm: "HTML",
    py: "Python",
    js: "JavaScript",
    ts: "TypeScript",
    tsx: "TSX",
    jsx: "JSX",
    java: "Java",
    kt: "Kotlin",
    rs: "Rust",
    go: "Go",
    c: "C",
    cpp: "C++",
    h: "C 헤더",
    hpp: "C++ 헤더",
    cs: "C#",
    rb: "Ruby",
    php: "PHP",
    sh: "Shell",
    sql: "SQL",
    css: "CSS",
    scss: "SCSS",
    toml: "TOML",
    ini: "INI",
    cfg: "Config",
    env: "환경 변수",
  };
  return map[ext] || (ext ? ext.toUpperCase() : "파일");
}

/** Icon prefix for non-image attachments. Image chips show the
 *  thumbnail instead. Stays inside the existing emoji vocabulary the
 *  rest of the composer uses (📎 / 🔗). */
function attachmentIcon(filename: string): string {
  const lower = filename.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  if (["pdf"].includes(ext)) return "📕";
  if (["docx", "doc"].includes(ext)) return "📘";
  if (["xlsx", "xls", "csv", "tsv"].includes(ext)) return "📗";
  if (["pptx", "ppt"].includes(ext)) return "📙";
  if (["hwpx", "hwp"].includes(ext)) return "📜";
  if (
    [
      "py", "js", "ts", "tsx", "jsx", "java", "kt", "rs", "go",
      "c", "cpp", "h", "hpp", "cs", "rb", "php", "sh", "sql",
      "css", "scss", "html", "htm", "xml", "json", "yaml", "yml",
      "toml", "ini", "cfg", "env",
    ].includes(ext)
  ) return "📄";
  return "📄";
}

/** Drop the leading workspace/project prefix from a path so the chip
 *  shows the actual file basename. Workspace files come in as
 *  "<workspace>/path/to/file.py"; clipboard pastes as
 *  "clipboard-2026-06-06.png" (no path). */
function attachmentBasename(filename: string): string {
  const slash = filename.lastIndexOf("/");
  return slash >= 0 ? filename.slice(slash + 1) : filename;
}

/** Parse a merge slash-command from the composer prompt.
 *
 * Accepted forms (case-insensitive on the keywords):
 *   /merge                /병합                 → no title (uses default)
 *   /merge 회의자료       /병합 회의자료        → title = "회의자료"
 *   합쳐줘 / 합쳐 / 합치기 / 병합 / 병합해줘     → no title
 *   회의자료로 병합        회의자료 합치기        → title = "회의자료"
 *   merge / combine                              → no title (EN aliases)
 *
 * Returns `{ matched: false }` for anything else so the normal LLM
 * flow runs. The match is strict — the whole prompt must be the
 * command, otherwise "병합 보고서를 요약해줘" type prompts would be
 * intercepted by accident.
 */
function parseMergeCommand(raw: string): { matched: boolean; title?: string } {
  const text = raw.trim();
  if (!text) return { matched: false };
  const slash = /^\/(?:merge|병합)(?:\s+(.+))?$/i.exec(text);
  if (slash) return { matched: true, title: slash[1]?.trim() };
  if (/^(?:병합(?:해줘|해)?|합쳐(?:줘)?|합치기|merge|combine)$/i.test(text)) {
    return { matched: true };
  }
  const suffix = /^(.+?)\s*(?:로|을|를)?\s*(?:병합(?:해줘|해)?|합쳐(?:줘)?|합치기)$/.exec(text);
  if (suffix) return { matched: true, title: suffix[1]?.trim() };
  return { matched: false };
}

export const ChatPanel = forwardRef<ChatPanelHandle, Props>(function ChatPanel(
  {
    sessionId,
    providers,
    onTitleSync,
    scrollToMessageId,
    onScrollHandled,
    onOpenSearch,
  },
  ref
) {
  const { user } = useAuth();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [prompt, setPrompt] = useState("");
  const [activeProvider, setActiveProvider] = useState<string>("");
  const [webSearch, setWebSearch] = useState(false);
  // _file holds the original browser File when we have it (direct
  // upload path) so the merge endpoint can re-receive the binary.
  // It's missing for attachments that came in pre-extracted via the
  // attach-queue or paste — those can't be format-preserving merged.
  // Never serialized: send() and the chat-stream payload always
  // strip down to the ExtractedFile fields.
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  // Workspace file tree panel — only meaningful for code-focused
  // (= workspace-linked) sessions. Persisted per session so the
  // user's open/closed preference survives reloads.
  const treePrefKey = `chat:session:${sessionId}:tree`;
  const [showWorkspaceTree, _setShowWorkspaceTree] = useState<boolean>(
    () => localStorage.getItem(treePrefKey) !== "0",
  );
  function setShowWorkspaceTree(v: boolean) {
    _setShowWorkspaceTree(v);
    localStorage.setItem(treePrefKey, v ? "1" : "0");
  }
  async function handleWorkspaceFileSelect(path: string) {
    if (!session?.workspace_id) return;
    const ws_id = session.workspace_id;
    const ws_title = session.title;
    try {
      const file = await api.workspaceFile(ws_id, path);
      setAttachments((prev) => [
        ...prev,
        {
          filename: `${ws_title}/${path}`,
          text: file.text,
          char_count: file.text.length,
          method: "workspace",
        },
      ]);
    } catch (e) {
      window.alert(
        `파일 첨부 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // Bumped by the markdown renderer every time the user applies a
  // `# file: <path>` patch, so the changes panel re-polls git status
  // without a full remount.
  const [changesRefreshKey, setChangesRefreshKey] = useState(0);
  // Document export — when selectionMode is on, each message bubble
  // renders a checkbox. The user picks the answers they want bundled
  // into one document and clicks "문서로" to open the dialog.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(
    new Set(),
  );
  const [exportOpen, setExportOpen] = useState(false);
  // Inline status for the `/병합` slash-command path — short banner
  // above the composer reporting merge progress / success / failure.
  // The legacy modal entry point was removed; the slash command is
  // now the only way to invoke merge from the chat surface.
  const [mergeStatus, setMergeStatus] = useState<string | null>(null);
  const toggleMessageSelection = (id: string) =>
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }
  const [elapsedSec, setElapsedSec] = useState(0);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const artifactsState = useArtifacts();
  const { selected: model } = useModels();
  // Model picker UI is hidden — auto routing handles selection.
  // ModelContext defaults `model` to "auto" so the backend's
  // _choose_model is exercised by default.

  // Per-session RAG project link. Persisted in localStorage so reloads
  // survive; the Cowork sidebar's project modal writes the same key and
  // dispatches a "chat:project-linked" custom event so we can mirror
  // the change without remounting.
  const projectStorageKey = `chat:session:${sessionId}:project`;
  const [linkedProjectId, setLinkedProjectId] = useState<string | null>(
    () => localStorage.getItem(projectStorageKey),
  );
  useEffect(() => {
    function onLinked(e: Event) {
      const ev = e as CustomEvent<{ sessionId: string; projectId: string | null }>;
      if (ev.detail?.sessionId === sessionId) {
        setLinkedProjectId(ev.detail.projectId);
      }
    }
    window.addEventListener("chat:project-linked", onLinked);
    return () => window.removeEventListener("chat:project-linked", onLinked);
  }, [sessionId]);

  // The Code workspace modal queues "attach this file" intents via
  // attachQueue + a chat:attach-file CustomEvent. We drain the queue
  // on every event AND on mount, so:
  //   - if this panel is already mounted when the user clicks attach,
  //     the event handler picks up the item; the queue is then empty.
  //   - if no chat existed yet (queueAttachment + a new session being
  //     created), the listener on the freshly mounted ChatPanel
  //     runs the mount-time drain and catches the item that arrived
  //     before it was listening.
  useEffect(() => {
    function ingest() {
      const items = drainAttachments();
      if (items.length === 0) return;
      setAttachments((prev) => [
        ...prev,
        ...items.map((p) => ({
          filename: p.filename,
          text: p.text,
          char_count: p.text.length,
          method: "workspace",
        })),
      ]);
    }
    // Drain anything that arrived before mount.
    ingest();
    window.addEventListener("chat:attach-file", ingest);
    return () => window.removeEventListener("chat:attach-file", ingest);
  }, []);

  // Subscribe to the (possibly in-flight) stream for this session.
  const liveStream = useLiveStream(sessionId);
  const streaming = !!liveStream && !liveStream.done;
  const liveAssistant = liveStream?.buffer ?? null;
  const livePrompt = liveStream?.prompt ?? null;
  const liveSources = liveStream?.sources ?? null;
  const liveSearchWarning = liveStream?.searchWarning ?? null;

  // Close dropdown on outside click.
  useImperativeHandle(ref, () => ({
    appendToPrompt(text: string) {
      setPrompt((prev) => (prev ? prev + text : text));
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    },
    addAttachmentFromText(filename: string, text: string) {
      setAttachments((prev) => [
        ...prev,
        { filename, text, char_count: text.length, method: "project" },
      ]);
    },
  }));

  // Elapsed-time ticker — anchored to the live stream's startedAt so it
  // keeps counting even when the user navigated away and came back.
  useEffect(() => {
    if (!liveStream || liveStream.done) {
      setElapsedSec(0);
      return;
    }
    const startedAt = liveStream.startedAt;
    const tick = () => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [liveStream]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [prompt]);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setLoadError(null);
    setAttachments([]);
    api
      .getSession(sessionId)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setLoadError(msg);
        console.error("getSession failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, loadAttempt]);

  // When a stream for this session finishes, refetch so the persisted
  // assistant message replaces the live overlay.
  useEffect(() => {
    if (!liveStream || !liveStream.done) return;
    let cancelled = false;
    api
      .getSession(sessionId)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch(() => {});
    onTitleSync?.();
    if (liveStream.errors.length) {
      alert(`응답 실패:\n\n${liveStream.errors.join("\n")}`);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveStream?.done, sessionId]);

  useEffect(() => {
    const enabled = providers.filter((p) => p.enabled);
    if (!activeProvider && enabled.length) setActiveProvider(enabled[0].name);
  }, [providers, activeProvider]);

  // Auto-scroll only when the user is already pinned to the bottom.
  // If they've manually scrolled up to re-read the answer or browse the
  // sources, incoming tokens shouldn't yank them back down.
  const stickToBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  function onMessagesScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    const atBottom = distance < 80;
    stickToBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
  }

  function jumpToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    // 'auto' instead of 'smooth' so rapid token updates don't queue
    // animations and stutter.
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, [session, liveAssistant, liveSources]);

  // Search-result scroll target — the global SearchDialog hands us a
  // message id after navigating, and we scroll that bubble into view
  // with a brief flash highlight. We wait for the session payload to
  // contain the message before acting; on a cross-session jump the
  // bubble doesn't exist yet on the first effect run.
  useEffect(() => {
    if (!scrollToMessageId) return;
    if (!session) return;
    const present = session.messages.some((m) => m.id === scrollToMessageId);
    if (!present) return;
    const root = scrollRef.current;
    if (!root) return;
    // Two RAFs so the bubble has actually been painted before we
    // measure its position. Without this the scrollIntoView lands
    // near the top of the chat instead of on the target.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const node = root.querySelector<HTMLElement>(
          `[data-message-id="${scrollToMessageId}"]`,
        );
        if (!node) {
          onScrollHandled?.();
          return;
        }
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.classList.add("search-flash");
        // Disable auto-stick-to-bottom for this turn so incoming
        // streams don't yank the highlighted message out of view.
        stickToBottomRef.current = false;
        setShowJumpToLatest(true);
        window.setTimeout(() => {
          node.classList.remove("search-flash");
        }, 1800);
        onScrollHandled?.();
      });
    });
  }, [scrollToMessageId, session, onScrollHandled]);

  // On session change, snap back to the bottom (new conversation starts
  // pinned) so the latest message is visible.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [sessionId]);

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setUploadProgress({ done: 0, total: files.length });
    const failures: string[] = [];
    const additions: LocalAttachment[] = [];
    let done = 0;

    // Pool of N workers pulling from the queue so a 50-file project
    // doesn't take 50 sequential round trips.
    const queue = [...files];
    const concurrency = 6;
    async function worker() {
      while (queue.length) {
        const f = queue.shift();
        if (!f) break;
        try {
          const ext = await api.extractFile(f);
          const rel = (f as File & { webkitRelativePath?: string })
            .webkitRelativePath;
          if (rel) ext.filename = rel;
          // Stash the original File so the same bytes can be
          // re-uploaded for format-preserving merge.
          additions.push({ ...ext, _file: f });
        } catch (e) {
          failures.push(
            `${f.name}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
        done += 1;
        setUploadProgress({ done, total: files.length });
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, files.length) }, worker)
    );

    setAttachments((prev) => [...prev, ...additions]);
    setUploading(false);
    setUploadProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (failures.length) {
      const shown = failures.slice(0, 8).join("\n");
      const more = failures.length > 8 ? `\n…외 ${failures.length - 8}개` : "";
      alert(`첨부 실패:\n\n${shown}${more}`);
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    await uploadFiles(Array.from(files));
  }

  // Drag-over highlight + clipboard-paste / drag-drop image intake.
  // The composer accepts any file the backend's /api/files/extract can
  // chew (image, PDF, DOCX, plain text). On mobile, paste of a clipboard
  // image (screenshot, copied photo) lands here too — Safari/Chrome ship
  // images as File entries on the paste event.
  const [dragOver, setDragOver] = useState(false);

  async function handleClipboardPaste(
    e: React.ClipboardEvent<HTMLTextAreaElement>,
  ) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file") {
        const raw = it.getAsFile();
        if (!raw) continue;
        // Clipboard images often arrive as just "image.png" or with no
        // name at all on some browsers. Rename to a timestamped form so
        // the backend's extension routing always picks them up and the
        // user can tell pastes apart in the attachments list.
        if (raw.type.startsWith("image/")) {
          const ext = raw.type.split("/")[1]?.split("+")[0] || "png";
          const ts = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .replace("T", "_")
            .slice(0, 19);
          files.push(
            new File([raw], `clipboard-${ts}.${ext}`, { type: raw.type }),
          );
        } else {
          files.push(raw);
        }
      }
    }
    if (files.length > 0) {
      e.preventDefault(); // don't paste filename text into the textarea
      await uploadFiles(files);
    }
  }

  function onComposerDragOver(e: React.DragEvent) {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      setDragOver(true);
    }
  }
  function onComposerDragLeave(e: React.DragEvent) {
    // Only clear when leaving the wrap entirely — child enter/leave
    // events fire constantly otherwise.
    if (e.currentTarget === e.target) setDragOver(false);
  }
  async function onComposerDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length > 0) await uploadFiles(dropped);
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  function startEditTitle() {
    if (!session) return;
    setTitleDraft(session.title);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }

  async function commitTitle() {
    if (!session) return;
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!next || next === session.title) return;
    try {
      const updated = await api.updateSession(session.id, next);
      setSession({ ...session, title: updated.title });
      onTitleSync?.();
    } catch (e) {
      alert(`제목 변경 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function cancelEditTitle() {
    setEditingTitle(false);
    setTitleDraft("");
  }

  // Show the live stream right away (without waiting for the session fetch)
  // so a chat switch back to an in-flight conversation doesn't appear to
  // interrupt the response.
  if (!session) {
    return (
      <div className="chat-panel">
        {liveStream ? (
          <>
            <header className="chat-header">
              <div className="chat-header-inner">
                <h2 className="chat-title">대화 불러오는 중...</h2>
              </div>
            </header>
            <div className="messages">
              <div className="messages-inner">
                <MessageBubble
                  role="user"
                  content={liveStream.prompt}
                  attachments={liveStream.attachments}
                />
                <MessageBubble
                  role="assistant"
                  provider="Ollama"
                  content={liveStream.buffer || "응답 생성 중..."}
                  streaming
                />
              </div>
            </div>
          </>
        ) : (
          <div className="chat-loading">
            {loadError ? (
              <>
                <p>대화를 불러오지 못했습니다.</p>
                <p className="chat-loading-detail">{loadError}</p>
                <button
                  className="primary"
                  onClick={() => setLoadAttempt((n) => n + 1)}
                >
                  다시 시도
                </button>
              </>
            ) : (
              <p>불러오는 중...</p>
            )}
          </div>
        )}
      </div>
    );
  }
  const enabledProviders = providers.filter((p) => p.enabled);
  const defaultLabel =
    enabledProviders.find((p) => p.name === activeProvider)?.label ?? "";
  // While the model picker is set to "auto" we don't know which Ollama
  // model the server will choose until the SSE `model` event lands.
  // Show the actual pick (with the routing reason) once known, and a
  // placeholder while we wait.
  const picked = liveStream?.pickedModel ?? null;
  const activeProviderLabel = (() => {
    if (model === "auto") {
      if (picked) return `Ollama (${picked.name}) · 🤖 ${picked.reason}`;
      return "Ollama · 🤖 자동 선택 중…";
    }
    return model ? `Ollama (${model})` : defaultLabel;
  })();

  function send() {
    if (!prompt.trim() || streaming || !activeProvider) return;
    const text = prompt;

    // Composer slash command: `/merge`, `/병합`, "합쳐줘", "[제목]로 병합".
    // Detected here so the user can stay in the textarea instead of
    // reaching for the 🔗 button — the LLM call is skipped entirely
    // when a merge command is recognised. The raw text is preserved
    // so the persisted user message reflects what they typed.
    const merge = parseMergeCommand(text);
    if (merge.matched) {
      void runInlineMerge(merge.title, text);
      return;
    }

    setPrompt("");
    setMergeStatus(null);
    const sentAttachments = attachments;
    setAttachments([]);
    streamStore.start({
      sessionId,
      prompt: text,
      provider: activeProvider,
      model: model || undefined,
      webSearch,
      attachments: sentAttachments.map((a) => ({
        filename: a.filename,
        text: a.text,
        image_b64: a.image_b64 ?? null,
      })),
      projectId: linkedProjectId,
    });
  }

  async function runInlineMerge(
    titleOverride?: string,
    userPromptRaw?: string,
  ) {
    const MERGEABLE = /\.(pdf|docx|xlsx|pptx|hwpx)$/i;
    const mergeable = attachments.filter(
      (a) => MERGEABLE.test(a.filename) && !!a._file,
    );
    if (mergeable.length < 2) {
      setMergeStatus(
        `병합하려면 같은 형식 원본 파일(.pdf/.docx/.xlsx/.pptx/.hwpx)이 ` +
          `2개 이상 필요합니다. 지금 ${mergeable.length}개. ` +
          `(원본이 보존된 직접 업로드 파일만 가능합니다.)`,
      );
      return;
    }
    // Group by extension and pick the largest same-format batch — so
    // "PDF 2개 + DOCX 1개"가 섞여 있어도 PDF 쪽만 자동으로 골라 병합.
    const byExt = new Map<string, typeof mergeable>();
    for (const a of mergeable) {
      const m = a.filename.toLowerCase().match(MERGEABLE);
      const ext = m ? m[0] : "";
      if (!byExt.has(ext)) byExt.set(ext, []);
      byExt.get(ext)!.push(a);
    }
    let majority: typeof mergeable = [];
    for (const group of byExt.values()) {
      if (group.length > majority.length) majority = group;
    }
    if (majority.length < 2) {
      setMergeStatus(
        "같은 형식의 원본 파일이 2개 이상 필요합니다 (현재는 형식이 모두 달라요).",
      );
      return;
    }

    // Default filename is timestamp-based — independent of the
    // session title so chats whose title happens to be "오타 찾아줘"
    // or any other prompt-derived string don't end up in the merge
    // output's name.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const baseTitle = titleOverride?.trim() || `병합문서-${stamp}`;
    setMergeStatus(`병합 중… (${majority.length}개)`);
    const userPrompt = (userPromptRaw ?? "").trim() || "/병합";
    try {
      const { blob, filename } = await api.mergeFiles({
        files: majority.map((a) => a._file as File),
        title: baseTitle,
        withSeparators: true,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMergeStatus(
        `✅ 다운로드 완료 — ${filename} (${Math.round(blob.size / 1024)} KB, ${majority.length}개 합침)`,
      );
      setPrompt("");
      // Persist a chat record of the merge — user's slash command
      // + an assistant-style confirmation chip. The download blob
      // itself isn't stored; this is purely for the visible log.
      try {
        const newMessages = await api.logMerge(sessionId, {
          user_prompt: userPrompt,
          source_filenames: majority.map((m) => m.filename),
          result_filename: filename,
          result_size: blob.size,
        });
        setSession((prev) =>
          prev
            ? {
                ...prev,
                messages: [
                  ...prev.messages,
                  ...newMessages.map((m) => ({ ...m, provider: m.provider })),
                ],
              }
            : prev,
        );
      } catch {
        // Logging is best-effort — the user already has their file.
      }
    } catch (e) {
      setMergeStatus(
        `병합 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }


  function formatElapsed(s: number): string {
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, "0");
    return `${m}:${ss}`;
  }

  return (
    <div className="chat-panel">
      <header className="chat-header">
        <div className="chat-header-inner">
        <div className="chat-header-left">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className="title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTitle();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEditTitle();
                }
              }}
              maxLength={200}
            />
          ) : (
            <h2
              className="chat-title"
              onClick={startEditTitle}
              title="클릭하여 제목 수정"
            >
              {session.title}
            </h2>
          )}
          {session.code_focused && (
            <span
              className="chat-code-badge"
              title="이 세션은 코드 작업에 특화돼 있습니다. 워크스페이스 파일이 매 턴 자동 첨부됩니다."
            >
              <IconCode size={11} /> 코드 모드
            </span>
          )}
        </div>
        <div className="chat-header-right">
          {onOpenSearch && (
            <button
              type="button"
              className="panel-toggle"
              onClick={onOpenSearch}
              title="모든 채팅에서 검색 (Ctrl+K)"
            >
              🔍 검색
            </button>
          )}
          <button
            type="button"
            className={`panel-toggle${selectionMode ? " active" : ""}`}
            onClick={() => {
              if (selectionMode) exitSelectionMode();
              else setSelectionMode(true);
            }}
            title={
              selectionMode
                ? "선택 모드 종료"
                : "메시지를 골라 한 문서로 내보내기"
            }
          >
            📄 {selectionMode ? "선택 종료" : "문서 만들기"}
          </button>
          {session.workspace_id && (
            <button
              type="button"
              className="panel-toggle"
              onClick={() => setShowWorkspaceTree(!showWorkspaceTree)}
              title={showWorkspaceTree ? "파일 트리 숨기기" : "파일 트리 보기"}
            >
              <IconFolder size={14} />{" "}
              {showWorkspaceTree ? "트리 닫기" : "파일 트리"}
            </button>
          )}
          {artifactsState.artifacts.length > 0 && (
            <button
              type="button"
              className="panel-toggle"
              onClick={() => artifactsState.setOpen(!artifactsState.open)}
              title="코드 사이드 패널 토글"
            >
              {artifactsState.open ? "패널 닫기" : `패널 열기 (${artifactsState.artifacts.length})`}
            </button>
          )}
        </div>
        </div>
      </header>

      <ChatWorkspaceProvider
        workspaceId={session.workspace_id ?? null}
        onPatchApplied={() => setChangesRefreshKey((k) => k + 1)}
      >
      <div className="chat-body">
        {session.workspace_id && showWorkspaceTree && (
          <aside className="chat-tree-side">
            <div className="chat-tree-head">
              <span className="chat-tree-title">
                <IconFolder size={13} /> {session.title}
              </span>
              <button
                type="button"
                className="chat-tree-close"
                onClick={() => setShowWorkspaceTree(false)}
                title="트리 닫기"
                aria-label="트리 닫기"
              >
                <IconX size={13} />
              </button>
            </div>
            <div className="chat-tree-hint">
              파일을 클릭하면 다음 메시지에 첨부됩니다.
            </div>
            <div className="chat-tree-scroll">
              <WorkspaceTree
                workspaceId={session.workspace_id}
                onSelectFile={handleWorkspaceFileSelect}
                refreshKey={changesRefreshKey}
              />
            </div>
            <WorkspaceChangesPanel
              workspaceId={session.workspace_id}
              refreshKey={changesRefreshKey}
            />
          </aside>
        )}
        <div className="chat-main">
      <div className="messages" ref={scrollRef} onScroll={onMessagesScroll}>
        <div className="messages-inner">
          {session.messages.length === 0 && !streaming && (
            <EmptyGreeting userName={user?.name ?? null} />
          )}
          {(() => {
            let turn = 0;
            return session.messages.map((m) => {
              if (m.role === "user") turn += 1;
              return (
                <MessageBubble
                  key={m.id}
                  messageId={m.id}
                  role={m.role}
                  provider={m.provider}
                  content={m.content}
                  attachments={m.attachments_summary ?? null}
                  artifactTitlePrefix={m.role === "assistant" ? `턴 ${turn}` : undefined}
                  selectionMode={selectionMode}
                  selected={selectedMessageIds.has(m.id)}
                  onToggleSelect={() => toggleMessageSelection(m.id)}
                />
              );
            });
          })()}
          {/* Live user + assistant bubbles only while the stream is
              still running; once it's done the persisted version is in
              session.messages and we'd duplicate it. The sources box
              below stays visible regardless of done state. */}
          {streaming && livePrompt && (
            <MessageBubble
              role="user"
              content={livePrompt}
              attachments={liveStream?.attachments ?? null}
            />
          )}
          {streaming && liveAssistant !== null && liveAssistant === "" ? (
            <div className="bubble assistant">
              <div className="avatar">A</div>
              <div className="body">
                <div className="bubble-header">{activeProviderLabel}</div>
                <div className="content thinking">
                  <span className="spinner" />
                  응답 생성 중... {formatElapsed(elapsedSec)}
                </div>
              </div>
            </div>
          ) : (
            streaming && liveAssistant !== null && (
              <MessageBubble
                role="assistant"
                provider={`${activeProviderLabel} · ${formatElapsed(elapsedSec)}`}
                content={liveAssistant}
                streaming
              />
            )
          )}
          {liveSources && (
            <SourcesBox
              sources={liveSources}
              warning={liveSearchWarning}
              streaming={streaming}
            />
          )}
          {liveStream?.ragChunks && liveStream.ragChunks.length > 0 && (
            <RagChunksBox
              chunks={liveStream.ragChunks}
              streaming={streaming}
            />
          )}
        </div>
      </div>
      {selectionMode && (
        <div className="export-action-bar">
          <span className="export-action-count">
            {selectedMessageIds.size}개 선택됨
          </span>
          <button
            type="button"
            className="export-action-clear"
            onClick={() => setSelectedMessageIds(new Set())}
            disabled={selectedMessageIds.size === 0}
          >
            선택 해제
          </button>
          <button
            type="button"
            className="export-action-go"
            onClick={() => setExportOpen(true)}
            disabled={selectedMessageIds.size === 0}
          >
            📄 문서로 만들기
          </button>
        </div>
      )}
      {showJumpToLatest && (
        <button
          type="button"
          className="jump-to-latest"
          onClick={jumpToLatest}
          title="최신 응답으로 이동"
        >
          ⬇ 최신 응답으로
        </button>
      )}

      <div
        className={`composer-wrap${dragOver ? " drag-over" : ""}`}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
      >
        {dragOver && (
          <div className="composer-drop-hint">
            <IconDownload size={20} />
            <span>여기에 놓으세요</span>
          </div>
        )}
        <div className="composer">
          {(attachments.length > 0 || uploading) && (
            <div className="attachments">
              {attachments.length > 0 && (
                <div className="attachments-summary">
                  <span>
                    📎 {attachments.length}개 첨부 · 총{" "}
                    {attachments
                      .reduce((acc, a) => acc + a.char_count, 0)
                      .toLocaleString()}
                    자
                  </span>
                  <button
                    type="button"
                    className="attachments-clear"
                    onClick={() => setAttachments([])}
                    disabled={streaming}
                  >
                    모두 제거
                  </button>
                </div>
              )}
              <div className="attachment-chips">
                {attachments.map((a, i) => {
                  const isImage = !!a.image_b64;
                  const guessMime = a.filename.toLowerCase().endsWith(".png")
                    ? "image/png"
                    : a.filename.toLowerCase().endsWith(".webp")
                    ? "image/webp"
                    : a.filename.toLowerCase().endsWith(".gif")
                    ? "image/gif"
                    : "image/jpeg";
                  const basename = attachmentBasename(a.filename);
                  const typeLabel = attachmentTypeLabel(a.filename, isImage);
                  // Full path + extraction stats land on the tooltip
                  // so the chip stays one glanceable line per file
                  // while power users can still hover for detail.
                  const tooltip =
                    a.filename +
                    (a.method ? `\n${a.method}` : "") +
                    (a.char_count
                      ? ` · ${a.char_count.toLocaleString()}자`
                      : "");
                  return (
                    <div
                      key={i}
                      className={`attachment-chip${isImage ? " image" : ""}`}
                      title={tooltip}
                    >
                      {isImage ? (
                        <img
                          className="attachment-thumb"
                          src={`data:${guessMime};base64,${a.image_b64}`}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <span className="attachment-icon" aria-hidden="true">
                          {attachmentIcon(a.filename)}
                        </span>
                      )}
                      <span className="attachment-info">
                        <span className="attachment-name">{basename}</span>
                        <span className="attachment-type">{typeLabel}</span>
                      </span>
                      <button
                        type="button"
                        className="attachment-remove"
                        onClick={() => removeAttachment(i)}
                        disabled={streaming}
                        aria-label="제거"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                {uploading && (
                  <div className="attachment-chip uploading">
                    업로드 중
                    {uploadProgress &&
                      ` ${uploadProgress.done}/${uploadProgress.total}`}
                    ...
                  </div>
                )}
              </div>
            </div>
          )}
          {attachments.length > 0 && webSearch && (
            <div className="composer-notice">
              <span>
                <IconSparkles size={14} /> 첨부 파일 분석 시 웹검색은 보통 모델을 산만하게 만들어요.
              </span>
              <button
                type="button"
                className="composer-notice-action"
                onClick={() => setWebSearch(false)}
                disabled={streaming}
              >
                웹검색 끄기
              </button>
            </div>
          )}
          {mergeStatus && (
            <div className="composer-notice">
              <span>{mergeStatus}</span>
              <button
                type="button"
                className="composer-notice-action"
                onClick={() => setMergeStatus(null)}
              >
                닫기
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={prompt}
            placeholder={
              attachments.length > 0
                ? "예) 요약해줘 · 오타 찾아줘 · 핵심만 알려줘 · 표로 정리해줘 · /병합 [제목] 으로 한 파일 합치기"
                : "무엇이든 물어보세요. 이미지를 붙여넣거나(Ctrl+V) 끌어다 놓아 분석·요약·번역도 가능합니다."
            }
            onChange={(e) => setPrompt(e.target.value)}
            onPaste={handleClipboardPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={streaming}
            rows={1}
          />
          <div className="composer-actions">
            <div className="composer-left">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.gif,.bmp,.tif,.tiff,.webp,.html,.xml,.py,.js,.ts,.tsx,.jsx,.java,.go,.rs,.c,.cpp,.h,.cs,.rb,.php,.sh,.sql,.css,.scss,.toml,.yaml,.yml,.log"
                style={{ display: "none" }}
                onChange={(e) => handleFiles(e.target.files)}
              />
              <button
                type="button"
                className="attach-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={streaming || uploading}
                title="파일 첨부 (PDF / DOCX / 이미지 / 텍스트)"
              >
                <IconPaperclip size={14} />
                <span>첨부</span>
              </button>
              <button
                type="button"
                className={`web-toggle ${webSearch ? "on" : ""}`}
                onClick={() => setWebSearch((v) => !v)}
                disabled={streaming}
                title="웹 검색 결과를 LLM 컨텍스트에 포함"
              >
                <IconSearch size={14} />
                <span>{webSearch ? "검색 ON" : "검색"}</span>
              </button>
            </div>
            <div className="composer-right">
              {streaming ? (
                <button
                  className="stop-btn"
                  onClick={() => liveStream?.abort()}
                  title="응답 생성을 중단"
                >
                  <IconX size={14} />
                  <span>중단 {formatElapsed(elapsedSec)}</span>
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={send}
                  disabled={uploading || !prompt.trim() || !activeProvider}
                  aria-label="전송"
                >
                  <IconSend size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
        </div>
      </div>
      </ChatWorkspaceProvider>

      <ExportDocumentDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        messages={session.messages}
        selectedIds={selectedMessageIds}
        defaultTitle={session.title}
      />
    </div>
  );
});

/** Centered greeting shown in an empty chat (no messages yet) —
 *  picks a Korean time-of-day greeting and addresses the user by
 *  name when we have one. Mirrors the way Claude opens a fresh
 *  conversation. */
function EmptyGreeting({ userName }: { userName: string | null }) {
  // Resolve everything in a single useMemo so the greeting picks one
  // suggestion at mount and doesn't shuffle on re-render.
  const { headline, sub, suggestions } = useMemo(() => {
    const h = new Date().getHours();
    const timeGreeting =
      h < 5 ? "늦은 밤이네요" :
      h < 12 ? "좋은 아침이에요" :
      h < 18 ? "좋은 오후예요" :
      "좋은 저녁이에요";
    const first = (userName || "").split(/[\s@]/)[0];
    const headline = first
      ? `${timeGreeting}, ${first}님`
      : `${timeGreeting}`;
    const sub = "오늘은 무엇을 도와드릴까요?";
    const suggestions = [
      { emoji: "📋", text: "긴 문서를 요약하기" },
      { emoji: "🔍", text: "오타·맞춤법 검사" },
      { emoji: "🌐", text: "웹 검색으로 최신 정보 찾기" },
      { emoji: "💻", text: "코드 작성 / 리뷰" },
      { emoji: "🌏", text: "번역하기" },
    ];
    return { headline, sub, suggestions };
  }, [userName]);

  return (
    <div className="empty-greeting">
      <div className="empty-greeting-headline">{headline}</div>
      <div className="empty-greeting-sub">{sub}</div>
      <ul className="empty-greeting-suggestions">
        {suggestions.map((s) => (
          <li key={s.text}>
            <span className="empty-greeting-emoji">{s.emoji}</span>
            <span>{s.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourcesBox({
  sources,
  warning,
  streaming,
}: {
  sources: import("../api/client").SearchSource[];
  warning?: string | null;
  // While the stream is live the box stays fully expanded — the user
  // is watching the answer build. Once `streaming=false` (done) we
  // collapse it into a small "📎 출처 N개" chip so it stops eating
  // the bottom of the chat. The user can click to peek if needed.
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  // Auto-collapse as soon as streaming ends. Re-expand if a new live
  // stream begins (the count below will jump on the next answer's
  // first sources event).
  useEffect(() => {
    if (streaming) setExpanded(true);
    else setExpanded(false);
  }, [streaming]);

  if (sources.length === 0) {
    return (
      <div className="sources">
        <strong>검색 출처</strong>
        <span className="sources-status"> · 검색 중...</span>
        {warning && <div className="sources-warning">{warning}</div>}
      </div>
    );
  }
  if (!expanded) {
    return (
      <button
        type="button"
        className="sources-chip"
        onClick={() => setExpanded(true)}
        title="검색 출처 펼치기"
      >
        📎 출처 {sources.length}개
        {warning ? " · ⚠" : ""}
      </button>
    );
  }
  const shop = sources.filter((s) => s.kind === "shop");
  const news = sources.filter((s) => s.kind === "news");
  const web = sources.filter((s) => !s.kind || s.kind === "web");
  return (
    <div className="sources">
      <div className="sources-head">
        <strong>검색 출처</strong>
        <button
          type="button"
          className="sources-collapse"
          onClick={() => setExpanded(false)}
          title="접기"
        >
          접기
        </button>
      </div>
      {warning && <div className="sources-warning">⚠ {warning}</div>}
      {shop.length > 0 && (
        <>
          <div className="sources-section">쇼핑</div>
          <div className="shop-grid">
            {shop.map((s, i) => (
              <a
                key={`shop-${i}`}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shop-card"
                title={s.title}
              >
                {s.image ? (
                  <img src={s.image} alt="" loading="lazy" />
                ) : (
                  <div className="shop-card-noimage">이미지 없음</div>
                )}
                <div className="shop-card-body">
                  <div className="shop-card-title">{s.title}</div>
                  {s.lprice != null && (
                    <div className="shop-card-price">
                      {s.lprice.toLocaleString("ko-KR")}원
                    </div>
                  )}
                  {s.mall && <div className="shop-card-mall">{s.mall}</div>}
                </div>
              </a>
            ))}
          </div>
        </>
      )}
      {news.length > 0 && (
        <>
          <div className="sources-section">뉴스</div>
          <ol className="sources-list">
            {news.map((s, i) => (
              <li key={`news-${i}`}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ol>
        </>
      )}
      {web.length > 0 && (
        <>
          <div className="sources-section">웹</div>
          <ol className="sources-list">
            {web.map((s, i) => (
              <li key={`web-${i}`}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function RagChunksBox({
  chunks,
  streaming,
}: {
  chunks: import("../api/client").RagChunk[];
  // Same collapse-after-streaming behaviour as SourcesBox so the
  // chunk list doesn't keep dominating the bottom of the chat once
  // the answer is finished.
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (streaming) setExpanded(true);
    else setExpanded(false);
  }, [streaming]);

  if (!expanded) {
    return (
      <button
        type="button"
        className="rag-chip"
        onClick={() => setExpanded(true)}
        title="검색된 코드 청크 펼치기"
      >
        📚 코드 청크 {chunks.length}개
      </button>
    );
  }
  return (
    <div className="rag-box">
      <div className="rag-head">
        <strong>📚 검색된 코드 청크 ({chunks.length})</strong>
        <button
          type="button"
          className="rag-collapse"
          onClick={() => setExpanded(false)}
          title="접기"
        >
          접기
        </button>
      </div>
      <ol className="rag-list">
        {chunks.map((c, i) => (
          <li key={i}>
            <span className="rag-file">{c.filename}</span>
            <span className="rag-range">
              :{c.start_line}-{c.end_line}
            </span>
            <span className="rag-score">{c.score.toFixed(3)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
