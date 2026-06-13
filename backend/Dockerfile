# ── Build stage ──────────────────────────────────────────────────────────────
FROM golang:1.22-alpine AS builder

RUN apk add --no-cache git

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w" -o /fct-backend .

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 1000 fct

WORKDIR /app

COPY --from=builder /fct-backend /app/fct-backend

RUN mkdir -p /data && chown fct:fct /data

USER fct

ENV DATA_DIR=/data
ENV PORT=8420

EXPOSE 8420

ENTRYPOINT ["/app/fct-backend"]
