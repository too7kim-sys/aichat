import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  type CorpusType,
  type Project,
  type SourceType,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";

interface ProjectsState {
  projects: Project[];
  storageBytes: number;
  refresh: () => Promise<void>;
  create: (payload: {
    name: string;
    source_type: SourceType;
    source_ref: string;
    ref?: string;
    corpus_type?: CorpusType;
    sql_query?: string | null;
  }) => Promise<Project>;
  remove: (id: string) => Promise<{ freedBytes: number }>;
  reindex: (id: string) => Promise<void>;
  activateSnapshot: (projectId: string, snapshotId: string) => Promise<void>;
  deleteSnapshot: (
    projectId: string,
    snapshotId: string,
  ) => Promise<{ freedBytes: number }>;
  refreshProject: (projectId: string) => Promise<void>;
  setSchedule: (
    projectId: string,
    intervalMinutes: number,
  ) => Promise<void>;
}

const Ctx = createContext<ProjectsState | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [storageBytes, setStorageBytes] = useState<number>(0);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, storage] = await Promise.all([
        api.listProjects(),
        api.projectStorage().catch(() => ({ total_bytes: 0, project_count: 0 })),
      ]);
      setProjects(list);
      setStorageBytes(storage.total_bytes);
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
      const res = await api.deleteProject(id);
      await refresh();
      return { freedBytes: res?.freed_bytes ?? 0 };
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

  const activateSnapshot = useCallback<ProjectsState["activateSnapshot"]>(
    async (projectId, snapshotId) => {
      await api.activateSnapshot(projectId, snapshotId);
      await refresh();
    },
    [refresh],
  );

  const deleteSnapshot = useCallback<ProjectsState["deleteSnapshot"]>(
    async (projectId, snapshotId) => {
      const res = await api.deleteSnapshot(projectId, snapshotId);
      await refresh();
      return { freedBytes: res?.freed_bytes ?? 0 };
    },
    [refresh],
  );

  const refreshProject = useCallback<ProjectsState["refreshProject"]>(
    async (projectId) => {
      await api.refreshProject(projectId);
      await refresh();
    },
    [refresh],
  );

  const setSchedule = useCallback<ProjectsState["setSchedule"]>(
    async (projectId, intervalMinutes) => {
      await api.setProjectSchedule(projectId, intervalMinutes);
      await refresh();
    },
    [refresh],
  );

  return (
    <Ctx.Provider
      value={{
        projects,
        storageBytes,
        refresh,
        create,
        remove,
        reindex,
        activateSnapshot,
        deleteSnapshot,
        refreshProject,
        setSchedule,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useProjects(): ProjectsState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProjects must be inside ProjectsProvider");
  return v;
}
