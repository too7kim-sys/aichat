import { useState } from "react";
import { useProject, type ProjectTreeNode } from "./ProjectContext";
import { readFileText, type ProjectFile } from "./fsAccess";

interface Props {
  onOpenFile: (file: ProjectFile, content: string) => void;
  onAddToContext: (file: ProjectFile, content: string) => void;
}

export function ProjectPanel({ onOpenFile, onAddToContext }: Props) {
  const { supported, root, rootName, tree, busy, error, pick, refresh, clear } =
    useProject();

  if (!supported) {
    const insecure =
      typeof window !== "undefined" &&
      !window.isSecureContext &&
      window.location.hostname !== "localhost" &&
      window.location.hostname !== "127.0.0.1";
    return (
      <div className="project-panel">
        {insecure ? (
          <p className="project-unsupported">
            File System Access API는 HTTPS 또는 localhost에서만 동작합니다.
            <br />
            지금은 평문 HTTP로 LAN IP에 접속 중이라 브라우저가 막고 있어요.
            <br />
            <br />
            해결책:
            <br />
            ① 같은 PC에서 <code>http://localhost:5173</code> 으로 접속
            <br />
            ② Vite를 HTTPS로 기동:{" "}
            <code>DEV_HTTPS=1 npm run dev</code>
            <br />
            ③ Chrome 플래그로 이 origin만 임시 허용:{" "}
            <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>
            에 <code>{window.location.origin}</code> 추가
          </p>
        ) : (
          <p className="project-unsupported">
            이 브라우저는 File System Access API를 지원하지 않습니다.
            <br />
            Chrome 또는 Edge 최신 버전에서 사용해 주세요.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="project-panel">
      <div className="project-toolbar">
        {!root ? (
          <button className="primary" onClick={pick}>
            폴더 선택
          </button>
        ) : (
          <>
            <span className="project-root" title={rootName}>
              {rootName}
            </span>
            <button onClick={refresh} title="다시 읽기" disabled={busy}>
              {busy ? "..." : "↻"}
            </button>
            <button onClick={clear} title="닫기">
              ×
            </button>
          </>
        )}
      </div>

      {error && <div className="project-error">{error}</div>}

      {root && (
        <ul className="project-tree">
          {tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              onOpenFile={onOpenFile}
              onAddToContext={onAddToContext}
            />
          ))}
        </ul>
      )}

      {!root && !error && (
        <p className="project-hint">
          폴더를 선택하면 트리가 표시됩니다.
          <br />
          파일을 열어 보거나 채팅 컨텍스트에 추가할 수 있어요.
        </p>
      )}
    </div>
  );
}

function TreeNode({
  node,
  onOpenFile,
  onAddToContext,
  depth = 0,
}: {
  node: ProjectTreeNode;
  onOpenFile: (file: ProjectFile, content: string) => void;
  onAddToContext: (file: ProjectFile, content: string) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth < 1);

  if (node.kind === "dir") {
    return (
      <li className="tree-dir">
        <div
          className="tree-row"
          style={{ paddingLeft: depth * 12 + 6 }}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tree-caret">{open ? "▾" : "▸"}</span>
          <span className="tree-name">{node.name}</span>
        </div>
        {open && node.children && node.children.length > 0 && (
          <ul>
            {node.children.map((c) => (
              <TreeNode
                key={c.path}
                node={c}
                depth={depth + 1}
                onOpenFile={onOpenFile}
                onAddToContext={onAddToContext}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  // file
  async function openFile() {
    if (!node.file) return;
    try {
      const text = await readFileText(node.file);
      onOpenFile(node.file, text);
    } catch (e) {
      alert(`파일 열기 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function addToContext(e: React.MouseEvent) {
    e.stopPropagation();
    if (!node.file) return;
    try {
      const text = await readFileText(node.file);
      onAddToContext(node.file, text);
    } catch (err) {
      alert(`컨텍스트 추가 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <li className="tree-file">
      <div
        className="tree-row"
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={openFile}
        title={node.path}
      >
        <span className="tree-caret" />
        <span className="tree-name">{node.name}</span>
        <button
          className="tree-add"
          onClick={addToContext}
          title="채팅 컨텍스트에 추가"
        >
          +
        </button>
      </div>
    </li>
  );
}
