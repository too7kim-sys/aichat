import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, type OllamaModel } from "../api/client";

interface ModelState {
  models: OllamaModel[];
  selected: string;
  setSelected: (model: string) => void;
}

const Ctx = createContext<ModelState | null>(null);

export function ModelProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [selected, setSelected] = useState<string>("");

  useEffect(() => {
    api
      .listOllamaModels()
      .then((res) => {
        setModels(res.models);
        setSelected((prev) => prev || res.current);
      })
      .catch(() => {
        /* Ollama unreachable; selector stays empty */
      });
  }, []);

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
