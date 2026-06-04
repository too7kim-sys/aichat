/* Tiny in-memory queue for "attach this file to chat" intents that
 * fire before a ChatPanel is mounted (Code workspace → first session
 * doesn't exist yet). The CodePane queues the item and asks App.tsx
 * to create a session; once the new ChatPanel mounts it drains
 * everything that's been waiting and adds it to its attachments.
 *
 * Already-mounted ChatPanels also drain on every "chat:attach-file"
 * event, so the queue is the single source of truth and there's no
 * double-add. */

export interface PendingAttachment {
  filename: string;
  text: string;
}

const pending: PendingAttachment[] = [];

export function queueAttachment(item: PendingAttachment): void {
  pending.push(item);
  window.dispatchEvent(
    new CustomEvent("chat:attach-file", { detail: item }),
  );
}

export function drainAttachments(): PendingAttachment[] {
  const out = pending.splice(0);
  return out;
}
