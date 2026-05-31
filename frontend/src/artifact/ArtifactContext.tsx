import { createContext, useContext, useState, type ReactNode } from "react";

export interface Artifact {
  id: string;
  title: string;
  language: string;
  code: string;
}

interface ArtifactState {
  artifacts: Artifact[];
  activeId: string | null;
  open: boolean;
  push: (a: Omit<Artifact, "id">) => string;
  remove: (id: string) => void;
  setActive: (id: string) => void;
  setOpen: (open: boolean) => void;
  updateCode: (id: string, code: string) => void;
  clear: () => void;
}

const Ctx = createContext<ArtifactState | null>(null);

let _id = 0;
function newId() {
  _id += 1;
  return `a-${Date.now().toString(36)}-${_id}`;
}

export function ArtifactProvider({ children }: { children: ReactNode }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  function push(a: Omit<Artifact, "id">) {
    const id = newId();
    setArtifacts((prev) => [...prev, { ...a, id }]);
    setActiveId(id);
    setOpen(true);
    return id;
  }

  function remove(id: string) {
    setArtifacts((prev) => {
      const next = prev.filter((a) => a.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
      if (next.length === 0) setOpen(false);
      return next;
    });
  }

  function updateCode(id: string, code: string) {
    setArtifacts((prev) =>
      prev.map((a) => (a.id === id ? { ...a, code } : a))
    );
  }

  function clear() {
    setArtifacts([]);
    setActiveId(null);
    setOpen(false);
  }

  return (
    <Ctx.Provider
      value={{
        artifacts,
        activeId,
        open,
        push,
        remove,
        setActive: setActiveId,
        setOpen,
        updateCode,
        clear,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useArtifacts(): ArtifactState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useArtifacts must be inside ArtifactProvider");
  return v;
}
