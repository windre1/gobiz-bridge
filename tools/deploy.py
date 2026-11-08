#!/usr/bin/env python3
"""Deploy the gobiz-bridge Worker to the owner's Cloudflare account.
Reuses the custom.cloudflare connector credential (dynamic surrogates).
Steps: create D1 -> apply schema -> upload script -> cron schedule ->
generate + set BRIDGE_* secrets -> enable workers.dev subdomain.
Owner-only secrets (GOBIZ_EMAIL, GOBIZ_PASSWORD, STATIC_QRIS_PAYLOAD) are
NOT set here; the owner enters them in the dashboard.
"""
import json, os, secrets, sys, urllib.request, uuid

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response, read_response_body

BASE = "https://api.cloudflare.com/client/v4"
ACCOUNT = os.environ.get("CF_ACCOUNT_ID", "YOUR-CLOUDFLARE-ACCOUNT-ID")
SCRIPT = "gobiz-bridge"
ROOT = os.path.expanduser("~/workspace/gobiz-bridge/worker-v2")
SECRETS_OUT = os.path.expanduser("~/workspace/gobiz-bridge/.bridge-secrets.json")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused")


def call(method, path, body=None, ctype="application/json"):
    data = None
    headers = {}
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers["Content-Type"] = ctype
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(req, timeout=90) as resp:
            return resp.status, read_json_response(resp)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            return e.code, {"raw": raw.decode("utf-8", "replace")[:1500]}


def ok(resp):
    return isinstance(resp, dict) and resp.get("success")


def ensure_d1():
    status, out = call("GET", f"/accounts/{ACCOUNT}/d1/database")
    for db in (out.get("result") or []):
        if db.get("name") == "gobiz-bridge":
            print("D1 exists:", db["uuid"])
            return db["uuid"]
    status, out = call("POST", f"/accounts/{ACCOUNT}/d1/database", {"name": "gobiz-bridge"})
    if not ok(out):
        print("D1 create FAILED", status, json.dumps(out)[:600]); sys.exit(1)
    dbid = out["result"]["uuid"]
    print("D1 created:", dbid)
    return dbid


def apply_schema(dbid):
    raw = open(os.path.join(ROOT, "schema.sql")).read()
    lines = [ln for ln in raw.splitlines() if not ln.strip().startswith("--")]
    sql = "\n".join(lines)
    clean = [s.strip() + ";" for s in sql.split(";") if s.strip()]
    for i, stmt in enumerate(clean):
        status, out = call("POST", f"/accounts/{ACCOUNT}/d1/database/{dbid}/query", {"sql": stmt})
        if not ok(out):
            print(f"schema stmt {i} FAILED", status, json.dumps(out)[:500], "\nSQL:", stmt[:200]); sys.exit(1)
    print(f"schema applied: {len(clean)} statements")


def upload_script(dbid):
    code = open(os.path.join(ROOT, "src/index.js"), "rb").read()
    meta = {
        "main_module": "index.js",
        "compatibility_date": "2025-01-15",
        "bindings": [
            {"type": "d1", "name": "DB", "id": dbid},
            {"type": "plain_text", "name": "GOBIZ_APP_VERSION", "text": "platform-v3.128.0-a941d748"},
            {"type": "plain_text", "name": "CALLBACK_URL", "text": "https://example.com/api/webhook"},
        ],
    }
    boundary = "----cf" + uuid.uuid4().hex
    parts = []
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(b'Content-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n')
    parts.append(json.dumps(meta).encode() + b"\r\n")
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(b'Content-Disposition: form-data; name="index.js"; filename="index.js"\r\nContent-Type: application/javascript+module\r\n\r\n')
    parts.append(code + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    status, out = call("PUT", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}", b"".join(parts),
                       ctype=f"multipart/form-data; boundary={boundary}")
    if not ok(out):
        print("script upload FAILED", status, json.dumps(out)[:800]); sys.exit(1)
    print("script uploaded:", out["result"].get("id"))


def set_schedule():
    status, out = call("PUT", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/schedules",
                       {"schedules": [{"cron": "*/1 * * * *"}]})
    print("schedule:", status, json.dumps(out)[:300])


def set_bridge_secrets():
    if os.path.exists(SECRETS_OUT):
        vals = json.load(open(SECRETS_OUT))
        print("bridge secrets already generated (file exists), re-setting them")
    else:
        vals = {
            "BRIDGE_API_KEY": "gob_" + secrets.token_hex(16),
            "BRIDGE_API_SECRET": secrets.token_hex(32),
            "BRIDGE_CALLBACK_SECRET": secrets.token_hex(32),
        }
        with open(SECRETS_OUT, "w") as f:
            json.dump(vals, f, indent=1)
        os.chmod(SECRETS_OUT, 0o600)
        print("bridge secrets generated ->", SECRETS_OUT)
    for name, text in vals.items():
        status, out = call("PUT", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/secrets",
                           {"name": name, "text": text, "type": "secret_text"})
        print("secret", name, ":", status, "ok" if ok(out) else json.dumps(out)[:300])


def enable_subdomain():
    status, out = call("POST", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/subdomain",
                       {"enabled": True, "previews_enabled": False})
    print("subdomain:", status, json.dumps(out)[:300])


if __name__ == "__main__":
    dbid = ensure_d1()
    apply_schema(dbid)
    upload_script(dbid)
    set_schedule()
    set_bridge_secrets()
    enable_subdomain()
    print("DEPLOY DONE db =", dbid)
