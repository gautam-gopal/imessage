// Pure helpers for Stage 10 in-app notifications. No store or DOM access
// (apart from the guarded visibility check), so they are easy to test.

// Mirrors UNREAD_COUNT_CAP in backend/src/lib/unread.js: the server stops
// counting at 100, so a count of 100 means "100 or more".
export const UNREAD_COUNT_CAP = 100;

export const isTabVisible = () =>
  typeof document === "undefined" || document.visibilityState === "visible";

// A conversation is "in view" when it is the selected one AND the tab is
// visible. Messages arriving in a conversation that is in view are being read
// as they land, so they raise no badge or alert.
export function isConversationInView(conversationId, activeConversationId) {
  return (
    Boolean(conversationId) &&
    String(conversationId) === String(activeConversationId) &&
    isTabVisible()
  );
}

export function unreadBadgeLabel(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "";
  return n >= UNREAD_COUNT_CAP ? "99+" : String(n);
}

// Total unread across the sidebar, ignoring the conversation currently in
// view (pass null when the tab is hidden so nothing is ignored).
export function totalUnreadCount(conversations, viewedConversationId) {
  return conversations.reduce((sum, conversation) => {
    if (conversation.id === viewedConversationId) return sum;
    return sum + (Number(conversation.unreadCount) || 0);
  }, 0);
}

export function titleWithUnread(baseTitle, total) {
  if (total <= 0) return baseTitle;
  return `(${total >= UNREAD_COUNT_CAP ? "99+" : total}) ${baseTitle}`;
}

export function messagePreview(message) {
  const text = String(message?.text ?? "").trim();
  if (text) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  if (message?.image) return "📷 Photo";
  if (message?.video) return "🎥 Video";
  return "New message";
}

export function buildNotificationText({ conversation, senderName, message }) {
  const preview = messagePreview(message);

  if (conversation.type === "group") {
    return senderName
      ? `${conversation.name} · ${senderName}: ${preview}`
      : `${conversation.name}: ${preview}`;
  }

  return `${conversation.name}: ${preview}`;
}
