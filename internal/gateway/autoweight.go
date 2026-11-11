package gateway

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	autoWindowSeconds = 10
	autoMinRPS        = 0.5
	autoFloor         = 5.0
	autoEventDelta    = 5
)

// AutoWeigher computes runtime weight overlays for routes marked AutoWeight.
// Configured weights stay the baseline and the fallback; nothing here touches
// the config store or creates revisions.
type AutoWeigher struct {
	store   *Store
	metrics *Metrics
	health  *Health
	events  *EventLog

	// effective is an immutable route ID -> upstream ID -> weight map swapped
	// once per tick, so the request path never takes a lock.
	effective atomic.Pointer[map[string]map[string]int]

	mu    sync.Mutex // guards state; held only by tick
	state map[string]*autoRouteState
}

type autoRouteState struct {
	ids     []string // upstream IDs in config order, identifies the upstream set
	last    map[string]int
	emitted map[string]int
}

func NewAutoWeigher(s *Store, m *Metrics, h *Health, e *EventLog) *AutoWeigher {
	return &AutoWeigher{store: s, metrics: m, health: h, events: e, state: map[string]*autoRouteState{}}
}

// Run recomputes effective weights every interval until stop is closed.
func (a *AutoWeigher) Run(stop <-chan struct{}, interval time.Duration) {
	if a == nil {
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			a.tick()
		}
	}
}

// Effective returns a copy of r.Upstreams carrying the effective weights. It
// falls back to configured weights for non-auto routes, a nil receiver, or when
// the last tick does not cover this exact upstream set (for example right
// after a config swap).
func (a *AutoWeigher) Effective(r Route) []Upstream {
	out := append([]Upstream(nil), r.Upstreams...)
	if a == nil || !r.AutoWeight {
		return out
	}
	mp := a.effective.Load()
	if mp == nil {
		return out
	}
	w, ok := (*mp)[r.ID]
	if !ok || len(w) != len(out) {
		return out
	}
	for i := range out {
		v, ok := w[out[i].ID]
		if !ok {
			return append([]Upstream(nil), r.Upstreams...)
		}
		out[i].Weight = v
	}
	return out
}

// Weights reports the effective weight of every upstream of every route in the
// active config.
func (a *AutoWeigher) Weights() map[string]map[string]int {
	out := map[string]map[string]int{}
	if a == nil || a.store == nil {
		return out
	}
	snap := a.store.Load()
	if snap == nil {
		return out
	}
	for _, r := range snap.Config.Routes {
		w := map[string]int{}
		for _, u := range a.Effective(r) {
			w[u.ID] = u.Weight
		}
		out[r.ID] = w
	}
	return out
}

func (a *AutoWeigher) tick() {
	a.mu.Lock()
	defer a.mu.Unlock()
	snap := a.store.Load()
	if snap == nil {
		return
	}
	win := a.metrics.Window(autoWindowSeconds).Upstreams
	next := map[string]map[string]int{}
	live := map[string]bool{}
	for _, r := range snap.Config.Routes {
		if !r.AutoWeight {
			continue
		}
		live[r.ID] = true
		next[r.ID] = a.computeRoute(r, win)
	}
	// Drop state for routes that vanished, stopped being auto, or changed upstreams.
	for id := range a.state {
		if !live[id] {
			delete(a.state, id)
		}
	}
	a.effective.Store(&next)
}

func sameIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (a *AutoWeigher) computeRoute(r Route, win map[string]StatPoint) map[string]int {
	ids := make([]string, len(r.Upstreams))
	configured := map[string]int{}
	for i, u := range r.Upstreams {
		ids[i] = u.ID
		configured[u.ID] = u.Weight
	}
	st := a.state[r.ID]
	if st == nil || !sameIDs(st.ids, ids) {
		st = &autoRouteState{ids: ids, last: copyWeights(configured), emitted: copyWeights(configured)}
		a.state[r.ID] = st
	}

	scores := make([]float64, len(ids))
	hasData := make([]bool, len(ids))
	var dataSum float64
	var dataN int
	for i, id := range ids {
		if !a.health.Allowed(id) {
			continue
		}
		p := win[id]
		if p.RPS < autoMinRPS {
			continue
		}
		errRatio := math.Min(math.Max(p.ErrorRPS/p.RPS, 0), 1)
		scores[i] = (1 - errRatio) * (1 - errRatio) / math.Max(p.P95, 1)
		hasData[i] = true
		dataSum += scores[i]
		dataN++
	}
	neutral := 1.0
	if dataN > 0 {
		neutral = dataSum / float64(dataN)
	}
	positive := 0
	var total float64
	for i, id := range ids {
		if a.health.Allowed(id) && !hasData[i] {
			scores[i] = neutral
		}
		if scores[i] > 0 {
			positive++
			total += scores[i]
		}
	}
	if total <= 0 {
		// Nothing is eligible: fall back to configured weights (proxy then 503s).
		st.last = copyWeights(configured)
		return copyWeights(configured)
	}

	smooth := make([]float64, len(ids))
	var ssum float64
	for i, id := range ids {
		if scores[i] <= 0 {
			continue
		}
		target := scores[i] / total * 100
		smooth[i] = 0.5*float64(st.last[id]) + 0.5*target
		ssum += smooth[i]
	}
	for i := range smooth {
		smooth[i] = smooth[i] / ssum * 100
	}
	if positive >= 2 {
		applyFloor(smooth, scores)
	}
	rounded := largestRemainder(smooth)
	res := map[string]int{}
	for i, id := range ids {
		res[id] = rounded[i]
	}
	st.last = copyWeights(res)

	moved := false
	for _, id := range ids {
		if d := res[id] - st.emitted[id]; d >= autoEventDelta || d <= -autoEventDelta {
			moved = true
		}
	}
	if moved {
		parts := make([]string, len(ids))
		for i, id := range ids {
			parts[i] = fmt.Sprintf("%s %d", id, res[id])
		}
		a.events.Add(Event{Kind: "weights", Level: "info", Route: r.ID, Message: fmt.Sprintf("Auto-weight %s: %s", r.ID, strings.Join(parts, ", "))})
		st.emitted = copyWeights(res)
	}
	return res
}

// applyFloor raises every positive-score weight to at least autoFloor and
// rescales the rest so the total stays 100.
func applyFloor(w, scores []float64) {
	pinned := make([]bool, len(w))
	for iter := 0; iter < len(w); iter++ {
		changed := false
		for i := range w {
			if scores[i] > 0 && !pinned[i] && w[i] < autoFloor {
				pinned[i] = true
				changed = true
			}
		}
		if !changed {
			return
		}
		var free float64
		pinnedN := 0
		for i := range w {
			if pinned[i] {
				pinnedN++
			} else if scores[i] > 0 {
				free += w[i]
			}
		}
		remaining := 100 - autoFloor*float64(pinnedN)
		for i := range w {
			switch {
			case pinned[i]:
				w[i] = autoFloor
			case scores[i] > 0 && free > 0:
				w[i] = w[i] / free * remaining
			}
		}
	}
}

// largestRemainder rounds w to integers that total exactly 100.
func largestRemainder(w []float64) []int {
	out := make([]int, len(w))
	type rem struct {
		i int
		f float64
	}
	var rems []rem
	used := 0
	for i, v := range w {
		fl := math.Floor(v + 1e-9)
		out[i] = int(fl)
		used += out[i]
		rems = append(rems, rem{i, v - fl})
	}
	sort.SliceStable(rems, func(x, y int) bool { return rems[x].f > rems[y].f })
	for k := 0; used < 100 && len(rems) > 0; k++ {
		// Only upstreams with a positive weight may receive a remainder unit.
		r := rems[k%len(rems)]
		if w[r.i] > 0 {
			out[r.i]++
			used++
		}
	}
	return out
}

func copyWeights(m map[string]int) map[string]int {
	out := make(map[string]int, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
