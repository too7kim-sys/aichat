import type { Mode, Session } from "../types";

interface Props {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (mode: Mode) => void;
  onDelete: (id: string) => void;
}

export function Sidebar({ sessions, activeId, onSelect, onCreate, onDelete }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-actions">
        <button onClick={() => onCreate("single")}>+ 단일 채팅</button>
        <button onClick={() => onCreate("compare")}>+ 비교 채팅</button>
      </div>
      <ul className="session-list">
        {sessions.map((s) => (
          <li
            key={s.id}
            className={s.id === activeId ? "active" : ""}
            onClick={() => onSelect(s.id)}
          >
            <span className="session-title">{s.title}</span>
            <span className={`session-mode ${s.mode}`}>{s.mode}</span>
            <button
              className="delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
