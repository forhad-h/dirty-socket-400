# Reproduce it yourself

Four ways to verify the bug, from "no code at all" to "the real proxy libraries". Every one runs
locally in under a minute. Nothing here needs `npm install` except the last.

---

## 1. The controlled experiment (30 seconds, no dependencies)

The most convincing version, because there is no client library involved. Just `printf`, `nc`, and a
real HTTP server. Three cases, changing one variable at a time:

```bash
git clone https://github.com/forhad-h/dirty-socket-400
cd dirty-socket-400
bash evidence/proof.sh
```

```
CASE A   two COMPLETE requests on ONE connection
  200 OK responses: 2        expected: 2

CASE B   PARTIAL body, follow-up on a SEPARATE connection
  HTTP/1.1 200 OK            expected: 200 OK

CASE C   PARTIAL body, follow-up REUSES the same connection
  HTTP/1.1 400 Bad Request   expected: 400 Bad Request

What the server logged during case C
  [upstream] parse-error: HPE_INVALID_METHOD — refusing the request
  [upstream] bad-body: body was not valid JSON (45 bytes): "{\"message\":\"Hello\",POST /chat-stream HTTP/1.1"
```

**Why this is the proof.** The follow-up request in case C is byte-for-byte identical to the one in
case B. Only the connection it travelled on changed.

- Case A rules out keep-alive reuse as the cause. Reuse on its own is fine.
- Case B rules out the unfinished body as the cause. An abandoned request on its own is fine.
- Case C is both together, and only that combination fails.

---

## 2. By hand, against your own server

You do not need this repo. Point these bytes at anything that reads a request body over keep-alive.

Start a server to aim at (this repo ships one):

```bash
node server/upstream.js --port=8088
```

Then, in another terminal, send a request that promises 45 body bytes but sends 19, and immediately
follow it with a second, perfectly valid request on the same connection:

```bash
{
  printf 'POST /chat-stream HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 45\r\nConnection: keep-alive\r\n\r\n'
  printf '{"message":"Hello",'
  sleep 0.3
  printf 'POST /chat-stream HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 26\r\nConnection: keep-alive\r\n\r\n{"message":"How are you?"}'
  sleep 1
} | nc 127.0.0.1 8088
```

```
HTTP/1.1 400 Bad Request
Connection: close
```

Change `Content-Length: 45` to `19` so the first body is complete, and the same two requests both
return `200 OK`. That one number is the whole bug.

---

## 3. The full scenario, both modes

Runs the abort-then-follow-up sequence the way a chat UI produces it, with and without the fix:

```bash
node server/raw-repro.js
```

```
broken  reused dirty socket: true   follow-up: HTTP/1.1 400 Bad Request
fixed   reused dirty socket: false  follow-up: HTTP/1.1 200 OK
```

Run one mode on its own with `--mode=broken` or `--mode=fixed`. Every step is timestamped, so you
can see the abort land and the socket go back into the pool still owing bytes.

To inspect the captured bytes directly rather than trusting the summary:

```bash
node server/capture.js                        # re-records traces/
cat traces/broken.json | head -60             # real frames, real timings
```

`traces/broken.json` contains the `stolen`, `resyncRemainder` and `stitchedBody` fields the simulator
highlights. `stitchedBody` is what request #1's body actually became.

---

## 4. See it, then read it

```bash
node server/serve-web.js     # http://localhost:4173
```

The simulator replays `traces/*.json`. Toggle Broken and Fixed, and step through with the Step
button or the arrow key. The wire inspector shows which bytes were swallowed and where the parser
resynced.

---

## 5. Against the real proxy libraries

This one needs `npm install`:

```bash
npm install
node server/live-demo.js
```

**Read the output carefully, because it does not say what you might expect.** Over a direct
localhost hop on Node 18+, `express-http-proxy` and `http-proxy-middleware` **both pass** — nothing
is left half-read and both follow-ups return 200. Destroying the client socket tears down the piped
upstream request on its own.

That is a real result and the script reports it rather than dressing it up.

The explicit `proxyReq.destroy()` matters when something holds the upstream socket open independently
of the client socket:

- a load balancer, TLS terminator, or service mesh sidecar between proxy and upstream
- a keep-alive agent under concurrency that hands the socket to the next request before teardown
  finishes
- any hop that turns one aborted client connection into a still-open upstream connection

Sections 1 to 3 model that state directly, which is why they are deterministic and this one is not.

---

## Verifying the fix in your own proxy

The failure needs a socket that is mid-message to re-enter the pool. So the check is not "did I
handle the error" but "did the socket survive the abort":

```js
on: {
  proxyReq: (proxyReq, req, res) => {
    const abortUpstream = () => {
      try { proxyReq.destroy?.(); } catch {}
    };
    req.on('aborted', abortUpstream);
    res.on('close',   abortUpstream);
  },
}
```

To confirm it is working, count sockets rather than errors. Abort a streaming request mid-body and
check that the upstream is not left holding a half-read request — `server/live-demo.js` shows one way
to instrument that.

If you are on `express-http-proxy`, there is no hook for this, which is the practical reason to move
streaming routes to `http-proxy-middleware`. Non-streaming routes can stay where they are; they
rarely abort mid-body, which is why the bug hides for so long.
