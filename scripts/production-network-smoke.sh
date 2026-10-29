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
  fi
  docker rm -fv "$edge_name" "$app_name" "$redis_name" "$db_name" >/dev/null 2>&1 || true
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
LOG_LEVEL=warn
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
  docker run --rm --network "$network_name" --env-file "$network_tmp/app.env" \
    -e "NOVA_NETWORK_PHASE=$1" -v "$PWD:/app:ro" -w /app \
    -v "$network_tmp/ca.crt:/certs/ca.crt:ro" \
    -v "$network_tmp/wrong-ca.crt:/certs/wrong-ca.crt:ro" \
    node:20-bookworm-slim node --test tests/production-network.smoke.js
}
probe tls
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

docker kill --signal=TERM "$app_name" >/dev/null
test "$(timeout 15s docker wait "$app_name")" = 0
echo 'PASS: production bootstrap exited successfully after SIGTERM'
