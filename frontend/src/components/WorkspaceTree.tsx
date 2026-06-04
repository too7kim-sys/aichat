import { useEffect, useState } from "react";
import { api, type WorkspaceTreeEntry } from "../api/client";
import {
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconFolder,
} from "./Icon";

interface Props {
  workspaceId: string;
  activePath?: string | null;
  onSelectFile: (path: string) => void | Promise<void>;
  /** Bump this to force a tree refetch (e.g., after a workspace sync). */
  refreshKey?: number | string;
}

export function WorkspaceTree({
  workspaceId,
  activePath = null,
  onSelectFile,
  refreshKey,
}: Props) {
  const [tree, setTree] = useState<WorkspaceTreeEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .workspaceTree(workspaceId)
      .then((res) => {
        if (!cancelled) setTree(res.tree);
      })
      .catch(() => {
        if (!cancelled) setTree([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey]);

  if (loading)
    return <div className="ws-tree-loading">트리 로드 중…</div>;
  if (tree.length === 0)
    return <div className="ws-tree-loading">파일이 없습니다</div>;
  return (
    <TreeList
      items={tree}
      depth={0}
      activePath={activePath}
      onSelect={onSelectFile}
    />
  );
}

function TreeList({
  items,
  depth,
  activePath,
  onSelect,
}: {
  items: WorkspaceTreeEntry[];
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void | Promise<void>;
}) {
  return (
    <ul className="ws-tree-list">
      {items.map((e) => (
        <TreeNode
          key={e.path}
          entry={e}
          depth={depth}
          activePath={activePath}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  entry,
  depth,
  activePath,
  onSelect,
}: {
  entry: WorkspaceTreeEntry;
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(depth < 1);
  const pad = { paddingLeft: 8 + depth * 12 };

  if (entry.kind === "dir") {
    return (
      <li className="ws-tn dir">
        <button
          type="button"
          className="ws-tn-row"
          style={pad}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
          <IconFolder size={13} />
          <span className="ws-tn-name">{entry.name}</span>
        </button>
        {open && (
          <TreeList
            items={entry.children}
            depth={depth + 1}
            activePath={activePath}
            onSelect={onSelect}
          />
        )}
      </li>
    );
  }
  return (
    <li className="ws-tn file">
      <button
        type="button"
        className={`ws-tn-row${activePath === entry.path ? " active" : ""}`}
        style={pad}
        onClick={() => onSelect(entry.path)}
        title={entry.path}
      >
        <span className="ws-tn-bullet" aria-hidden />
        <IconFileText size={13} />
        <span className="ws-tn-name">{entry.name}</span>
      </button>
    </li>
  );
}
