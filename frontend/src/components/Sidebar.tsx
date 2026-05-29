import type { Mode, Session } from "../types";

interface Props {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (mode: Mode) => void;
  onDelete: (id: string) => void;
}

function groupByDate(sessions: Session[]) {
  const now = Date.now();
  const today: Session[] = [];
  const yesterday: Session[] = [];
  const lastWeek: Session[] = [];
  const earlier: Session[] = [];

  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;

  for (const s of sessions) {
    const t = new Date(s.updated_at).getTime();
    if (t >= todayStart) today.push(s);
    else if (t >= yesterdayStart) yesterday.push(s);
    else if (t >= weekStart) lastWeek.push(s);
    else earlier.push(s);
  }
  return { today, yesterday, lastWeek, earlier };
}

export function Sidebar({ sessions, activeId, onSelect, onCreate, onDelete }: Props) {
  const groups = groupByDate(sessions);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">Multi-LLM Chat</div>
      <div className="sidebar-actions">
        <button className="primary" onClick={() => onCreate("single")}>
          + 새 대화
        </button>
        <button onClick={() => onCreate("compare")}>+ 비교 대화</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <SessionGroup label="오늘" sessions={groups.today} {...{ activeId, onSelect, onDelete }} />
        <SessionGroup label="어제" sessions={groups.yesterday} {...{ activeId, onSelect, onDelete }} />
        <SessionGroup label="지난 7일" sessions={groups.lastWeek} {...{ activeId, onSelect, onDelete }} />
        <SessionGroup label="이전" sessions={groups.earlier} {...{ activeId, onSelect, onDelete }} />
      </div>
    </aside>
  );
}

function SessionGroup({
  label,
  sessions,
  activeId,
  onSelect,
  onDelete,
}: {
  label: string;
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <>
      <div className="session-section">{label}</div>
      <ul className="session-list">
        {sessions.map((s) => (
          <li
            key={s.id}
            className={s.id === activeId ? "active" : ""}
            onClick={() => onSelect(s.id)}
          >
            <span className="session-title">{s.title}</span>
            {s.mode === "compare" && <span className="session-mode">비교</span>}
            <button
              className="delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
              aria-label="삭제"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
