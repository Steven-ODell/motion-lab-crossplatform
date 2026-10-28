from motionlab.build import *

s = Scene("quicksort")
intro, pick, split, lock, sides, repeat, until, done = s.narrate([
    "Quicksort. One idea, used over and over.",
    "Pick a number. We'll call it the pivot.",
    {"say": "Everything smaller goes to its left. Everything bigger goes to its right.", "gap": 0.6},
    "Now the pivot is in its final spot. It never moves again.",
    "Then do the exact same thing to each side.",
    {"say": "Pick a pivot. Split. Repeat.", "pause": 1.6},
    {"say": "Until every piece is a single number.", "pause": 1.8},
    ("Sorted. About n log n steps on average, and C plus plus's standard sort is built on this idea.",
     "Sorted. About n log n steps on average, and C++'s std::sort is built on this idea."),
], gap=0.4)

with s.folder("Title"):
    title = s.text("Quick[[#ff5ef1|sort]]", "title", "top")
    title.reveal(intro.start)
    cost = s.text("average  O(n log n)", "label", "sub", size=48)
with s.folder("Array"):
    a = s.array([6, 3, 8, 1, 9, 2, 7, 4])
a.show(intro.start + 0.5)

def pivot_up(sl, t):
    a.color(sl, "pink", t); a.glow(sl, 26, t); a.lift(sl, t); a.tag(sl, "pivot", t + 0.1)

def lock_in(sl, t):
    a.drop(sl, t); a.untag("pivot", t); a.color(sl, "green", t + 0.15); a.glow(sl, 14, t + 0.15)

def lomuto(lo, hi):
    """New slot order after partitioning lo..hi around the last bar, and the pivot's slot."""
    idx, p, i = list(range(lo, hi + 1)), a.value(hi), -1
    for j in range(len(idx) - 1):
        if a.value(idx[j]) < p:
            i += 1; idx[i], idx[j] = idx[j], idx[i]
    idx[i + 1], idx[-1] = idx[-1], idx[i + 1]
    return list(range(lo)) + idx + list(range(hi + 1, len(a.order))), lo + i + 1

# The first split, narrated step by step.
a.bracket(0, 7, pick.start + 0.2)
pivot_up(7, pick.word("pivot"))
small = [k for k in range(7) if a.value(k) < 4]; big = [k for k in range(7) if a.value(k) > 4]
lt = a.label("smaller than 4", 0, 2, split.start + 0.1, "cyan")
a.color(small, "cyan", split.start + 0.25, gap=0.12)
gt = a.label("bigger than 4", 4, 7, split.word("Everything", 2), "purple")
a.color(big, "purple", split.word("Everything", 2) + 0.1, gap=0.1)
order, pv = lomuto(0, 7)
a.arrange(order, split.word("bigger"), dur=0.8, gap=0.08)
lock_in(pv, lock.start + 0.2); lt.fade_out(lock.start + 0.6); gt.fade_out(lock.start + 0.6)
a.color([0, 1, 2, 4, 5, 6, 7], "dim", lock.start + 0.9, dur=0.4)

# Recursion: same move on each side, faster.
a.bracket(0, 2, sides.start + 0.3); a.dim([3, 4, 5, 6, 7], sides.start + 0.3)
def part(lo, hi, t):
    pivot_up(hi, t)
    order, pv = lomuto(lo, hi)
    a.arrange(order, t + 0.55, dur=0.65)
    lock_in(pv, t + 1.3)
    return pv, t + 1.7

t = repeat.start + 0.1
pv, t = part(0, 2, t)
a.color([0, 2], "green", t); t += 0.35
a.bracket(4, 7, t); a.dim([0, 1, 2, 3], t); a.undim([4, 5, 6, 7], t); t += 0.5
pv, t = part(4, 7, t)
a.bracket(5, 7, t); pv, t = part(5, 7, t + 0.4)
a.bracket(5, 6, t); pv, t = part(5, 6, t + 0.4)
a.color(6, "green", t)
assert t < done.start, f"recursion ends at {t:.2f}, after the last line starts ({done.start})"

a.unbracket(done.start + 0.1); a.undim(range(8), done.start + 0.1)
a.wave(done.start + 0.4)
cost.slide_in(done.start + 1.2, dy=24)
end = done.end + 1.0
for e in (title, cost, a.g):
    e.fade_out(end, 0.6)
s.save(tail=0.1)
