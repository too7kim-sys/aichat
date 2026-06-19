import type React from "react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { copyText } from "../lib/clipboard";
import { errorToast, infoToast } from "../lib/toast";
import { useAuth } from "../auth/AuthContext";
import type { ProviderInfo, SessionDetail } from "../types";
import {
  IconBookOpen,
  IconCheckCircle,
  IconCode,
  IconDownload,
  IconFileText,
  IconFolder,
  IconGlobe,
  IconImage,
  IconPaperclip,
  IconSearch,
  IconSend,
  IconSparkles,
  IconX,
} from "./Icon";
import type { LocalAttachment } from "../export/MergeAttachmentsDialog";
import { MessageBubble } from "./MessageBubble";
import { ShoppingBrowser } from "./ShoppingBrowser";
import { BrandLogo } from "./BrandLogo";
import { CommentThread } from "./CoworkPanels";
// 별 파일로 떨어진 ChatPanel 구성요소 — 메인 3K줄 다이어트.
import { EmptyGreeting } from "./chat/EmptyGreeting";
import { ExportSessionMenu } from "./chat/ExportSessionMenu";
import { MicButton } from "./chat/MicButton";
import { RagChunksBox } from "./chat/RagChunksBox";
import { SlashPromptPicker } from "./chat/SlashPromptPicker";
import { SourcesBox } from "./chat/SourcesBox";
import { WorkspaceChangesPanel } from "./WorkspaceChangesPanel";
import { WorkspaceTree } from "./WorkspaceTree";
import { useArtifacts } from "../artifact/ArtifactContext";
import { ChatWorkspaceProvider } from "../state/ChatWorkspaceContext";
import { useWorkspaces } from "../state/WorkspacesContext";
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
  /** Close the chat view — deselects the active session at the App
   *  level so the main pane falls back to the empty/welcome state.
   *  Optional so storybook-style mounts that pass no parent stay
   *  functional. */
  onCloseChat?: () => void;
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

/** Drop the leading workspace/project prefix from a path so the chip
 *  shows the actual file basename. Workspace files come in as
 *  "<workspace>/path/to/file.py"; clipboard pastes as
 *  "clipboard-2026-06-06.png" (no path). */
function attachmentBasename(filename: string): string {
  const slash = filename.lastIndexOf("/");
  return slash >= 0 ? filename.slice(slash + 1) : filename;
}

/** Extract `<title>` text from an HTML document — used to name the
 *  artifact tab + download filename when the model returned a full
 *  HTML document. Falls back to null when the title is missing or
 *  empty after trim, so the caller can supply a default. */
function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (!m) return null;
  const t = m[1].replace(/\s+/g, " ").trim();
  return t || null;
}

/** Pull every ```html``` fenced code block whose body looks like a
 *  complete HTML document (carries a doctype or a <html> tag).
 *  Anything else is treated as a snippet and skipped — auto-opening
 *  every <div> the model echoes back would be noisy. */
function extractHtmlDocBlocks(content: string): string[] {
  const out: string[] = [];
  const re = /```html\s*\n([\s\S]*?)\n?```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const body = m[1];
    if (/<!doctype\s+html/i.test(body) || /<html[\s>]/i.test(body)) {
      out.push(body);
    }
  }
  return out;
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
    onCloseChat,
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
      errorToast("파일 첨부 실패", e);
    }
  }
  // Bumped by the markdown renderer every time the user applies a
  // `# file: <path>` patch, so the changes panel re-polls git status
  // without a full remount.
  const [changesRefreshKey, setChangesRefreshKey] = useState(0);
  // Inline status for the `/병합` slash-command path — short banner
  // above the composer reporting merge progress / success / failure.
  // The legacy modal entry point was removed; the slash command is
  // now the only way to invoke merge from the chat surface.
  const [mergeStatus, setMergeStatus] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  // 글자 크기·줄 간격 — 사용자별 가독성 설정. 모든 세션에 공통 적용해
  // 사용자가 한 번 정하면 끝.  localStorage 키는 namespace 분리.
  const [chatFont, _setChatFont] = useState<"s" | "m" | "l" | "xl">(() => {
    const v = localStorage.getItem("chat:font-size");
    return v === "s" || v === "m" || v === "l" || v === "xl" ? v : "m";
  });
  const [chatLine, _setChatLine] = useState<"snug" | "normal" | "loose">(() => {
    const v = localStorage.getItem("chat:line-height");
    return v === "snug" || v === "normal" || v === "loose" ? v : "normal";
  });
  function setChatFont(v: "s" | "m" | "l" | "xl") {
    _setChatFont(v);
    localStorage.setItem("chat:font-size", v);
  }
  function setChatLine(v: "snug" | "normal" | "loose") {
    _setChatLine(v);
    localStorage.setItem("chat:line-height", v);
  }
  const [typoOpen, setTypoOpen] = useState(false);
  const typoRef = useRef<HTMLDivElement | null>(null);
  const statsRef = useRef<HTMLDivElement | null>(null);

  // ── 세션 내 검색 (#17) ───────────────────────────────────
  // 헤더의 🔎 또는 Ctrl/⌘+F 로 본문 입력칸 토글. 입력에 매칭되는
  // 메시지 ID 목록을 만들어 ↓ / ↑ 또는 Enter 로 순회 — 기존
  // scroll-flash 패턴 재활용.
  const [searchBarOpen, setSearchBarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ── 대화 잠금 (#21) ─────────────────────────────────────
  // 세션별로 localStorage 에 저장. 잠그면 composer + 편집/별표/평가/
  // 분기/재전송 버튼이 비활성화돼 실수 수정 방지. 백엔드 스키마는
  // 안 건드림 — 클라이언트 가드만으로 충분.
  const lockedKey = `chat:session:${sessionId}:locked`;
  const [locked, _setLocked] = useState<boolean>(
    () => localStorage.getItem(lockedKey) === "1",
  );
  function setLocked(v: boolean) {
    _setLocked(v);
    if (v) localStorage.setItem(lockedKey, "1");
    else localStorage.removeItem(lockedKey);
  }

  // ── 자동 요약 카드 (#22) ────────────────────────────────
  // 메시지 30개 넘으면 상단에 "지금까지의 흐름" 카드. 사용자가
  // 닫아도 다시 30개 단위로 재등장하지 않도록 localStorage 에
  // dismissed 표시. 본문은 클라이언트에서 첫 사용자 질문 + 직전
  // 어시스턴트 답변 짧게 발췌 — 백엔드 요약 호출 없이 가볍게.
  // ── 작성 중 자동 저장 (#23) ─────────────────────────────
  // composer 의 prompt 값을 세션별 localStorage 에 저장. 새로고침이나
  // 다른 세션 갔다가 돌아와도 그대로. 빈 문자열이면 키 삭제.
  const draftKey = `chat:session:${sessionId}:draft`;

  // ── AI 말투 (#28) ──────────────────────────────────────
  // composer 옆 칩으로 격식/친근/짧게 선택. 다음 send 시 prompt 앞에
  // 짧은 디렉티브를 prepend.  세션과 무관한 전역 설정.
  const [tone, _setTone] = useState<"default" | "formal" | "casual" | "brief">(
    () => {
      const v = localStorage.getItem("chat:tone");
      if (v === "formal" || v === "casual" || v === "brief" || v === "default") return v;
      return "default";
    },
  );
  function setTone(v: "default" | "formal" | "casual" | "brief") {
    _setTone(v);
    if (v === "default") localStorage.removeItem("chat:tone");
    else localStorage.setItem("chat:tone", v);
  }
  const [toneOpen, setToneOpen] = useState(false);
  const toneRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!toneOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!toneRef.current) return;
      if (toneRef.current.contains(e.target as Node)) return;
      setToneOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setToneOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [toneOpen]);
  const TONE_LABEL: Record<typeof tone, string> = {
    default: "기본",
    formal: "격식",
    casual: "친근",
    brief: "짧게",
  };

  // ── 세션 통계 카드 (#26) ────────────────────────────────
  const [statsOpen, setStatsOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  // 헤더 popover 들의 click-outside / Esc 처리 (UI 최적화).
  useEffect(() => {
    if (!typoOpen && !statsOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (typoOpen && typoRef.current && !typoRef.current.contains(t))
        setTypoOpen(false);
      if (statsOpen && statsRef.current && !statsRef.current.contains(t))
        setStatsOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (typoOpen) setTypoOpen(false);
      if (statsOpen) setStatsOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [typoOpen, statsOpen]);

  // ── 이미지 분석 / 예측 (29) ─────────────────────────────
  // 첨부된 이미지의 data URI 를 라이트박스에서 확대해 본다. null 이면
  // 모달 닫힘. base64 + mime 둘 다 보관해야 src 만들 수 있음.
  const [lightbox, setLightbox] = useState<
    | { src: string; name: string }
    | null
  >(null);

  // 🛒 쇼핑 브라우저 — 별도 모달에서 Naver shop 직접 검색 후
  // 선택한 상품으로 AI 에 비교/추천 요청 프롬프트 자동 생성.
  const [shopBrowserOpen, setShopBrowserOpen] = useState(false);

  const summaryDismissKey = `chat:session:${sessionId}:summary-dismissed`;
  const [summaryDismissed, _setSummaryDismissed] = useState<boolean>(
    () => localStorage.getItem(summaryDismissKey) === "1",
  );
  function dismissSummary() {
    _setSummaryDismissed(true);
    localStorage.setItem(summaryDismissKey, "1");
  }
  const [summaryOpen, setSummaryOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  // AskBlock 의 선택지 클릭 이벤트를 받아 send 로 전달 — send 함수는
  // 컴포넌트 본문 아래에서 정의되고 early return 위에 hook 이 필요해서
  // ref 로 우회한다. 본문에서 매 렌더마다 sendRef.current 를 최신 send
  // 로 교체.
  const sendRef = useRef<((override: string) => void) | null>(null);
  // 다음 turn 으로 보낼 텍스트를 ref 에 두는 패턴 — composer 가 비어
  // 있어도 prefill 만 할 수 있게.
  const promptSetterRef = useRef<((next: string) => void) | null>(null);
  const sessionRef = useRef<{
    messages: {
      id: string;
      role: string;
      content: string;
      starred?: boolean;
    }[];
  } | null>(null);
  useEffect(() => {
    function onChoice(e: Event) {
      const ev = e as CustomEvent<{ text: string }>;
      if (ev.detail?.text) sendRef.current?.(ev.detail.text);
    }
    function onRewindResend(e: Event) {
      const ev = e as CustomEvent<{ text: string }>;
      if (ev.detail?.text) sendRef.current?.(ev.detail.text);
    }
    function onRegenerateLast() {
      // 가장 최근 user 메시지 찾아서 그대로 다시 보냄 — 직전 assistant
      // 답변은 굳이 지우지 않고 새 답변이 그 아래에 붙는다 (사용자가
      // 원하면 별표 / 비교).
      const s = sessionRef.current;
      const msgs = s?.messages ?? [];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      if (lastUser?.content) sendRef.current?.(lastUser.content);
    }
    function onQuotePick(e: Event) {
      const ev = e as CustomEvent<{ text: string }>;
      if (ev.detail?.text) promptSetterRef.current?.(ev.detail.text);
    }
    function onCitation(e: Event) {
      const ev = e as CustomEvent<{ index: number }>;
      const idx = ev.detail?.index;
      if (!idx) return;
      const root = scrollRef.current;
      if (!root) return;
      const node = root.querySelector<HTMLElement>(
        `[data-citation-idx="${idx}"]`,
      );
      if (!node) return;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.add("rag-list-flash");
      window.setTimeout(() => node.classList.remove("rag-list-flash"), 1600);
    }
    window.addEventListener("chat:choice-picked", onChoice);
    window.addEventListener("chat:rewind-resend", onRewindResend);
    window.addEventListener("chat:regenerate-last", onRegenerateLast);
    window.addEventListener("chat:quote-pick", onQuotePick);
    window.addEventListener("chat:show-citation", onCitation);
    return () => {
      window.removeEventListener("chat:choice-picked", onChoice);
      window.removeEventListener("chat:rewind-resend", onRewindResend);
      window.removeEventListener("chat:regenerate-last", onRegenerateLast);
      window.removeEventListener("chat:quote-pick", onQuotePick);
      window.removeEventListener("chat:show-citation", onCitation);
    };
  }, []);
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
  // RAG 파일명 필터 (선택). 채워지면 청크의 source filename 에 포함된
  // 것만 검색에 사용 — "billing/" 같은 서브트리 좁히기.
  const ragFilterKey = `chat:session:${sessionId}:ragfilter`;
  const [ragFilenameFilter, setRagFilenameFilter] = useState<string>(
    () => localStorage.getItem(ragFilterKey) || "",
  );
  useEffect(() => {
    if (ragFilenameFilter) localStorage.setItem(ragFilterKey, ragFilenameFilter);
    else localStorage.removeItem(ragFilterKey);
  }, [ragFilenameFilter, ragFilterKey]);
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

  // Look up the workspace's source_type so the code-block action chips
  // can pick the right "save" flow — git workspaces get commit+push,
  // local-folder workspaces just save to the registered path.
  const { workspaces } = useWorkspaces();
  const sessionWorkspace = session?.workspace_id
    ? workspaces.find((w) => w.id === session.workspace_id) ?? null
    : null;
  const workspaceSourceType =
    (sessionWorkspace?.source_type as "git" | "local" | undefined) ?? null;

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

  // HTML-document auto-open — when an assistant turn completes with a
  // ```html``` code block that looks like a full self-contained doc,
  // push it to the artifact panel so the user gets the rendered
  // preview + download for free. Tracks last-handled message id so
  // navigating back into the session doesn't re-trigger the open.
  const lastHtmlAutoOpenedRef = useRef<string | null>(null);
  const prevStreamingRef = useRef(streaming);
  useEffect(() => {
    const justFinished = prevStreamingRef.current && !streaming;
    prevStreamingRef.current = streaming;
    if (!justFinished) return;
    const msgs = session?.messages;
    if (!msgs || msgs.length === 0) return;
    const last = msgs[msgs.length - 1];
    if (last.role !== "assistant") return;
    if (lastHtmlAutoOpenedRef.current === last.id) return;
    const blocks = extractHtmlDocBlocks(last.content);
    if (blocks.length === 0) return;
    for (const block of blocks) {
      const title = extractHtmlTitle(block) || "생성된 문서";
      artifactsState.push({ title, language: "html", code: block });
    }
    lastHtmlAutoOpenedRef.current = last.id;
  }, [streaming, session, artifactsState]);

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
    // 세션 전환 시 그 세션에 저장돼 있던 작성 중 텍스트 복원 (#23).
    // 없으면 빈 문자열로 리셋.
    const savedDraft = localStorage.getItem(draftKey) ?? "";
    setPrompt(savedDraft);
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

  // 입력값 변화에 따라 draft 저장 — debounce 없이 setItem 은 동기지만
  // localStorage 쓰기는 한국어 길이에서도 미세하므로 그대로 둠.
  useEffect(() => {
    try {
      if (prompt.trim() === "") localStorage.removeItem(draftKey);
      else localStorage.setItem(draftKey, prompt);
    } catch {
      // private 모드 / quota — 조용히 무시.
    }
  }, [prompt, draftKey]);

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
    // ── 답변 완료 알림 (#24) ────────────────────────────────
    // 탭이 백그라운드면 document.title 에 깜빡 표시 + 사용자가
    // 알림 권한을 허용한 경우 시스템 Notification.
    if (document.hidden && liveStream.errors.length === 0) {
      const base = document.title.replace(/^●\s*답변 도착\s*·\s*/, "");
      document.title = `● 답변 도착 · ${base}`;
      try {
        if (
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          new Notification("답변이 도착했어요", {
            body: "탭을 클릭해 확인하세요.",
            tag: `chat-reply-${sessionId}`,
          });
        }
      } catch {
        // 권한·환경 이슈 — 조용히 무시.
      }
    }
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

  // 마지막 스크롤 위치 저장 — 세션 다시 열 때 그 자리로 돌아오게 (#18).
  // rAF 로 처리량 제한해서 흘러가는 메시지 본문에 영향 없게.
  const scrollSaveKey = `chat:session:${sessionId}:scroll`;
  const scrollSaveRafRef = useRef<number | null>(null);
  function onMessagesScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    const atBottom = distance < 80;
    stickToBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
    // 바닥에 붙은 상태면 굳이 저장하지 않음 — 다음 진입 때 어차피
    // 새 메시지가 와 있으면 그쪽으로 스크롤 됨.
    if (scrollSaveRafRef.current != null)
      cancelAnimationFrame(scrollSaveRafRef.current);
    scrollSaveRafRef.current = requestAnimationFrame(() => {
      try {
        if (atBottom) localStorage.removeItem(scrollSaveKey);
        else localStorage.setItem(scrollSaveKey, String(el.scrollTop));
      } catch {
        // localStorage 가득 / private 모드 — 조용히 무시.
      }
    });
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

  // ── 마지막 위치 복원 (#18) ──────────────────────────────
  // 세션 메시지가 처음 그려졌을 때, 저장된 scrollTop 이 있으면 그
  // 자리로 점프. 딥링크(scrollToMessageId)가 잡혀 있으면 그쪽이 우선
  // 이므로 패스. 처음 한 번만 실행되도록 ref 가드.
  const scrollRestoredRef = useRef(false);
  useEffect(() => {
    if (scrollRestoredRef.current) return;
    if (!session || session.messages.length === 0) return;
    if (scrollToMessageId) {
      scrollRestoredRef.current = true;
      return;
    }
    const saved = localStorage.getItem(scrollSaveKey);
    if (!saved) {
      scrollRestoredRef.current = true;
      return;
    }
    const top = Number(saved);
    if (!Number.isFinite(top)) {
      scrollRestoredRef.current = true;
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTo({ top, behavior: "auto" });
        stickToBottomRef.current = false;
        scrollRestoredRef.current = true;
      });
    });
  }, [session, scrollToMessageId, scrollSaveKey]);
  // 세션이 바뀌면 다음 첫 렌더에서 다시 복원하도록 가드 리셋.
  useEffect(() => {
    scrollRestoredRef.current = false;
  }, [sessionId]);

  // 답변 알림 (#24) — 탭이 다시 보이면 title 접두사 제거.
  useEffect(() => {
    function onVis() {
      if (!document.hidden) {
        document.title = document.title.replace(
          /^●\s*답변 도착\s*·\s*/,
          "",
        );
      }
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // ── 세션 내 검색 매칭 (#17) ─────────────────────────────
  // 입력값으로 message 본문 substring 매치 (대소문자 무시). 매칭된
  // ID 목록을 메모이즈, 현재 인덱스가 범위 밖이면 0 으로 클램프.
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q || !session) return [] as string[];
    return session.messages
      .filter((m) => m.content.toLowerCase().includes(q))
      .map((m) => m.id);
  }, [searchQuery, session]);
  useEffect(() => {
    if (searchIdx >= searchMatches.length) setSearchIdx(0);
  }, [searchMatches, searchIdx]);
  // 매칭 결과 + 인덱스가 바뀔 때마다 그 메시지를 가운데로 스크롤 + 플래시.
  useEffect(() => {
    if (!searchBarOpen) return;
    const id = searchMatches[searchIdx];
    if (!id) return;
    const root = scrollRef.current;
    if (!root) return;
    requestAnimationFrame(() => {
      const node = root.querySelector<HTMLElement>(
        `[data-message-id="${id}"]`,
      );
      if (!node) return;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.add("search-flash");
      stickToBottomRef.current = false;
      window.setTimeout(() => node.classList.remove("search-flash"), 1400);
    });
  }, [searchIdx, searchMatches, searchBarOpen]);

  // Ctrl/⌘+F → 검색 토글, ? → 단축키 도움말 (App 측 처리),
  // [ / ] → 별표 메시지 사이 이동 (#20). 입력칸 포커스 중이면 무시.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const inField =
        tag === "input" || tag === "textarea" || tag === "select" ||
        (e.target as HTMLElement | null)?.isContentEditable;
      if ((e.key === "f" || e.key === "F") && (e.metaKey || e.ctrlKey)) {
        // composer 안에서 누른 경우에도 채팅 검색을 띄움 — 브라우저
        // find 는 어차피 messages 컨테이너 안 가상 스크롤이 아니라
        // 모든 메시지가 DOM 에 있어 정상 동작하지만, 인앱 검색이 더
        // 빠르고 메시지 단위 이동이 가능.
        e.preventDefault();
        setSearchBarOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
      if (inField) return;
      if (e.key === "[" || e.key === "]") {
        const s = sessionRef.current;
        const msgs = s?.messages ?? [];
        const stars = msgs.filter((m) => !!m.starred).map((m) => m.id);
        if (stars.length === 0) return;
        const root = scrollRef.current;
        if (!root) return;
        // 현재 화면 중앙에 가장 가까운 별표 메시지를 기준점으로 잡고
        // 이전/다음으로 이동. 단순히 첫 번째 → 다음 으로 잡지 않는
        // 이유: 사용자가 중간에 있으면 자기 위치에서 인접한 게
        // 자연스러움.
        const viewCenter =
          root.scrollTop + root.clientHeight / 2;
        let nearestIdx = 0;
        let nearestDist = Infinity;
        stars.forEach((id, i) => {
          const node = root.querySelector<HTMLElement>(
            `[data-message-id="${id}"]`,
          );
          if (!node) return;
          const d = Math.abs(node.offsetTop - viewCenter);
          if (d < nearestDist) {
            nearestDist = d;
            nearestIdx = i;
          }
        });
        const next =
          e.key === "]"
            ? (nearestIdx + 1) % stars.length
            : (nearestIdx - 1 + stars.length) % stars.length;
        const tgtId = stars[next];
        const tgt = root.querySelector<HTMLElement>(
          `[data-message-id="${tgtId}"]`,
        );
        if (tgt) {
          tgt.scrollIntoView({ behavior: "smooth", block: "center" });
          tgt.classList.add("search-flash");
          window.setTimeout(() => tgt.classList.remove("search-flash"), 1400);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
          // 어떤 종류의 실패인지 사용자가 바로 알 수 있게 — 사이즈
          // 초과는 413, 추출 못 한 형식은 400, 토큰 만료/네트워크는
          // 그 외.  메시지에 파일 크기도 함께 표시.
          const sizeMb = (f.size / (1024 * 1024)).toFixed(1);
          failures.push(
            `${f.name} (${sizeMb} MB): ${
              e instanceof Error ? e.message : String(e)
            }`,
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
  // 슬래시 명령 picker (저장된 프롬프트 라이브러리). textarea 가 "/"
  // 로 시작할 때 열림, query 는 그 뒤 텍스트.
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");

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
                <h2 className="chat-title">대화 불러오는 중…</h2>
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
                  content={liveStream.buffer || "응답 생성 중…"}
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
              <p>불러오는 중…</p>
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
      if (picked) return `Ollama (${picked.name}) · 자동: ${picked.reason}`;
      return "Ollama · 자동 선택 중…";
    }
    return model ? `Ollama (${model})` : defaultLabel;
  })();

  function send(override?: string) {
    if (streaming || !activeProvider) return;
    if (locked) return;
    let text = (override ?? prompt).trim();
    if (!text) return;

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

    // 말투 토글 (#28) — 짧은 디렉티브를 prompt 끝에 한 줄로 부착.
    // 끝에 두는 이유: 본문이 짧은 인사·질문일 때 prefix 가 시선을 끌어
    // 어색해지는 걸 막기 위함.  메시지에 그대로 저장되므로 사용자가
    // 의도를 인지할 수 있게 한국어로 명시.
    if (tone === "formal") text += "\n\n(격식체·존댓말로 답해 주세요.)";
    else if (tone === "casual") text += "\n\n(편안한 반말로, 친한 사람처럼 답해 주세요.)";
    else if (tone === "brief") text += "\n\n(핵심만 3~5줄 이내로 짧게 답해 주세요.)";

    if (override === undefined) {
      setPrompt("");
      // 작성 자동저장 (#23) — 보낸 직후 draft 클리어.
      try { localStorage.removeItem(draftKey); } catch {}
    }
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
      ragFilenameFilter: ragFilenameFilter.trim() || undefined,
    });
  }

  // 매 렌더마다 ref 를 최신 send 로 교체 — 위에서 등록한 이벤트
  // 리스너가 항상 최신 closure 의 send 를 호출하도록.
  sendRef.current = send;
  // session 이 ref 에 박혀 있어야 useEffect 안 핸들러가 항상 최신 메시지
  // 리스트를 본다.
  sessionRef.current = session as never;
  promptSetterRef.current = (next: string) => {
    setPrompt((cur) => (cur ? cur + (cur.endsWith("\n") ? "" : "\n\n") + next : next));
    // 다음 tick 에 포커스 — input 위에 prefill 텍스트 보이게.
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

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
        `다운로드 완료 · ${filename} (${Math.round(blob.size / 1024)} KB, ${majority.length}개 합침)`,
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
          <button
            type="button"
            className="panel-toggle"
            onClick={() => {
              setSearchBarOpen((v) => {
                const nv = !v;
                if (nv) window.setTimeout(() => searchInputRef.current?.focus(), 0);
                return nv;
              });
            }}
            title="이 대화에서 검색 (Ctrl/⌘+F)"
            aria-label="대화 내 검색"
          >
            <IconSearch size={13} /> 찾기
          </button>
          <button
            type="button"
            className={`panel-toggle${locked ? " locked-on" : ""}`}
            onClick={() => setLocked(!locked)}
            title={locked ? "대화 잠금 해제" : "대화 잠금 — 실수 편집·삭제 방지"}
            aria-label={locked ? "대화 잠금 해제" : "대화 잠금"}
          >
            {locked ? "🔒 잠김" : "🔓"}
          </button>
          <button
            type="button"
            className="panel-toggle"
            onClick={() => setCommentsOpen(true)}
            title="이 세션에 코멘트 남기기 (팀원과 공유)"
            aria-label="세션 코멘트"
          >
            💬
          </button>
          <div className="chat-stats-wrap" ref={statsRef}>
            <button
              type="button"
              className="panel-toggle"
              onClick={() => setStatsOpen((v) => !v)}
              title="이 세션의 통계"
              aria-label="세션 통계"
            >
              📊
            </button>
            {statsOpen && session && (() => {
              const msgs = session.messages;
              const total = msgs.length;
              const userCount = msgs.filter((m) => m.role === "user").length;
              const aiCount = total - userCount;
              const starCount = msgs.filter((m) => m.starred).length;
              const latencies = msgs
                .map((m) => m.latency_ms)
                .filter((v): v is number => typeof v === "number" && v > 0);
              const avgLatency =
                latencies.length === 0
                  ? null
                  : latencies.reduce((a, b) => a + b, 0) / latencies.length;
              const tokens = msgs
                .map((m) => m.tokens_out ?? 0)
                .reduce((a, b) => a + b, 0);
              const firstAt = msgs[0]?.created_at;
              const lastAt = msgs[msgs.length - 1]?.created_at;
              return (
                <div className="chat-stats-popover" role="dialog">
                  <div className="chat-stats-row"><span>메시지</span><b>{total}</b></div>
                  <div className="chat-stats-row"><span>↳ 사용자 / AI</span><b>{userCount} / {aiCount}</b></div>
                  <div className="chat-stats-row"><span>별표</span><b>{starCount}</b></div>
                  <div className="chat-stats-row">
                    <span>평균 응답 시간</span>
                    <b>{avgLatency === null ? "—" : `${(avgLatency / 1000).toFixed(1)}s`}</b>
                  </div>
                  <div className="chat-stats-row">
                    <span>출력 토큰 합</span>
                    <b>{tokens.toLocaleString()}</b>
                  </div>
                  {firstAt && lastAt && (
                    <div className="chat-stats-row chat-stats-since">
                      <span>기간</span>
                      <b>
                        {new Date(firstAt).toLocaleDateString()} ~
                        {" "}{new Date(lastAt).toLocaleDateString()}
                      </b>
                    </div>
                  )}
                  <button
                    type="button"
                    className="chat-stats-close"
                    onClick={() => setStatsOpen(false)}
                  >
                    닫기
                  </button>
                </div>
              );
            })()}
          </div>
          <div className="chat-typo-wrap" ref={typoRef}>
            <button
              type="button"
              className="panel-toggle chat-typo-btn"
              onClick={() => setTypoOpen((v) => !v)}
              title="글자 크기 / 줄 간격"
              aria-label="글자 크기 설정"
            >
              Aa
            </button>
            {typoOpen && (
              <div className="chat-typo-popover" role="dialog">
                <div className="chat-typo-row">
                  <span className="chat-typo-label">크기</span>
                  {(["s", "m", "l", "xl"] as const).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      className={`chat-typo-chip${chatFont === sz ? " picked" : ""}`}
                      onClick={() => setChatFont(sz)}
                    >
                      {sz === "s" ? "작게" : sz === "m" ? "보통" : sz === "l" ? "크게" : "아주크게"}
                    </button>
                  ))}
                </div>
                <div className="chat-typo-row">
                  <span className="chat-typo-label">줄간격</span>
                  {(["snug", "normal", "loose"] as const).map((ln) => (
                    <button
                      key={ln}
                      type="button"
                      className={`chat-typo-chip${chatLine === ln ? " picked" : ""}`}
                      onClick={() => setChatLine(ln)}
                    >
                      {ln === "snug" ? "좁게" : ln === "normal" ? "보통" : "넉넉히"}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="chat-typo-close"
                  onClick={() => setTypoOpen(false)}
                >
                  닫기
                </button>
              </div>
            )}
          </div>
          <ExportSessionMenu sessionId={session.id} title={session.title} />
          <button
            type="button"
            className="panel-toggle"
            onClick={async () => {
              try {
                const r = await api.createSessionShare(session.id, null);
                const link = `${window.location.origin}${r.url}`;
                const ok = await copyText(
                  link,
                  "아래 공유 링크를 복사하세요",
                );
                window.dispatchEvent(
                  new CustomEvent("chat:toast", {
                    detail: {
                      text: ok
                        ? "🔗 공유 링크가 복사됐어요"
                        : "🔗 공유 링크 생성됨 — 위 prompt 에서 복사",
                    },
                  }),
                );
              } catch (e) {
                errorToast("공유 링크 생성 실패", e);
              }
            }}
            title="이 대화의 공유 링크 (로그인된 사용자 읽기 전용)"
          >
            🔗 공유
          </button>
          <button
            type="button"
            className={`panel-toggle${session.has_passphrase ? " locked-on" : ""}`}
            onClick={async () => {
              if (session.has_passphrase) {
                if (!window.confirm("세션 잠금을 해제할까요?")) return;
                try {
                  await api.lockSession(session.id, null);
                  setSession((prev) =>
                    prev ? { ...prev, has_passphrase: false } : prev,
                  );
                } catch (e) {
                  errorToast("해제 실패", e);
                }
                return;
              }
              const p = window.prompt(
                "이 세션을 잠글 비밀번호를 입력하세요.  잊으면 본문을 다시 볼 수 없어요.",
              );
              if (!p) return;
              try {
                await api.lockSession(session.id, p);
                setSession((prev) =>
                  prev ? { ...prev, has_passphrase: true } : prev,
                );
                window.dispatchEvent(
                  new CustomEvent("chat:toast", {
                    detail: { text: "🔐 세션이 잠겼어요" },
                  }),
                );
              } catch (e) {
                errorToast("잠금 실패", e);
              }
            }}
            title={session.has_passphrase ? "잠금 해제" : "세션 비밀번호 잠금"}
          >
            {session.has_passphrase ? "🔐 잠김" : "🔓"}
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
          {onCloseChat && (
            <button
              type="button"
              className="chat-close-btn"
              onClick={onCloseChat}
              title="채팅 닫기"
              aria-label="채팅 닫기"
            >
              <IconX size={14} />
            </button>
          )}
        </div>
        </div>
      </header>

      <ChatWorkspaceProvider
        workspaceId={session.workspace_id ?? null}
        sourceType={workspaceSourceType}
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
      {session.messages.length >= 8 && (
        <div className="chat-minimap" aria-hidden="true">
          {session.messages.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`chat-minimap-dot ${m.role === "user" ? "u" : "a"}${m.starred ? " star" : ""}${m.feedback === -1 ? " bad" : ""}`}
              title={`${m.role === "user" ? "나" : "AI"} · ${m.content.slice(0, 40)}${m.content.length > 40 ? "…" : ""}`}
              onClick={() => {
                const root = scrollRef.current;
                if (!root) return;
                const node = root.querySelector<HTMLElement>(
                  `[data-message-id="${m.id}"]`,
                );
                if (!node) return;
                node.scrollIntoView({ behavior: "smooth", block: "center" });
                node.classList.add("search-flash");
                stickToBottomRef.current = false;
                window.setTimeout(
                  () => node.classList.remove("search-flash"),
                  1400,
                );
              }}
            />
          ))}
        </div>
      )}
      <div
        className="messages"
        ref={scrollRef}
        onScroll={onMessagesScroll}
        style={
          {
            "--chat-font-size":
              chatFont === "s"
                ? "13px"
                : chatFont === "m"
                  ? "14.5px"
                  : chatFont === "l"
                    ? "16px"
                    : "18px",
            "--chat-line-height":
              chatLine === "snug" ? "1.45" : chatLine === "normal" ? "1.65" : "1.85",
          } as React.CSSProperties
        }
      >
        <div className="messages-inner">
          {searchBarOpen && (
            <div className="chat-search-bar" role="search">
              <input
                ref={searchInputRef}
                className="chat-search-input"
                placeholder="이 대화에서 찾기"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchBarOpen(false);
                    setSearchQuery("");
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (searchMatches.length === 0) return;
                    setSearchIdx((i) =>
                      e.shiftKey
                        ? (i - 1 + searchMatches.length) % searchMatches.length
                        : (i + 1) % searchMatches.length,
                    );
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    if (searchMatches.length > 0)
                      setSearchIdx((i) => (i + 1) % searchMatches.length);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    if (searchMatches.length > 0)
                      setSearchIdx(
                        (i) =>
                          (i - 1 + searchMatches.length) % searchMatches.length,
                      );
                  }
                }}
              />
              <span className="chat-search-count">
                {searchQuery.trim() === ""
                  ? "Enter ↑↓ 로 이동, Esc 로 닫기"
                  : searchMatches.length === 0
                    ? "결과 없음"
                    : `${searchIdx + 1} / ${searchMatches.length}`}
              </span>
              <button
                type="button"
                className="chat-search-nav"
                onClick={() => {
                  if (searchMatches.length === 0) return;
                  setSearchIdx(
                    (i) =>
                      (i - 1 + searchMatches.length) % searchMatches.length,
                  );
                }}
                aria-label="이전 결과"
              >
                ↑
              </button>
              <button
                type="button"
                className="chat-search-nav"
                onClick={() => {
                  if (searchMatches.length === 0) return;
                  setSearchIdx((i) => (i + 1) % searchMatches.length);
                }}
                aria-label="다음 결과"
              >
                ↓
              </button>
              <button
                type="button"
                className="chat-search-close"
                onClick={() => {
                  setSearchBarOpen(false);
                  setSearchQuery("");
                }}
                aria-label="검색 닫기"
              >
                ✕
              </button>
            </div>
          )}
          {!summaryDismissed && session.messages.length >= 30 && (() => {
            const firstUser = session.messages.find((m) => m.role === "user");
            const lastAssistant = [...session.messages]
              .reverse()
              .find((m) => m.role === "assistant" && !m.hidden);
            return (
              <div className={`chat-summary-card${summaryOpen ? " open" : ""}`}>
                <div className="chat-summary-head">
                  <button
                    type="button"
                    className="chat-summary-toggle"
                    onClick={() => setSummaryOpen((v) => !v)}
                  >
                    {summaryOpen ? "▾" : "▸"} 지금까지의 흐름 · 메시지 {session.messages.length}개
                  </button>
                  <button
                    type="button"
                    className="chat-summary-dismiss"
                    onClick={dismissSummary}
                    title="이 세션에서 더 안 보이게"
                    aria-label="요약 카드 닫기"
                  >
                    ✕
                  </button>
                </div>
                {summaryOpen && (
                  <div className="chat-summary-body">
                    {firstUser && (
                      <div className="chat-summary-row">
                        <span className="chat-summary-label">첫 질문</span>
                        <span className="chat-summary-text">
                          {firstUser.content.slice(0, 240)}
                          {firstUser.content.length > 240 ? "…" : ""}
                        </span>
                      </div>
                    )}
                    {lastAssistant && (
                      <div className="chat-summary-row">
                        <span className="chat-summary-label">최근 답변</span>
                        <span className="chat-summary-text">
                          {lastAssistant.content.slice(0, 240)}
                          {lastAssistant.content.length > 240 ? "…" : ""}
                        </span>
                      </div>
                    )}
                    <div className="chat-summary-hint">
                      대화가 길어졌어요. ⌘/Ctrl+F 로 본문 검색, [ / ] 로 별표 사이 이동.
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          {session.messages.length === 0 && !streaming && (
            <EmptyGreeting userName={user?.name ?? null} />
          )}
          {(() => {
            let turn = 0;
            // Inline edit is intended for the 회의록(transcript) chat
            // where users tidy a mis-transcribed line or tighten the
            // summary before exporting. Detect transcript sessions by
            // the hidden-message marker the transcription pipeline
            // sets — regular chats stay read-only so model history
            // doesn't drift from what was actually sent.
            const isTranscriptSession = session.messages.some(
              (m) => m.hidden,
            );
            return session.messages.map((m) => {
              if (m.role === "user") turn += 1;
              return (
                <MessageBubble
                  key={m.id}
                  messageId={m.id}
                  sessionId={session.id}
                  role={m.role}
                  provider={m.provider}
                  content={m.content}
                  hidden={!!m.hidden}
                  editable={isTranscriptSession}
                  starred={!!m.starred}
                  feedback={m.feedback ?? 0}
                  feedbackNote={m.feedback_note ?? null}
                  feedbackCategory={m.feedback_category ?? null}
                  rating={m.rating ?? null}
                  escalatedAt={m.escalated_at ?? null}
                  createdAt={m.created_at}
                  latencyMs={m.latency_ms ?? null}
                  tokensOut={m.tokens_out ?? null}
                  tags={m.tags ?? null}
                  locked={locked}
                  searchQuery={searchBarOpen ? searchQuery : ""}
                  onBranchFrom={async () => {
                    try {
                      const ns = await api.branchSessionFrom(session.id, m.id);
                      onTitleSync?.();
                      // 새 세션이 만들어졌으니 onSelect 와 같은 흐름으로
                      // 전환 — 외부에 콜백이 없으면 location 으로 폴백.
                      window.dispatchEvent(
                        new CustomEvent("chat:switch-session", {
                          detail: { sessionId: ns.id },
                        }),
                      );
                    } catch (e) {
                      errorToast("분기 실패", e);
                    }
                  }}
                  onMetaChanged={(patch) =>
                    setSession((prev) =>
                      prev
                        ? {
                            ...prev,
                            messages: prev.messages.map((row) =>
                              row.id === m.id ? { ...row, ...patch } : row,
                            ),
                          }
                        : prev,
                    )
                  }
                  onEdited={(next) =>
                    setSession((prev) =>
                      prev
                        ? {
                            ...prev,
                            messages: prev.messages.map((row) =>
                              row.id === m.id
                                ? { ...row, content: next, hidden: false }
                                : row,
                            ),
                          }
                        : prev,
                    )
                  }
                  attachments={m.attachments_summary ?? null}
                  artifactTitlePrefix={m.role === "assistant" ? `턴 ${turn}` : undefined}
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
              <div className="avatar avatar-brand thinking" aria-hidden="true">
                <BrandLogo size={20} />
              </div>
              <div className="body">
                <div className="bubble-header">{activeProviderLabel}</div>
                <div className="content thinking">
                  <span className="spinner" />
                  응답 생성 중… {formatElapsed(elapsedSec)}
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
            <RagChunksBox chunks={liveStream.ragChunks} />
          )}
        </div>
      </div>
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
          {linkedProjectId && (
            <div className="rag-filter-row">
              <span className="rag-filter-label" title="이 채팅에 RAG 지식베이스가 연결되어 있습니다">📚 RAG</span>
              <input
                type="text"
                className="rag-filter-input"
                placeholder="파일명 필터 (예: billing/)"
                value={ragFilenameFilter}
                onChange={(e) => setRagFilenameFilter(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                maxLength={200}
                title="채워지면 청크의 파일명에 이 문자열이 포함된 것만 검색에 사용"
              />
              {ragFilenameFilter && (
                <button
                  type="button"
                  className="rag-filter-clear"
                  onClick={() => setRagFilenameFilter("")}
                  title="필터 지우기"
                >
                  ×
                </button>
              )}
            </div>
          )}
          {attachments.length > 0 && (() => {
            // 첨부 타입 감지 — 이미지 / 표 데이터 / 일반 텍스트.
            const hasImage = attachments.some((a) => !!a.image_b64);
            const hasData = attachments.some((a) =>
              /\.(csv|tsv|xlsx|xls|json|jsonl|parquet)$/i.test(a.filename),
            );
            if (!hasImage && !hasData) return null;
            // chip 한 번 누르면 즉시 send — composer 가 비어있어도 첨부된
            // 이미지/데이터에 대한 분석을 바로 받을 수 있게.
            function quickAnalyze(text: string) {
              send(text);
            }
            return (
              <div className="attach-analysis-bar" role="toolbar">
                {hasImage && (
                  <>
                    <span className="attach-analysis-label">
                      🖼 이미지 분석
                    </span>
                    {(
                      [
                        ["설명", "첨부된 이미지를 한국어로 자세히 설명해 주세요. 주요 객체, 장면, 분위기, 텍스트(있다면)를 짚어 주세요."],
                        ["OCR", "첨부된 이미지에 보이는 모든 글자를 빠짐없이 추출해 주세요. 위치/순서는 자연스럽게 유지하고, 표가 있으면 Markdown 표로 정리해 주세요."],
                        ["차트", "첨부된 이미지가 차트라면 X·Y 축, 데이터 값, 추세를 읽어내 표로 정리해 주시고, 보이는 추세에 대한 짧은 해석도 덧붙여 주세요."],
                        ["객체", "첨부된 이미지에서 인식되는 모든 객체를 목록으로 알려 주세요. 각 객체의 위치(좌상/우하 등)와 추정 신뢰도도 함께."],
                        ["검수", "첨부된 이미지에서 결함·이상·위험 요소가 있으면 알려 주세요. 없다면 '특이사항 없음' 으로 답해 주세요."],
                        ["요약", "첨부된 이미지의 핵심을 3줄 이내로 요약해 주세요."],
                      ] as const
                    ).map(([label, prompt]) => (
                      <button
                        key={label}
                        type="button"
                        className="attach-analysis-chip"
                        onClick={() => quickAnalyze(prompt)}
                        disabled={streaming || locked}
                        title={prompt}
                      >
                        {label}
                      </button>
                    ))}
                  </>
                )}
                {hasData && (
                  <>
                    <span className="attach-analysis-label">
                      📊 데이터 분석·예측
                    </span>
                    {(
                      [
                        ["요약", "첨부된 표/데이터의 행·열 구조, 주요 통계(평균·중앙값·범위), 결측 비율을 정리해 주세요."],
                        ["추세", "첨부된 데이터의 시계열·시간순 추세를 파악해 주세요. 시점 컬럼이 있다면 그 기준으로 정렬해 분석."],
                        ["예측", "첨부된 데이터를 기반으로 다음 5~10 기간을 예측하고, 신뢰구간이나 가정도 함께 설명해 주세요. 가능하면 코드 블록(Python, pandas/statsmodels)도 제시해 Pyodide 패널에서 실행할 수 있게."],
                        ["이상치", "첨부된 데이터에서 이상치/특이값을 찾아 행 번호와 이유를 알려 주세요."],
                        ["상관", "첨부된 데이터 컬럼 간 상관관계가 의미 있는 쌍을 찾아 정리해 주세요."],
                        ["차트", "첨부된 데이터를 가장 잘 보여주는 차트를 1~2종 추천하고, Python(matplotlib) 코드로 그려 주세요. Pyodide 가 자동 실행합니다."],
                      ] as const
                    ).map(([label, prompt]) => (
                      <button
                        key={label}
                        type="button"
                        className="attach-analysis-chip"
                        onClick={() => quickAnalyze(prompt)}
                        disabled={streaming || locked}
                        title={prompt}
                      >
                        {label}
                      </button>
                    ))}
                  </>
                )}
              </div>
            );
          })()}
          {(attachments.length > 0 || uploading) && (
            <div className="attachments">
              {attachments.length > 0 && (
                <div className="attachments-summary">
                  <span>
                    <IconPaperclip size={12} />{" "}
                    {attachments.length}개 첨부 · 총{" "}
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
                        <button
                          type="button"
                          className="attachment-thumb-btn"
                          onClick={() =>
                            setLightbox({
                              src: `data:${guessMime};base64,${a.image_b64}`,
                              name: basename,
                            })
                          }
                          title="크게 보기"
                        >
                          <img
                            className="attachment-thumb"
                            src={`data:${guessMime};base64,${a.image_b64}`}
                            alt=""
                            loading="lazy"
                          />
                        </button>
                      ) : (
                        <span className="attachment-icon" aria-hidden="true">
                          <IconFileText size={18} />
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
          <SlashPromptPicker
            open={slashOpen}
            query={slashQuery}
            onPick={(body) => {
              setPrompt(body);
              setSlashOpen(false);
              window.setTimeout(() => textareaRef.current?.focus(), 0);
            }}
            onClose={() => setSlashOpen(false)}
          />
          <textarea
            ref={textareaRef}
            value={prompt}
            placeholder={
              attachments.length > 0
                ? "예) 요약해줘 · 오타 찾아줘 · 핵심만 알려줘 · 표로 정리해줘 · /병합 [제목] 으로 한 파일 합치기"
                : "무엇이든 물어보세요. / 를 누르면 프롬프트 라이브러리, Ctrl+V 로 이미지 붙여넣기."
            }
            onChange={(e) => {
              const v = e.target.value;
              setPrompt(v);
              // 첫 글자 `/` 면 picker 띄움. 이후 입력은 search query.
              const startsWithSlash = v.startsWith("/");
              setSlashOpen(startsWithSlash);
              setSlashQuery(startsWithSlash ? v.slice(1).trim() : "");
            }}
            onPaste={handleClipboardPaste}
            onKeyDown={(e) => {
              if (slashOpen && e.key === "Escape") {
                setSlashOpen(false);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !slashOpen) {
                e.preventDefault();
                if (locked) return;
                send();
              }
            }}
            disabled={streaming || locked}
            rows={1}
          />
          {locked && (
            <div className="composer-locked-banner">
              🔒 대화 잠금 중 — 헤더의 자물쇠를 다시 눌러 해제하면 보낼 수 있어요.
            </div>
          )}
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
              <button
                type="button"
                className="shop-toggle"
                onClick={() => setShopBrowserOpen(true)}
                disabled={streaming}
                title="쇼핑몰 상품 검색 — Naver Shopping API"
              >
                🛒 <span>쇼핑</span>
              </button>
              <div className="composer-tone-wrap" ref={toneRef}>
                <button
                  type="button"
                  className={`composer-tone-btn${tone !== "default" ? " picked" : ""}`}
                  onClick={() => setToneOpen((v) => !v)}
                  disabled={streaming}
                  title="AI 말투 — 다음 메시지에 적용"
                  aria-haspopup="menu"
                  aria-expanded={toneOpen}
                >
                  말투: {TONE_LABEL[tone]} ▾
                </button>
                {toneOpen && (
                  <div className="composer-tone-pop" role="menu">
                    {(
                      [
                        ["default", "기본"],
                        ["formal", "격식체 / 존댓말"],
                        ["casual", "친근한 반말"],
                        ["brief", "짧게 (3~5줄)"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        role="menuitem"
                        className={tone === key ? "picked" : ""}
                        onClick={() => {
                          setTone(key);
                          setToneOpen(false);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="composer-right">
              <MicButton
                disabled={streaming || uploading}
                onTranscribed={(text) => {
                  setPrompt((cur) => (cur ? cur + " " + text : text));
                  window.setTimeout(() => textareaRef.current?.focus(), 0);
                }}
              />
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
                  onClick={() => send()}
                  disabled={uploading || !prompt.trim() || !activeProvider || locked}
                  aria-label="전송"
                  title={locked ? "대화 잠금 중" : "전송"}
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
      <ShoppingBrowser
        open={shopBrowserOpen}
        onClose={() => setShopBrowserOpen(false)}
        onSendToChat={(text) => {
          // composer 에 prefill 하고 즉시 send — 사용자가 한 번 더
          // 확인하길 원하면 send 대신 setPrompt 만 호출하도록 바꿀 수
          // 있다. 현재는 모달에서 이미 선택을 했으므로 자동 전송.
          send(text);
        }}
      />
      {lightbox && (
        <div
          className="image-lightbox-backdrop"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            className="image-lightbox-close"
            onClick={() => setLightbox(null)}
            aria-label="닫기"
          >
            ✕
          </button>
          <img
            className="image-lightbox-img"
            src={lightbox.src}
            alt={lightbox.name}
            onClick={(e) => e.stopPropagation()}
          />
          <a
            className="image-lightbox-download"
            href={lightbox.src}
            download={lightbox.name}
            onClick={(e) => e.stopPropagation()}
          >
            💾 저장
          </a>
        </div>
      )}
      {commentsOpen && (
        <CommentThread
          targetType="session"
          targetId={session.id}
          onClose={() => setCommentsOpen(false)}
        />
      )}
    </div>
  );
});

/** Centered greeting shown in an empty chat (no messages yet) —
 *  picks a Korean time-of-day greeting and addresses the user by
 *  name when we have one. Mirrors the way Claude opens a fresh
 *  conversation. */






