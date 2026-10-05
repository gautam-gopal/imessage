import { create } from "zustand";
import { axiosInstance } from "../lib/axios";
import { io } from "socket.io-client";

const BASE_URL =
  import.meta.env.MODE === "development" ? "http://localhost:3000" : "/";

// Clerk session tokens are short-lived. The socket asks for a fresh token on
// every (re)connect attempt instead of reusing the one from first login,
// otherwise a reconnect after the token expired would be rejected.
let tokenGetter = null;

export const useAuthStore = create((set, get) => ({
  authUser: null,
  isCheckingAuth: true,
  onlineUsers: [],
  socket: null,
  // Incremented on every socket connect AFTER the first one for the current
  // socket (i.e. each reconnect). ChatPage uses it to trigger catch-up.
  connectionEpoch: 0,

  checkAuth: async (getToken) => {
    set({ isCheckingAuth: true });

    try {
      const res = await axiosInstance.get("/auth/check");
      set({ authUser: res.data });
      tokenGetter = getToken;
      const token = await getToken();
      get().connectSocket(res.data, token);
    } catch (error) {
      console.error("Error in checkAuth:", error);
      set({ authUser: null });
    } finally {
      set({ isCheckingAuth: false });
    }
  },

  clearAuth: () => {
    tokenGetter = null;
    set({
      authUser: null,
      isCheckingAuth: false,
      onlineUsers: [],
      connectionEpoch: 0,
    });
    get().disconnectSocket();
  },

  connectSocket: (user, token) => {
    if (!user || !token || get().socket?.connected) return;

    const socket = io(BASE_URL, {
      auth: async (cb) => {
        try {
          const fresh = tokenGetter ? await tokenGetter() : null;
          cb({ token: fresh || token });
        } catch {
          cb({ token });
        }
      },
    });

    set({ socket, connectionEpoch: 0 });

    let hasConnected = false;
    socket.on("connect", () => {
      if (hasConnected) {
        set((state) => ({ connectionEpoch: state.connectionEpoch + 1 }));
      }
      hasConnected = true;
    });

    socket.on("getOnlineUsers", (userIds) => {
      set({ onlineUsers: userIds });
    });
  },

  disconnectSocket: () => {
    const socket = get().socket;
    if (socket?.connected) socket.disconnect();
    set({ socket: null });
  },
}));
