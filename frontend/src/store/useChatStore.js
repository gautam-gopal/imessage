import { create } from "zustand";
import { persist } from "zustand/middleware";

import { axiosInstance } from "../lib/axios";
import { useAuthStore } from "./useAuthStore";
import toast from "react-hot-toast";

// Tracks this store's own "newMessage" listener so it can be removed by
// reference, without touching any other listener that might be registered
// on the same shared socket for other purposes, present or future.
let newMessageHandler = null;

// Converts one row of GET /messages/conversations (backend shape:
// { _id, type, peer } for direct, { _id, type, name, avatar,
// participantCount, admins } for group) into the single frontend
// representation used by the store, hook and sidebar.
function normalizeConversation(raw) {
  if (raw.type === "group") {
    return {
      id: String(raw._id),
      type: "group",
      lastMessageAt: raw.lastMessageAt,
      name: raw.name,
      avatarUrl: raw.avatar || "",
      peerId: null,
      peer: null,
      participantCount: raw.participantCount ?? 0,
      participantIds: (raw.participants || []).map(String),
      admins: (raw.admins || []).map(String),
    };
  }

  if (!raw.peer) return null;

  return {
    id: String(raw._id),
    type: "direct",
    lastMessageAt: raw.lastMessageAt,
    name: raw.peer.fullName,
    avatarUrl: raw.peer.profilePic,
    peerId: String(raw.peer._id),
    peer: raw.peer,
    participantCount: 2,
    participantIds: [],
    admins: [],
  };
}

// Decides which endpoint the current selection talks to.
//   group  -> conversation-addressed routes (real Conversation _id)
//   direct -> existing peer-addressed routes
// A group is only ever recognised from the conversation list's own `type`;
// it is never inferred from a peer id.
function resolveConversationTarget(state) {
  const {
    activeConversationId,
    pendingDirectPeerId,
    conversations,
    conversationIdByPeerId,
  } = state;

  if (activeConversationId) {
    const conversation = conversations.find(
      (item) => item.id === activeConversationId,
    );

    if (conversation?.type === "group") {
      return { kind: "group", conversationId: activeConversationId };
    }

    // Direct: prefer the list entry, fall back to the transitional
    // peer -> conversation bridge (e.g. a conversation created a moment ago
    // that the sidebar list hasn't refreshed for yet).
    const peerId =
      conversation?.peerId ??
      Object.keys(conversationIdByPeerId).find(
        (id) => conversationIdByPeerId[id] === activeConversationId,
      );

    return peerId
      ? { kind: "direct", peerId, conversationId: activeConversationId }
      : null;
  }

  if (pendingDirectPeerId) {
    return {
      kind: "direct",
      peerId: pendingDirectPeerId,
      conversationId: null,
    };
  }

  return null;
}

// If the user is sitting on a pending direct chat and a Conversation for
// that peer now exists (first message sent, peer wrote first, or the list
// refreshed), promote the selection to the real Conversation _id.
function promotePendingSelection(state, conversationIdByPeerId) {
  const resolved = state.pendingDirectPeerId
    ? conversationIdByPeerId[state.pendingDirectPeerId]
    : null;

  return resolved
    ? { activeConversationId: resolved, pendingDirectPeerId: null }
    : {};
}

export const useChatStore = create(
  persist(
    (set, get) => ({
      users: [],
      conversations: [],
      messagesByConversationId: {},
      // Transitional adapter: direct peer id -> direct Conversation _id.
      // Populated only from direct conversations / messages that carry a
      // receiverId. Group conversations never touch it.
      conversationIdByPeerId: {},
      isConversationsLoading: false,
      isUsersLoading: false,
      isMessagesLoading: false,
      // Always a real Conversation _id (direct or group), or null.
      activeConversationId: null,
      // A selected direct peer who has no Conversation yet. Mutually
      // exclusive with activeConversationId.
      pendingDirectPeerId: null,
      searchQuery: "",
      sidebarTab: "chats",
      composerText: "",
      isSoundEnabled: true,
      isSendingMedia: false,

      getUsers: async () => {
        set({ isUsersLoading: true });
        try {
          const res = await axiosInstance.get("/messages/users");
          set((state) => ({
            users: res.data,
            pendingDirectPeerId:
              state.pendingDirectPeerId &&
              res.data.some((user) => user._id === state.pendingDirectPeerId)
                ? state.pendingDirectPeerId
                : null,
          }));
        } catch (error) {
          console.log("Error in get Users", error.message);
        } finally {
          set({ isUsersLoading: false });
        }
      },

      getConversations: async () => {
        set({ isConversationsLoading: true });
        try {
          const res = await axiosInstance.get("/messages/conversations");
          const conversations = res.data
            .map(normalizeConversation)
            .filter(Boolean);

          set((state) => {
            const directIdsByPeerId = {};
            for (const conversation of conversations) {
              if (conversation.type === "direct") {
                directIdsByPeerId[conversation.peerId] = conversation.id;
              }
            }

            const nextMap = {
              ...state.conversationIdByPeerId,
              ...directIdsByPeerId,
            };

            // A group the user was viewing that no longer appears in the
            // refreshed list (removed from it, or left it) is deselected.
            const lostActiveGroup =
              state.activeConversationId &&
              state.conversations.some(
                (conversation) =>
                  conversation.id === state.activeConversationId &&
                  conversation.type === "group",
              ) &&
              !conversations.some(
                (conversation) =>
                  conversation.id === state.activeConversationId,
              );

            return {
              conversations,
              conversationIdByPeerId: nextMap,
              ...promotePendingSelection(state, nextMap),
              ...(lostActiveGroup ? { activeConversationId: null } : {}),
            };
          });
        } catch (error) {
          console.log("Error in getConversations", error.message);
        } finally {
          set({ isConversationsLoading: false });
        }
      },

      // Merges a batch of messages — all expected to belong to one
      // conversation — into messagesByConversationId, deduplicated by _id,
      // sorted by (createdAt asc, _id asc). Shared by REST history load, the
      // sender's own POST response, and the Socket.IO "newMessage" event, so
      // a message arriving through more than one of those (sender's own POST
      // response plus the Socket.IO room self-echo, or a REST snapshot
      // racing a live event) is stored exactly once. Does not touch the
      // sidebar — callers decide that from addedCount.
      // Any message whose conversationId doesn't match the batch's own is
      // dropped with a warning rather than silently misfiled — current call
      // sites never produce this, but the guard is cheap and keeps the
      // function safe if that assumption is ever violated later.
      ingestMessages: (incoming) => {
        if (!incoming || incoming.length === 0) return { addedCount: 0 };

        const conversationId = String(incoming[0].conversationId);
        const messagesForConversation = incoming.filter(
          (message) => String(message.conversationId) === conversationId,
        );

        if (messagesForConversation.length !== incoming.length) {
          console.warn(
            "ingestMessages: dropped message(s) with a conversationId " +
              "different from the batch's first message — ingestMessages " +
              "assumes a single-conversation batch.",
          );
        }

        const myId = String(useAuthStore.getState().authUser?._id);

        let addedCount = 0;

        set((state) => {
          const existing = state.messagesByConversationId[conversationId] || [];
          const byId = new Map(
            existing.map((message) => [String(message._id), message]),
          );

          for (const message of messagesForConversation) {
            const id = String(message._id);
            if (!byId.has(id)) addedCount += 1;
            byId.set(id, message);
          }

          const merged = Array.from(byId.values()).sort((a, b) => {
            const timeDiff = new Date(a.createdAt) - new Date(b.createdAt);
            if (timeDiff !== 0) return timeDiff;
            const aId = String(a._id);
            const bId = String(b._id);
            return aId < bId ? -1 : aId > bId ? 1 : 0;
          });

          // Peer bridge: direct messages only. A group message has no
          // receiverId, so it can never yield a peer mapping; a conversation
          // already known to be a group is skipped as a second guard.
          const isKnownGroup = state.conversations.some(
            (conversation) =>
              conversation.id === conversationId &&
              conversation.type === "group",
          );

          const peerId = isKnownGroup
            ? undefined
            : messagesForConversation
                .filter((message) => message.receiverId)
                .map((message) =>
                  String(message.senderId) === myId
                    ? String(message.receiverId)
                    : String(message.senderId),
                )
                .find(Boolean);

          const nextMap = peerId
            ? { ...state.conversationIdByPeerId, [peerId]: conversationId }
            : state.conversationIdByPeerId;

          return {
            messagesByConversationId: {
              ...state.messagesByConversationId,
              [conversationId]: merged,
            },
            conversationIdByPeerId: nextMap,
            ...promotePendingSelection(state, nextMap),
          };
        });

        return { addedCount };
      },

      // Loads history for the current selection: group -> conversation-
      // addressed route, direct (existing or pending) -> peer-addressed
      // route. A pending peer with no Conversation simply gets [].
      getMessages: async () => {
        const target = resolveConversationTarget(get());
        if (!target) return;

        const url =
          target.kind === "group"
            ? `/conversations/${target.conversationId}/messages`
            : `/messages/${target.peerId}`;

        set({ isMessagesLoading: true });
        try {
          const res = await axiosInstance.get(url);
          get().ingestMessages(res.data);
        } catch (error) {
          toast.error(
            error.response?.data?.message || "Failed to load messages",
          );
        } finally {
          set({ isMessagesLoading: false });
        }
      },

      sendMessage: async (messageData) => {
        const target = resolveConversationTarget(get());
        if (!target) return false;

        const url =
          target.kind === "group"
            ? `/conversations/${target.conversationId}/messages`
            : `/messages/send/${target.peerId}`;

        try {
          const res = await axiosInstance.post(url, messageData);
          const { addedCount } = get().ingestMessages([res.data]);
          set({ composerText: "" });
          if (addedCount > 0) get().getConversations();
          return true;
        } catch (error) {
          toast.error(
            error.response?.data?.message || "Failed to send message",
          );
          return false;
        }
      },

      subscribeToMessages: () => {
        const socket = useAuthStore.getState().socket;
        if (!socket) return;

        if (newMessageHandler) {
          socket.off("newMessage", newMessageHandler);
        }

        newMessageHandler = (newMessage) => {
          const { addedCount } = get().ingestMessages([newMessage]);
          if (addedCount > 0) get().getConversations();
        };

        socket.on("newMessage", newMessageHandler);
      },

      unsubscribeFromMessages: () => {
        const socket = useAuthStore.getState().socket;
        if (socket && newMessageHandler) {
          socket.off("newMessage", newMessageHandler);
        }
        newMessageHandler = null;
      },

      // Selects an existing conversation (direct or group) by its real
      // Conversation _id. Passing null clears the selection entirely,
      // including any pending direct peer. Cached messages are never
      // cleared here.
      setActiveConversationId: (conversationId) =>
        set({
          activeConversationId: conversationId ?? null,
          pendingDirectPeerId: null,
        }),

      // Selects a person (Users tab). If a direct Conversation with them
      // already exists, that Conversation becomes active; otherwise the
      // peer is held as pending until the first message creates it.
      selectDirectPeer: (peerId) => {
        const existingConversationId = get().conversationIdByPeerId[peerId];

        if (existingConversationId) {
          set({
            activeConversationId: existingConversationId,
            pendingDirectPeerId: null,
          });
          return;
        }

        set({ activeConversationId: null, pendingDirectPeerId: peerId });
      },

      // Group management. Every action resyncs the conversation list from
      // the server afterwards (also on failure, e.g. a 409 membership
      // conflict) so the UI never keeps a stale participant list.
      createGroup: async ({ name, avatar, participantIds }) => {
        try {
          const payload = { name, participantIds };
          if (avatar) payload.avatar = avatar;

          const res = await axiosInstance.post("/conversations", payload);
          await get().getConversations();
          set({ sidebarTab: "chats" });
          get().setActiveConversationId(String(res.data._id));
          return true;
        } catch (error) {
          toast.error(
            error.response?.data?.message || "Failed to create group",
          );
          return false;
        }
      },

      addGroupMember: async (conversationId, memberId) => {
        try {
          await axiosInstance.post(`/conversations/${conversationId}/members`, {
            memberId,
          });
          await get().getConversations();
          return true;
        } catch (error) {
          toast.error(error.response?.data?.message || "Failed to add member");
          await get().getConversations();
          return false;
        }
      },

      // Covers both an admin removing someone and a member leaving
      // (memberId === the logged-in user).
      removeGroupMember: async (conversationId, memberId) => {
        const myId = String(useAuthStore.getState().authUser?._id);

        try {
          await axiosInstance.delete(
            `/conversations/${conversationId}/members/${memberId}`,
          );

          if (
            String(memberId) === myId &&
            get().activeConversationId === conversationId
          ) {
            get().setActiveConversationId(null);
          }

          await get().getConversations();
          return true;
        } catch (error) {
          toast.error(
            error.response?.data?.message || "Failed to update group members",
          );
          await get().getConversations();
          return false;
        }
      },

      setSearchQuery: (searchQuery) => set({ searchQuery }),
      setSidebarTab: (sidebarTab) => set({ sidebarTab }),
      setComposerText: (composerText) => set({ composerText }),
      setSoundEnabled: (isSoundEnabled) => set({ isSoundEnabled }),

      // The target is resolved from store selection state, not from the
      // caller: a pending direct chat has no conversationId yet.
      sendTextMessage: async () => {
        const messageText = get().composerText.trim();
        if (!messageText) return false;

        return get().sendMessage({ text: messageText });
      },

      sendMediaMessage: async ({ file } = {}) => {
        if (!file) return false;

        const formData = new FormData();
        formData.append("media", file);

        set({ isSendingMedia: true });
        try {
          return await get().sendMessage(formData);
        } finally {
          set({ isSendingMedia: false });
        }
      },
    }),
    {
      name: "imessage-storage",
      partialize: (state) => ({ isSoundEnabled: state.isSoundEnabled }),
    },
  ),
);
