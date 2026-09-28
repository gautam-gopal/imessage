import { useEffect, useLayoutEffect, useRef } from "react";
import { useChatStore } from "../store/useChatStore";

// How close to the top of the scroll container (in px) triggers loading
// the next older page.
const TOP_THRESHOLD_PX = 120;

/**
 * Wires infinite-scroll loading of older history onto an existing scroll
 * container ref (the same ref returned by useScrollToBottom and attached to
 * the messages list). Triggers loadOlderMessages(conversationId) when the
 * user scrolls near the top, respects hasMore/isLoadingOlder from
 * historyByConversationId, and restores scroll position so the message the
 * user was looking at doesn't visually jump when older messages are
 * prepended above it.
 *
 * conversationId: the real active Conversation _id, or null/undefined for
 *   no selection, or a pending direct peer with no history to page yet.
 * messageCount: activeConversation?.messages.length — a primitive, so the
 *   restore effect only reacts to actual list-length changes rather than to
 *   the fresh array reference useSelectedConversation() builds every render.
 *
 * Returns { isLoadingOlder } for a minimal loading indicator.
 */
export function useLoadOlderMessages(scrollRef, conversationId, messageCount) {
  const loadOlderMessages = useChatStore((state) => state.loadOlderMessages);
  const historyMeta = useChatStore((state) =>
    conversationId ? state.historyByConversationId[conversationId] : undefined,
  );

  // { conversationId, scrollHeight, scrollTop } captured right before an
  // older-page request we initiated, consumed by the layout effect below
  // once the prepended messages have been committed to the DOM. null
  // whenever no restore is pending.
  const restoreInfoRef = useRef(null);

  // A conversation switch invalidates any restore that was pending for the
  // previously-open conversation — its eventual response must never touch
  // the newly-selected conversation's scroll position.
  useEffect(() => {
    restoreInfoRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !conversationId) return;

    const handleScroll = () => {
      if (el.scrollTop > TOP_THRESHOLD_PX) return;
      if (!historyMeta?.hasMore || historyMeta.isLoadingOlder) return;
      // Extra synchronous guard alongside historyMeta.isLoadingOlder: the
      // store flag only becomes true once React re-renders with the new
      // state, so a second scroll event in the same burst could still see
      // the pre-fetch value.
      if (restoreInfoRef.current) return;

      const requestedConversationId = conversationId;

      restoreInfoRef.current = {
        conversationId: requestedConversationId,
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };

      loadOlderMessages(requestedConversationId).then((result) => {
        // The user may have switched conversations while this was in
        // flight (the reset effect above already cleared the ref for
        // that), or a newer request for this same conversation may have
        // superseded this one.
        if (
          restoreInfoRef.current?.conversationId !== requestedConversationId
        ) {
          return;
        }
        // Nothing was actually prepended (failed, or every message in the
        // page was already loaded locally) — there's no DOM change to
        // restore against, so don't leave a stale restore pending for a
        // later, unrelated length change (e.g. the next live message) to
        // misapply.
        if (!result.ok || result.addedCount === 0) {
          restoreInfoRef.current = null;
        }
      });
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [scrollRef, conversationId, historyMeta, loadOlderMessages]);

  useLayoutEffect(() => {
    const info = restoreInfoRef.current;
    if (!info || info.conversationId !== conversationId) return;

    const el = scrollRef.current;
    if (!el) {
      restoreInfoRef.current = null;
      return;
    }

    // Keep the message the user was looking at in the same visual
    // position: the container grew by (newScrollHeight - oldScrollHeight)
    // above the old scrollTop, so shift scrollTop by exactly that amount.
    const newScrollHeight = el.scrollHeight;
    el.scrollTop = info.scrollTop + (newScrollHeight - info.scrollHeight);
    restoreInfoRef.current = null;
    // messageCount is the intentional trigger: it changes only when the
    // list actually grows/shrinks, unlike the array reference which is
    // rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageCount]);

  return { isLoadingOlder: Boolean(historyMeta?.isLoadingOlder) };
}
