package gateway

import (
	"sync"
	"time"
)

// Event is one entry in the operator-facing activity log.
type Event struct {
	Seq      uint64    `json:"seq"`
	Time     time.Time `json:"time"`
	Kind     string    `json:"kind"`  // "config" | "health" | "fault" | "load" | "weights" | "secrets"
	Level    string    `json:"level"` // "info" | "success" | "warn" | "error"
	Message  string    `json:"message"`
	Route    string    `json:"route,omitempty"`
	Upstream string    `json:"upstream,omitempty"`
}

// EventLog is a fixed-capacity ring of recent events. A nil *EventLog is a
// valid no-op sink so components work without one.
type EventLog struct {
	mu   sync.Mutex
	buf  []Event
	next uint64 // sequence assigned to the next event
}

func NewEventLog(capacity int) *EventLog {
	if capacity < 1 {
		capacity = 1
	}
	return &EventLog{buf: make([]Event, 0, capacity), next: 1}
}

// Add assigns Seq and, when zero, Time (UTC), stores the event and returns it.
func (l *EventLog) Add(e Event) Event {
	if l == nil {
		return e
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	e.Seq = l.next
	l.next++
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}
	if len(l.buf) == cap(l.buf) {
		copy(l.buf, l.buf[1:])
		l.buf = l.buf[:len(l.buf)-1]
	}
	l.buf = append(l.buf, e)
	return e
}

// Since returns events with Seq greater than seq, oldest first.
func (l *EventLog) Since(seq uint64) []Event {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	out := []Event{}
	for _, e := range l.buf {
		if e.Seq > seq {
			out = append(out, e)
		}
	}
	return out
}

// Recent returns the newest n events, oldest first.
func (l *EventLog) Recent(n int) []Event {
	if l == nil || n <= 0 {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if n > len(l.buf) {
		n = len(l.buf)
	}
	return append([]Event(nil), l.buf[len(l.buf)-n:]...)
}
