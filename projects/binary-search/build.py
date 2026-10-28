from motionlab.build import *

s = Scene("binary-search")
intro, rule, mid, cut, again, found, cost = s.narrate([
    "Binary search finds a number in a sorted list, fast.",
    "We're looking for thirty seven.",
    "Check the middle. Sixteen is too small.",
    "So the whole left half is gone. Thirty seven can't be there.",
    {"say": "Check the middle of what's left, and cut again.", "pause": 1.4},
    "Found it, in two checks. Going one by one takes seven.",
    "Each check halves the list, so a million numbers take about twenty checks.",
])
with s.folder("Title"):
    title = s.text("Binary [[cyan|search]]", "title", "top"); title.reveal(intro.start)
    goal = s.text("target: 37", "label", "sub", size=44, color="pink"); goal.pop_in(rule.start + 0.3)
with s.folder("Array"):
    a = s.array([2, 5, 8, 12, 16, 23, 37, 41, 56], pos=(.32, .52), slot=104, tall={"pos": (.5, .385), "scale": .85})
with s.folder("Code"):
    c = s.code("""int lo = 0, hi = n - 1;
while (lo <= hi) {
  int mid = (lo + hi) / 2;
  if (a[mid] == x) return mid;
  if (a[mid] < x) lo = mid + 1;
  else hi = mid - 1;
}""", pos=(.77, .52), size=28, tall={"pos": (.5, .632), "scale": 1.08})

a.show(intro.start + 0.5); c.show(intro.start + 1)
a.bracket(0, 8, rule.start + 0.2); c.highlight(1, rule.start + 0.2)

def check(sl, t, hit=False):
    c.highlight(3, t); a.tag(sl, "mid", t); a.color(sl, "pink", t)
    c.highlight(4 if hit else 5, t + 0.9)
    return t + 1.2

t = check(4, mid.start)              # 16 < 37
c.highlight(5, mid.word("small"))
a.dim(range(0, 5), cut.start + 0.3); a.bracket(5, 8, cut.start + 0.3)
t = check(6, again.start + 0.2)      # 37? lo..hi = 5..8, mid = 6
a.color(6, "green", found.start); a.glow(6, 24, found.start); a.untag("mid", found.start)
c.highlight(4, found.start)
a.dim([5, 7, 8], found.start + 0.3)
goal.fade_out(cost.start)
note = s.text("1,000,000 → ~20 checks", "label", "sub", size=44, color="cyan")
note.slide_in(cost.word("million"))
s.save()
