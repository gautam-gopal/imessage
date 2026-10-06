# Monolith: Vite frontend + Express API (+ Socket.IO). Build from repo root.
# Single instance only: presence and the AI rate limiter are in-memory.

# --- Stage 1: build the SPA (Vite) ---
# Produces static HTML/JS/CSS under frontend/dist.
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# Public Clerk key; @clerk/react reads VITE_CLERK_PUBLISHABLE_KEY at build
# time and embeds it in the client JS. The browser calls /api and the socket
# on the same host as the page (see frontend/src/lib/axios.js).
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
RUN npm run build

# --- Stage 2: build the API bundle ---
# The backend is ESM JavaScript, so `npm run build` just copies src/ to dist/.
# It needs no dependencies, so none are installed here.
FROM node:22-bookworm-slim AS backend-build
WORKDIR /app
COPY backend/package.json ./
COPY backend/src ./src
RUN npm run build

# --- Stage 3: production dependencies only ---
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Stage 4: runtime image ---
# Express serves the API, Socket.IO and the static SPA from public/.
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Default for local/compose use. Platforms such as Render inject their own PORT.
ENV PORT=3001

# package.json is needed at runtime for "type": "module".
COPY backend/package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /app/frontend/dist ./public

EXPOSE 3001

# Readiness (not just liveness): unhealthy until MongoDB is connected.
# start-period covers the initial Mongo connection. Render ignores this and
# uses its own health check path (/ready); this serves docker / compose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

USER node

# Exec form: node is PID 1 and receives SIGTERM directly, which the app's
# graceful-shutdown handler (src/lib/shutdown.js) relies on.
CMD ["node", "dist/index.js"]