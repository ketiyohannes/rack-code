// Package sidecar wires the configuration, the tailnet node and the forwarding
// handler into one supervised process lifetime.
//
// The tailnet is an interface rather than a concrete tsnet.Server so that the
// whole startup, serving and shutdown sequence can be tested over an ordinary
// loopback listener. internal/tailnet holds the only implementation that talks
// to Tailscale.
package sidecar

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/rack/tsnet-sidecar/internal/config"
	"github.com/rack/tsnet-sidecar/internal/proxy"
)

// Status describes the node once it has joined the tailnet.
type Status struct {
	// NodeName is the node's MagicDNS name, which may differ from the
	// requested hostname when the control plane had to disambiguate it.
	NodeName string

	// IPs are the node's tailnet addresses, for logging and diagnosis.
	IPs []string
}

// Tailnet is the subset of a tsnet node that the sidecar needs.
//
// Start must block until the node is usable or the attempt fails; returning
// early would make the first inbound connection fail for a reason that is hard
// to attribute. Close must be safe to call exactly once, after Start has
// returned either way.
type Tailnet interface {
	Start(ctx context.Context) (Status, error)
	Listen(network, addr string) (net.Listener, error)
	ListenTLS(network, addr string) (net.Listener, error)

	// IdentityResolver returns the resolver used to attribute inbound
	// connections to tailnet peers, or nil when the implementation cannot
	// provide one.
	IdentityResolver() proxy.IdentityResolver

	Close() error
}

// ReadHeaderTimeout bounds how long a peer may take to send request headers.
// It is the only inbound deadline the server sets; see Run for why.
const ReadHeaderTimeout = 20 * time.Second

// IdleTimeout bounds how long an idle keep-alive connection is retained.
const IdleTimeout = 2 * time.Minute

// Run joins the tailnet, serves until ctx is cancelled, then shuts down.
//
// It returns nil after a clean shutdown and an error for any failure that
// prevented or interrupted serving. The tailnet node is always closed before
// Run returns, including on the error paths, so the caller can exit
// immediately afterwards.
func Run(ctx context.Context, cfg config.Config, tn Tailnet, logger *slog.Logger) (err error) {
	if tn == nil {
		return errors.New("sidecar: a Tailnet implementation is required")
	}
	if logger == nil {
		return errors.New("sidecar: a logger is required")
	}

	// Closing the node tears down the userspace network stack, which also
	// terminates any upgraded connection that outlived the HTTP shutdown
	// below. It is deferred so that every return path releases it.
	defer func() {
		if closeErr := tn.Close(); closeErr != nil {
			logger.LogAttrs(context.Background(), slog.LevelWarn, "closing the tailnet node failed",
				slog.String("error", closeErr.Error()))
			if err == nil {
				err = fmt.Errorf("closing tailnet node: %w", closeErr)
			}
		}
	}()

	logger.LogAttrs(ctx, slog.LevelInfo, "joining tailnet", slog.String("hostname", cfg.Hostname))
	status, err := tn.Start(ctx)
	if err != nil {
		return fmt.Errorf("joining tailnet as %q: %w", cfg.Hostname, err)
	}
	logger.LogAttrs(ctx, slog.LevelInfo, "tailnet node ready",
		slog.String("node_name", status.NodeName),
		slog.Any("tailnet_ips", status.IPs),
	)

	listener, err := listen(cfg, tn)
	if err != nil {
		return err
	}

	var resolver proxy.IdentityResolver
	if cfg.IdentityHeaders {
		resolver = tn.IdentityResolver()
		if resolver == nil {
			// Fail loudly: the operator asked the daemon to trust the
			// identity headers, and silently omitting them would turn
			// an authorization signal into a missing one.
			listener.Close()
			return errors.New("identity headers are enabled but this tailnet node cannot resolve peer identities; pass -identity-headers=false to forward requests without them")
		}
	}

	handler, err := proxy.New(proxy.Options{
		Target:   cfg.TargetURL(),
		Logger:   logger,
		Identity: resolver,
	})
	if err != nil {
		listener.Close()
		return fmt.Errorf("building the forwarding handler: %w", err)
	}

	// upgraded counts connections that were hijacked for a protocol switch.
	// net/http does not track them after the hijack, so they are reported at
	// shutdown to explain why the process may still have live sockets.
	var upgraded atomic.Int64

	server := &http.Server{
		Handler: handler,

		// Only ReadHeaderTimeout and IdleTimeout are set. ReadTimeout and
		// WriteTimeout apply to the whole request and response, so any
		// value would eventually sever a healthy WebSocket session or a
		// long-running event stream, which is exactly the traffic this
		// sidecar exists to carry.
		ReadHeaderTimeout: ReadHeaderTimeout,
		IdleTimeout:       IdleTimeout,

		ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelWarn),

		ConnState: func(_ net.Conn, state http.ConnState) {
			if state == http.StateHijacked {
				upgraded.Add(1)
			}
		},

		// Requests inherit a context that is independent of ctx: the
		// graceful shutdown below is what ends them, so that in-flight
		// work is drained rather than cancelled at the first signal.
		BaseContext: func(net.Listener) context.Context { return context.Background() },
	}

	serveErr := make(chan error, 1)
	go func() {
		logger.LogAttrs(ctx, slog.LevelInfo, "forwarding tailnet traffic to the daemon",
			slog.String("listen", listener.Addr().String()),
			slog.Bool("tls", cfg.TLS),
			slog.String("target", cfg.Target),
			slog.Bool("identity_headers", resolver != nil),
		)
		serveErr <- server.Serve(listener)
	}()

	select {
	case err := <-serveErr:
		// Serve returned on its own, which is always a failure here:
		// nothing closes the listener except the shutdown path below.
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serving tailnet traffic: %w", err)

	case <-ctx.Done():
		logger.LogAttrs(context.Background(), slog.LevelInfo, "shutting down",
			slog.Duration("timeout", cfg.ShutdownTimeout),
			slog.Int64("upgraded_connections", upgraded.Load()),
		)
		return shutdown(server, cfg.ShutdownTimeout, serveErr, logger)
	}
}

// listen opens the tailnet listener described by the configuration.
func listen(cfg config.Config, tn Tailnet) (net.Listener, error) {
	addr := cfg.ListenAddr()
	if cfg.TLS {
		// ListenTLS needs a Tailscale-issued certificate for the node's
		// MagicDNS name, which requires HTTPS certificates to be enabled
		// for the tailnet. The error is returned verbatim because its
		// wording is the operator's best clue.
		listener, err := tn.ListenTLS("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("listening on %s with TLS (HTTPS certificates must be enabled for this tailnet): %w", addr, err)
		}
		return listener, nil
	}
	listener, err := tn.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listening on %s: %w", addr, err)
	}
	return listener, nil
}

// shutdown drains the server within the configured budget.
//
// Shutdown stops accepting, finishes in-flight requests and closes idle
// connections. It does not touch hijacked connections: once a WebSocket
// handshake has completed, net/http no longer owns that socket. The deadline is
// therefore enforced by falling back to Close, after which the caller's
// deferred Tailnet.Close removes the network stack those sockets live on.
func shutdown(server *http.Server, timeout time.Duration, serveErr <-chan error, logger *slog.Logger) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	err := server.Shutdown(ctx)
	if err != nil {
		logger.LogAttrs(context.Background(), slog.LevelWarn, "graceful shutdown timed out, closing connections",
			slog.String("error", err.Error()))
		if closeErr := server.Close(); closeErr != nil {
			logger.LogAttrs(context.Background(), slog.LevelWarn, "closing the server failed",
				slog.String("error", closeErr.Error()))
		}
	}

	// Serve always returns once the server is closed; waiting for it keeps
	// the goroutine from outliving Run.
	if serveResult := <-serveErr; serveResult != nil && !errors.Is(serveResult, http.ErrServerClosed) {
		return fmt.Errorf("serving tailnet traffic: %w", serveResult)
	}

	// A drain that ran out of time is reported, because in-flight work was
	// cut short and the operator should know.
	if err != nil {
		return fmt.Errorf("draining in-flight requests: %w", err)
	}
	logger.LogAttrs(context.Background(), slog.LevelInfo, "shutdown complete")
	return nil
}
