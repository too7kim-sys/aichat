import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, type Project } from "../api/client";
import { useAuth } from "../auth/AuthContext";

interface ProjectsState {
  projects: Project[];
  refresh: () => Promise<void>;
  create: (payload: {
    name: string;
    source_type: "folder" | "git";
    source_ref: string;
    ref?: string;
  }) => Promise<Project>;
  remove: (id: string) => Promise<void>;
  reindex: (id: string) => Promise<void>;
}

const Ctx = createContext<ProjectsState | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list);
    } catch {
      /* unauthorized / RAG disabled — leave empty */
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setProjects([]);
      return;
    }
    refresh();
  }, [user, refresh]);

  // While any project is mid-indexing, poll for updated status. The
  // backend's indexer runs as a background task; the UI shows live
  // progress through this loop.
  useEffect(() => {
    const inFlight = projects.some(
      (p) => p.status === "pending" || p.status === "indexing",
    );
    if (!inFlight) {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(refresh, 2000);
    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [projects, refresh]);

  const create = useCallback<ProjectsState["create"]>(
    async (payload) => {
      const created = await api.createProject(payload);
      await refresh();
      return created;
    },
    [refresh],
  );

  const remove = useCallback<ProjectsState["remove"]>(
    async (id) => {
      await api.deleteProject(id);
      await refresh();
    },
    [refresh],
  );

  const reindex = useCallback<ProjectsState["reindex"]>(
    async (id) => {
      await api.reindexProject(id);
      await refresh();
    },
    [refresh],
  );

  return (
    <Ctx.Provider value={{ projects, refresh, create, remove, reindex }}>
      {children}
    </Ctx.Provider>
  );
}

export function useProjects(): ProjectsState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProjects must be inside ProjectsProvider");
  return v;
}
