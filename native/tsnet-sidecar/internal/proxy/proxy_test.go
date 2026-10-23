package proxy

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// discardLogger keeps test output readable while still exercising every
// logging call site.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// stubIdentity is an IdentityResolver with a fixed answer.
type stubIdentity struct {
	identity Identity
	err      error

	// lastRemoteAddr records what the handler passed in, so a test can
	// assert that the peer address rather than some rewritten value is used.
	lastRemoteAddr string
}

func (s *stubIdentity) Identify(_ context.Context, remoteAddr string) (Identity, error) {
	s.lastRemoteAddr = remoteAddr
	if s.err != nil {
		return Identity{}, s.err
	}
	return s.identity, nil
}

// newProxy starts a frontend server running the real handler in front of the
// given backend, and returns the frontend's base URL.
func newProxy(t *testing.T, backendURL string, opts Options) string {
	t.Helper()

	target, err := url.Parse(backendURL)
	if err != nil {
		t.Fatalf("parsing backend URL: %v", err)
	}
	opts.Target = target
	if opts.Logger == nil {
		opts.Logger = discardLogger()
	}

	handler, err := New(opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	frontend := httptest.NewServer(handler)
	t.Cleanup(frontend.Close)
	return frontend.URL
}

func TestNewRejectsIncompleteOptions(t *testing.T) {
	t.Parallel()

	if _, err := New(Options{Logger: discardLogger()}); err == nil {
		t.Error("New accepted a nil Target")
	}
	target, _ := url.Parse("http://127.0.0.1:1")
	if _, err := New(Options{Target: target}); err == nil {
		t.Error("New accepted a nil Logger")
	}
	if _, err := New(Options{Target: &url.URL{Path: "/relative"}, Logger: discardLogger()}); err == nil {
		t.Error("New accepted a relative Target")
	}
}

func TestForwardsPlainHTTP(t *testing.T) {
	t.Parallel()

	var (
		gotHost          string
		gotForwardedHost string
		gotForwardedFor  string
		gotProto         string
	)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		gotForwardedHost = r.Header.Get("X-Forwarded-Host")
		gotForwardedFor = r.Header.Get("X-Forwarded-For")
		gotProto = r.Header.Get("X-Forwarded-Proto")
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"path":"`+r.URL.Path+`"}`)
	}))
	defer backend.Close()

	frontend := newProxy(t, backend.URL, Options{})

	resp, err := http.Get(frontend + "/rack/health")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if string(body) != `{"path":"/rack/health"}` {
		t.Errorf("body = %s, want the request path to be preserved", body)
	}
	if want := strings.TrimPrefix(backend.URL, "http://"); gotHost != want {
		t.Errorf("backend Host = %q, want the target address %q", gotHost, want)
	}
	if gotForwardedHost != strings.TrimPrefix(frontend, "http://") {
		t.Errorf("X-Forwarded-Host = %q, want the address the client used", gotForwardedHost)
	}
	if gotForwardedFor == "" {
		t.Error("X-Forwarded-For was not set")
	}
	if gotProto != "http" {
		t.Errorf("X-Forwarded-Proto = %q, want http", gotProto)
	}
}

// TestForwardsWebSocketUpgrade drives a real RFC 6455 handshake through the
// handler and then exchanges bytes in both directions over the upgraded
// connection. It uses a hand-written handshake rather than a WebSocket library
// so the module keeps a single external dependency.
func TestForwardsWebSocketUpgrade(t *testing.T) {
	t.Parallel()

	const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Fail loudly if the hop-by-hop headers that make an upgrade
		// work did not survive the proxy.
		if !IsUpgrade(r.Header) || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "upgrade headers were not forwarded", http.StatusBadRequest)
			return
		}
		key := r.Header.Get("Sec-WebSocket-Key")
		if key == "" {
			http.Error(w, "Sec-WebSocket-Key was not forwarded", http.StatusBadRequest)
			return
		}

		conn, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer conn.Close()

		sum := sha1.Sum([]byte(key + websocketGUID))
		accept := base64.StdEncoding.EncodeToString(sum[:])
		_, err = io.WriteString(buffered, "HTTP/1.1 101 Switching Protocols\r\n"+
			"Upgrade: websocket\r\n"+
			"Connection: Upgrade\r\n"+
			"Sec-WebSocket-Accept: "+accept+"\r\n\r\n")
		if err != nil {
			return
		}
		if err := buffered.Flush(); err != nil {
			return
		}

		// Echo frames back uppercased, which proves that bytes flow in
		// both directions after the switch rather than only towards the
		// daemon.
		scanner := bufio.NewScanner(buffered)
		for scanner.Scan() {
			if _, err := io.WriteString(buffered, strings.ToUpper(scanner.Text())+"\n"); err != nil {
				return
			}
			if err := buffered.Flush(); err != nil {
				return
			}
		}
	}))
	defer backend.Close()

	identity := &stubIdentity{identity: Identity{LoginName: "alice@example.com", NodeName: "laptop.tail.ts.net"}}
	frontend := newProxy(t, backend.URL, Options{Identity: identity})

	conn, err := net.Dial("tcp", strings.TrimPrefix(frontend, "http://"))
	if err != nil {
		t.Fatalf("dialing the sidecar: %v", err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatalf("SetDeadline: %v", err)
	}

	request := "GET /rack/socket HTTP/1.1\r\n" +
		"Host: " + strings.TrimPrefix(frontend, "http://") + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatalf("writing handshake: %v", err)
	}

	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatalf("reading handshake response: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d (%s), want 101", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if accept := resp.Header.Get("Sec-WebSocket-Accept"); accept != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Errorf("Sec-WebSocket-Accept = %q, want the value derived from the forwarded key", accept)
	}

	if _, err := io.WriteString(conn, "hello daemon\n"); err != nil {
		t.Fatalf("writing after the upgrade: %v", err)
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("reading after the upgrade: %v", err)
	}
	if strings.TrimSpace(line) != "HELLO DAEMON" {
		t.Errorf("echo = %q, want the upgraded connection to carry bytes both ways", line)
	}
}

// TestIdentityHeadersCannotBeSpoofed is the security-relevant case: a peer
// sends the identity headers itself, and they must be replaced by the resolved
// identity rather than passed through.
func TestIdentityHeadersCannotBeSpoofed(t *testing.T) {
	t.Parallel()

	var got http.Header
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
	}))
	defer backend.Close()

	identity := &stubIdentity{identity: Identity{
		LoginName: "alice@example.com",
		NodeName:  "laptop.tail.ts.net",
		Tags:      []string{"tag:rack-controller"},
	}}
	frontend := newProxy(t, backend.URL, Options{Identity: identity})

	req, err := http.NewRequest(http.MethodGet, frontend+"/", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set(HeaderTailnetUser, "root@example.com")
	req.Header.Set(HeaderTailnetNode, "attacker.tail.ts.net")
	req.Header.Set(HeaderTailnetTags, "tag:admin")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	resp.Body.Close()

	if got.Get(HeaderTailnetUser) != "alice@example.com" {
		t.Errorf("%s = %q, want the resolved identity", HeaderTailnetUser, got.Get(HeaderTailnetUser))
	}
	if got.Get(HeaderTailnetNode) != "laptop.tail.ts.net" {
		t.Errorf("%s = %q, want the resolved identity", HeaderTailnetNode, got.Get(HeaderTailnetNode))
	}
	if got.Get(HeaderTailnetTags) != "tag:rack-controller" {
		t.Errorf("%s = %q, want the resolved tags", HeaderTailnetTags, got.Get(HeaderTailnetTags))
	}
	if identity.lastRemoteAddr == "" {
		t.Error("the resolver was not called with the peer address")
	}
}

// TestIdentityHeadersStrippedWithoutResolver covers the configuration where
// identity forwarding is disabled: the daemon must never see a header that the
// sidecar did not assert.
func TestIdentityHeadersStrippedWithoutResolver(t *testing.T) {
	t.Parallel()

	var got http.Header
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
	}))
	defer backend.Close()

	frontend := newProxy(t, backend.URL, Options{})

	req, _ := http.NewRequest(http.MethodGet, frontend+"/", nil)
	req.Header.Set(HeaderTailnetUser, "root@example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	resp.Body.Close()

	if v := got.Get(HeaderTailnetUser); v != "" {
		t.Errorf("%s = %q, want it stripped when no resolver is configured", HeaderTailnetUser, v)
	}
}

func TestUnresolvableIdentityIsRefused(t *testing.T) {
	t.Parallel()

	reached := false
	backend := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		reached = true
	}))
	defer backend.Close()

	frontend := newProxy(t, backend.URL, Options{
		Identity: &stubIdentity{err: errors.New("node not found")},
	})

	resp, err := http.Get(frontend + "/")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", resp.StatusCode)
	}
	if reached {
		t.Error("the request was forwarded despite an unresolvable identity")
	}
}

func TestUnreachableDaemonReturnsBadGateway(t *testing.T) {
	t.Parallel()

	// Bind and immediately release a port to obtain an address that is
	// almost certainly closed, without depending on a fixed port number.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	closedAddr := listener.Addr().String()
	listener.Close()

	frontend := newProxy(t, "http://"+closedAddr, Options{})

	resp, err := http.Get(frontend + "/")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadGateway {
		t.Errorf("status = %d, want 502 when the daemon is down", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "unreachable") {
		t.Errorf("body = %q, want an explicit explanation", body)
	}
}

// TestStreamingResponsesAreNotBuffered covers FlushInterval -1: the first chunk
// of a long-lived response must reach the client before the daemon finishes
// writing, because run events stream over such a response.
func TestStreamingResponsesAreNotBuffered(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "event: first\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
		io.WriteString(w, "event: second\n")
	}))
	defer backend.Close()
	defer close(release)

	frontend := newProxy(t, backend.URL, Options{})

	resp, err := http.Get(frontend + "/events")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	type readResult struct {
		line string
		err  error
	}
	results := make(chan readResult, 1)
	go func() {
		line, err := bufio.NewReader(resp.Body).ReadString('\n')
		results <- readResult{line, err}
	}()

	select {
	case got := <-results:
		if got.err != nil {
			t.Fatalf("reading the first chunk: %v", got.err)
		}
		if strings.TrimSpace(got.line) != "event: first" {
			t.Errorf("first chunk = %q", got.line)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the first chunk was buffered; streaming responses must be flushed immediately")
	}
}

func TestIsUpgrade(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		header http.Header
		want   bool
	}{
		{"plain request", http.Header{}, false},
		{"websocket", http.Header{"Connection": {"Upgrade"}, "Upgrade": {"websocket"}}, true},
		{"lowercase token", http.Header{"Connection": {"upgrade"}, "Upgrade": {"websocket"}}, true},
		{"token among others", http.Header{"Connection": {"keep-alive, Upgrade"}, "Upgrade": {"websocket"}}, true},
		{"connection without upgrade header", http.Header{"Connection": {"Upgrade"}}, false},
		{"upgrade header without connection token", http.Header{"Upgrade": {"websocket"}}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := IsUpgrade(tc.header); got != tc.want {
				t.Errorf("IsUpgrade(%v) = %v, want %v", tc.header, got, tc.want)
			}
		})
	}
}
