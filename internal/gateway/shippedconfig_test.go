package gateway

import (
	"path/filepath"
	"testing"
)

// TestShippedConfigsValidate loads every checked-in config/*.json so a bad edit
// to a starting or demo config fails in CI instead of at container startup.
func TestShippedConfigsValidate(t *testing.T) {
	files, err := filepath.Glob("../../config/*.json")
	if err != nil || len(files) == 0 {
		t.Fatalf("no shipped configs found: %v", err)
	}
	for _, f := range files {
		cfg, err := LoadConfig(f)
		if err != nil {
			t.Errorf("%s: load: %v", f, err)
			continue
		}
		if err := Validate(cfg); err != nil {
			t.Errorf("%s: validate: %v", f, err)
		}
	}
}
