import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, type OllamaModel } from "../api/client";
import { useAuth } from "../auth/AuthContext";

const PICK_KEY = "chat:ollama_model";

interface ModelState {
  models: OllamaModel[];
  selected: string;
  setSelected: (model: string) => void;
}

const Ctx = createContext<ModelState | null>(null);

export function ModelProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [models, setModels] = useState<OllamaModel[]>([]);
  // Hydrate the user's last pick so it survives reloads.
  const [selected, _setSelected] = useState<string>(
    () => localStorage.getItem(PICK_KEY) || ""
  );

  function setSelected(name: string) {
    _setSelected(name);
    if (name) localStorage.setItem(PICK_KEY, name);
    else localStorage.removeItem(PICK_KEY);
  }

  // Fetch the model list whenever the authenticated user changes.
  // Skipping when there is no user avoids a 401 on the very first page
  // load that would otherwise leave `models` empty even after sign-in.
  useEffect(() => {
    if (!user) return;
    api
      .listOllamaModels()
      .then((res) => {
        setModels(res.models);
        _setSelected((prev) => {
          if (prev && res.models.some((m) => m.name === prev)) return prev;
          return res.current;
        });
      })
      .catch(() => {
        /* Ollama unreachable; selector stays empty */
      });
  }, [user]);

  return (
    <Ctx.Provider value={{ models, selected, setSelected }}>
      {children}
    </Ctx.Provider>
  );
}

export function useModels(): ModelState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useModels must be inside ModelProvider");
  return v;
}
