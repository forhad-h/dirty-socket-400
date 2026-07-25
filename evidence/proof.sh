#!/usr/bin/env bash
#
# A controlled experiment, using nothing but printf and nc.
#
# There is no JavaScript client here and no proxy library. Raw bytes go into a
# TCP socket and a real HTTP server answers. Three cases, changing one variable
# at a time, to show the 400 comes from the COMBINATION of an unfinished body
# and a reused connection -- not from either one alone.
#
#   Case A   two COMPLETE requests, same connection      -> 200, 200
#   Case B   PARTIAL body, follow-up on a NEW connection -> 200
#   Case C   PARTIAL body, follow-up REUSES it           -> 400 Bad Request
#
# Usage:  ./evidence/proof.sh [port]

set -u

PORT="${1:-8088}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM="$HERE/../server/upstream.js"

for tool in nc node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "  need '$tool' on PATH"; exit 1; }
done

echo
echo "Starting the upstream on 127.0.0.1:$PORT"
node "$UPSTREAM" --port="$PORT" > /tmp/dirty-socket-upstream.$$.log 2>&1 &
UP_PID=$!
trap 'kill $UP_PID 2>/dev/null; rm -f /tmp/dirty-socket-upstream.$$.log' EXIT
sleep 1.2

B1='{"message":"Hello","sessionId":"a"}'
B2='{"message":"How are you?"}'

# A complete, well-formed request.
req () {
  printf 'POST /chat-stream HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: keep-alive\r\n\r\n%s' "${#1}" "$1"
}

# Headers promising 45 body bytes, but only 19 are sent. This is the state a
# proxy leaves behind when it drops a request without destroying the socket.
partial () {
  printf 'POST /chat-stream HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 45\r\nConnection: keep-alive\r\n\r\n{"message":"Hello",'
}

line () { printf '%s\n' "------------------------------------------------------------"; }

echo
line
echo "CASE A   two COMPLETE requests on ONE connection"
echo "         (is keep-alive reuse itself the problem? no)"
line
COUNT=$({ req "$B1"; sleep 0.6; req "$B2"; sleep 1.5; } \
  | timeout 6 nc 127.0.0.1 "$PORT" | grep -cE '^HTTP/1.1 200')
echo "  200 OK responses: $COUNT        expected: 2"

echo
line
echo "CASE B   PARTIAL body, follow-up on a SEPARATE connection"
echo "         (is the unfinished body itself the problem? no)"
line
{ partial; sleep 0.3; } | timeout 3 nc 127.0.0.1 "$PORT" >/dev/null 2>&1
{ req "$B2"; sleep 1.5; } | timeout 6 nc 127.0.0.1 "$PORT" \
  | grep -E '^HTTP/1.1' | head -1 | sed 's/^/  /'
echo "                                  expected: 200 OK"

echo
line
echo "CASE C   PARTIAL body, follow-up REUSES the same connection"
echo "         (this is the bug)"
line
{ partial; sleep 0.3; req "$B2"; sleep 1.0; } | timeout 6 nc 127.0.0.1 "$PORT" \
  | grep -E '^HTTP/1.1' | head -1 | sed 's/^/  /'
echo "                                  expected: 400 Bad Request"

echo
line
echo "What the server logged during case C"
line
grep -E 'parse-error|bad-body' /tmp/dirty-socket-upstream.$$.log | tail -2 | sed 's/^ */  /'

echo
echo "  The follow-up in case C is byte-for-byte identical to the one in case B."
echo "  Only the connection it travelled on changed."
echo
