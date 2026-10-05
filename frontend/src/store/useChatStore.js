import { create } from "zustand";
import { persist } from "zustand/middleware";

import { axiosInstance } from "../lib/axios";
import { useAuthStore } from "./useAuthStore";
import toast from "react-hot-toast";
import { assistantErrorMessage } from "../lib/assistant";
import {
  buildNotificationText,
  isConversationInView,
} from "../lib/notifications";

// Tracks this store's own "newMessage" listener so it can be removed by
// reference, without touching any other listener that might be registered
// on the same shared socket for other purposes, present or future.
let newMessageHandler = null;
let messageReadHandler = null;
let assistantErrorHandler = null;

// getConversations responses can arrive out of order; only the newest
// request's response may be applied.
let conversationsRequestSeq = 0;

// Coalesces bursts of "refresh the conversation list" triggers: at most one
// request in flight plus one queued follow-up, however many triggers arrive.
let refreshInFlight = null;
let refreshQueued = false;

// Message ids are 24-char hex ObjectIds. Lowercased fixed-width hex compares
// lexicographically exactly as the numeric ObjectId ordering does, which is
// the same _id ordering the server uses for "read up to" (Stage 5/6).
function compareObjectIds(a, b) {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

// Union of two readBy arrays, one entry per user. readBy is append-only on
// the server and first-read-wins, so a union is always correct; on a
// (never expected) conflict the earlier readAt is kept.
function mergeReadBy(current, incoming) {
  if (!incoming?.length) return current ?? [];
  if (!current?.length) return incoming;

  const merged = new Map();
  for (const entry of [...current, ...incoming]) {
    const userId = String(entry.userId);
    const prior = merged.get(userId);
    if (!prior || new Date(entry.readAt) < new Date(prior.readAt)) {
      merged.set(userId, { userId, readAt: entry.readAt });
    }
  }
  return Array.from(merged.values());
}

// Emits message:read and resolves with the server ack
// ({ ok, modifiedCount } | { ok: false, error }). Never rejects.
function emitMarkRead(socket, payload) {
  return new Promise((resolve) => {
    socket.timeout(5000).emit("message:read", payload, (err, ack) => {
      if (err) return resolve({ ok: false, error: "Read receipt timed out" });
      resolve(ack ?? { ok: false, error: "No acknowledgement" });
    });
  });
}
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
      unreadCount: raw.unreadCount ?? 0,
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
    unreadCount: raw.unreadCount ?? 0,
    name: raw.peer.fullName,
    avatarUrl: raw.peer.profilePic,
    peerId: String(raw.peer._id),
    peer: raw.peer,
    participantCount: 2,
    participantIds: [],
    admins: [],
  };
}

// Decides which endpoint a given real Conversation _id talks to.
//   group  -> conversation-addressed routes
//   direct -> existing peer-addressed routes (peer resolved from the
//              conversation list, falling back to the transitional
//              peer -> conversation bridge)
// Used both for the currently active selection (resolveConversationTarget)
// and for a conversationId supplied explicitly (loadOlderMessages), so an
// older-page request always targets the conversation it was issued for,
// independent of whatever is selected by the time the response arrives.
function resolveTargetByConversationId(state, conversationId) {
  if (!conversationId) return null;

  const { conversations, conversationIdByPeerId } = state;
  const conversation = conversations.find((item) => item.id === conversationId);

  if (conversation?.type === "group") {
    return { kind: "group", conversationId };
  }

  const peerId =
    conversation?.peerId ??
    Object.keys(conversationIdByPeerId).find(
      (id) => conversationIdByPeerId[id] === conversationId,
    );

  return peerId ? { kind: "direct", peerId, conversationId } : null;
}

// Decides which endpoint the current selection talks to.
// A group is only ever recognised from the conversation list's own `type`;
// it is never inferred from a peer id.
function resolveConversationTarget(state) {
  const { activeConversationId, pendingDirectPeerId } = state;

  if (activeConversationId) {
    return resolveTargetByConversationId(state, activeConversationId);
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
      historyByConversationId: {},
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
        const requestSeq = ++conversationsRequestSeq;
        set({ isConversationsLoading: true });
        try {
          const res = await axiosInstance.get("/messages/conversations");
          // A newer request was issued meanwhile; its response wins.
          if (requestSeq !== conversationsRequestSeq) return;

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
            const previous = byId.get(id);
            if (!previous) addedCount += 1;
            // Replace the message but union readBy, so a late POST response
            // or a stale REST snapshot can never erase a read receipt that
            // a message:read event already applied.
            byId.set(id, {
              ...message,
              readBy: mergeReadBy(previous?.readBy, message.readBy),
            });
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

      // Applies one server "message:read" payload (or the REST fallback's
      // response, which has the same shape). Idempotent and first-read-wins:
      // an existing entry for the reader is never touched or duplicated.
      // The reader's own messages are excluded. If the conversation's
      // bucket isn't loaded (or is partial), only loaded messages are
      // updated; anything fetched later carries its own readBy.
      applyReadReceipt: ({
        conversationId,
        readerId,
        upToMessageId,
        readAt,
      }) => {
        const key = String(conversationId);
        const reader = String(readerId);
        const upTo = String(upToMessageId);

        set((state) => {
          const bucket = state.messagesByConversationId[key];
          if (!bucket || bucket.length === 0) return state;

          let changed = false;
          const next = bucket.map((message) => {
            if (String(message.senderId) === reader) return message;
            if (compareObjectIds(message._id, upTo) > 0) return message;

            const readBy = message.readBy || [];
            if (readBy.some((entry) => String(entry.userId) === reader)) {
              return message;
            }

            changed = true;
            return {
              ...message,
              readBy: [...readBy, { userId: reader, readAt }],
            };
          });

          if (!changed) return state;

          return {
            messagesByConversationId: {
              ...state.messagesByConversationId,
              [key]: next,
            },
          };
        });
      },

      // Newest (by _id) message in the loaded bucket that was sent by
      // someone else and that the current user has not read, or null.
      // Pure derivation for Part 4; it decides nothing about visibility.
      getUnreadReadAnchor: (conversationId) => {
        const myId = String(useAuthStore.getState().authUser?._id);
        const bucket =
          get().messagesByConversationId[String(conversationId)] || [];

        let anchor = null;
        for (const message of bucket) {
          if (String(message.senderId) === myId) continue;
          if ((message.readBy || []).some((e) => String(e.userId) === myId)) {
            continue;
          }
          const id = String(message._id);
          if (anchor === null || compareObjectIds(id, anchor) > 0) anchor = id;
        }
        return anchor;
      },

      // Tells the server the current user has read a conversation up to
      // upToMessageId. Socket-first (the server then broadcasts message:read
      // to the whole room, including this user's own devices, and that
      // broadcast updates local state). Falls back to REST only when the
      // socket is disconnected; the REST endpoint does not broadcast, so
      // other participants see the receipt on their next history load, and
      // the response is applied locally here. Resolves { ok, modifiedCount }
      // or { ok: false, error }; never throws, never toasts.
      markConversationRead: async (conversationId, upToMessageId) => {
        if (!conversationId || !upToMessageId) {
          return { ok: false, error: "Missing conversation or message" };
        }

        const payload = {
          conversationId: String(conversationId),
          upToMessageId: String(upToMessageId),
        };

        const socket = useAuthStore.getState().socket;
        if (socket?.connected) {
          const ack = await emitMarkRead(socket, payload);
          // modifiedCount > 0: the server broadcasts message:read, whose
          // handler refreshes our unread counts. 0: nothing is broadcast but
          // the read watermark may still have moved, so refresh here.
          if (ack.ok && !ack.modifiedCount) void get().refreshConversations();
          return ack;
        }
        try {
          const res = await axiosInstance.post(
            `/conversations/${payload.conversationId}/read`,
            { upToMessageId: payload.upToMessageId },
          );
          if (res.data.modifiedCount > 0) get().applyReadReceipt(res.data);
          // The REST path broadcasts nothing, so refresh our counts directly.
          void get().refreshConversations();
          return { ok: true, modifiedCount: res.data.modifiedCount };
        } catch (error) {
          return {
            ok: false,
            error:
              error.response?.data?.message ||
              "Failed to mark messages as read",
          };
        }
      },

      // Loads the newest page of history for the current selection:
      // group -> conversation-addressed route, direct (existing or
      // pending) -> peer-addressed route. A pending peer with no
      // Conversation gets the empty-page shape from the backend. Always
      // fetches the newest page (no `before`) and resets that
      // conversation's pagination meta from the response — any
      // previously-paged-back older messages already in the bucket are
      // kept (ingestMessages merges, never truncates), they just aren't
      // reflected in the fresh hasMore/nextCursor until loadOlderMessages
      // walks back through them again.
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
          const { messages, pageInfo } = res.data;
          get().ingestMessages(messages);

          if (target.conversationId) {
            const key = String(target.conversationId);
            set((state) => ({
              historyByConversationId: {
                ...state.historyByConversationId,
                [key]: {
                  limit: pageInfo.limit,
                  hasMore: pageInfo.hasMore,
                  nextCursor: pageInfo.nextCursor,
                  isLoadingOlder: false,
                },
              },
            }));
          }
        } catch (error) {
          toast.error(
            error.response?.data?.message || "Failed to load messages",
          );
        } finally {
          set({ isMessagesLoading: false });
        }
      },

      // Loads the next older page for conversationId (a real Conversation
      // _id — call only once the first page has loaded, per the semantics
      // above). Independent of the current selection: builds its own
      // target from conversationId rather than resolveConversationTarget,
      // so a response that arrives after the user has switched to another
      // conversation still applies to the conversation it was requested
      // for, not whatever is active by then. Serialized per conversation
      // via isLoadingOlder; a second call while one is already in flight
      // for the same conversation is a no-op. Resolves
      // { ok: true, addedCount } | { ok: false, error }; never throws.
      loadOlderMessages: async (conversationId) => {
        const key = conversationId ? String(conversationId) : null;
        if (!key) return { ok: false, error: "No conversation" };

        const meta = get().historyByConversationId[key];

        if (!meta) {
          return { ok: false, error: "History not loaded yet" };
        }
        if (meta.isLoadingOlder) {
          return { ok: false, error: "Already loading" };
        }
        if (!meta.hasMore || !meta.nextCursor) {
          return { ok: false, error: "No more history" };
        }

        const target = resolveTargetByConversationId(get(), key);
        if (!target) return { ok: false, error: "Conversation not found" };

        const requestCursor = meta.nextCursor;
        const limit = meta.limit;

        set((state) => ({
          historyByConversationId: {
            ...state.historyByConversationId,
            [key]: {
              ...state.historyByConversationId[key],
              isLoadingOlder: true,
            },
          },
        }));

        const url =
          target.kind === "group"
            ? `/conversations/${target.conversationId}/messages`
            : `/messages/${target.peerId}`;

        try {
          const res = await axiosInstance.get(url, {
            params: { before: requestCursor, limit },
          });
          const { messages, pageInfo } = res.data;

          const { addedCount } = get().ingestMessages(messages);

          set((state) => {
            const currentMeta = state.historyByConversationId[key];
            if (!currentMeta) return state;

            // Someone else (a fresh getMessages first-load, most likely)
            // already advanced this conversation's cursor past our
            // starting point while this request was in flight — apply the
            // messages (safe, ingestMessages dedupes by _id) but don't let
            // this stale response overwrite newer pagination state with
            // older data. Still clear our own isLoadingOlder flag.
            if (currentMeta.nextCursor !== requestCursor) {
              return {
                historyByConversationId: {
                  ...state.historyByConversationId,
                  [key]: { ...currentMeta, isLoadingOlder: false },
                },
              };
            }

            return {
              historyByConversationId: {
                ...state.historyByConversationId,
                [key]: {
                  limit: pageInfo.limit,
                  hasMore: pageInfo.hasMore,
                  nextCursor: pageInfo.nextCursor,
                  isLoadingOlder: false,
                },
              },
            };
          });

          return { ok: true, addedCount };
        } catch (error) {
          set((state) => ({
            historyByConversationId: {
              ...state.historyByConversationId,
              [key]: {
                ...state.historyByConversationId[key],
                isLoadingOlder: false,
              },
            },
          }));
          toast.error(
            error.response?.data?.message || "Failed to load older messages",
          );
          return { ok: false, error: "request failed" };
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

      // Refetches the conversation list (server-derived unread counts and
      // ordering) with bursts coalesced: one request in flight, at most one
      // queued behind it. Never rejects.
      refreshConversations: () => {
        if (refreshInFlight) {
          refreshQueued = true;
          return refreshInFlight;
        }

        const run = (async () => {
          try {
            await get().getConversations();
          } finally {
            if (refreshInFlight === run) refreshInFlight = null;
          }

          if (refreshQueued) {
            refreshQueued = false;
            await get().refreshConversations();
          }
        })();

        refreshInFlight = run;
        return run;
      },

      // Transient alert for a message that just arrived live in a
      // conversation the user is not looking at. Only called for messages the
      // store had not seen before (ingest addedCount > 0), so a message that
      // also arrives via history or reconnect catch-up never alerts twice.
      // The toast id is the message id as a second guard. Never throws: a
      // failed alert must not affect message delivery.
      notifyIncomingMessage: async (message) => {
        try {
          const myId = String(useAuthStore.getState().authUser?._id);
          if (String(message.senderId) === myId) return;

          const conversationId = String(message.conversationId);
          if (
            isConversationInView(conversationId, get().activeConversationId)
          ) {
            return;
          }

          let conversation = get().conversations.find(
            (item) => item.id === conversationId,
          );

          // First message of a brand-new conversation: it is not in the list
          // yet, so fetch the list to learn its name.
          if (!conversation) {
            await get().getConversations();
            conversation = get().conversations.find(
              (item) => item.id === conversationId,
            );
          }
          if (!conversation) return;

          const senderName = get().users.find(
            (user) => String(user._id) === String(message.senderId),
          )?.fullName;

          toast(buildNotificationText({ conversation, senderName, message }), {
            id: `msg-${message._id}`,
          });
        } catch (error) {
          console.error("Error showing message notification:", error?.message);
        }
      },

      // After a socket reconnect, realtime events from the gap are lost:
      // refetch server-derived state. The open thread's newest page is
      // refetched too (merged by _id, so overlap is harmless; if the gap is
      // larger than one page, scrolling up pages through it because the
      // cursor restarts from the newest page). Other threads catch up when
      // opened, which always refetches the newest page.
      catchUpAfterReconnect: async () => {
        await get().getConversations();

        if (get().activeConversationId || get().pendingDirectPeerId) {
          await get().getMessages();
        }
      },

      subscribeToMessages: () => {
        const socket = useAuthStore.getState().socket;
        if (!socket) return;

        if (newMessageHandler) {
          socket.off("newMessage", newMessageHandler);
        }
        if (messageReadHandler) {
          socket.off("message:read", messageReadHandler);
        }
        if (assistantErrorHandler) {
          socket.off("assistant:error", assistantErrorHandler);
        }

        newMessageHandler = (newMessage) => {
          const { addedCount } = get().ingestMessages([newMessage]);
          if (addedCount === 0) return;

          void get().refreshConversations();
          void get().notifyIncomingMessage(newMessage);
        };

        // Routed by the event's own conversationId, independent of the
        // selected conversation (same model as newMessage).
        messageReadHandler = (payload) => {
          if (!payload?.conversationId || !payload?.readerId) return;
          if (!payload.upToMessageId) return;
          get().applyReadReceipt(payload);

          // Our own read (this tab or another device) changes our unread
          // counts; the server is the source of truth for them.
          const myId = String(useAuthStore.getState().authUser?._id);
          if (String(payload.readerId) === myId) {
            void get().refreshConversations();
          }
        };

        // Private to the user who mentioned the assistant (server-targeted,
        // not persisted). A fixed toast id keeps repeated failures to one toast.
        assistantErrorHandler = (payload) => {
          toast.error(assistantErrorMessage(payload?.reason), {
            id: "assistant-error",
          });
        };

        socket.on("newMessage", newMessageHandler);
        socket.on("message:read", messageReadHandler);
        socket.on("assistant:error", assistantErrorHandler);
      },

      unsubscribeFromMessages: () => {
        const socket = useAuthStore.getState().socket;
        if (socket && newMessageHandler) {
          socket.off("newMessage", newMessageHandler);
        }
        if (socket && messageReadHandler) {
          socket.off("message:read", messageReadHandler);
        }
        if (socket && assistantErrorHandler) {
          socket.off("assistant:error", assistantErrorHandler);
        }
        newMessageHandler = null;
        messageReadHandler = null;
        assistantErrorHandler = null;
        refreshInFlight = null;
        refreshQueued = false;
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
