# Build context = repository root (see api-go/compose.snippet.yml). Multi-stage: static binary, tiny runtime.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY api-go/go.mod api-go/go.sum ./
RUN go mod download
COPY api-go/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /moontv-api .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /moontv-api /usr/local/bin/moontv-api
# TV app + browser simulator served at /tv/ and /sim (optional: drop these two lines for API-only)
COPY app /app/tv
COPY sim /app/sim
ENV MOONTV_UPSTREAM=http://moontv-core:3000 \
    TZ=UTC \
    MOONTV_CACHE=/cache \
    MOONTV_PORT=8788 \
    MOONTV_APP_DIR=/app/tv \
    MOONTV_SIM=/app/sim/index.html
VOLUME ["/cache"]
EXPOSE 8788
HEALTHCHECK --interval=60s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8788/health >/dev/null || exit 1
CMD ["moontv-api"]
