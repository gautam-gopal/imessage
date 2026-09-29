import { Fragment } from "react";
import useScrollToBottom from "../../hooks/useScrollToBottom";
import { useLoadOlderMessages } from "../../hooks/useLoadOlderMessages";
import { useChatStore } from "../../store/useChatStore";
import { MessageBubble } from "./MessageBubble";
import { NoConversationPlaceholder } from "./NoConversationPlaceholder";
import { useSelectedConversation } from "../../hooks/useSelectedConversation";

export function MessageList() {
  const { activeConversation, activeConversationId } =
    useSelectedConversation();
  const users = useChatStore((state) => state.users);

  const isGroup = activeConversation?.type === "group";
  const senderName = (senderId) =>
    users.find((user) => String(user._id) === senderId)?.fullName ||
    "Unknown user";

  const lastMessageId = activeConversation?.messages.at(-1)?.id;
  const messagesScrollRef = useScrollToBottom(
    activeConversationId,
    lastMessageId,
  );

  const { isLoadingOlder } = useLoadOlderMessages(
    messagesScrollRef,
    activeConversationId,
    activeConversation?.messages.length ?? 0,
  );

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {activeConversation ? (
        <>
          {isLoadingOlder ? (
            <p className="pointer-events-none absolute inset-x-0 top-0 z-10 py-1 text-center text-[11px] font-medium uppercase tracking-wide text-muted">
              Loading older messages…
            </p>
          ) : null}
          <div
            ref={messagesScrollRef}
            data-message-scroll-root
            className="flex flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-2 py-3 sm:px-3 sm:py-4"
          >
            <p className="mb-3 text-center text-[11px] font-medium uppercase tracking-wide text-muted">
              Today
            </p>
            {activeConversation.messages.map((message, index) => {
              // Group chats: label other people's messages with the sender's
              // name, once per consecutive run from the same sender.
              const showSender =
                isGroup &&
                message.role === "them" &&
                activeConversation.messages[index - 1]?.senderId !==
                  message.senderId;

              return (
                <Fragment key={message.id}>
                  {showSender ? (
                    <p className="mt-1 px-1 text-[11px] font-medium text-muted">
                      {senderName(message.senderId)}
                    </p>
                  ) : null}
                  <MessageBubble message={message} />
                </Fragment>
              );
            })}
          </div>
        </>
      ) : (
        <NoConversationPlaceholder />
      )}
    </div>
  );
}
