#!/bin/sh
# HTTP handler for /purge — called by nc -lk -e
read -r method path _
# Consume remaining headers
while read -r line; do
  line=$(printf '%s' "$line" | tr -d '\r\n')
  [ -z "$line" ] && break
done

touch /tmp/purge-cache
BODY='{"success":true,"message":"cache purge scheduled"}'
printf "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" ${#BODY} "$BODY"
