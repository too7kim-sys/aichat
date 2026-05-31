import { lazy, Suspense, useEffect, useState } from "react";

const DiffEditor = lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor }))
);

interface Props {
  filename: string;
  /** Proposed new content. */
  next: string;
  /** Existing content, or null if the file doesn't exist yet. */
  current: string | null;
  language: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DiffPreview({
  filename,
  next,
  current,
  language,
  onCancel,
  onConfirm,
}: Props) {
  // Esc cancels, Cmd/Ctrl+Enter confirms.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onConfirm();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  const isNew = current === null;

  return (
    <div className="diff-backdrop" onClick={onCancel}>
      <div className="diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diff-header">
          <div>
            <span className="diff-title">{filename}</span>
            <span className={`diff-badge ${isNew ? "new" : "modify"}`}>
              {isNew ? "새 파일" : "수정"}
            </span>
          </div>
          <button className="diff-close" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="diff-body">
          <Suspense
            fallback={
              <div className="diff-loading">
                <span className="spinner" /> 에디터 로딩 중...
              </div>
            }
          >
            <DiffEditor
              height="100%"
              original={current ?? ""}
              modified={next}
              language={language}
              theme="vs"
              options={{
                readOnly: true,
                renderSideBySide: true,
                originalEditable: false,
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 13,
                scrollBeyondLastLine: false,
              }}
            />
          </Suspense>
        </div>
        <div className="diff-footer">
          <div className="diff-hint">
            <kbd>Esc</kbd> 취소 · <kbd>Ctrl+Enter</kbd> 저장
          </div>
          <div className="diff-actions">
            <button onClick={onCancel}>취소</button>
            <button className="primary" onClick={onConfirm}>
              {isNew ? "새 파일로 저장" : "변경사항 저장"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface DiffRequest {
  filename: string;
  proposed: string;
  language: string;
}

interface State {
  request: DiffRequest;
  current: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Hook used by App to drive the modal. Calling open(request, fetchCurrent)
 * displays the modal once the current content is loaded; the returned
 * Promise resolves to true if the user confirmed.
 */
export function useDiffPreview() {
  const [state, setState] = useState<State | null>(null);
  const [resolver, setResolver] = useState<((ok: boolean) => void) | null>(null);

  async function open(
    request: DiffRequest,
    fetchCurrent: () => Promise<string | null>
  ): Promise<boolean> {
    setState({ request, current: null, loading: true, error: null });
    try {
      const current = await fetchCurrent();
      setState({ request, current, loading: false, error: null });
    } catch (e) {
      setState({
        request,
        current: null,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return new Promise<boolean>((res) => setResolver(() => res));
  }

  function cancel() {
    resolver?.(false);
    setResolver(null);
    setState(null);
  }
  function confirm() {
    resolver?.(true);
    setResolver(null);
    setState(null);
  }

  const node =
    state === null ? null : state.loading ? (
      <div className="diff-backdrop">
        <div className="diff-modal small">
          <div className="diff-loading">
            <span className="spinner" /> 기존 파일 읽는 중...
          </div>
        </div>
      </div>
    ) : state.error ? (
      <div className="diff-backdrop" onClick={cancel}>
        <div className="diff-modal small" onClick={(e) => e.stopPropagation()}>
          <div className="diff-loading">파일 읽기 실패: {state.error}</div>
          <div className="diff-actions">
            <button className="primary" onClick={confirm}>
              그대로 저장
            </button>
            <button onClick={cancel}>취소</button>
          </div>
        </div>
      </div>
    ) : (
      <DiffPreview
        filename={state.request.filename}
        next={state.request.proposed}
        current={state.current}
        language={state.request.language}
        onCancel={cancel}
        onConfirm={confirm}
      />
    );

  return { open, node };
}
