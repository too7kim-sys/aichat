interface Props {
  role: "user" | "assistant";
  provider?: string | null;
  content: string;
  streaming?: boolean;
}

export function MessageBubble({ role, provider, content, streaming }: Props) {
  if (role === "user") {
    return (
      <div className="bubble user">
        {content}
        {streaming && <span className="cursor">▍</span>}
      </div>
    );
  }
  return (
    <div className="bubble assistant">
      <div className="avatar">A</div>
      <div className="body">
        {provider && <div className="bubble-header">{provider}</div>}
        <div className="content">
          {content}
          {streaming && <span className="cursor">▍</span>}
        </div>
      </div>
    </div>
  );
}
