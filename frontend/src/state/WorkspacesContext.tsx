import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, type Workspace } from "../api/client";
import { useAuth } from "../auth/AuthContext";

interface WorkspacesState {
  workspaces: Workspace[];
  refresh: () => Promise<void>;
  create: (payload: {
    name: string;
    source_type?: "git" | "local";
    git_url?: string;
    branch?: string;
    auth_username?: string;
    auth_token?: string;
    local_path?: string;
  }) => Promise<Workspace>;
  remove: (id: string) => Promise<{ freedBytes: number }>;
  sync: (id: string) => Promise<void>;
}

const Ctx = createContext<WorkspacesState | null>(null);

export function WorkspacesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listWorkspaces();
      setWorkspaces(list);
    } catch {
      /* unauthorized / route missing */
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setWorkspaces([]);
      return;
    }
    refresh();
  }, [user, refresh]);

  // Poll while any clone or sync is in flight so the status badge
  // tracks live progress without a manual refresh.
  useEffect(() => {
    const busy = workspaces.some((w) => w.status === "cloning");
    if (!busy) {
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
  }, [workspaces, refresh]);

  const create = useCallback<WorkspacesState["create"]>(
    async (payload) => {
      const created = await api.createWorkspace(payload);
      await refresh();
      return created;
    },
    [refresh],
  );
  const remove = useCallback<WorkspacesState["remove"]>(
    async (id) => {
      const res = await api.deleteWorkspace(id);
      await refresh();
      return { freedBytes: res?.freed_bytes ?? 0 };
    },
    [refresh],
  );
  const sync = useCallback<WorkspacesState["sync"]>(
    async (id) => {
      await api.syncWorkspace(id);
      await refresh();
    },
    [refresh],
  );

  return (
    <Ctx.Provider value={{ workspaces, refresh, create, remove, sync }}>
      {children}
    </Ctx.Provider>
  );
}

export function useWorkspaces(): WorkspacesState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspaces must be inside WorkspacesProvider");
  return v;
}
