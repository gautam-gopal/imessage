import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../store/useChatStore";

const READ_DEBOUNCE_MS = 300;

const isTabVisible = () => document.visibilityState === "visible";

// Fixed-width lowercase hex ObjectIds compare like the numeric ordering.
const isSameOrNewer = (a, b) =>
  String(a).toLowerCase() >= String(b).toLowerCase();

// Marks the selected conversation read while it is visibly active:
// a real Conversation is selected AND the browser tab is visible.
// Works identically for direct and group conversations (both have a real
// Conversation _id once selected; a pending direct chat has nothing to read).
export function useMarkConversationRead(activeConversationId) {
  const [tabVisible, setTabVisible] = useState(isTabVisible);

  // conversationId -> newest anchor already requested (in flight or acked).
  const requestedAnchorRef = useRef(new Map());

  // The selected conversation's message bucket. Its reference changes only
  // when that bucket changes (history load, new message, read receipt), so
  // unrelated store updates (e.g. typing in the composer) never re-run this.
  const bucket = useChatStore((state) =>
    activeConversationId
      ? state.messagesByConversationId[activeConversationId]
      : undefined,
  );

  useEffect(() => {
    const onVisibilityChange = () => setTabVisible(isTabVisible());
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!activeConversationId || !tabVisible || !bucket?.length) return;

    const conversationId = activeConversationId;

    // Trailing debounce: every re-run cancels the previous timer, so a
    // burst of changes coalesces into one check after things settle.
    const timer = setTimeout(async () => {
      const { getUnreadReadAnchor, markConversationRead } =
        useChatStore.getState();

      // Re-derived at fire time so the request carries the newest anchor.
      const anchor = getUnreadReadAnchor(conversationId);
      if (!anchor) return;

      const requested = requestedAnchorRef.current.get(conversationId);
      if (requested && isSameOrNewer(requested, anchor)) return;

      requestedAnchorRef.current.set(conversationId, anchor);

      const result = await markConversationRead(conversationId, anchor);

      // Failure clears the marker (only if no newer request replaced it) so
      // the next trigger can retry.
      if (
        !result.ok &&
        requestedAnchorRef.current.get(conversationId) === anchor
      ) {
        requestedAnchorRef.current.delete(conversationId);
      }
    }, READ_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [activeConversationId, tabVisible, bucket]);
}
