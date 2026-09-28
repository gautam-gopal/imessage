import { useMediaQuery } from "./useMediaQuery";
import { formatMessageTime } from "../lib/utils";
import { useChatStore } from "../store/useChatStore";
import { useAuthStore } from "../store/useAuthStore";

// John Doe -> JD
export function getInitials(name) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((namePart) => namePart[0])
    .join("");
}

// Read-receipt view-model for one of the current user's own messages.
// Derived on every render from message.readBy plus current conversation
// membership; nothing here is stored.
//   direct -> { type: "direct", isRead }
//   group  -> { type: "group", readCount, totalCount }
function buildReceipt(message, receiptContext) {
  if (!receiptContext) return null;

  const readBy = message.readBy || [];

  if (receiptContext.type === "direct") {
    return {
      type: "direct",
      isRead: readBy.some(
        (entry) => String(entry.userId) === receiptContext.peerId,
      ),
    };
  }

  const { recipientIds } = receiptContext;
  if (recipientIds.size === 0) return null;

  let readCount = 0;
  if (readBy.length > 0) {
    const readers = new Set();
    for (const entry of readBy) {
      const id = String(entry.userId);
      if (recipientIds.has(id)) readers.add(id);
    }
    readCount = readers.size;
  }

  return { type: "group", readCount, totalCount: recipientIds.size };
}

// Adapter from raw backend message documents to the UI message view-model.
// senderId is carried through so group UI can attribute messages later.
// `receipt` is only populated for the current user's own messages.
function mapMessages(messages, authUser, receiptContext) {
  return messages.map((message) => {
    const isOwn = String(message.senderId) === String(authUser?._id);

    return {
      id: message._id,
      senderId: String(message.senderId),
      role: isOwn ? "me" : "them",
      text: message.text || "",
      time: formatMessageTime(message.createdAt),
      imageUrl: message.image,
      videoUrl: message.video,
      receipt: isOwn ? buildReceipt(message, receiptContext) : null,
    };
  });
}

// View-model for a direct chat. `id` is the real Conversation _id, or null
// for a pending direct chat that has no Conversation yet.
function mapDirectView({ id, user, messages, authUser, onlineUsers }) {
  return {
    id,
    type: "direct",
    peerId: user._id,
    memberCount: null,
    peer: {
      name: user.fullName,
      subtitle: user.email,
      isOnline: onlineUsers.includes(user._id),
      avatarUrl: user.profilePic,
      initials: getInitials(user.fullName),
    },
    messages: mapMessages(messages, authUser, {
      type: "direct",
      peerId: String(user._id),
    }),
  };
}

// View-model for a group chat. `peer` carries the group's display
// name/avatar so existing header code keeps rendering; there is no human
// presence for a group (isOnline is always false — Part 4 must branch on
// `type` instead of showing a presence indicator).
function mapGroupView({ conversation, messages, authUser, systemUserIds }) {
  // Read-summary recipients: current participants, excluding the sender
  // (receipts are only rendered on the current user's own messages, so the
  // sender is always the current user) and excluding system users.
  const myId = String(authUser?._id);
  const recipientIds = new Set(
    conversation.participantIds.filter(
      (id) => id !== myId && !systemUserIds.has(id),
    ),
  );

  return {
    id: conversation.id,
    type: "group",
    peerId: null,
    memberCount: conversation.participantCount,
    peer: {
      name: conversation.name,
      subtitle: `${conversation.participantCount} members`,
      isOnline: false,
      avatarUrl: conversation.avatarUrl,
      initials: getInitials(conversation.name),
    },
    messages: mapMessages(messages, authUser, { type: "group", recipientIds }),
  };
}

export function useSelectedConversation() {
  const activeConversationId = useChatStore(
    (state) => state.activeConversationId,
  );
  const pendingDirectPeerId = useChatStore(
    (state) => state.pendingDirectPeerId,
  );
  const conversations = useChatStore((state) => state.conversations);
  const users = useChatStore((state) => state.users);
  const conversationIdByPeerId = useChatStore(
    (state) => state.conversationIdByPeerId,
  );
  const messagesByConversationId = useChatStore(
    (state) => state.messagesByConversationId,
  );

  const authUser = useAuthStore((state) => state.authUser);
  const onlineUsers = useAuthStore((state) => state.onlineUsers);

  const isLargeScreen = useMediaQuery("(min-width: 1024px)");

  const systemUserIds = new Set(
    users.filter((user) => user.isSystemUser).map((user) => String(user._id)),
  );

  let activeConversation = null;
  let activePeerId = null;

  if (activeConversationId) {
    const messages = messagesByConversationId[activeConversationId] || [];
    const conversation = conversations.find(
      (item) => item.id === activeConversationId,
    );

    if (conversation?.type === "group") {
      activeConversation = mapGroupView({
        conversation,
        messages,
        authUser,
        systemUserIds,
      });
    } else {
      // Direct: the list entry knows the peer; if the list hasn't caught up
      // yet, fall back to the transitional peer -> conversation bridge.
      const peerId =
        conversation?.peerId ??
        Object.keys(conversationIdByPeerId).find(
          (id) => conversationIdByPeerId[id] === activeConversationId,
        );

      const user =
        conversation?.peer || users.find((item) => item._id === peerId);

      if (user) {
        activePeerId = String(user._id);
        activeConversation = mapDirectView({
          id: activeConversationId,
          user,
          messages,
          authUser,
          onlineUsers,
        });
      }
    }
  } else if (pendingDirectPeerId) {
    const user = users.find((item) => item._id === pendingDirectPeerId);

    if (user) {
      activePeerId = String(user._id);
      activeConversation = mapDirectView({
        id: null,
        user,
        messages: [],
        authUser,
        onlineUsers,
      });
    }
  }

  return {
    activeConversation,
    // Real Conversation _id, or null (nothing selected / pending direct).
    activeConversationId,
    pendingDirectPeerId,
    // Peer of the selected direct chat (existing or pending), else null.
    activePeerId,
    // True whenever something is selected, including a pending direct chat.
    hasSelection: Boolean(activeConversationId || pendingDirectPeerId),
    isLargeScreen,
  };
}
