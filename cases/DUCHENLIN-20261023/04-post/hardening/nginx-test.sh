#!/usr/bin/env bash
# nginx-test.sh - 在容器里校验 nginx-hardened.conf 的语法与结构，不需要本机装 nginx。
# 用法：bash nginx-test.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$HERE/.nginx-test"
rm -rf "$TMP"; mkdir -p "$TMP/conf.d" "$TMP/certs" "$TMP/logs"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$TMP/certs/privkey.pem" -out "$TMP/certs/fullchain.pem" \
  -days 2 -subj "/CN=duchenlin.top" 2>/dev/null

cat > "$TMP/nginx.conf" <<'EOF'
worker_processes 1;
error_log /etc/nginx-test/logs/error.log warn;
pid /etc/nginx-test/logs/nginx.pid;
events { worker_connections 256; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  access_log /etc/nginx-test/logs/access.log;
  include /etc/nginx-test/conf.d/*.conf;
}
EOF

printf 'proxy_set_header Host $host;\nproxy_set_header X-Real-IP $remote_addr;\n' > "$TMP/proxy_params"

sed -e 's#/etc/letsencrypt/live/duchenlin.top/#/etc/nginx-test/certs/#' \
    -e 's#/etc/nginx/proxy_params#/etc/nginx-test/proxy_params#' \
    "$HERE/nginx-hardened.conf" > "$TMP/conf.d/00-hardening.conf"

WIN=$(cd "$TMP" && pwd -W 2>/dev/null || pwd)
echo "== nginx -t =="
docker run --rm -v "$WIN:/etc/nginx-test" --entrypoint /bin/sh nginx:alpine \
  -c "/usr/sbin/nginx -t -c /etc/nginx-test/nginx.conf 2>&1; echo EXIT=\$?"

echo "== 负向对照（应 EXIT=1）=="
echo 'this_is_not_a_directive on;' > "$TMP/conf.d/99-broken.conf"
docker run --rm -v "$WIN:/etc/nginx-test" --entrypoint /bin/sh nginx:alpine \
  -c "/usr/sbin/nginx -t -c /etc/nginx-test/nginx.conf 2>&1; echo EXIT=\$?" || true
rm -f "$TMP/conf.d/99-broken.conf"
