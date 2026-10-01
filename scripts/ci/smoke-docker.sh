#!/usr/bin/env bash
#
# Starts the whole stack from docker-compose.yml — web, server, broker — under
# its own project name and ports, attacks it with smoke.sh, checks what only
# the containers can show, and takes it down again, volume and all.
#
#   SMOKE_BUILD=0   use the images already named by KRAFTVERK_SERVER_IMAGE and
#                   KRAFTVERK_WEB_IMAGE instead of building (CI builds once and
#                   tests what it will ship).
#   SMOKE_HOST      where the published ports are (default 127.0.0.1). When
#                   the Docker is another machine — a Docker-in-Docker service
#                   — that machine, and the internet entrance has to be
#                   published there too: KRAFTVERK_PUBLIC_BIND=0.0.0.0.
#
# Leaves the containers' logs in smoke-logs.txt, for when it fails.

set -euo pipefail
cd "$(dirname "$0")/../.."

project=kraftverk-smoke
host=${SMOKE_HOST:-127.0.0.1}
export COMPOSE_PROJECT_NAME=$project
export READ_ONLY=1
export KRAFTVERK_ALLOWED_HOSTS=kraftverk.example.test
export KRAFTVERK_LAN_PORT=18080 KRAFTVERK_PUBLIC_PORT=18090 KRAFTVERK_MQTT_PORT=11883 KRAFTVERK_API_PORT=13333
compose() { docker compose -f docker-compose.yml "$@"; }

finish() {
  status=$?
  compose logs --no-color --timestamps > smoke-logs.txt 2>&1 || true
  compose down --volumes --remove-orphans > /dev/null 2>&1 || true
  [ $status -eq 0 ] || echo "The stack's logs are in smoke-logs.txt" >&2
  exit $status
}
trap finish EXIT

echo "Starting the stack"
if [ "${SMOKE_BUILD:-1}" = "0" ]; then
  compose up -d --no-build --wait --wait-timeout 180
else
  compose up -d --build --wait --wait-timeout 600
fi
compose ps

LAN_URL=http://$host:18080 PUBLIC_URL=http://$host:18090 PUBLIC_HOST=kraftverk.example.test \
  bash scripts/ci/smoke.sh

echo "Inside the stack"
ok() { printf '  ok  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; exit 1; }

# The two start together, and the server retries until the broker listens —
# so give the retry time rather than reading the log once.
connected=0
for _ in $(seq 1 30); do
  if compose logs kraftverk | grep -q 'Connected to the broker'; then connected=1; break; fi
  sleep 1
done
[ "$connected" = 1 ] || fail 'the server connects to the broker'
ok 'the server connects to the broker'

# A client that is not the server, connecting as a station would and then
# trying to command one. MQTT 3.1.1 CONNECT, client id "smoke-intruder":
exec 3<>/dev/tcp/$host/11883
printf '\x10\x1a\x00\x04MQTT\x04\x02\x00\x3c\x00\x0esmoke-intruder' >&3
connack=$(timeout 5 head -c 4 <&3 | od -An -tx1 | tr -d ' \n')
[ "$connack" = "20020000" ] || fail "the broker accepts a connection on the station port (got '$connack')"
ok 'the broker accepts a connection on the station port'
# PUBLISH to ABCDEF012345/client/request/data: a command, which only the
# server may send. The broker must refuse it and close the connection.
printf '\x30\x24\x00\x20ABCDEF012345/client/request/data\x01\x03' >&3
# `cat` ends when the broker closes the connection; `timeout` says 124 if it never did.
closed=0
timeout 5 cat <&3 > /dev/null 2>&1 || closed=$?
[ "$closed" -ne 124 ] || fail 'the broker cuts off a client that commands a station'
exec 3<&- 3>&-
sleep 1
compose exec -T broker sh -c 'cat /data/broker/logs/broker-*.jsonl' | grep -q '"kind":"mqtt.refused"' \
  || fail 'the refusal is in the broker journal'
ok 'the broker cuts off a client that commands a station, and journals it'

compose exec -T kraftverk sh -c 'ls /data/logs/server-*.log' > /dev/null || fail 'the server keeps its log on the volume'
ok 'the server keeps its log on the volume'
compose exec -T broker sh -c 'ls /data/broker/logs/broker-*.jsonl' > /dev/null || fail 'the broker keeps its journal on the volume'
ok 'the broker keeps its journal on the volume'

echo "The stack passed"
