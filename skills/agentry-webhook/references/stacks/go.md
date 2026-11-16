# Go — net/http (chi/gin/echo: same handler body)

Raw body: `io.ReadAll(r.Body)` before decoding. Constant-time compare: `hmac.Equal`. Background:
a goroutine started after writing the 200 (use a `context.Background()`-derived context, not the
request's — it's cancelled when the handler returns).

```go
package agentry

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

type Payload struct {
	AgentID    string            `json:"agent_id"`
	User       map[string]any    `json:"user"`
	ReplyURL   string            `json:"reply_url"`
	ReplyToken string            `json:"reply_token"`
	Settings   map[string]string `json:"settings"`
	Envelope   struct {
		Type    string         `json:"type"`
		ID      string         `json:"id"`
		ChatID  string         `json:"chat_id"`
		Content map[string]any `json:"content"`
	} `json:"envelope"`
}

var (
	seenMu sync.Mutex
	seen   = map[string]time.Time{}
)

func secret() string { return os.Getenv("AGENTRY_WEBHOOK_SECRET") }

func verify(raw []byte, header string) bool {
	if header == "" || secret() == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret()))
	mac.Write(raw)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(header))
}

func firstTime(id string) bool {
	seenMu.Lock()
	defer seenMu.Unlock()
	if _, ok := seen[id]; ok {
		return false
	}
	if len(seen) > 5000 {
		for k, t := range seen {
			if time.Since(t) > time.Hour {
				delete(seen, k)
			}
		}
	}
	seen[id] = time.Now()
	return true
}

func Health(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{"ok":true}`)) }

func Webhook(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if secret() == "" {
		w.WriteHeader(503)
		w.Write([]byte(`{"error":"signing_secret_not_configured"}`))
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil || !verify(raw, r.Header.Get("X-Super-Signature")) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"bad_signature"}`))
		return
	}
	var p Payload
	if err := json.Unmarshal(raw, &p); err != nil {
		w.WriteHeader(400)
		return
	}
	if p.Envelope.ID != "" && !firstTime(p.Envelope.ID) {
		w.Write([]byte(`{"ok":true,"duplicate":true}`))
		return
	}
	w.Write([]byte(`{"ok":true}`))
	if p.Envelope.Type == "message" {
		go runTurn(p)
	}
}

func newID(prefix string) string {
	b := make([]byte, 16)
	rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}

func base(p Payload, typ string) map[string]any {
	prefix := "evt"
	if typ == "message" {
		prefix = "msg"
	}
	return map[string]any{
		"type": typ, "id": newID(prefix), "chat_id": p.Envelope.ChatID,
		"from":      map[string]string{"kind": "agent", "id": p.AgentID},
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}
}

func send(p Payload, env map[string]any, usage map[string]any) {
	body := map[string]any{"envelope": env}
	if usage != nil {
		body["usage"] = usage
	}
	buf, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", p.ReplyURL, bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.ReplyToken)
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		log.Println("agentry reply:", err)
		return
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		msg, _ := io.ReadAll(res.Body)
		log.Printf("agentry reply %s -> %d %s", env["type"], res.StatusCode, msg)
	}
}

func runTurn(p Payload) {
	start := base(p, "typing_start")
	start["expires_at"] = time.Now().UTC().Add(10 * time.Second).Format(time.RFC3339)
	send(p, start, nil)
	defer send(p, base(p, "typing_stop"), nil)

	text, _ := p.Envelope.Content["text"].(string)
	// ⬇ Call the project's agent. Keep per-chat history keyed by p.Envelope.ChatID.
	answer, usage, err := RunAgent(text, p)
	if err != nil {
		log.Println("agentry turn:", err)
		answer, usage = "Sorry — something went wrong on my side. Please try again.", nil
	}
	msg := base(p, "message")
	msg["in_reply_to"] = p.Envelope.ID
	msg["content"] = map[string]string{"kind": "text", "text": answer}
	send(p, msg, usage)
}

```

Register: `mux.HandleFunc("GET /health", agentry.Health)` and
`mux.HandleFunc("POST /agentry/webhook", agentry.Webhook)` (Go 1.22+ patterns).
