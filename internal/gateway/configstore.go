package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ConfigStore serializes config writers while readers use Store's atomic snapshot.
type ConfigStore struct {
	mu        sync.Mutex
	path      string
	store     *Store
	auditPath string
}
type Audit struct {
	Timestamp   time.Time `json:"timestamp"`
	OldRevision int64     `json:"old_revision"`
	NewRevision int64     `json:"new_revision"`
	Outcome     string    `json:"outcome"`
	Error       string    `json:"error,omitempty"`
}
type persistedConfig struct {
	Revision int64  `json:"revision"`
	Config   Config `json:"config"`
}

func OpenConfigStore(path string, initial Config) (*ConfigStore, error) {
	// Keep revision and route data in one file so a restart cannot pair a new config
	// with an old revision (or vice versa).
	cs := &ConfigStore{path: path, store: &Store{}, auditPath: filepath.Join(filepath.Dir(path), "reload-audit.jsonl")}
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	rev := int64(1)
	if errors.Is(err, os.ErrNotExist) {
		if err = Validate(initial); err != nil {
			return nil, err
		}
		data, err = json.MarshalIndent(persistedConfig{Revision: rev, Config: initial}, "", "  ")
		if err != nil {
			return nil, err
		}
		if err = atomicWrite(path, data); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	var disk struct {
		Revision int64   `json:"revision"`
		Config   *Config `json:"config"`
	}
	if err = json.Unmarshal(data, &disk); err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var c Config
	if disk.Config != nil {
		// The envelope is the current format. The fallback below accepts an older
		// plain-config file and upgrades it in memory at revision 1.
		c = *disk.Config
		if disk.Revision < 1 {
			return nil, errors.New("persisted revision must be positive")
		}
		rev = disk.Revision
	} else if err = json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	if err = Validate(c); err != nil {
		return nil, fmt.Errorf("invalid persisted config: %w", err)
	}
	cs.store.Activate(c, rev)
	return cs, nil
}
func (cs *ConfigStore) Store() *Store { return cs.store }
func (cs *ConfigStore) Replace(c Config, expected int64) (Audit, error) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	old := cs.store.Load()
	// Check the caller's ETag while holding the writer lock; concurrent PUTs cannot
	// both commit against the same revision.
	a := Audit{Timestamp: time.Now().UTC(), OldRevision: old.Revision, Outcome: "rejected"}
	if expected != old.Revision {
		err := fmt.Errorf("revision conflict: active revision is %d", old.Revision)
		a.Error = err.Error()
		_ = cs.appendAudit(a)
		return a, err
	}
	if err := Validate(c); err != nil {
		a.Error = err.Error()
		_ = cs.appendAudit(a)
		return a, err
	}
	data, err := json.MarshalIndent(persistedConfig{Revision: old.Revision + 1, Config: c}, "", "  ")
	if err != nil {
		a.Error = err.Error()
		_ = cs.appendAudit(a)
		return a, err
	}
	if err = atomicWrite(cs.path, data); err != nil {
		a.Error = err.Error()
		_ = cs.appendAudit(a)
		return a, err
	}
	a.NewRevision = old.Revision + 1
	a.Outcome = "accepted"
	// Publish only after durable storage succeeds, so readers never observe an
	// update that would be lost if the process crashed immediately afterward.
	cs.store.Activate(c, a.NewRevision)
	_ = cs.appendAudit(a)
	return a, nil
}
func (cs *ConfigStore) appendAudit(a Audit) error {
	// Audit data contains outcomes and validation errors only, never request tokens.
	f, e := os.OpenFile(cs.auditPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	b, e := json.Marshal(a)
	if e != nil {
		return e
	}
	if _, e = f.Write(append(b, '\n')); e != nil {
		return e
	}
	return f.Sync()
}
func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	f, e := os.CreateTemp(dir, ".config-*.tmp")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e != nil {
		f.Close()
		return e
	}
	if _, e = f.Write(data); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if e = os.Rename(name, path); e != nil {
		return e
	}
	d, e := os.Open(dir)
	if e == nil {
		// Sync the directory entry as well as file contents to make the rename
		// durable across a sudden host restart on filesystems that require it.
		defer d.Close()
		e = d.Sync()
	}
	return e
}
