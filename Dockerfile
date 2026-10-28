# Compile static binaries for the requested target architecture in a Go build stage.
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod ./
# Source and module metadata are sufficient because each executable is self-contained.
COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/gateway ./cmd/gateway && \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/upstream ./cmd/upstream && \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/bench ./cmd/bench && \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/faultctl ./cmd/faultctl
# Keep the runtime small while providing CA roots and AWS CLI for role-based secret reads.
FROM alpine:3.21
RUN apk add --no-cache aws-cli ca-certificates && addgroup -S gateway && adduser -S -G gateway gateway && mkdir -p /data && chown gateway:gateway /data
COPY --from=build /out/gateway /usr/local/bin/gateway
COPY --from=build /out/upstream /usr/local/bin/upstream
COPY --from=build /out/bench /usr/local/bin/bench
COPY --from=build /out/faultctl /usr/local/bin/faultctl
# The gateway runs unprivileged; /data remains writable for fsync-and-rename state.
USER gateway
VOLUME ["/data"]
EXPOSE 8080 9090
ENTRYPOINT ["/usr/local/bin/gateway"]
