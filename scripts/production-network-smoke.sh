#!/usr/bin/env bash
# Disposable CI topology only: no published ports, real credentials or providers.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null
command -v openssl >/dev/null
test -d node_modules

network_tmp=$(mktemp -d)
network_name="nova-network-${GITHUB_RUN_ID:-local}-$$"
db_name="$network_name-db"
redis_name="$network_name-redis"
app_name="$network_name-app"
edge_name="$network_name-edge"
cleanup() {
  result=$?
  trap - EXIT
  if ((result != 0)); then
    # These containers contain only disposable synthetic state. Never dump env.
    docker logs --tail 35 "$app_name" 2>/dev/null || true
    docker logs --tail 15 "$db_name" 2>/dev/null || true
    docker logs --tail 15 "$edge_name" 2>/dev/null || true
    docker logs --tail 30 "$network_name-n13-fixture" 2>/dev/null || true
  fi
  docker rm -fv "$network_name-probe" "$network_name-n13-fixture" "$edge_name" "$app_name" "$redis_name" "$db_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  # PostgreSQL's private key has container ownership.
  docker run --rm --network none -v "$network_tmp:/cleanup" postgres:15 \
    sh -c 'rm -f /cleanup/*' >/dev/null 2>&1 || true
  rm -rf "$network_tmp"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for image in postgres:15 redis:7-alpine node:20-bookworm-slim nginx:stable-alpine; do
  docker pull "$image" >/dev/null
done
chmod 755 "$network_tmp"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -sha256 \
  -subj '/CN=Nova disposable test CA' -keyout "$network_tmp/ca.key" \
  -out "$network_tmp/ca.crt" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -sha256 \
  -subj '/CN=Unrelated disposable CA' -keyout "$network_tmp/wrong-ca.key" \
  -out "$network_tmp/wrong-ca.crt" >/dev/null 2>&1
for server in db edge; do
  openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$server" \
    -keyout "$network_tmp/$server.key" -out "$network_tmp/$server.csr" >/dev/null 2>&1
  printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$server" > "$network_tmp/$server.ext"
  openssl x509 -req -in "$network_tmp/$server.csr" -CA "$network_tmp/ca.crt" \
    -CAkey "$network_tmp/ca.key" -CAcreateserial -days 1 -sha256 \
    -extfile "$network_tmp/$server.ext" -out "$network_tmp/$server.crt" >/dev/null 2>&1
done
chmod 600 "$network_tmp"/*.key
docker run --rm --network none -v "$network_tmp:/certs" postgres:15 \
  sh -c 'chown postgres:postgres /certs/db.key'

db_password=$(openssl rand -hex 24)
redis_password=$(openssl rand -hex 24)
umask 077
cat > "$network_tmp/app.env" <<ENV
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
TRUST_PROXY_HOPS=1
DATABASE_URL=postgres://nova:$db_password@db:5432/nova_network?sslmode=disable
DATABASE_SSL_CA=/certs/ca.crt
DB_CONNECTION_TIMEOUT_MS=1000
REDIS_URL=redis://:$redis_password@redis:6379
GEMINI_API_KEY=synthetic-no-provider-access
WEBHOOK_VERIFY_TOKEN=$(openssl rand -hex 32)
META_APP_SECRET=$(openssl rand -hex 32)
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)
ENV
cat > "$network_tmp/db.env" <<ENV
POSTGRES_DB=nova_network
POSTGRES_USER=nova
POSTGRES_PASSWORD=$db_password
ENV
cat > "$network_tmp/redis.conf" <<CONF
bind 0.0.0.0
requirepass $redis_password
maxmemory-policy noeviction
save ""
appendonly no
CONF
cat > "$network_tmp/nginx.conf" <<'CONF'
events {}
http {
  access_log off;
  server {
    listen 443 ssl;
    ssl_certificate /certs/edge.crt;
    ssl_certificate_key /certs/edge.key;
    location / {
      proxy_pass http://app:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto https;
    }
  }
}
CONF
chmod 644 "$network_tmp/redis.conf" "$network_tmp/nginx.conf"
docker network create --internal "$network_name" >/dev/null
docker run -d --name "$db_name" --network "$network_name" --network-alias db --network-alias db-wrong \
  --env-file "$network_tmp/db.env" \
  -v "$network_tmp/db.crt:/certs/server.crt:ro" -v "$network_tmp/db.key:/certs/server.key:ro" \
  postgres:15 -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key >/dev/null
docker run -d --name "$redis_name" --network "$network_name" --network-alias redis \
  -v "$network_tmp/redis.conf:/etc/redis-test.conf:ro" redis:7-alpine redis-server /etc/redis-test.conf >/dev/null
for attempt in {1..30}; do
  if docker exec "$db_name" pg_isready -U nova -d nova_network >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$db_name" pg_isready -U nova -d nova_network >/dev/null

probe() {
  docker run --rm --name "$network_name-probe" --network "$network_name" --env-file "$network_tmp/app.env" \
    -e "NOVA_NETWORK_PHASE=$1" -v "$PWD:/app:ro" -w /app \
    -v "$network_tmp/ca.crt:/certs/ca.crt:ro" \
    -v "$network_tmp/wrong-ca.crt:/certs/wrong-ca.crt:ro" \
    node:20-bookworm-slim node --test tests/production-network.smoke.js
}
probe tls
probe worker-shutdown
docker run -d --name "$app_name" --network "$network_name" --network-alias app \
  --env-file "$network_tmp/app.env" -v "$PWD:/app:ro" -w /app \
  -v "$network_tmp/ca.crt:/certs/ca.crt:ro" node:20-bookworm-slim node src/bootstrap.js >/dev/null
docker run -d --name "$edge_name" --network "$network_name" --network-alias edge --network-alias edge-wrong \
  -v "$network_tmp/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$network_tmp/edge.crt:/certs/edge.crt:ro" -v "$network_tmp/edge.key:/certs/edge.key:ro" \
  nginx:stable-alpine >/dev/null

test "$(docker network inspect --format '{{.Internal}}' "$network_name")" = true
for container in "$db_name" "$redis_name" "$app_name" "$edge_name"; do
  test -z "$(docker port "$container")"
done
echo 'PASS: private network, no published ports or provider egress'
probe https
docker stop -t 5 "$redis_name" >/dev/null
probe unavailable
docker start "$redis_name" >/dev/null
probe recovered
docker stop -t 5 "$db_name" >/dev/null
probe unavailable
docker start "$db_name" >/dev/null
probe recovered

# N-13 active-inbox crash/recovery: exercise the real signed webhook and worker.
# The helper owns a PostgreSQL advisory lock; a one-message trigger blocks the
# canonical INSERT only after the durable inbox lease has been committed.
control_name="$network_name-n13-fixture"
docker run -d --name "$control_name" --network "$network_name" \
  --env-file "$network_tmp/app.env" -e N13_CONTROL_DIR=/control \
  -v "$PWD:/app:ro" -w /app -v "$network_tmp:/control" \
  -v "$network_tmp/ca.crt:/certs/ca.crt:ro" \
  node:20-bookworm-slim node tests/n13-active-inbox.smoke.js prepare >/dev/null

for attempt in {1..60}; do
  if [ -s "$network_tmp/ready.json" ]; then break; fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$control_name" 2>/dev/null || true)" != true ]; then
    docker logs "$control_name" 2>/dev/null || true
    echo 'N-13 fixture helper exited before establishing the active inbox lease' >&2
    exit 1
  fi
  sleep 0.5
done
test -s "$network_tmp/ready.json"
inbox_id=$(jq -r '.inboxId' "$network_tmp/ready.json")
tenant_id=$(jq -r '.tenantId' "$network_tmp/ready.json")
message_id=$(jq -r '.messageId' "$network_tmp/ready.json")
test -n "$inbox_id" && test -n "$tenant_id" && test -n "$message_id"
echo "N-13 fixture claimed inbox $inbox_id"
echo 'N13_STAGE=fixture_claimed'

# Preserve Redis process and in-memory job state; disconnect only its network.
echo "N13_STAGE=redis_disconnect_start"
docker network disconnect "$network_name" "$redis_name"
echo "N13_STAGE=redis_disconnected"
sleep 1
docker kill --signal=TERM "$app_name" >/dev/null
app_exit=$(timeout 15s docker wait "$app_name")
echo "N13_STAGE=app_exited code=$app_exit"
docker logs "$app_name" > "$network_tmp/n13-shutdown.log" 2>&1 || true
if [ "$app_exit" = 0 ]; then
  grep -q 'Nova-AI server closed successfully' "$network_tmp/n13-shutdown.log"
elif [ "$app_exit" = 1 ]; then
  grep -q 'Forced shutdown after 10 seconds' "$network_tmp/n13-shutdown.log"
  echo "N13_STAGE=watchdog_confirmed"
else
  echo "Unexpected active-inbox shutdown exit code: $app_exit" >&2
  exit 1
fi

# The helper owns the advisory lock used by the blocking trigger. Release it
# before DDL: DROP TRIGGER needs an AccessExclusive table lock and would wait
# behind the worker INSERT while that INSERT is still waiting on the helper.
# The app container has already exited, so releasing the fixture cannot cause
# a live application worker to commit this transaction.
touch "$network_tmp/release-lock"
test "$(timeout 10s docker wait "$control_name")" = 0
echo "N13_STAGE=fixture_helper_released"
docker exec "$db_name" psql -v ON_ERROR_STOP=1 -U nova -d nova_network \
  -c 'DROP TRIGGER IF EXISTS n13_pause_message_insert ON messages; DROP FUNCTION IF EXISTS n13_pause_message_insert();' >/dev/null
echo "N13_STAGE=trigger_removed"
docker rm -f "$control_name" >/dev/null

rollback_check=$(docker exec "$db_name" psql -At -v ON_ERROR_STOP=1 -U nova -d nova_network \
  -c "SELECT CASE WHEN w.state='PROCESSING' AND w.lease_token IS NOT NULL AND w.lease_until > NOW() AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id=w.tenant_id AND m.whatsapp_message_id='$message_id') THEN 'ok' ELSE 'bad' END FROM webhook_messages w WHERE w.id='$inbox_id' AND w.tenant_id='$tenant_id'")
test "$rollback_check" = ok
echo "N13_STAGE=transaction_rollback_verified"

# Restore the same Redis process; its stalled BullMQ job and lock state survive.
docker network connect --alias redis "$network_name" "$redis_name"
docker start "$app_name" >/dev/null
probe recovered
echo "N13_STAGE=app_restarted"

docker run --rm --network "$network_name" --env-file "$network_tmp/app.env" \
  -e N13_INBOX_ID="$inbox_id" -e N13_TENANT_ID="$tenant_id" -e N13_MESSAGE_ID="$message_id" \
  -v "$PWD:/app:ro" -w /app -v "$network_tmp/ca.crt:/certs/ca.crt:ro" \
  node:20-bookworm-slim node tests/n13-active-inbox.smoke.js verify-live
echo "N13_STAGE=live_lease_assertion_passed"

# Expire only the synthetic PostgreSQL lease. The app's real 10-second recovery
# loop must redispatch the same inbox after BullMQ's stalled-job no-op.
docker exec "$db_name" psql -v ON_ERROR_STOP=1 -U nova -d nova_network \
  -c "UPDATE webhook_messages SET lease_until=NOW()-INTERVAL '1 second', queue_dispatched_at=NOW()-INTERVAL '31 seconds', available_at=NOW() WHERE id='$inbox_id' AND tenant_id='$tenant_id' AND state='PROCESSING'" >/dev/null
echo "N13_STAGE=db_lease_expired"

docker run --rm --network "$network_name" --env-file "$network_tmp/app.env" \
  -e N13_INBOX_ID="$inbox_id" -e N13_TENANT_ID="$tenant_id" -e N13_MESSAGE_ID="$message_id" \
  -v "$PWD:/app:ro" -w /app -v "$network_tmp/ca.crt:/certs/ca.crt:ro" \
  node:20-bookworm-slim node tests/n13-active-inbox.smoke.js verify-completed
echo "N13_STAGE=recovery_completion_assertion_passed"

docker exec "$db_name" psql -v ON_ERROR_STOP=1 -U nova -d nova_network \
  -c "DELETE FROM tenants WHERE id='$tenant_id'" >/dev/null
echo 'PASS: active inbox crash recovery, stalled-job fencing and one-time canonical persistence'

# N-13 idle shutdown: separately verify bounded graceful close during Redis outage.
# This exercises app-level closeQueue() rather than only a standalone BullMQ worker.
docker stop -t 1 "$redis_name" >/dev/null
sleep 1
docker kill --signal=TERM "$app_name" >/dev/null
app_exit=$(timeout 15s docker wait "$app_name")
test "$app_exit" = 0
echo 'PASS: production app exited successfully after SIGTERM while Redis was unavailable'
