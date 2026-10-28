package gateway

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

func verifyJWT(token string, keys *parsedKeys, skew time.Duration) error {
	// Decode and verify locally from the last atomically loaded key set; request
	// handling never reaches out to Secrets Manager.
	if keys == nil {
		return errors.New("verification keys unavailable")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return errors.New("malformed token")
	}
	decode := func(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }
	hb, e := decode(parts[0])
	if e != nil {
		return errors.New("malformed header")
	}
	pb, e := decode(parts[1])
	if e != nil {
		return errors.New("malformed claims")
	}
	sig, e := decode(parts[2])
	if e != nil {
		return errors.New("malformed signature")
	}
	var h struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if json.Unmarshal(hb, &h) != nil || h.Alg != "RS256" || h.Kid == "" {
		return errors.New("unsupported or incomplete token header")
	}
	key := keys.Keys[h.Kid]
	if key == nil {
		return errors.New("unknown key ID")
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	// Pin the algorithm instead of trusting a token-selected verifier.
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig) != nil {
		return errors.New("invalid signature")
	}
	var c struct {
		Iss string `json:"iss"`
		Aud any    `json:"aud"`
		Exp int64  `json:"exp"`
		Nbf int64  `json:"nbf"`
	}
	if json.Unmarshal(pb, &c) != nil {
		return errors.New("malformed claims")
	}
	if c.Iss != keys.Set.Issuer {
		return errors.New("issuer mismatch")
	}
	if !audienceContains(c.Aud, keys.Set.Audience) {
		return errors.New("audience mismatch")
	}
	now := time.Now()
	if c.Exp == 0 || now.After(time.Unix(c.Exp, 0).Add(skew)) {
		return errors.New("token expired")
	}
	if c.Nbf > 0 && now.Add(skew).Before(time.Unix(c.Nbf, 0)) {
		return errors.New("token not active")
	}
	return nil
}
func audienceContains(v any, want string) bool {
	// JWT permits either one audience string or an array of audience strings.
	switch a := v.(type) {
	case string:
		return a == want
	case []any:
		for _, x := range a {
			if x == want {
				return true
			}
		}
	}
	return false
}
func bearer(h string) (string, error) {
	// Require a two-part Bearer header and leave token parsing to verifyJWT.
	p := strings.SplitN(h, " ", 2)
	if len(p) != 2 || !strings.EqualFold(p[0], "Bearer") || p[1] == "" {
		return "", fmt.Errorf("bearer token required")
	}
	return p[1], nil
}
