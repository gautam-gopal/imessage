import { create } from "zustand";
import { persist } from "zustand/middleware";

import { axiosInstance } from "../lib/axios";
import { useAuthStore } from "./useAuthStore";
import toast from "react-hot-toast";

// Tracks this store's own "newMessage" listener so it can be removed by
// reference, without touching any other listener that might be registered
// on the same shared socket for other purposes, present or future.
let newMessageHandler = null;

export const useChatStore = create(
  persist(
    (set, get) => ({
      users: [],
      conversations: [],
      messagesByConversationId: {},
      conversationIdByPeerId: {},
      selectedUser: null,
      isConversationsLoading: false,
      isUsersLoading: false,
      isMessagesLoading: false,
      activeConversationId: null,
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
            selectedUser:
              state.selectedUser &&
              res.data.some((user) => user._id === state.selectedUser._id)
                ? state.selectedUser
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
          set({ conversations: res.data });
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

          const peerId = messagesForConversation
            .map((message) => {
              const senderId = String(message.senderId);
              const receiverId = message.receiverId
                ? String(message.receiverId)
                : null;
              return senderId === myId ? receiverId : senderId;
            })
            .find(Boolean);

          return {
            messagesByConversationId: {
              ...state.messagesByConversationId,
              [conversationId]: merged,
            },
            conversationIdByPeerId: peerId
              ? { ...state.conversationIdByPeerId, [peerId]: conversationId }
              : state.conversationIdByPeerId,
          };
        });

        return { addedCount };
      },

      getMessages: async (userId) => {
        if (!userId) return;
        set({ isMessagesLoading: true });
        try {
          const res = await axiosInstance.get(`/messages/${userId}`);
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
        const { selectedUser } = get();
        if (!selectedUser) return false;

        try {
          const res = await axiosInstance.post(
            `/messages/send/${selectedUser._id}`,
            messageData,
          );
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

      setSelectedUser: (selectedUser) => set({ selectedUser }),

      setActiveConversationId: (activeConversationId) => {
        set((state) => ({
          activeConversationId,
          selectedUser:
            state.users.find((user) => user._id === activeConversationId) ||
            state.conversations.find(
              (user) => user._id === activeConversationId,
            ) ||
            null,
        }));
      },

      setSearchQuery: (searchQuery) => set({ searchQuery }),
      setSidebarTab: (sidebarTab) => set({ sidebarTab }),
      setComposerText: (composerText) => set({ composerText }),
      setSoundEnabled: (isSoundEnabled) => set({ isSoundEnabled }),

      sendTextMessage: async (conversationId) => {
        const messageText = get().composerText.trim();
        if (!conversationId || !messageText) return false;

        return get().sendMessage({ text: messageText });
      },

      sendMediaMessage: async ({ conversationId, file }) => {
        if (!conversationId || !file) return false;

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
