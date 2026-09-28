import { useWallpaper } from "../context/wallpaper";
import { useChatStore } from "../store/useChatStore";
import { useSelectedConversation } from "../hooks/useSelectedConversation";
import { useEffect } from "react";
import ChatSidebar from "../components/chat/ChatSidebar";
import { ChatHeader } from "../components/chat/ChatHeader";
import { MessageList } from "../components/chat/MessageList";
import { ChatComposer } from "../components/chat/ChatComposer";

function ChatPage() {
  const { frameStyle } = useWallpaper();

  const getConversations = useChatStore((state) => state.getConversations);
  const getMessages = useChatStore((state) => state.getMessages);
  const getUsers = useChatStore((state) => state.getUsers);
  const subscribeToMessages = useChatStore(
    (state) => state.subscribeToMessages,
  );
  const unsubscribeFromMessages = useChatStore(
    (state) => state.unsubscribeFromMessages,
  );

  const {
    activeConversation,
    activeConversationId,
    pendingDirectPeerId,
    hasSelection,
    isLargeScreen,
  } = useSelectedConversation();

  useEffect(() => {
    getUsers();
    getConversations();
  }, [getUsers, getConversations]);

  // Loads history for the current selection (existing direct, group, or a
  // pending direct peer). The store resolves the right endpoint itself.
  useEffect(() => {
    if (!activeConversationId && !pendingDirectPeerId) return;

    getMessages();
  }, [getMessages, activeConversationId, pendingDirectPeerId]);

  // Subscribed once, independent of which conversation is selected — Stage
  // 2's room-based delivery sends "newMessage" for every conversation this
  // user is a member of, not just the currently open one.
  useEffect(() => {
    subscribeToMessages();
    return () => unsubscribeFromMessages();
  }, [subscribeToMessages, unsubscribeFromMessages]);

  return (
    <div
      className="flex h-dvh flex-col overflow-hidden p-2 sm:p-3 md:p-8"
      style={frameStyle}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-1 overflow-hidden rounded-2xl border border-border bg-background text-foreground">
        <ChatSidebar />

        <div
          className={`flex-1 flex-col overflow-hidden ${
            !isLargeScreen && !hasSelection ? "hidden lg:flex" : "flex"
          }`}
        >
          <ChatHeader />
          <MessageList />

          {activeConversation ? <ChatComposer /> : null}
        </div>
      </div>
    </div>
  );
}
export default ChatPage;
