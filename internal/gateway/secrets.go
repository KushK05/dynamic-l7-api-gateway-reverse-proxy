package gateway

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"
)

// KeySet is the JSON shape stored in Secrets Manager; it contains public keys only.
type KeySet struct {
	Revision string            `json:"revision"`
	Issuer   string            `json:"issuer"`
	Audience string            `json:"audience"`
	Keys     map[string]string `json:"keys"`
}

// parsedKeys is immutable after construction and published as one atomic pointer.
type parsedKeys struct {
	Set      KeySet
	Keys     map[string]*rsa.PublicKey
	loadedAt time.Time
}

// KeyManager retains the last valid set if a refresh cannot fetch or parse a replacement.
type KeyManager struct {
	current   atomic.Pointer[parsedKeys]
	secretARN string
	ttl       time.Duration
}

func NewKeyManager(arn string, ttl time.Duration) *KeyManager {
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	return &KeyManager{secretARN: arn, ttl: ttl}
}
func (k *KeyManager) Current() *parsedKeys { return k.current.Load() }
func (k *KeyManager) RefreshIfExpired(ctx context.Context) error {
	if p := k.Current(); p != nil && time.Since(p.loadedAt) < k.ttl {
		return nil
	}
	return k.Refresh(ctx)
}
func (k *KeyManager) Refresh(ctx context.Context) error {
	var raw []byte
	if v := os.Getenv("JWT_KEYS_JSON"); v != "" {
		// Local development can inject public test material without AWS credentials.
		raw = []byte(v)
	} else if k.secretARN != "" {
		// On EC2, the AWS CLI uses the instance role credential chain; no access keys
		// are passed to or stored by the gateway.
		cmd := exec.CommandContext(ctx, "aws", "secretsmanager", "get-secret-value", "--secret-id", k.secretARN, "--query", "SecretString", "--output", "text")
		out, err := cmd.Output()
		if err != nil {
			return fmt.Errorf("read JWT verification secret: %w", err)
		}
		raw = out
	} else {
		return errors.New("JWT_KEYS_JSON or JWT_SECRET_ARN must be configured")
	}
	var set KeySet
	if err := json.Unmarshal(raw, &set); err != nil {
		return fmt.Errorf("parse verification key secret: %w", err)
	}
	if set.Issuer == "" || set.Audience == "" || len(set.Keys) == 0 {
		return errors.New("verification secret requires issuer, audience, and keys")
	}
	p := &parsedKeys{Set: set, Keys: map[string]*rsa.PublicKey{}, loadedAt: time.Now()}
	for id, material := range set.Keys {
		if id == "" {
			return errors.New("verification key ID is empty")
		}
		if strings.Contains(material, "BEGIN PUBLIC KEY") || strings.Contains(material, "BEGIN RSA PUBLIC KEY") {
			// Accept PEM public keys for operator readability, including both standard
			// SubjectPublicKeyInfo and PKCS#1 RSA encodings.
			block, _ := pem.Decode([]byte(material))
			if block == nil {
				return fmt.Errorf("key %s has invalid PEM", id)
			}
			pub, e := x509.ParsePKIXPublicKey(block.Bytes)
			if e != nil {
				if rp, er := x509.ParsePKCS1PublicKey(block.Bytes); er == nil {
					p.Keys[id] = rp
					continue
				}
				return fmt.Errorf("key %s: %w", id, e)
			}
			rp, ok := pub.(*rsa.PublicKey)
			if !ok {
				return fmt.Errorf("key %s is not RSA", id)
			}
			p.Keys[id] = rp
		} else {
			// Compact deployments may encode PKCS#1 DER bytes as base64url text.
			der, e := base64.RawURLEncoding.DecodeString(material)
			if e != nil {
				return fmt.Errorf("key %s: decode PKCS1 public key: %w", id, e)
			}
			rp, e := x509.ParsePKCS1PublicKey(der)
			if e != nil {
				return fmt.Errorf("key %s: %w", id, e)
			}
			p.Keys[id] = rp
		}
	}
	// Publish only after every key parses successfully, preserving last-known-good
	// verification material if any replacement entry is malformed.
	k.current.Store(p)
	return nil
}
