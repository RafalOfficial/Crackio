"""The door in front of a Crackio that runs on a Colab GPU (colab/start.py starts it).

  python3 gate.py <listen port> <Crackio's port> <key file> [<file with the link's host name>]

Crackio has no login: on your own computer only that computer can open it. On Colab it sits behind a web link, so this
small door stands in front and lets in only a browser that has the key, a long random text made new for every session.
The notebook's "Open Crackio" button carries the key after a # (that part of an address is never sent to a server or
written to a log): the door's page reads it, hands it over once and gets a cookie back. A program can send
Authorization: Bearer <key> instead. Everything else passes through as it is: pages, files, uploads, live connections.
"""
import asyncio
import hashlib
import hmac
import os
import sys

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web

LISTEN, UP_PORT, KEY_FILE = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
# The file the notebook keeps the link's host name in (optional).
HOST_FILE = sys.argv[4] if len(sys.argv) > 4 else ""
LINK = {"at": 0.0, "name": ""}
KEY = open(KEY_FILE, encoding="utf-8").read().strip()
if len(KEY) < 20:
    sys.exit("The key is too short to be safe.")
UPSTREAM = f"127.0.0.1:{UP_PORT}"
COOKIE = "crackio_gate"
# What the cookie holds: a mark made from the key, not the key.
MARK = hashlib.sha256(("crackio-gate:" + KEY).encode()).hexdigest()
# Headers that belong to one connection, not to the message passed on.
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length"}
# Headers the door writes itself (or keeps to itself: the key), whatever the link in front sent.
OURS = {"authorization", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "forwarded"}
PAGE = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Crackio</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0c11;color:#f2efe9;font:16px system-ui,sans-serif">
<form method="post" action="/__gate" style="width:min(360px,86vw)">
<h1 style="font-size:22px;margin:0 0 6px">Crackio</h1>
<p id="said" style="margin:0 0 18px;color:#9a96a3;font-size:14px;line-height:1.45">__SAID__</p>
<input name="key" type="password" autocomplete="off" placeholder="Key" style="box-sizing:border-box;width:100%;height:46px;border-radius:12px;border:1px solid #33303c;background:#17151d;color:#f2efe9;padding:0 14px;font-size:16px">
<button style="margin-top:12px;width:100%;height:46px;border-radius:12px;border:0;background:#ff5b2e;color:#1a0e08;font-weight:700;font-size:15px">Open</button>
</form>
<script>
(async () => {
  const key = decodeURIComponent(location.hash.slice(1));
  if (!key) return;
  // The key leaves the address bar and the browser's history before anything else happens.
  history.replaceState(null, "", "/__gate");
  const said = document.getElementById("said");
  said.textContent = "Opening Crackio ...";
  try {
    const res = await fetch("/__gate", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "key=" + encodeURIComponent(key) });
    if (res.ok) return location.replace("/");
    said.textContent = "That link is from an earlier session. Press the Open Crackio button in your notebook again.";
  } catch {
    said.textContent = "Crackio isn't answering. Look at your notebook: it says what is happening.";
  }
})();
</script></body></html>"""
ASK = "This Crackio is locked. Press the Open Crackio button in your Colab notebook: it lets you in by itself. Or paste the key shown under that button here."


def public_host(request):
    """The name the browser opened. A link may hand requests over under a name of its own (Colab's own address does),
    so the notebook writes the link's name to a file and that is the one Crackio hears."""
    if HOST_FILE:
        try:
            at = os.stat(HOST_FILE).st_mtime
            if at != LINK["at"]:
                LINK.update(at=at, name=open(HOST_FILE, encoding="utf-8").read().strip())
        except OSError:
            pass
        if LINK["name"]:
            return LINK["name"]
    return request.headers.get("Host", "")


def same(given, right):
    return bool(right) and bool(given) and hmac.compare_digest(str(given).encode(), right.encode())


def allowed(request):
    auth = request.headers.get("Authorization", "")
    return same(auth[7:] if auth.startswith("Bearer ") else "", KEY) or same(request.cookies.get(COOKIE), MARK)


def ask(said=ASK, status=200):
    return web.Response(status=status, content_type="text/html", text=PAGE.replace("__SAID__", said), headers={"Cache-Control": "no-store"})


async def live(request):
    """A live connection, both ways."""
    ours = web.WebSocketResponse(max_msg_size=0)
    await ours.prepare(request)
    query = request.rel_url.query_string
    async with request.app["session"].ws_connect(f"ws://{UPSTREAM}{request.rel_url.path}{'?' + query if query else ''}", max_msg_size=0) as theirs:

        async def pump(src, dst):
            async for msg in src:
                if msg.type == WSMsgType.TEXT:
                    await dst.send_str(msg.data)
                elif msg.type == WSMsgType.BINARY:
                    await dst.send_bytes(msg.data)
                else:
                    break

        tasks = [asyncio.ensure_future(pump(ours, theirs)), asyncio.ensure_future(pump(theirs, ours))]
        _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
    await ours.close()
    return ours


async def handle(request):
    if request.path == "/__gate/ping":
        # For the notebook: is the link alive? Says nothing about Crackio and needs no key.
        return web.Response(text="crackio-gate", headers={"Cache-Control": "no-store"})
    if request.path == "/__gate":
        if request.method != "POST":
            return ask()
        form = await request.post()
        # Someone may paste the button's whole link instead of the key: the key is the part after the #.
        given = str(form.get("key", "")).strip().rsplit("#", 1)[-1].strip()
        if not same(given, KEY):
            # A wrong key waits, so guessing is slow (the key is 32 random characters: there is nothing to guess).
            await asyncio.sleep(2)
            return ask("That isn't the key. It is shown under the Open Crackio button in your Colab notebook.", 401)
        # The page's own script gets a plain yes; a form sent without scripts is taken to Crackio.
        answer = web.Response(status=303, headers={"Location": "/"}) if "text/html" in request.headers.get("Accept", "") else web.Response(status=204)
        answer.set_cookie(COOKIE, MARK, max_age=7 * 86400, httponly=True, secure=True, samesite="Lax", path="/")
        answer.headers["Cache-Control"] = "no-store"
        return answer
    if not allowed(request):
        # A page asked for by a person gets the door; anything else a plain refusal.
        if request.method == "GET" and "text/html" in request.headers.get("Accept", ""):
            return web.Response(status=302, headers={"Location": "/__gate", "Cache-Control": "no-store"})
        return web.Response(status=401, text="This Crackio is private: open it with the button in its Colab notebook.")
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return await live(request)
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP and k.lower() not in OURS}
    # Crackio checks that a page's requests come from the address it is opened at: the address the browser used goes
    # along, once (the link's own forwarding headers are dropped above, or Crackio would see two names and refuse both).
    headers["X-Forwarded-Host"] = public_host(request)
    headers["X-Forwarded-Proto"] = "https"
    if request.content_length is not None:
        headers["Content-Length"] = str(request.content_length)
    body = request.content if request.body_exists else None
    try:
        async with request.app["session"].request(request.method, f"http://{UPSTREAM}{request.rel_url}", headers=headers, data=body, allow_redirects=False) as up:
            out = web.StreamResponse(status=up.status, headers={k: v for k, v in up.headers.items() if k.lower() not in HOP})
            await out.prepare(request)
            try:
                async for chunk in up.content.iter_any():
                    await out.write(chunk)
                await out.write_eof()
            except (ConnectionResetError, asyncio.CancelledError):
                pass
            return out
    except OSError:
        # Crackio is starting (or starting again): say so instead of a bare error.
        return web.Response(status=503, text="Crackio is starting. Try again in a few seconds.", headers={"Retry-After": "5", "Cache-Control": "no-store"})


async def session(app):
    # Bytes pass as they are (no unpacking here), and nothing times out: a big file takes as long as it takes.
    app["session"] = ClientSession(auto_decompress=False, timeout=ClientTimeout(total=None))
    yield
    await app["session"].close()


app = web.Application(client_max_size=0)
app.cleanup_ctx.append(session)
app.router.add_route("*", "/{tail:.*}", handle)
web.run_app(app, host="127.0.0.1", port=LISTEN, print=None)
