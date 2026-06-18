import { useEffect, useMemo, useState } from "react";
import { api, type Prompt, type Project, type Workflow } from "../api/client";
import { IconAlertTriangle, IconPlus, IconTrash, IconX } from "./Icon";
import { WorkflowRunsPanel } from "./CoworkPanels";

interface Props {
  /** null = create-new; Workflow = edit existing. */
  workflow: Workflow | null;
  /** Prompt + project catalog used to populate the dropdowns. The
   *  parent already needs these for its listing so it just hands them
   *  through instead of refetching. */
  prompts: Prompt[];
  projects: Project[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onDeleted?: () => void | Promise<void>;
}

/** Schedule presets matching the same wall-clock alignment the RAG
 *  scheduler uses — 0 disables, daily fires at the configured "새벽"
 *  hour, sub-day intervals fire on boundaries. */
const SCHEDULE_PRESETS: { label: string; mins: number }[] = [
  { label: "수동", mins: 0 },
  { label: "10분", mins: 10 },
  { label: "30분", mins: 30 },
  { label: "1시간", mins: 60 },
  { label: "6시간", mins: 60 * 6 },
  { label: "1일", mins: 60 * 24 },
];

/** Create / edit dialog for a single workflow. Picks a prompt, sets
 *  the {var} substitutions, optionally pins a RAG project for
 *  retrieval-augmented runs, and configures the auto-schedule. */
export function WorkflowEditModal({
  workflow,
  prompts,
  projects,
  onClose,
  onSaved,
  onDeleted,
}: Props) {
  const isNew = workflow === null;
  const [name, setName] = useState(workflow?.name ?? "");
  const [description, setDescription] = useState(workflow?.description ?? "");
  const [promptId, setPromptId] = useState(workflow?.prompt_id ?? "");
  const [projectId, setProjectId] = useState(workflow?.project_id ?? "");
  const [model, setModel] = useState(workflow?.model ?? "");
  const [scheduleMins, setScheduleMins] = useState(
    workflow?.schedule_interval_minutes ?? 0,
  );
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);
  const [skipHolidays, setSkipHolidays] = useState(workflow?.skip_holidays ?? false);
  const [teamId, setTeamId] = useState<string>(workflow?.team_id ?? "");
  const [requiresApproval, setRequiresApproval] = useState<boolean>(
    workflow?.requires_approval ?? false,
  );
  const [runsOpen, setRunsOpen] = useState(false);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api.listTeams().then((r) => setTeams(r.map((t) => ({ id: t.id, name: t.name })))).catch(() => setTeams([]));
  }, []);
  // {var_name: value} editor — variables are detected from the
  // selected prompt's body and rendered as key-value rows so the
  // operator only fills in the placeholders the run actually needs.
  const [promptVars, setPromptVars] = useState<Record<string, string>>(
    (workflow?.prompt_vars as Record<string, string>) ?? {},
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Detect {var} placeholders in the selected prompt's body so we
  // can pre-seed empty rows for each — the operator fills them and
  // the runner does the substitution at execution time.
  const selectedPrompt = prompts.find((p) => p.id === promptId);
  const detectedVars = useMemo(() => {
    if (!selectedPrompt) return [] as string[];
    const set = new Set<string>();
    const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(selectedPrompt.body)) !== null) {
      set.add(m[1]);
    }
    return Array.from(set);
  }, [selectedPrompt]);

  async function submit() {
    if (!name.trim()) {
      setErr("이름을 입력하세요");
      return;
    }
    if (!promptId) {
      setErr("프롬프트를 선택하세요");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Drop empty vars so the runner falls back to the prompt's own
      // default literal (the {var} stays as-is in the rendered body).
      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(promptVars)) {
        if (v && v.trim()) vars[k] = v;
      }
      if (isNew) {
        await api.createWorkflow({
          name: name.trim(),
          description: description.trim(),
          prompt_id: promptId,
          prompt_vars: Object.keys(vars).length > 0 ? vars : null,
          project_id: projectId || null,
          model: model.trim() || null,
          schedule_interval_minutes: scheduleMins,
          enabled,
          skip_holidays: skipHolidays,
          team_id: teamId || null,
          requires_approval: requiresApproval,
        });
      } else {
        await api.updateWorkflow(workflow!.id, {
          name: name.trim(),
          description: description.trim(),
          prompt_id: promptId,
          prompt_vars: Object.keys(vars).length > 0 ? vars : null,
          project_id: projectId || null,
          model: model.trim() || null,
          schedule_interval_minutes: scheduleMins,
          enabled,
          skip_holidays: skipHolidays,
          team_id: teamId || null,
          requires_approval: requiresApproval,
        });
      }
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!workflow) return;
    if (!window.confirm(`"${workflow.name}" 워크플로를 삭제할까요?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteWorkflow(workflow.id);
      await onDeleted?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
    {runsOpen && workflow && (
      <WorkflowRunsPanel
        workflowId={workflow.id}
        onClose={() => setRunsOpen(false)}
      />
    )}
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal cp-edit-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pm-head">
          <div className="pm-head-text">
            <h3>{isNew ? "새 워크플로" : "워크플로 편집"}</h3>
            <p>
              프롬프트와 (선택) 지식베이스를 묶어 정해진 시각에 자동으로
              실행됩니다. 결과는 새 채팅 세션으로 남습니다.
            </p>
          </div>
          <div className="pm-head-right">
            <button
              type="button"
              className="modal-close"
              onClick={onClose}
              aria-label="닫기"
            >
              <IconX size={18} />
            </button>
          </div>
        </header>

        <div className="cp-edit-body">
          <div className="pm-field">
            <label htmlFor="wf-name">이름</label>
            <input
              id="wf-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={busy}
              autoFocus
              placeholder="예: 일일 보안 점검"
            />
          </div>
          <div className="pm-field">
            <label htmlFor="wf-desc">설명 (선택)</label>
            <input
              id="wf-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              disabled={busy}
            />
          </div>
          <div className="pm-field">
            <label htmlFor="wf-prompt">프롬프트</label>
            <select
              id="wf-prompt"
              value={promptId}
              onChange={(e) => setPromptId(e.target.value)}
              disabled={busy}
            >
              <option value="">— 프롬프트 선택 —</option>
              {prompts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.category ? ` [${p.category}]` : ""}
                  {!p.owned ? " (공유)" : ""}
                </option>
              ))}
            </select>
            {selectedPrompt && (
              <div className="pm-help">
                {selectedPrompt.description ||
                  selectedPrompt.body.slice(0, 120) +
                    (selectedPrompt.body.length > 120 ? "…" : "")}
              </div>
            )}
          </div>

          {detectedVars.length > 0 && (
            <div className="pm-field">
              <label>프롬프트 변수</label>
              <div className="wf-vars">
                {detectedVars.map((v) => (
                  <div key={v} className="wf-vars-row">
                    <span className="wf-vars-name">{v}</span>
                    <input
                      type="text"
                      value={promptVars[v] ?? ""}
                      onChange={(e) =>
                        setPromptVars((prev) => ({
                          ...prev,
                          [v]: e.target.value,
                        }))
                      }
                      disabled={busy}
                      placeholder={`{${v}} 자리에 들어갈 값`}
                    />
                  </div>
                ))}
              </div>
              <div className="pm-help">
                비워두면 프롬프트의 {"{변수명}"} 표기가 그대로 남습니다.
              </div>
            </div>
          )}

          <div className="pm-field-row">
            <div className="pm-field">
              <label htmlFor="wf-project">지식베이스 (선택)</label>
              <select
                id="wf-project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={busy}
              >
                <option value="">— 사용 안 함 —</option>
                {projects
                  .filter((p) => p.status === "ready")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="pm-field">
              <label htmlFor="wf-model">모델 (선택)</label>
              <input
                id="wf-model"
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                maxLength={120}
                disabled={busy}
                placeholder="비우면 기본 모델"
              />
            </div>
          </div>

          <div className="pm-field-row">
            <div className="pm-field">
              <label htmlFor="wf-team">공유 팀 (선택)</label>
              <select
                id="wf-team"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                disabled={busy}
              >
                <option value="">— 개인 워크플로 —</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <div className="pm-help">
                팀을 지정하면 팀원이 실행 이력·결과를 볼 수 있습니다.
              </div>
            </div>
            <div className="pm-field">
              <label className="pm-share-toggle" style={{ marginTop: 24 }}>
                <input
                  type="checkbox"
                  checked={requiresApproval}
                  onChange={(e) => setRequiresApproval(e.target.checked)}
                  disabled={busy}
                />
                <span>
                  <b>실행 전 승인 필요</b>
                  <span className="pm-help">
                    팀장(또는 관리자)이 승인해야 자동 실행이 시작됩니다.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="pm-field">
            <label>자동 실행 주기</label>
            <div className="pm-sched-presets">
              {SCHEDULE_PRESETS.map((s) => (
                <button
                  key={s.mins}
                  type="button"
                  className={`pm-sched-pill${
                    scheduleMins === s.mins ? " active" : ""
                  }`}
                  onClick={() => setScheduleMins(s.mins)}
                  disabled={busy}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <label className="pm-share-toggle" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                disabled={busy}
              />
              <span>
                <b>활성화</b>
                <span className="pm-help">
                  비활성화하면 예약 시간이 와도 실행되지 않습니다.
                </span>
              </span>
            </label>
            <label className="pm-share-toggle" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={skipHolidays}
                onChange={(e) => setSkipHolidays(e.target.checked)}
                disabled={busy}
              />
              <span>
                <b>공휴일 자동 실행 안 함</b>
                <span className="pm-help">
                  한국 공휴일 + 사내 휴일(.env WORKFLOW_EXTRA_HOLIDAYS) 인
                  날에는 스케줄이 와도 건너뜁니다.
                </span>
              </span>
            </label>
          </div>

          {err && (
            <div className="pm-add-error">
              <IconAlertTriangle size={14} />
              <span>{err}</span>
            </div>
          )}

          <div className="cp-edit-actions">
            {!isNew && (
              <>
                <button
                  type="button"
                  className="pm-btn-secondary cp-edit-delete"
                  onClick={remove}
                  disabled={busy}
                >
                  <IconTrash size={13} /> 삭제
                </button>
                <button
                  type="button"
                  className="pm-btn-secondary"
                  onClick={() => setRunsOpen(true)}
                  disabled={busy}
                  title="이 워크플로의 실행 이력 보기"
                >
                  📜 실행 이력
                </button>
              </>
            )}
            <div className="cp-edit-actions-right">
              <button
                type="button"
                className="pm-btn-secondary"
                onClick={onClose}
                disabled={busy}
              >
                취소
              </button>
              <button
                type="button"
                className="pm-btn-primary"
                onClick={submit}
                disabled={busy}
              >
                {busy ? "저장 중…" : isNew ? (
                  <>
                    <IconPlus size={13} /> 만들기
                  </>
                ) : "저장"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}

