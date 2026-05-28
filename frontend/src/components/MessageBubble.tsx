interface Props {
  role: "user" | "assistant";
  provider?: string | null;
  content: string;
  streaming?: boolean;
}

export function MessageBubble({ role, provider, content, streaming }: Props) {
  return (
    <div className={`bubble ${role}`}>
      {role === "assistant" && provider && (
        <div className="bubble-header">{provider}</div>
      )}
      <div className="bubble-content">
        {content}
        {streaming && <span className="cursor">▍</span>}
      </div>
    </div>
  );
}
