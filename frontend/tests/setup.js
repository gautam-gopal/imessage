// The chat store uses zustand `persist` (localStorage). Node has no
// localStorage, so give it a minimal in-memory one instead of a DOM.
const data = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
  },
});
