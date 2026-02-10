# Kanban Lane Redesign

## Your Mental Model

| Lane | Meaning |
|------|---------|
| **Watching** | Has started to form a setup or pattern we like but not yet confirmed |
| **Almost Ready** | Really close but needs just a little bit more for us to Enter |
| **Enter Now** | Time to enter |
| **Just Entered** | We just entered (position open, very recent) |
| **Hold** | Holding the position |
| **Trim** | Taking profits / trimming |
| **Exit** | Exiting the position |
| **Archived** | Done (invalidated, completed, or late-cycle) |

---

## Current State vs Proposed

### Current (consolidated into one Setup lane)
- Single **Setup** lane with sub-labels: "Beginning to setup", "Setup, not yet time", "Nearing entry", "Just flipped"
- Then: Enter Now, Hold, Trim, Exit, Archive

### Implemented (8 distinct lanes)

| # | Lane | Backend stage(s) | Notes |
|---|------|------------------|-------|
| 1 | **Watching** | `watch`, `setup_watch` | Pattern forming, not yet confirmed |
| 2 | **Almost Ready** | `flip_watch`, `just_flipped` | Close to entry, needs a bit more |
| 3 | **Enter Now** | `enter_now` | Entry-eligible |
| 4 | **Just Entered** | `just_entered` | Backend: entry within last 15 min |
| 5 | **Hold** | `hold` | Holding position (🛡 Defend badge when `kanban_meta.bucket === "defend"`) |
| 6 | **Trim** | `trim` | Taking profits |
| 7 | **Exit** | `exit` | Exiting |
| 8 | **Archived** | `archive` | Done |

---

## Implementation Notes

### 1. "Just Entered" vs "Hold"

**Implemented (Option B — backend as source of truth)**  
- Worker `classifyKanbanStage` returns `just_entered` when: active position + `entry_ts` within last 15 min of ingest `ts`.  
- UI renders the stage. Worker is source of truth; UI is presenter.

### 2. "Watching" vs "Almost Ready"

- **Watching**: `watch` + `setup_watch` — early setup, pattern forming, corridor but not momentum, or momentum but entry blocked.  
- **Almost Ready**: `flip_watch` + `just_flipped` — about to flip or just flipped into momentum, needs one more confirmation before Enter Now.

### 3. "Defend" Placement

**Implemented**: Defend folded into **Hold**. Worker returns `hold` for both; `deriveKanbanMeta` returns `{ bucket: "defend" }` when severity is WARNING and completion < 0.6, phase < 0.65. UI shows 🛡 Defend badge on Hold cards when `kanban_meta?.bucket === "defend"`.

### 4. Column Order

1. Watching  
2. Almost Ready  
3. Enter Now  
4. Just Entered  
5. Hold  
6. Trim  
7. Exit  
8. Archived  

---

## Summary of Changes (Implemented)

1. **Worker (source of truth)**  
   - Add `just_entered` stage when entry within 15 min.  
   - Fold `defend` into `hold`; `deriveKanbanMeta` returns `{ bucket: "defend" }` for badge.  
   - Update lifecycle gates, recycle rules, Discord embeds for new stages.

2. **React UI (presenter)**  
   - 8 lanes: Watching, Almost Ready, Enter Now, Just Entered, Hold, Trim, Exit, Archived.  
   - Watching = watch + setup_watch; Almost Ready = flip_watch + just_flipped.  
   - Defend badge on Hold cards when `kanban_meta?.bucket === "defend"`.  
   - Filter pills and Right Rail guidance aligned with new lanes.

---

## Lane Titles for UI

| Lane | Title | Subtitle (optional) |
|------|-------|---------------------|
| Watching | Watching | Pattern forming, not yet confirmed |
| Almost Ready | Almost Ready | Needs a bit more to enter |
| Enter Now | Enter Now | Time to enter |
| Just Entered | Just Entered | Recently entered |
| Hold | Hold | Holding position |
| Trim | Trim | Taking profits |
| Exit | Exit | Exiting |
| Archived | Archived | Done |
