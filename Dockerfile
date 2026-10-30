# syntax=docker/dockerfile:1

# ---- deps: install node_modules from the lockfile ----
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- builder: run the React Router / Vite build ----
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The commit being built (CI passes it; .git isn't copied in).
ARG REVISION=dev
ENV APP_REVISION=$REVISION
RUN bun --bun run build

# ---- runtime ----
FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/punchlist.db
ENV CONFIG_FILE=/config/punchlist.yaml

# tzdata provides /usr/share/zoneinfo. Without it TZ silently falls back to UTC.
# All dates in the app use the zone in the config file, so this only matters to
# logs and to anything a deployment does with TZ itself.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tzdata \
  && rm -rf /var/lib/apt/lists/*
ENV TZ=UTC

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./package.json
# The server build already contains src/; the operator commands
# (`bun run admin-link`) run from source, so it's copied too. server.ts is the
# production server (Express behind the reverse proxy); Bun runs it as is.
COPY --from=builder /app/src ./src
COPY --from=builder /app/server.ts ./server.ts

VOLUME ["/data"]
EXPOSE 3000

# The same commit for code run from source here (the operator CLI). Last, so
# a new commit doesn't invalidate the layers above.
ARG REVISION=dev
ENV APP_REVISION=$REVISION

# /healthz is 200 when the server answers and the database does. With
# SOCKET_PATH the app has no TCP port, so the check follows it onto the socket.
# --start-interval (Docker Engine 25+) checks every 2 s while starting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["bun", "-e", "const s = process.env.SOCKET_PATH; const r = await fetch(s ? 'http://localhost/healthz' : `http://127.0.0.1:${process.env.PORT ?? 3000}/healthz`, s ? { unix: s } : {}); process.exit(r.ok ? 0 : 1)"]

CMD ["bun", "server.ts"]
