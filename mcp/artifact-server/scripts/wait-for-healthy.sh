#!/usr/bin/env bash
# wait-for-healthy.sh — Block until all services in a docker-compose project
# report healthy status, or until the timeout is exceeded.
#
# Usage:
#   ./scripts/wait-for-healthy.sh [compose-file] [timeout-seconds]
#
# Arguments:
#   compose-file     Path to the docker-compose file (default: docker-compose.test.yml)
#   timeout-seconds  Maximum seconds to wait (default: 120)
#
# Exit codes:
#   0 — all services healthy
#   1 — timeout exceeded or a service exited unexpectedly

set -euo pipefail

COMPOSE_FILE="${1:-docker-compose.test.yml}"
TIMEOUT="${2:-120}"

if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: timeout must be a positive integer, got: $TIMEOUT" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE_PATH="$COMPOSE_DIR/$COMPOSE_FILE"

if [[ ! -f "$COMPOSE_FILE_PATH" ]]; then
  echo "ERROR: compose file not found: $COMPOSE_FILE_PATH" >&2
  exit 1
fi

echo "Waiting for all services to become healthy (timeout: ${TIMEOUT}s)..."
echo "Compose file: $COMPOSE_FILE_PATH"

start_time=$(date +%s)

while true; do
  now=$(date +%s)
  elapsed=$(( now - start_time ))

  if [[ $elapsed -ge $TIMEOUT ]]; then
    echo "ERROR: Timed out after ${TIMEOUT}s waiting for services to become healthy." >&2
    # Print service status for debugging
    docker compose -f "$COMPOSE_FILE_PATH" ps --format json 2>/dev/null || \
      docker compose -f "$COMPOSE_FILE_PATH" ps
    exit 1
  fi

  # Get health status for all services that have a healthcheck defined.
  # docker compose ps --format json outputs one JSON object per line.
  statuses=$(docker compose -f "$COMPOSE_FILE_PATH" ps --format json 2>/dev/null)

  if [[ -z "$statuses" ]]; then
    sleep 2
    continue
  fi

  # Count services and their health states using awk to avoid jq dependency.
  total=0
  healthy=0
  unhealthy=0
  exited=0

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    total=$(( total + 1 ))

    health=$(echo "$line" | awk -F'"Health":"' '{print $2}' | awk -F'"' '{print $1}')
    state=$(echo "$line" | awk -F'"State":"' '{print $2}' | awk -F'"' '{print $1}')

    if [[ "$state" == "exited" ]] || [[ "$state" == "dead" ]]; then
      exited=$(( exited + 1 ))
    elif [[ "$health" == "healthy" ]]; then
      healthy=$(( healthy + 1 ))
    elif [[ "$health" == "unhealthy" ]]; then
      unhealthy=$(( unhealthy + 1 ))
    fi
  done <<< "$statuses"

  if [[ $exited -gt 0 ]]; then
    echo "ERROR: One or more services exited unexpectedly." >&2
    docker compose -f "$COMPOSE_FILE_PATH" ps
    exit 1
  fi

  if [[ $unhealthy -gt 0 ]]; then
    echo "ERROR: One or more services reported unhealthy." >&2
    docker compose -f "$COMPOSE_FILE_PATH" ps
    exit 1
  fi

  # All services with healthchecks must be healthy.
  # Services without healthchecks show health="" and state="running" — count as healthy.
  running_no_healthcheck=$(( total - healthy - unhealthy - exited ))
  effective_healthy=$(( healthy + running_no_healthcheck ))
  if [[ $total -gt 0 && $effective_healthy -eq $total ]]; then
    echo "All $total service(s) healthy after ${elapsed}s."
    exit 0
  fi

  echo "  [${elapsed}s] waiting... (${healthy}/${total} healthy)"
  sleep 5
done
