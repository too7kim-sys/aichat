/** 슬래시 명령 picker — composer textarea 가 "/" 로 시작할 때 떠서
 *  저장된 프롬프트(시스템 + 매크로) 를 검색·선택. 클릭 시 textarea
 *  에 본문 채워짐.  매크로 인라인 추가 폼 포함. */
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { errorToast } from "../../lib/toast";

export function SlashPromptPicker({
  open,
  query,
  onPick,
  onClose,
}: {
  open: boolean;
  query: string;
  onPick: (body: string) => void;
  onClose: () => void;
}) {
  const [prompts, setPrompts] = useState<Awaited<ReturnType<typeof api.listPrompts>>>([]);
  const [macros, setMacros] = useState<Awaited<ReturnType<typeof api.listMacros>>>([]);
  // 시스템(팀) 매크로 (#48) — 관리자가 등록, 모두 사용 가능.
  const [sysMacros, setSysMacros] = useState<Awaited<ReturnType<typeof api.listSystemMacros>>>([]);
  // 매크로 추가 인라인 폼 (#33).
  const [adding, setAdding] = useState(false);
  const [macroName, setMacroName] = useState("");
  const [macroBody, setMacroBody] = useState("");
  async function refreshMacros() {
    try {
      setMacros(await api.listMacros());
    } catch {
      setMacros([]);
    }
    try {
      setSysMacros(await api.listSystemMacros());
    } catch {
      setSysMacros([]);
    }
  }
  useEffect(() => {
    if (!open) return;
    api.listPrompts().then(setPrompts).catch(() => setPrompts([]));
    refreshMacros();
  }, [open]);
  if (!open) return null;

  const q = query.toLowerCase().trim();
  const filteredPrompts = prompts
    .filter((p) => {
      if (!q) return true;
      return (
        p.code.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        (p.tags || "").toLowerCase().includes(q)
      );
    })
    .slice(0, 8);
  const filteredMacros = macros
    .filter((m) => !q || m.name.toLowerCase().includes(q))
    .slice(0, 8);
  const filteredSysMacros = sysMacros
    .filter((m) => !q || m.name.toLowerCase().includes(q))
    .slice(0, 8);

  async function saveMacro() {
    const name = macroName.trim();
    const body = macroBody.trim();
    if (!name || !body) return;
    try {
      await api.createMacro(name, body);
      setMacroName("");
      setMacroBody("");
      setAdding(false);
      await refreshMacros();
    } catch (e) {
      errorToast("매크로 저장 실패", e);
    }
  }
  async function removeMacro(id: string) {
    if (!window.confirm("이 매크로를 삭제할까요?")) return;
    try {
      await api.deleteMacro(id);
      await refreshMacros();
    } catch (e) {
      errorToast("매크로 삭제 실패", e);
    }
  }

  return (
    <div className="slash-picker" role="listbox">
      <div className="slash-picker-head">
        <span>📚 프롬프트 + ⌨ 내 매크로</span>
        <span className="slash-picker-hint">Esc 닫기</span>
      </div>
      {filteredSysMacros.length > 0 && (
        <>
          <div className="slash-picker-sec">팀 공통 매크로</div>
          <ul>
            {filteredSysMacros.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onPick(m.body)}>
                  <div className="slash-picker-name">
                    <code>/{m.name}</code>
                    <span className="slash-picker-badge">팀</span>
                  </div>
                  <div className="slash-picker-snippet">
                    {m.body.slice(0, 120)}
                    {m.body.length > 120 ? "…" : ""}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {filteredMacros.length > 0 && (
        <>
          <div className="slash-picker-sec">내 매크로</div>
          <ul>
            {filteredMacros.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onPick(m.body)}>
                  <div className="slash-picker-name">
                    <code>/{m.name}</code>
                  </div>
                  <div className="slash-picker-snippet">
                    {m.body.slice(0, 120)}
                    {m.body.length > 120 ? "…" : ""}
                  </div>
                </button>
                <button
                  type="button"
                  className="slash-picker-del"
                  title="삭제"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeMacro(m.id);
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {filteredPrompts.length > 0 && (
        <>
          <div className="slash-picker-sec">시스템 프롬프트</div>
          <ul>
            {filteredPrompts.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => onPick(p.body)}>
                  <div className="slash-picker-name">
                    <code>/{p.code}</code> {p.name}
                  </div>
                  <div className="slash-picker-snippet">
                    {p.body.slice(0, 120)}
                    {p.body.length > 120 ? "…" : ""}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {filteredMacros.length === 0 && filteredPrompts.length === 0 && (
        <div className="slash-picker-empty">
          {prompts.length + macros.length === 0
            ? "프롬프트·매크로가 비어 있어요. 아래에서 첫 매크로를 추가해 보세요."
            : `"${query}" 일치 없음`}
        </div>
      )}
      {adding ? (
        <div className="slash-picker-add">
          <input
            placeholder="단축어 (예: 내인사)"
            value={macroName}
            onChange={(e) => setMacroName(e.target.value)}
            maxLength={80}
            autoFocus
          />
          <textarea
            placeholder="이 단축어로 채워질 본문"
            value={macroBody}
            onChange={(e) => setMacroBody(e.target.value)}
            rows={3}
          />
          <div className="slash-picker-add-actions">
            <button type="button" onClick={() => setAdding(false)}>
              취소
            </button>
            <button
              type="button"
              className="primary"
              onClick={saveMacro}
              disabled={!macroName.trim() || !macroBody.trim()}
            >
              저장
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="slash-picker-add-btn"
          onClick={() => setAdding(true)}
        >
          ⌨ 매크로 추가
        </button>
      )}
      <button
        type="button"
        className="slash-picker-close"
        onClick={onClose}
        aria-label="닫기"
      >
        ✕
      </button>
    </div>
  );
}
