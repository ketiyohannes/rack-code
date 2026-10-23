package sidecar

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rack/tsnet-sidecar/internal/config"
	"github.com/rack/tsnet-sidecar/internal/proxy"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeTailnet stands in for a tsnet node. Its listeners are ordinary loopback
// listeners, so Run's real startup, serving and shutdown sequence is exercised
// end to end without a tailnet.
type fakeTailnet struct {
	startErr  error
	listenErr error
	resolver  proxy.IdentityResolver

	// usedTLS records which listen method Run called.
	usedTLS bool

	mu       sync.Mutex
	listener net.Listener
	closed   bool
	started  bool
}

func (f *fakeTailnet) Start(context.Context) (Status, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.started = true
	if f.startErr != nil {
		return Status{}, f.startErr
	}
	return Status{NodeName: "rack-daemon.tail.ts.net", IPs: []string{"100.64.0.1"}}, nil
}

func (f *fakeTailnet) Listen(network, _ string) (net.Listener, error) {
	if f.listenErr != nil {
		return nil, f.listenErr
	}
	// The configured tailnet port is ignored: inside the tailnet the node
	// has its own address space, and a test must not try to bind a fixed
	// port on the host.
	listener, err := net.Listen(network, "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	f.listener = listener
	f.mu.Unlock()
	return listener, nil
}

func (f *fakeTailnet) ListenTLS(network, addr string) (net.Listener, error) {
	f.usedTLS = true
	return f.Listen(network, addr)
}

func (f *fakeTailnet) IdentityResolver() proxy.IdentityResolver { return f.resolver }

func (f *fakeTailnet) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	return nil
}

func (f *fakeTailnet) addr() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listener == nil {
		return ""
	}
	return f.listener.Addr().String()
}

func (f *fakeTailnet) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

// stubResolver reports a fixed identity for every peer.
type stubResolver struct{}

func (stubResolver) Identify(context.Context, string) (proxy.Identity, error) {
	return proxy.Identity{LoginName: "alice@example.com"}, nil
}

// testConfig returns a valid configuration pointing at the given daemon.
func testConfig(t *testing.T, daemonURL string) config.Config {
	t.Helper()
	cfg, err := config.Loader{}.Load([]string{
		"-hostname", "rack-daemon",
		"-state-dir", "/var/lib/rack/tsnet",
		"-target", strings.TrimPrefix(daemonURL, "http://"),
		"-shutdown-timeout", "5s",
		// Identity resolution is covered separately; most cases only
		// care about the forwarding and lifetime behavior.
		"-identity-headers=false",
	})
	if err != nil {
		t.Fatalf("building the test configuration: %v", err)
	}
	return cfg
}

// waitForAddr waits until Run has opened its listener.
func waitForAddr(t *testing.T, tn *fakeTailnet) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if addr := tn.addr(); addr != "" {
			return addr
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the sidecar never opened a listener")
	return ""
}

func TestRunForwardsUntilContextIsCancelled(t *testing.T) {
	t.Parallel()

	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "daemon:"+r.URL.Path)
	}))
	defer daemon.Close()

	tn := &fakeTailnet{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- Run(ctx, testConfig(t, daemon.URL), tn, discardLogger()) }()

	addr := waitForAddr(t, tn)
	resp, err := http.Get("http://" + addr + "/rack/health")
	if err != nil {
		t.Fatalf("GET through the sidecar: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "daemon:/rack/health" {
		t.Errorf("body = %q, want the daemon's response", body)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v, want nil after a clean shutdown", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}

	if !tn.isClosed() {
		t.Error("the tailnet node was not closed")
	}
	if _, err := http.Get("http://" + addr + "/"); err == nil {
		t.Error("the listener still accepts connections after shutdown")
	}
}

// TestRunDrainsInFlightRequests asserts that cancellation starts a graceful
// drain rather than cutting active work: a request already being served must
// finish with its real response.
func TestRunDrainsInFlightRequests(t *testing.T) {
	t.Parallel()

	started := make(chan struct{})
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		time.Sleep(300 * time.Millisecond)
		io.WriteString(w, "finished")
	}))
	defer daemon.Close()

	tn := &fakeTailnet{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- Run(ctx, testConfig(t, daemon.URL), tn, discardLogger()) }()

	addr := waitForAddr(t, tn)

	type result struct {
		body string
		err  error
	}
	responses := make(chan result, 1)
	go func() {
		resp, err := http.Get("http://" + addr + "/slow")
		if err != nil {
			responses <- result{err: err}
			return
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		responses <- result{body: string(body), err: err}
	}()

	<-started
	cancel()

	select {
	case got := <-responses:
		if got.err != nil {
			t.Fatalf("the in-flight request failed during shutdown: %v", got.err)
		}
		if got.body != "finished" {
			t.Errorf("body = %q, want the completed response", got.body)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the in-flight request never completed")
	}

	if err := <-done; err != nil {
		t.Fatalf("Run returned %v, want nil", err)
	}
}

func TestRunReportsAFailureToJoinTheTailnet(t *testing.T) {
	t.Parallel()

	tn := &fakeTailnet{startErr: errors.New("invalid auth key")}
	err := Run(context.Background(), testConfig(t, "http://127.0.0.1:1"), tn, discardLogger())
	if err == nil {
		t.Fatal("Run succeeded although the node could not join the tailnet")
	}
	if !strings.Contains(err.Error(), "invalid auth key") {
		t.Errorf("error = %v, want the underlying cause to be reported", err)
	}
	if !tn.isClosed() {
		t.Error("the tailnet node was not closed after a failed start")
	}
}

func TestRunReportsAFailureToListen(t *testing.T) {
	t.Parallel()

	tn := &fakeTailnet{listenErr: errors.New("port already in use")}
	err := Run(context.Background(), testConfig(t, "http://127.0.0.1:1"), tn, discardLogger())
	if err == nil || !strings.Contains(err.Error(), "port already in use") {
		t.Fatalf("error = %v, want the listen failure to be reported", err)
	}
	if !tn.isClosed() {
		t.Error("the tailnet node was not closed after a failed listen")
	}
}

func TestRunUsesTheTLSListenerWhenConfigured(t *testing.T) {
	t.Parallel()

	daemon := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer daemon.Close()

	cfg := testConfig(t, daemon.URL)
	cfg.TLS = true

	tn := &fakeTailnet{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Run(ctx, cfg, tn, discardLogger()) }()

	waitForAddr(t, tn)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !tn.usedTLS {
		t.Error("TLS was configured but the plain listener was used")
	}
}

// TestRunRefusesIdentityHeadersWithoutAResolver covers the fail-loudly rule:
// the daemon must not be told to trust headers that will never arrive.
func TestRunRefusesIdentityHeadersWithoutAResolver(t *testing.T) {
	t.Parallel()

	cfg := testConfig(t, "http://127.0.0.1:1")
	cfg.IdentityHeaders = true

	tn := &fakeTailnet{resolver: nil}
	err := Run(context.Background(), cfg, tn, discardLogger())
	if err == nil || !strings.Contains(err.Error(), "identity") {
		t.Fatalf("error = %v, want a refusal mentioning identity resolution", err)
	}
	if !tn.isClosed() {
		t.Error("the tailnet node was not closed after the refusal")
	}
}

func TestRunForwardsTheResolvedIdentity(t *testing.T) {
	t.Parallel()

	identities := make(chan string, 1)
	daemon := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case identities <- r.Header.Get(proxy.HeaderTailnetUser):
		default:
		}
	}))
	defer daemon.Close()

	cfg := testConfig(t, daemon.URL)
	cfg.IdentityHeaders = true

	tn := &fakeTailnet{resolver: stubResolver{}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Run(ctx, cfg, tn, discardLogger()) }()

	addr := waitForAddr(t, tn)
	resp, err := http.Get("http://" + addr + "/")
	if err != nil {
		t.Fatalf("GET through the sidecar: %v", err)
	}
	resp.Body.Close()

	select {
	case got := <-identities:
		if got != "alice@example.com" {
			t.Errorf("%s = %q, want the resolved identity", proxy.HeaderTailnetUser, got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the daemon never received a request")
	}

	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestRunRejectsMissingDependencies(t *testing.T) {
	t.Parallel()

	if err := Run(context.Background(), config.Config{}, nil, discardLogger()); err == nil {
		t.Error("Run accepted a nil Tailnet")
	}
	if err := Run(context.Background(), config.Config{}, &fakeTailnet{}, nil); err == nil {
		t.Error("Run accepted a nil logger")
	}
}
