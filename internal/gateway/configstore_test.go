package gateway

import (
	"path/filepath"
	"testing"
)

func TestReplacePersistsBeforeActivationAndChecksRevision(t *testing.T) {
	// A temporary directory isolates the durable file and audit log from other tests.
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	initial := validConfig()
	cs, e := OpenConfigStore(path, initial)
	if e != nil {
		t.Fatal(e)
	}
	next := validConfig()
	next.Routes[0].Priority = 7
	a, e := cs.Replace(next, 1)
	if e != nil {
		t.Fatal(e)
	}
	if a.NewRevision != 2 || cs.Store().Load().Revision != 2 {
		t.Fatalf("unexpected revision: %#v", a)
	}
	// The persisted envelope must be readable on a fresh store, not just in memory.
	b, e := cs.Replace(initial, 1)
	if e == nil || b.Outcome != "rejected" {
		t.Fatal("stale revision should reject")
	}
	restarted, e := OpenConfigStore(path, initial)
	if e != nil {
		t.Fatal(e)
	}
	if restarted.Store().Load().Revision != 2 || restarted.Store().Load().Config.Routes[0].Priority != 7 {
		t.Fatal("restart did not preserve active revision and config")
	}
}
