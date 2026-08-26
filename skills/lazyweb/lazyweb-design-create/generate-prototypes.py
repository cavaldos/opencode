#!/usr/bin/env python3
"""Lazyweb design-research prototype generator (v3.4 image-gen-first path).

Two subcommands, pure stdlib:

  probe     -- detect live image routes, write/refresh the capability cache
  generate  -- generate one image per bet IN PARALLEL on the openai route,
               with a de-branded retry on policy refusal and a per-bet
               status file the skill uses to HTML-fallback failed bets only

Usage:
  generate-prototypes.py probe [--native ok|dead] [--skill-version X.Y.Z] [--force]
  generate-prototypes.py generate --bets bets.json --out-dir references/ \
      [--status work/proto-status.json] [--size 1536x1024]

bets.json:
  [{"slug": "live-trust-dashboard", "prompt": "...", "debranded_prompt": "..."}, ...]

Capability cache (~/.lazyweb/imagegen-capability.json):
  {"checked_at": ISO, "skill_version": "0.6.0",
   "native": "ok|dead", "codex": "ok|dead", "openai": "ok|dead",
   "api": "ok|dead", "openai_model": "gpt-image-2"}
Cache busts when: >7 days old, --force, skill_version changed, or the
openai field is missing (pre-v3.4 cache).

The OpenAI key is read from OPENAI_API_KEY or ~/.lazyweb/openai_api_key and
is NEVER printed. Env overrides (tests): OPENAI_BASE_URL, LAZYWEB_CAP_CACHE.
Exit codes: 0 = all requested work done (even if some bets failed -> see
status file); 2 = route unusable up front (skill falls back for all bets).
"""
import argparse
import base64
import concurrent.futures
import datetime
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

MAX_CONCURRENCY = 3
GEN_TIMEOUT_S = 180
CACHE_TTL_DAYS = 7


def log(msg):
    print(msg, file=sys.stderr)


def cache_path():
    override = os.environ.get("LAZYWEB_CAP_CACHE")
    if override:
        return pathlib.Path(override)
    return pathlib.Path.home() / ".lazyweb" / "imagegen-capability.json"


def load_key():
    k = os.environ.get("OPENAI_API_KEY", "").strip()
    if k:
        return k
    p = pathlib.Path.home() / ".lazyweb" / "openai_api_key"
    if p.is_file():
        return p.read_text().strip()
    return ""


def openai_base():
    return os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")


def newest_image_model(key):
    """Return the newest gpt-image-* model id, or None."""
    req = urllib.request.Request(
        f"{openai_base()}/models",
        headers={"Authorization": f"Bearer {key}"},
    )
    data = json.loads(urllib.request.urlopen(req, timeout=20).read())
    models = [m["id"] for m in data.get("data", []) if str(m.get("id", "")).startswith("gpt-image")]
    if not models:
        return None
    # newest = highest major ("gpt-image-2" > "gpt-image-1"), dated snapshots beat bare ids
    return sorted(models, reverse=True)[0]


def probe(args):
    cp = cache_path()
    if cp.is_file() and not args.force:
        try:
            cached = json.loads(cp.read_text())
            checked = datetime.datetime.fromisoformat(cached.get("checked_at", "1970-01-01T00:00:00"))
            fresh = (datetime.datetime.utcnow() - checked).days < CACHE_TTL_DAYS
            same_version = cached.get("skill_version") == args.skill_version
            has_openai = "openai" in cached
            if fresh and same_version and has_openai:
                log(f"PROBE_CACHED: {json.dumps({k: v for k, v in cached.items() if k != 'checked_at'})}")
                print(json.dumps(cached))
                return 0
        except (ValueError, OSError):
            pass

    caps = {
        "checked_at": datetime.datetime.utcnow().isoformat(timespec="seconds"),
        "skill_version": args.skill_version,
        "native": args.native,
    }
    # codex: healthy CLI? (bitmap emission is settled by actual use; a healthy
    # CLI is the precondition — codex has no native image tool, so it stays a
    # low-priority route behind openai)
    try:
        r = subprocess.run(["codex", "exec", "reply with exactly: OK", "-s", "read-only"],
                           capture_output=True, text=True, timeout=90)
        caps["codex"] = "ok" if (r.returncode == 0 and "OK" in r.stdout) else "dead"
    except (OSError, subprocess.TimeoutExpired):
        caps["codex"] = "dead"
    # openai images
    key = load_key()
    if not key:
        caps["openai"] = "dead"
        caps["openai_model"] = None
    else:
        try:
            model = newest_image_model(key)
            caps["openai"] = "ok" if model else "dead"
            caps["openai_model"] = model
        except Exception as exc:
            log(f"PROBE: openai models call failed: {type(exc).__name__}")
            caps["openai"] = "dead"
            caps["openai_model"] = None
    # legacy field for older skill text: any external API route alive?
    caps["api"] = caps["openai"]

    cp.parent.mkdir(parents=True, exist_ok=True)
    cp.write_text(json.dumps(caps))
    os.chmod(cp, 0o600)
    log(f"PROBE_FRESH: native={caps['native']} codex={caps['codex']} openai={caps['openai']} model={caps.get('openai_model')}")
    print(json.dumps(caps))
    return 0


def gen_image(key, model, prompt, size, out_file):
    body = json.dumps({"model": model, "prompt": prompt, "size": size, "n": 1}).encode()
    req = urllib.request.Request(
        f"{openai_base()}/images/generations",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    data = json.loads(urllib.request.urlopen(req, timeout=GEN_TIMEOUT_S).read())
    item = data["data"][0]
    if item.get("b64_json"):
        out_file.write_bytes(base64.b64decode(item["b64_json"]))
    elif item.get("url"):
        with urllib.request.urlopen(item["url"], timeout=60) as resp:
            out_file.write_bytes(resp.read())
    else:
        raise RuntimeError("no image payload in response")


def classify_error(exc):
    if isinstance(exc, urllib.error.HTTPError):
        try:
            detail = json.loads(exc.read().decode("utf-8", "replace"))
            msg = str(detail.get("error", {}).get("message", ""))[:200]
            code = str(detail.get("error", {}).get("code", ""))
        except Exception:
            msg, code = "", ""
        if exc.code == 400 and ("safety" in msg.lower() or "policy" in msg.lower()
                                or "moderation" in (msg + code).lower()):
            return "refused", msg
        return f"http_{exc.code}", msg
    return type(exc).__name__, str(exc)[:200]


def generate(args):
    key = load_key()
    if not key:
        log("GEN_FALLBACK: no OpenAI key")
        return 2
    try:
        cached = json.loads(cache_path().read_text())
        model = cached.get("openai_model")
    except (OSError, ValueError):
        model = None
    if not model:
        try:
            model = newest_image_model(key)
        except Exception:
            model = None
    if not model:
        log("GEN_FALLBACK: no gpt-image-* model available")
        return 2

    bets = json.loads(pathlib.Path(args.bets).read_text())
    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    status = {}

    def run_bet(bet):
        slug = bet["slug"]
        out_file = out_dir / f"prototype-{slug}.png"
        started = time.time()
        try:
            gen_image(key, model, bet["prompt"], args.size, out_file)
            return slug, {"status": "ok", "model": model, "file": out_file.name,
                          "elapsed_s": round(time.time() - started, 1)}
        except Exception as exc:
            kind, msg = classify_error(exc)
            if kind == "refused" and bet.get("debranded_prompt"):
                try:
                    gen_image(key, model, bet["debranded_prompt"], args.size, out_file)
                    return slug, {"status": "ok", "model": model, "file": out_file.name,
                                  "debranded_retry": True,
                                  "elapsed_s": round(time.time() - started, 1)}
                except Exception as exc2:
                    kind, msg = classify_error(exc2)
            return slug, {"status": "failed", "error": kind, "detail": msg,
                          "elapsed_s": round(time.time() - started, 1)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_CONCURRENCY) as pool:
        for slug, result in pool.map(run_bet, bets):
            status[slug] = result

    if args.status:
        sp = pathlib.Path(args.status)
        sp.parent.mkdir(parents=True, exist_ok=True)
        sp.write_text(json.dumps({"model": model, "bets": status}, indent=1))
    ok = sum(1 for s in status.values() if s["status"] == "ok")
    log(f"GEN_DONE: {ok}/{len(bets)} images via {model}; failed bets need HTML fallback")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe")
    p.add_argument("--native", choices=["ok", "dead"], default="dead")
    p.add_argument("--skill-version", default="0.0.0")
    p.add_argument("--force", action="store_true")
    g = sub.add_parser("generate")
    g.add_argument("--bets", required=True)
    g.add_argument("--out-dir", required=True)
    g.add_argument("--status", default="")
    g.add_argument("--size", default="1536x1024")
    args = ap.parse_args()
    return probe(args) if args.cmd == "probe" else generate(args)


if __name__ == "__main__":
    sys.exit(main())
