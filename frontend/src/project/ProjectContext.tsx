import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import {
  buildTree,
  isFsAccessSupported,
  pickProjectRoot,
  type ProjectFile,
  type ProjectTreeNode,
} from "./fsAccess";

interface ProjectState {
  supported: boolean;
  root: FileSystemDirectoryHandle | null;
  rootName: string;
  tree: ProjectTreeNode[];
  busy: boolean;
  error: string | null;
  pick: () => Promise<void>;
  refresh: () => Promise<void>;
  clear: () => void;
}

const Ctx = createContext<ProjectState | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
  const [rootName, setRootName] = useState("");
  const [tree, setTree] = useState<ProjectTreeNode[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!root) return;
    setBusy(true);
    setError(null);
    try {
      const nodes = await buildTree(root);
      setTree(nodes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [root]);

  const pick = useCallback(async () => {
    setError(null);
    try {
      const handle = await pickProjectRoot();
      setRoot(handle);
      setRootName(handle.name);
      setBusy(true);
      const nodes = await buildTree(handle);
      setTree(nodes);
    } catch (e) {
      // AbortError from cancel is expected
      if (e instanceof Error && e.name !== "AbortError") {
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(() => {
    setRoot(null);
    setRootName("");
    setTree([]);
    setError(null);
  }, []);

  return (
    <Ctx.Provider
      value={{
        supported: isFsAccessSupported(),
        root,
        rootName,
        tree,
        busy,
        error,
        pick,
        refresh,
        clear,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useProject(): ProjectState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProject must be inside ProjectProvider");
  return v;
}

export type { ProjectFile, ProjectTreeNode };
