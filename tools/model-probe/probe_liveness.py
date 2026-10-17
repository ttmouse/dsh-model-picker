#!/usr/bin/env python3
"""Liveness probe for DSH desktop-profile model providers.

Reads API keys from ~/.dsh/.credentials.yaml (values never printed), sends one
minimal chat completion per model, and records status / latency / error class.

Usage:
  python3 probe_liveness.py [--out results/liveness-<ts>.json] [--only p1,p2] [--jobs 6]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime

HOME = os.path.expanduser("~")
CREDS = os.path.join(HOME, ".dsh", ".credentials.yaml")
HERE = os.path.dirname(os.path.abspath(__file__))

# Provider routes under test. baseURL from the desktop profile, or from the
# bundled pi-ai catalog when the profile leaves it to the catalog.
PROVIDERS = {
    "opencode-go1": dict(
        base="https://opencode.ai/zen/go/v1",
        key="OPENCODE_ZEN_API_KEY",
        headers={"x-opencode-session": "dsh-web-local"},
        models=["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-flash",
                "deepseek-v4.1-flash", "deepseek-v4-flash-vision-exp"],
    ),
    "commandcode": dict(
        base="https://api.commandcode.ai/provider/v1",
        key="COMMANDCODE_API_KEY",
        models=["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash",
                "MiniMaxAI/MiniMax-M3"],
    ),
    "yqa": dict(
        base="https://ai.17an.com/v1",
        key="YQA_API_KEY",
        models=["deepseek-v4.1-flash", "glm-5.3-flash"],
    ),
    "yqa-anbot": dict(
        base="https://ai.17an.com/v1",
        key="CUSTOM_17AN_ANBOT_API_KEY",
        models=["deepseek-v4.1-flash"],
    ),
    "yqa-mumiao": dict(
        base="https://ai.17an.com/v1",
        key="CUSTOM_17AN_MUMIAO_API_KEY",
        models=["deepseek-v4-flash", "deepseek-v4-pro", "claude-opus-4-6",
                "claude-opus-4-6-max", "hy3", "deepseek-v4-flash-202605",
                "deepseek/deepseek-v4-flash-vision-exp"],
    ),
    "qwen-token-plan-cn": dict(
        base="https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        key="QWEN_TOKEN_PLAN_CN_API_KEY",
        models=["deepseek-v4-flash", "deepseek-v4-flash-0731",
                "deepseek-v4-pro", "deepseek-v4-pro-0813",
                "deepseek-v4.1-flash", "glm-5.3", "kimi-k2.5"],
    ),
    "zai-coding-cn": dict(
        base="https://api.z.ai/api/coding/paas/v4",
        key="ZAI_CODING_CN_API_KEY",
        models=["glm-5.3", "glm-5.3-flash", "glm-5.3-highspeed", "glm-4.6v"],
    ),
    "magpie": dict(
        base="http://127.0.0.1:3425/v1",
        key="MAGPIE_GATEWAY_KEY",
        discover=True,
    ),
    "magpie-responses": dict(
        base="http://127.0.0.1:3425/v1",
        key="MAGPIE_GATEWAY_KEY",
        api="responses",
        models=["codex/gpt-6-astra", "grok/grok-4.7"],
    ),
    "magpie-anthropic": dict(
        base="http://127.0.0.1:3425",
        key="MAGPIE_GATEWAY_KEY",
        api="messages",
        models=["zcode/GLM-5.3-Flash", "zcode/GLM-5.3"],
    ),
}


def load_keys() -> dict[str, str]:
    import yaml

    doc = yaml.safe_load(open(CREDS))
    return {k: str(v) for k, v in (doc.get("refs") or {}).items()}


def post(url: str, key: str, body: dict, headers: dict, timeout: int = 60):
    data = json.dumps(body).encode()
    # A real UA matters: Cloudflare in front of commandcode rejects python-urllib (error 1010).
    h = {"Content-Type": "application/json", "Authorization": f"Bearer {key}",
         "User-Agent": "dsh-model-probe/0.1"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, time.time() - t0, raw, None
    except urllib.error.HTTPError as e:
        return e.code, time.time() - t0, e.read().decode("utf-8", "replace"), "http"
    except Exception as e:  # timeout, dns, reset
        return None, time.time() - t0, "", f"{type(e).__name__}: {e}"


def get(url: str, key: str, headers: dict, timeout: int = 30):
    h = {"Authorization": f"Bearer {key}", "User-Agent": "dsh-model-probe/0.1"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace"), None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), "http"
    except Exception as e:
        return None, "", f"{type(e).__name__}: {e}"


def classify(status, err, raw) -> str:
    if err and status is None:
        if "timed out" in (err or "").lower() or "Timeout" in (err or ""):
            return "timeout"
        return "network"
    if status == 200:
        return "ok"
    if status in (401, 403):
        return "auth"
    if status == 404:
        return "model-not-found"
    if status == 429:
        return "rate-limit"
    if status in (402,):
        return "quota"
    if status and status >= 500:
        return "server"
    return f"http-{status}"


def msg_of(raw: str) -> str:
    try:
        d = json.loads(raw)
    except Exception:
        return (raw or "")[:200].replace("\n", " ")
    if isinstance(d, dict):
        e = d.get("error")
        if isinstance(e, dict):
            return str(e.get("message") or e.get("code") or e)[:220]
        if e:
            return str(e)[:220]
        if d.get("message"):
            return str(d["message"])[:220]
    return json.dumps(d)[:220]


def body_for(api: str, model: str) -> dict:
    if api == "responses":
        return {"model": model, "input": "Reply with the single word: ok",
                "max_output_tokens": 2000}
    if api == "messages":
        return {"model": model, "max_tokens": 64,
                "messages": [{"role": "user", "content": "Reply with the single word: ok"}]}
    return {"model": model, "max_tokens": 64, "stream": False,
            "messages": [{"role": "user", "content": "Reply with the single word: ok"}]}


def url_for(base: str, api: str) -> str:
    if api == "responses":
        return base + "/responses"
    if api == "messages":
        return base.rstrip("/") + "/v1/messages"
    return base + "/chat/completions"


def snippet(raw: str) -> str:
    try:
        d = json.loads(raw)
    except Exception:
        return ""
    try:
        if "choices" in d:
            return str(d["choices"][0].get("message", {}).get("content", ""))[:120]
        if d.get("output") is not None:
            return json.dumps(d["output"])[:120]
        if d.get("content"):
            c = d["content"]
            if isinstance(c, list):
                return " ".join(str(x.get("text", "")) for x in c if isinstance(x, dict))[:120]
            return str(c)[:120]
    except Exception:
        pass
    return ""


def probe_one(prov, cfg, keys, model):
    key = keys.get(cfg["key"], "")
    rec = {"provider": prov, "model": model, "api": cfg.get("api", "chat"),
           "keyPresent": bool(key)}
    if not key:
        rec.update(status=None, verdict="no-key", seconds=0, message="")
        return rec
    st, sec, raw, err = post(url_for(cfg["base"], cfg.get("api", "chat")),
                             key, body_for(cfg.get("api", "chat"), model),
                             cfg.get("headers"), timeout=cfg.get("timeout", 90))
    rec.update(status=st, seconds=round(sec, 2), verdict=classify(st, err, raw),
               message=msg_of(raw) if st != 200 else "", snippet=snippet(raw) if st == 200 else "")
    usage = {}
    try:
        u = json.loads(raw).get("usage") or {}
        usage = {k: u.get(k) for k in ("prompt_tokens", "completion_tokens") if k in u}
    except Exception:
        pass
    rec["usage"] = usage
    return rec


def probe_provider(prov, cfg, keys, jobs):
    models = list(cfg.get("models") or [])
    discovery = None
    key = keys.get(cfg["key"], "")
    if cfg.get("discover") and key:
        st, raw, err = get(cfg["base"] + "/models", key, cfg.get("headers"))
        if st == 200:
            try:
                models = [m["id"] for m in json.loads(raw)["data"]]
                discovery = f"{len(models)} models via /models"
            except Exception:
                discovery = "models list unparseable"
        else:
            discovery = f"/models -> {st} {msg_of(raw) or err}"
    out = []
    with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
        futs = {ex.submit(probe_one, prov, cfg, keys, m): m for m in models}
        for f in cf.as_completed(futs):
            r = f.result()
            out.append(r)
            mark = "OK " if r["verdict"] == "ok" else "!! "
            print(f"  {mark}{r['model']:38} {r['verdict']:15} {r['seconds']:>6}s "
                  f"{r['message'][:80]}", flush=True)
    out.sort(key=lambda r: r["model"])
    return out, discovery


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--timeout", type=int, default=75)
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    keys = load_keys()
    only = [s for s in a.only.split(",") if s]
    results = {"startedAt": datetime.now().isoformat(timespec="seconds"),
               "providers": {}, "discovery": {}}
    for prov, cfg in PROVIDERS.items():
        if only and prov not in only:
            continue
        cfg = dict(cfg, timeout=a.timeout)
        print(f"== {prov}", flush=True)
        rows, disc = probe_provider(prov, cfg, keys, a.jobs)
        results["providers"][prov] = rows
        if disc:
            results["discovery"][prov] = disc
        if disc:
            print(f"  discovery: {disc}")
    out = a.out or os.path.join(HERE, "results",
                                f"liveness-{datetime.now():%Y%m%d-%H%M%S}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(results, open(out, "w"), indent=1)
    ok = sum(1 for rows in results["providers"].values() for r in rows if r["verdict"] == "ok")
    tot = sum(len(rows) for rows in results["providers"].values())
    print(f"\n{ok}/{tot} ok -> {out}")


if __name__ == "__main__":
    main()
