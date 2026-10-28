// jwtgen creates review-only RS256 verification material and short-lived tokens.
// Do not copy the private key to the gateway or commit either generated file.
package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type keySet struct {
	Revision string            `json:"revision"`
	Issuer   string            `json:"issuer"`
	Audience string            `json:"audience"`
	Keys     map[string]string `json:"keys"`
}

func main() {
	if len(os.Args) < 2 {
		die("usage: jwtgen keygen|token [flags]")
	}
	switch os.Args[1] {
	case "keygen":
		keygen(os.Args[2:])
	case "token":
		token(os.Args[2:])
	default:
		die("usage: jwtgen keygen|token [flags]")
	}
}
func keygen(args []string) {
	f := flag.NewFlagSet("keygen", flag.ExitOnError)
	kid := f.String("kid", "review-1", "verification key ID")
	issuer := f.String("issuer", "dynamic-l7-review", "JWT issuer")
	aud := f.String("audience", "dynamic-l7-gateway", "JWT audience")
	privPath := f.String("private", "review-signing-private.pem", "local signing key output (keep off gateway)")
	secretPath := f.String("secret", "jwt-keys.secret.json", "public verification key secret JSON output")
	_ = f.Parse(args)
	if strings.TrimSpace(*kid) == "" || strings.TrimSpace(*issuer) == "" || strings.TrimSpace(*aud) == "" {
		die("kid, issuer and audience are required")
	}
	key, e := rsa.GenerateKey(rand.Reader, 3072)
	if e != nil {
		die(e.Error())
	}
	if e = os.MkdirAll(filepath.Dir(*privPath), 0700); e != nil {
		die(e.Error())
	}
	if e = os.MkdirAll(filepath.Dir(*secretPath), 0700); e != nil {
		die(e.Error())
	}
	priv := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	if e = os.WriteFile(*privPath, priv, 0600); e != nil {
		die(e.Error())
	}
	pub := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: must(x509.MarshalPKIXPublicKey(&key.PublicKey))})
	set := keySet{Revision: time.Now().UTC().Format("20060102T150405Z"), Issuer: *issuer, Audience: *aud, Keys: map[string]string{*kid: string(pub)}}
	data, e := json.MarshalIndent(set, "", "  ")
	if e != nil {
		die(e.Error())
	}
	if e = os.WriteFile(*secretPath, data, 0600); e != nil {
		die(e.Error())
	}
	fmt.Printf("created private signing key %s and public verification secret %s\n", *privPath, *secretPath)
}
func token(args []string) {
	f := flag.NewFlagSet("token", flag.ExitOnError)
	privPath := f.String("private", "review-signing-private.pem", "local private signing key")
	kid := f.String("kid", "review-1", "key ID")
	issuer := f.String("issuer", "dynamic-l7-review", "JWT issuer")
	aud := f.String("audience", "dynamic-l7-gateway", "JWT audience")
	expiry := f.Duration("expires-in", 10*time.Minute, "token lifetime")
	_ = f.Parse(args)
	b, e := os.ReadFile(*privPath)
	if e != nil {
		die(e.Error())
	}
	block, _ := pem.Decode(b)
	if block == nil {
		die("invalid PEM signing key")
	}
	key, e := x509.ParsePKCS1PrivateKey(block.Bytes)
	if e != nil {
		if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
			var ok bool
			key, ok = k.(*rsa.PrivateKey)
			if !ok {
				die("signing key is not RSA")
			}
		} else {
			die(e.Error())
		}
	}
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT", "kid": *kid})
	now := time.Now()
	claims, _ := json.Marshal(map[string]any{"iss": *issuer, "aud": *aud, "iat": now.Unix(), "nbf": now.Add(-5 * time.Second).Unix(), "exp": now.Add(*expiry).Unix()})
	enc := func(b []byte) string {
		return strings.TrimRight(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(base64Encode(b)), "+", "-"), "/", "_"), "=")
	}
	input := enc(header) + "." + enc(claims)
	digest := sha256sum([]byte(input))
	sig, e := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest)
	if e != nil {
		die(e.Error())
	}
	fmt.Println(input + "." + enc(sig))
}
func base64Encode(b []byte) string { return base64.RawStdEncoding.EncodeToString(b) }
func sha256sum(b []byte) []byte    { h := sha256.Sum256(b); return h[:] }
func must(b []byte, e error) []byte {
	if e != nil {
		die(e.Error())
	}
	return b
}
func die(s string) { fmt.Fprintln(os.Stderr, s); os.Exit(1) }
