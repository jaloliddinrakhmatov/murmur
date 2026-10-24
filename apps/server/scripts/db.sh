#!/usr/bin/env bash
# Project-local PostgreSQL cluster (not a system service): data in apps/server/.dev/pgdata,
# port 54329, loopback only. Usage: db.sh start|stop|status
set -euo pipefail

PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="$ROOT/.dev"
DATA="$DEV/pgdata"
PORT="${MURMUR_PG_PORT:-54329}"

running() { "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; }

start() {
  mkdir -p "$DEV"
  if [ ! -f "$DATA/PG_VERSION" ]; then
    "$PG_BIN/initdb" -D "$DATA" -U murmur --auth=trust --encoding=UTF8 --locale=C >/dev/null
  fi
  if ! running; then
    "$PG_BIN/pg_ctl" -D "$DATA" -l "$DEV/postgres.log" -w \
      -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$DEV" start >/dev/null
  fi
  for db in murmur_dev murmur_test; do
    if [ "$("$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U murmur -d postgres -Atc "select 1 from pg_database where datname='$db'")" != "1" ]; then
      "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U murmur "$db"
    fi
  done
  echo "PostgreSQL ready on 127.0.0.1:$PORT (databases murmur_dev, murmur_test)"
}

stop() {
  if running; then "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null; fi
  echo "PostgreSQL stopped"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) if running; then echo running; else echo stopped; exit 1; fi ;;
  *) echo "usage: db.sh start|stop|status" >&2; exit 2 ;;
esac
