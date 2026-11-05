# string — Fly.io / container deploy
# The server is a single stateless Node process: static files + WebSocket signaling.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install the single runtime dep (ws) from the lockfile, no dev deps.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code.
COPY server.js ./
COPY public ./public

# Fly's proxy talks to the app on this port; server.js reads process.env.PORT.
ENV PORT=8080
EXPOSE 8080

# No healthcheck binary needed — fly.toml does an HTTP check against /.
CMD ["node", "server.js"]
