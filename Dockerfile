# ===== Stage 1: build the frontend =====
FROM node:22-alpine AS web-builder

WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY web/ ./
RUN npm run build

# ===== Stage 2: build the Rust backend (with embedded frontend) =====
FROM rust:1-alpine AS server-builder

# Alpine needs a C compiler + musl dev for SQLite/sqlx.
RUN apk add --no-cache musl-dev pkgconfig openssl-dev gcc

WORKDIR /server
COPY server/Cargo.toml server/Cargo.lock* ./
COPY server/config.toml ./
COPY server/migrations ./migrations
COPY server/src ./src

# Copy the built frontend so rust-embed can include it.
COPY --from=web-builder /web/dist ./../web/dist

ENV CARGO_TERM_COLOR=always
RUN cargo build --release --bin dragonfox-drive

# ===== Stage 3: runtime =====
FROM alpine:3.20

RUN apk add --no-cache ca-certificates libc6-compat

WORKDIR /app

COPY --from=server-builder /server/target/release/dragonfox-drive /app/dragonfox-drive
COPY --from=server-builder /server/config.toml /app/config.toml

# Data dir mounted as a volume.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8080

ENV RUST_LOG=info
ENV DRAGONFOX__SERVER__HOST=0.0.0.0
ENV DRAGONFOX__SERVER__PORT=8080
ENV DRAGONFOX__STORAGE__DATA_DIR=/app/data
ENV DRAGONFOX__DATABASE__URL=sqlite:///app/data/dragonfox.db?mode=rwc

ENTRYPOINT ["/app/dragonfox-drive"]
