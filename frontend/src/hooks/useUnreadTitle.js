import { useEffect, useRef } from "react";
import { useChatStore } from "../store/useChatStore";
import { useTabVisible } from "./useTabVisible";
import { titleWithUnread, totalUnreadCount } from "../lib/notifications";

// Shows "(n) <title>" in the browser tab while there is unread activity in
// conversations the user is not currently looking at.
export function useUnreadTitle() {
  const conversations = useChatStore((state) => state.conversations);
  const activeConversationId = useChatStore(
    (state) => state.activeConversationId,
  );
  const tabVisible = useTabVisible();
  const baseTitleRef = useRef(null);

  useEffect(() => {
    baseTitleRef.current = document.title;
    return () => {
      document.title = baseTitleRef.current;
    };
  }, []);

  const total = totalUnreadCount(
    conversations,
    tabVisible ? activeConversationId : null,
  );

  useEffect(() => {
    if (baseTitleRef.current === null) return;
    document.title = titleWithUnread(baseTitleRef.current, total);
  }, [total]);
}
