#!/usr/bin/env bash
# Use Docker directly on developer machines and passwordless sudo on the EC2 demo host.
gateway_docker() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    if sudo -n docker info >/dev/null 2>&1; then
      if [[ -n "${JWT_BENCH_TOKEN:-}" ]]; then
        sudo -n --preserve-env=JWT_BENCH_TOKEN docker "$@"
      else
        sudo -n docker "$@"
      fi
      return
    fi
    if [[ -t 0 ]] && sudo docker info >/dev/null 2>&1; then
      if [[ -n "${JWT_BENCH_TOKEN:-}" ]]; then
        sudo --preserve-env=JWT_BENCH_TOKEN docker "$@"
      else
        sudo docker "$@"
      fi
      return
    fi
  fi

  echo "Docker is unavailable. Check Docker is running and that your account can use it." >&2
  return 1
}
