package gateway

import "testing"

func TestEventLogSeqRingSinceRecent(t *testing.T) {
	l := NewEventLog(3)
	for i := 1; i <= 5; i++ {
		e := l.Add(Event{Kind: "config", Level: "info", Message: string(rune('a' + i - 1))})
		if e.Seq != uint64(i) || e.Time.IsZero() || e.Time.Location().String() != "UTC" {
			t.Fatalf("event %d: %+v", i, e)
		}
	}
	got := l.Recent(10)
	if len(got) != 3 || got[0].Seq != 3 || got[2].Seq != 5 {
		t.Fatalf("ring should keep newest 3 oldest-first, got %+v", got)
	}
	if r := l.Recent(2); len(r) != 2 || r[0].Seq != 4 || r[1].Seq != 5 {
		t.Fatalf("Recent(2): %+v", r)
	}
	if s := l.Since(3); len(s) != 2 || s[0].Seq != 4 {
		t.Fatalf("Since(3): %+v", s)
	}
	if s := l.Since(0); len(s) != 3 || s[0].Seq != 3 {
		t.Fatalf("Since(0): %+v", s)
	}
	if s := l.Since(5); len(s) != 0 {
		t.Fatalf("Since(5): %+v", s)
	}
	if r := l.Recent(0); len(r) != 0 {
		t.Fatalf("Recent(0): %+v", r)
	}
}

func TestEventLogNilSafe(t *testing.T) {
	var l *EventLog
	l.Add(Event{Message: "x"})
	if l.Since(0) != nil && len(l.Since(0)) != 0 {
		t.Fatal("nil log Since should be empty")
	}
	if len(l.Recent(5)) != 0 {
		t.Fatal("nil log Recent should be empty")
	}
}
