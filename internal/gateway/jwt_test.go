package gateway

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func testToken(t *testing.T, key *rsa.PrivateKey, claims map[string]any) string {
	// Build a correctly signed token so each assertion changes only one claim.
	t.Helper()
	enc := func(v any) string {
		b, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		return base64.RawURLEncoding.EncodeToString(b)
	}
	h := enc(map[string]string{"alg": "RS256", "kid": "one"})
	p := enc(claims)
	input := h + "." + p
	digest := sha256.Sum256([]byte(input))
	sig, e := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if e != nil {
		t.Fatal(e)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}
func TestVerifyJWTClaimsAndAlgorithms(t *testing.T) {
	priv, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	// Use a generated local key so the test has no external secret dependency.
	der := x509.MarshalPKCS1PublicKey(&priv.PublicKey)
	_ = der
	keys := &parsedKeys{Set: KeySet{Issuer: "issuer", Audience: "gateway"}, Keys: map[string]*rsa.PublicKey{"one": &priv.PublicKey}}
	claims := map[string]any{"iss": "issuer", "aud": "gateway", "exp": time.Now().Add(time.Minute).Unix(), "nbf": time.Now().Add(-time.Minute).Unix()}
	tok := testToken(t, priv, claims)
	if e = verifyJWT(tok, keys, 0); e != nil {
		t.Fatal(e)
	}
	claims["aud"] = "other"
	if e = verifyJWT(testToken(t, priv, claims), keys, 0); e == nil {
		t.Fatal("wrong audience accepted")
	}
	claims["aud"] = "gateway"
	claims["exp"] = time.Now().Add(-time.Minute).Unix()
	if e = verifyJWT(testToken(t, priv, claims), keys, 0); e == nil {
		t.Fatal("expired token accepted")
	}
	if e = verifyJWT("not.a.jwt", keys, 0); e == nil {
		t.Fatal("malformed token accepted")
	}
}
