// Package proxy builds the HTTP handler that forwards inbound tailnet requests
// to the local Rack daemon.
//
// It knows nothing about Tailscale. Everything tailnet-specific is injected as
// an IdentityResolver, which keeps the forwarding rules testable against an
// ordinary loopback backend: the tests in this package exercise the real
// handler, including a real WebSocket upgrade, with no tailnet in sight.
package proxy

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// Headers carrying the authenticated tailnet peer identity to the daemon.
//
// The sidecar performs no authorization of its own: it forwards everything the
// tailnet delivers, and the tailnet's ACLs decide who may reach the node at
// all. These headers let the daemon make a finer-grained decision (for example
// accepting only its owner, or only nodes carrying a specific tag) without
// implementing Tailscale-specific logic itself.
const (
	HeaderTailnetUser = "Rack-Tailnet-User"
	HeaderTailnetNode = "Rack-Tailnet-Node"
	HeaderTailnetTags = "Rack-Tailnet-Tags"
)

// identityHeaders lists every header whose value is asserted by the sidecar.
// They are removed from each inbound request before anything else happens, so
// a peer cannot impersonate another user by sending them itself.
var identityHeaders = []string{HeaderTailnetUser, HeaderTailnetNode, HeaderTailnetTags}

// Identity is the authenticated tailnet peer behind a request.
type Identity struct {
	// LoginName is the owning user, for example "alice@example.com". For a
	// tagged node the control plane reports a synthetic owner rather than a
	// human, so Tags is the meaningful field there.
	LoginName string

	// NodeName is the peer's MagicDNS name.
	NodeName string

	// Tags are the peer's ACL tags, each including the "tag:" prefix.
	Tags []string
}

// IdentityResolver maps a connection's remote address onto the tailnet peer
// that owns it. The tailnet package implements it with Tailscale's WhoIs API;
// tests implement it with a stub.
type IdentityResolver interface {
	// Identify resolves a "host:port" remote address. Implementations must
	// return an error rather than an empty Identity when the peer cannot be
	// established, so that the caller can refuse the request instead of
	// forwarding it as anonymous.
	Identify(ctx context.Context, remoteAddr string) (Identity, error)
}

// Options configures New.
type Options struct {
	// Target is the daemon's base URL, normally http://127.0.0.1:<port>.
	Target *url.URL

	// Logger receives proxy-level events. Required.
	Logger *slog.Logger

	// Identity resolves the tailnet peer for each request. When nil, the
	// identity headers are stripped but not set, and the daemon sees every
	// request as coming from an unidentified tailnet peer.
	Identity IdentityResolver

	// Transport overrides the outbound transport. Leave it nil outside
	// tests; the default is built by DefaultTransport below.
	Transport http.RoundTripper

	// IdentityTimeout bounds the identity lookup, which talks to the local
	// tailscaled state machine. Zero means DefaultIdentityTimeout.
	IdentityTimeout time.Duration
}

// DefaultIdentityTimeout bounds a WhoIs lookup. The call is local and normally
// answered from memory; a timeout only matters if the node is still starting.
const DefaultIdentityTimeout = 5 * time.Second

// DefaultTransport returns the transport used to reach the daemon.
//
// Two settings matter and are therefore explicit:
//
//   - ForceAttemptHTTP2 is false. HTTP/2 has no equivalent of the RFC 6455
//     Upgrade mechanism, so a transport that negotiated h2c with the daemon
//     would make every WebSocket handshake fail. The hop is a single loopback
//     connection, so HTTP/1.1 costs nothing here.
//   - No ResponseHeaderTimeout is set. Agent runs stream for minutes over one
//     response, and a header timeout plus FlushInterval -1 would be the only
//     deadlines on that path; killing a slow-but-healthy stream is worse than
//     waiting for the daemon.
func DefaultTransport() *http.Transport {
	return &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:   false,
		MaxIdleConns:        64,
		MaxIdleConnsPerHost: 64,
		IdleConnTimeout:     90 * time.Second,
	}
}

// New builds the forwarding handler.
//
// Request handling, in order:
//
//  1. Strip the identity headers, so they can only ever carry a value the
//     sidecar itself asserted.
//  2. Resolve the tailnet peer. A resolution failure is answered with 502
//     rather than forwarded without identity: a daemon configured to trust the
//     headers must not silently receive an anonymous request.
//  3. Hand the request to httputil.ReverseProxy, which rewrites the URL, adds
//     the X-Forwarded-* headers, and transparently handles both plain HTTP and
//     protocol upgrades.
func New(opts Options) (http.Handler, error) {
	if opts.Target == nil {
		return nil, errors.New("proxy: Target is required")
	}
	if opts.Target.Scheme == "" || opts.Target.Host == "" {
		return nil, fmt.Errorf("proxy: Target must be an absolute URL, got %q", opts.Target.String())
	}
	if opts.Logger == nil {
		return nil, errors.New("proxy: Logger is required")
	}

	transport := opts.Transport
	if transport == nil {
		transport = DefaultTransport()
	}
	identityTimeout := opts.IdentityTimeout
	if identityTimeout <= 0 {
		identityTimeout = DefaultIdentityTimeout
	}
	target := opts.Target
	logger := opts.Logger

	reverse := &httputil.ReverseProxy{
		// Rewrite (rather than the legacy Director) is used because it
		// keeps the inbound request available as r.In while the outbound
		// request is a clone, and because SetXForwarded applies Go's
		// current, non-spoofable X-Forwarded-* rules.
		Rewrite: func(r *httputil.ProxyRequest) {
			// SetXForwarded must come first: it overwrites
			// X-Forwarded-For/Host/Proto using the inbound request,
			// discarding whatever the peer claimed.
			r.SetXForwarded()
			// SetURL points the outbound request at the daemon and
			// clears Host, so the daemon sees the loopback address
			// as its Host header. The original value stays available
			// as X-Forwarded-Host, which is what the daemon must use
			// for any origin or host check.
			r.SetURL(target)
		},
		Transport: transport,

		// -1 flushes every write immediately. The daemon streams run
		// events as they happen; any buffering here would batch them into
		// visible latency in the controller UI.
		FlushInterval: -1,

		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// A client that disconnects mid-stream is normal, not an
			// error worth alerting on.
			level := slog.LevelError
			if errors.Is(err, context.Canceled) {
				level = slog.LevelDebug
			}
			logger.LogAttrs(r.Context(), level, "forwarding failed",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.String("target", target.Host),
				slog.String("error", err.Error()),
			)
			// 502 is the honest status: the sidecar is reachable, the
			// daemon behind it is not.
			http.Error(w, "rack daemon unreachable", http.StatusBadGateway)
		},

		// ReverseProxy logs some conditions (such as a failed upgrade
		// copy) through a standard logger; route them into slog so the
		// process emits one log format.
		ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, name := range identityHeaders {
			r.Header.Del(name)
		}

		if opts.Identity != nil {
			ctx, cancel := context.WithTimeout(r.Context(), identityTimeout)
			identity, err := opts.Identity.Identify(ctx, r.RemoteAddr)
			cancel()
			if err != nil {
				logger.LogAttrs(r.Context(), slog.LevelWarn, "rejecting request with unresolvable tailnet identity",
					slog.String("remote_addr", r.RemoteAddr),
					slog.String("error", err.Error()),
				)
				http.Error(w, "tailnet identity unavailable", http.StatusBadGateway)
				return
			}
			setIdentityHeaders(r.Header, identity)
		}

		logger.LogAttrs(r.Context(), slog.LevelDebug, "forwarding request",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Bool("upgrade", IsUpgrade(r.Header)),
			slog.String("remote_addr", r.RemoteAddr),
		)

		reverse.ServeHTTP(w, r)
	})

	return handler, nil
}

// setIdentityHeaders writes the resolved identity onto the request. Empty
// fields are left unset rather than written as empty strings, so the daemon can
// treat "header present" as "identity established".
func setIdentityHeaders(header http.Header, identity Identity) {
	if identity.LoginName != "" {
		header.Set(HeaderTailnetUser, identity.LoginName)
	}
	if identity.NodeName != "" {
		header.Set(HeaderTailnetNode, identity.NodeName)
	}
	if len(identity.Tags) > 0 {
		header.Set(HeaderTailnetTags, strings.Join(identity.Tags, ","))
	}
}

// IsUpgrade reports whether a request asks for a protocol switch, such as a
// WebSocket handshake.
//
// The forwarding itself does not depend on this function: net/http's
// ReverseProxy detects upgrades on its own, preserves the Connection and
// Upgrade headers across its hop-by-hop header removal, and takes over both
// connections when the daemon answers 101. It exists so the log line can say
// which requests are long-lived, which matters when reading a shutdown trace.
func IsUpgrade(header http.Header) bool {
	for _, value := range header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
				return header.Get("Upgrade") != ""
			}
		}
	}
	return false
}
