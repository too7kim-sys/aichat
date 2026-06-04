import { createContext, useContext, type ReactNode } from "react";

/** Context shared by everything inside a chat panel: which workspace
 * (if any) is bound to this chat session, so that nested components
 * like the markdown renderer can offer "apply to workspace" without
 * having to plumb the workspace id through every prop. */
interface ChatWorkspaceValue {
  workspaceId: string | null;
  /** Triggered by the markdown renderer after a successful patch
   * apply — lets a parent panel refresh its dirty-files view. */
  onPatchApplied?: () => void;
}

const ChatWorkspaceCtx = createContext<ChatWorkspaceValue>({
  workspaceId: null,
});

export function ChatWorkspaceProvider({
  workspaceId,
  onPatchApplied,
  children,
}: ChatWorkspaceValue & { children: ReactNode }) {
  return (
    <ChatWorkspaceCtx.Provider value={{ workspaceId, onPatchApplied }}>
      {children}
    </ChatWorkspaceCtx.Provider>
  );
}

export function useChatWorkspace(): ChatWorkspaceValue {
  return useContext(ChatWorkspaceCtx);
}
