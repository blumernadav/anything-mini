# Goals Feature — Implementation Plan

## Summary

Add **Done Goals** and **Time Goals** to Anything Mini. Goals are optional properties on items that provide visual progress feedback. Items with goals are prioritized (rendered first) in the Actions list. Progress is derived automatically from existing data — no manual progress tracking.

---

## Goal Types

### Done Goal
- **Definition**: Success = all descendant leaves are marked `done: true`.
- **Progress**: `doneLeaves / totalLeaves` (recursive).
- **Data**: `goal: { type: 'done' }` on the item.
- **Use case**: Projects like "Shenkar project" — finish all sub-tasks.

### Time Goal
- **Definition**: Success = accumulate X seconds of tracked time on this item (and descendants).
- **Progress**: `trackedSeconds / targetSeconds`.
- **Data**: `goal: { type: 'time', target: <seconds> }` on the item.
- **Tracked time source**: Timeline entries with `type: 'work'` and matching `itemId` (or descendant itemIds).
- **Use case**: "Spend 2 hours on kolwrite this week."

---

## Data Model Changes

### Item Schema (items.json)
Items gain an optional `goal` property:

```json
{
  "id": 9,
  "name": "anything",
  "goal": { "type": "done" },
  "children": [...]
}
```

```json
{
  "id": 28,
  "name": "health",
  "goal": { "type": "time", "target": 7200 },
  "children": [...]
}
```

- No migration needed — items without `goal` continue to work as before.
- Goals can be set on **any item** (leaf or branch). Done goals make most sense on branches, but there's no restriction.

---

## Implementation Steps

### Step 1: Goal Calculation Helpers (script.js)

Add two pure functions near the Tree Utilities section (~line 135):

#### `calculateDoneProgress(item)`
- Recursively collect all descendant leaves.
- Count those with `done: true`.
- Return `{ done: <number>, total: <number>, percent: <0-100> }`.

#### `calculateTimeProgress(item, timelineEntries)`
- Collect all descendant IDs (including self) via `collectDescendantIds(item)`.
- Filter `timelineEntries` for entries with `type === 'work'` and `itemId` in the descendant set.
- Sum `(endTime - startTime)` for each matching entry (in milliseconds, convert to seconds).
- Return `{ tracked: <seconds>, target: <seconds>, percent: <0-100> }`.

#### `getGoalProgress(item, timelineEntries)`
- Dispatcher: if `item.goal.type === 'done'` → call `calculateDoneProgress`.
- If `item.goal.type === 'time'` → call `calculateTimeProgress`.
- Returns a unified progress object: `{ type, done, total, tracked, target, percent, label }`.
- `label` is a human-readable string like "3/5 done" or "1.5h / 2h".

---

### Step 2: Actions Sort with Goal Priority (script.js — `renderActions`)

**Current sort** (line ~1250):
```js
const sorted = indexed.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return a._treeIdx - b._treeIdx;
});
```

**New sort** — three tiers:
1. Undone items with goals (tree order)
2. Undone items without goals (tree order)
3. Done items (tree order)

```js
const sorted = indexed.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const aHasGoal = hasActiveGoal(a);
    const bHasGoal = hasActiveGoal(b);
    if (aHasGoal !== bHasGoal) return aHasGoal ? -1 : 1;
    return a._treeIdx - b._treeIdx;
});
```

**`hasActiveGoal(action)`**: Checks whether the action itself OR any of its ancestors has a `goal` property. An action is "goal-connected" if it's a descendant of a goaled project.

- Use `action._path` (which contains the ancestor chain) to check if any ancestor item has a `goal`.
- This means: if "anything" has a Done goal, then all leaf tasks under "anything" are goal-connected and sorted first.

---

### Step 3: Goal Progress Badge on Action Rows (script.js — `createActionElement`)

When rendering an action that belongs to a goaled ancestor (or has a goal itself):

- After the action name, insert a **goal progress badge** element.
- The badge shows a small inline progress bar + label text.
- Structure:
```html
<div class="action-goal-badge">
    <div class="action-goal-bar">
        <div class="action-goal-fill" style="width: 60%"></div>
    </div>
    <span class="action-goal-label">3/5</span>
</div>
```

**Logic for which goal to show**:
- If the action's direct item has a goal → show that item's progress.
- If not, walk up `action._path` to find the nearest ancestor with a goal → show that ancestor's progress.
- Only show the badge for the **nearest** goaled ancestor (not all of them).

**Note**: For Done goals, the badge on individual leaf actions shows the **parent project's** progress (e.g., "3/5 done" for the whole project), giving context about how the bigger picture is going. For Time goals, it shows tracked vs. target.

---

### Step 4: Goal Progress in Project Tree (script.js — `renderProjectLevel`)

Add a subtle progress indicator on project rows that have a goal:

- After the project name, append a small badge: `<span class="project-goal-badge">60%</span>` or a mini progress bar.
- Keep it minimal — just enough to provide bird's-eye-view orientation.
- For Done goals: show "X/Y" (e.g., "3/5").
- For Time goals: show tracked time (e.g., "1.5h / 2h").

---

### Step 5: Set/Edit/Remove Goal via Context Menus

#### In `showProjectContextMenu` (for branches):
Add a "Set Goal..." option (or "Edit Goal..." / "Remove Goal" if one exists).

#### In `showActionContextMenu` (for leaves):
Add the same "Set Goal..." option.

#### Goal Modal:
Create a small modal for goal configuration:

```html
<div class="goal-modal-overlay" id="goal-modal-overlay">
    <div class="goal-modal">
        <h3>Set Goal</h3>
        <div class="goal-type-selector">
            <button class="goal-type-btn active" data-type="done">✓ Done</button>
            <button class="goal-type-btn" data-type="time">⏱ Time</button>
        </div>
        <!-- Done type: no extra inputs needed -->
        <div class="goal-done-info" id="goal-done-info">
            Track completion of all sub-tasks.
        </div>
        <!-- Time type: target input -->
        <div class="goal-time-inputs" id="goal-time-inputs" style="display:none">
            <label>Target</label>
            <input type="number" id="goal-hours" placeholder="0" min="0"> h
            <input type="number" id="goal-minutes" placeholder="0" min="0" max="59"> m
        </div>
        <div class="goal-modal-actions">
            <button id="goal-save-btn">Save</button>
            <button id="goal-remove-btn" class="danger" style="display:none">Remove Goal</button>
            <button id="goal-cancel-btn">Cancel</button>
        </div>
    </div>
</div>
```

**Save logic**:
- Done: `api.patch(/items/${id}, { goal: { type: 'done' } })`.
- Time: `api.patch(/items/${id}, { goal: { type: 'time', target: hours*3600 + minutes*60 } })`.
- Remove: `api.patch(/items/${id}, { goal: null })`.
- Update local state + `renderAll()`.

---

### Step 6: CSS Across All 4 Skins

Add styles to each skin file (`modern.css`, `win95.css`, `duolingo.css`, `pencil.css`):

#### Goal Badge on Actions (`.action-goal-badge`)
- Small, inline, positioned after the action name.
- Contains a thin progress bar (`.action-goal-bar` + `.action-goal-fill`) and a label.
- Progress bar: ~60px wide, 4px tall, rounded, semi-transparent background.
- Fill color: green (done goals), blue/purple (time goals).
- Label: small muted text showing "3/5" or "1h / 2h".

#### Goal Badge on Projects (`.project-goal-badge`)
- Very compact — just text or a tiny bar next to the project name.
- Muted opacity so it doesn't dominate the tree.

#### Goal Modal (`.goal-modal-overlay`, `.goal-modal`)
- Follow existing modal patterns (like the schedule modal).
- Centered overlay, dark backdrop.

#### Type selector buttons (`.goal-type-btn`)
- Segmented control style, similar to existing UI patterns.

---

## Step Ordering & Dependencies

```
Step 1: Calculation helpers        (no deps)
Step 2: Sort with goal priority    (needs Step 1)
Step 3: Action row badges          (needs Step 1)
Step 4: Project tree badges        (needs Step 1)
Step 5: Context menu + modal       (needs Steps 1-4, provides the UI to set goals)
Step 6: CSS styling for all skins  (can be done alongside Steps 3-5)
```

**Recommended build order**: 1 → 5 → 3 → 2 → 4 → 6

Rationale: Build the helpers first, then the modal (so you can actually set goals to test with), then the visual feedback (badges, sorting), then polish with CSS.

---

## What This Does NOT Include (Future)

- Habit/recurring goals (daily cadence reset)
- Deadlines / urgency coloring
- Daily progress summary ("4 of 7 items planned for today done")
- Goal progress in timeline entries
- Notifications or alerts for goal completion
