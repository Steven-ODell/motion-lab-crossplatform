"""Cheap checks on a project, printed after every build and check."""
import re

SIZE = {"wide": (1920, 1080), "tall": (1080, 1920)}
NAME = {"wide": "16:9", "tall": "9:16"}


def check(p: dict) -> list[str]:
    out = []
    for a, (W, H) in SIZE.items():
        for e in p.get("elements", []):
            if e.get("parent") or e.get("hidden"):
                continue
            r = {**e["props"], **(e.get("tall") or {} if a == "tall" else {})}
            x, y, w, h = r["x"], r["y"], r["w"], r["h"]
            sc = r.get("scale", 1)
            if not (0 <= x <= W and 0 <= y <= H):
                out.append(f"{e['name']} is off-stage in {NAME[a]} (center {x:.0f},{y:.0f})")
            elif x - w * sc / 2 < -W * 0.03 or x + w * sc / 2 > W * 1.03 or y - h * sc / 2 < -H * 0.03 or y + h * sc / 2 > H * 1.03:
                if e["type"] != "video":
                    out.append(f"{e['name']} spills past the frame edge in {NAME[a]}")
    # Things that partly overlap are almost always a layout bug (full containment,
    # like text on a panel, is fine). Groups count as the union of what's in them;
    # text counts as its estimated ink width.
    kids = {}
    for e in p.get("elements", []):
        kids.setdefault(e.get("parent"), []).append(e)
    for a, (W, H) in SIZE.items():
        def box(e):
            r = {**e["props"], **(e.get("tall") or {} if a == "tall" else {})}
            sc = r.get("scale", 1)
            if e["type"] == "group" and kids.get(e["id"]):
                inner = [box(k) for k in kids[e["id"]] if not k.get("hidden")]
                l, t = min(b[0] for b in inner), min(b[1] for b in inner)
                rr, bb = max(b[2] for b in inner), max(b[3] for b in inner)
                ox, oy = r["x"] - r["w"] / 2 * sc, r["y"] - r["h"] / 2 * sc
                return (ox + l * sc, oy + t * sc, ox + rr * sc, oy + bb * sc)
            w, h = r["w"] * sc, r["h"] * sc
            if e["type"] == "text" and "\n" not in r.get("text", ""):
                plain = re.sub(r"\[\[[^|\]]+\|(.*?)\]\]", r"\1", r.get("text", ""))
                w = min(w, len(plain) * r.get("size", 64) * (0.8 if r.get("font") == "Unbounded" else 0.58) * sc)
            return (r["x"] - w / 2, r["y"] - h / 2, r["x"] + w / 2, r["y"] + h / 2)

        boxes = []
        for e in kids.get(None, []):
            if e.get("hidden") or e["type"] == "video":
                continue
            b = box(e)
            if (b[2] - b[0]) * (b[3] - b[1]) > 0.8 * W * H:
                continue  # backgrounds
            name = "Captions" if e["name"].startswith("Caption") else e["name"]
            boxes.append((name, *b))
        seen = set()
        inside = lambda X, Y: X[1] >= Y[1] - 2 and X[2] >= Y[2] - 2 and X[3] <= Y[3] + 2 and X[4] <= Y[4] + 2
        for i, A in enumerate(boxes):
            for B in boxes[i + 1:]:
                ix, iy = min(A[3], B[3]) - max(A[1], B[1]), min(A[4], B[4]) - max(A[2], B[2])
                key = tuple(sorted((A[0], B[0])))
                if ix <= 10 or iy <= 10 or inside(A, B) or inside(B, A) or key in seen or key[0] == key[1]:
                    continue
                seen.add(key)
                out.append(f"{key[0]} and {key[1]} overlap in {NAME[a]}")
    dur = p["duration"]
    late = [t for t in p.get("tweens", []) if t["start"] + t["dur"] > dur + 0.01]
    if late:
        out.append(f"{len(late)} tweens run past the end ({dur} s)")
    nar = sorted((c for c in p.get("audio", []) if c["track"] == "narration"), key=lambda c: c["start"])
    out += [f"narration line not voiced: {c.get('text', '')[:40]!r}" for c in nar if not c.get("src")]
    for a, b in zip(nar, nar[1:]):
        if b["start"] < a["start"] + a["dur"] - 0.05:
            out.append(f"narration overlaps at {b['start']:.2f} s")
    ids = {e["id"] for e in p.get("elements", [])}
    orphans = {t["target"] for t in p.get("tweens", [])} - ids
    if orphans:
        out.append(f"tweens target missing elements: {sorted(orphans)[:5]}")
    return out
