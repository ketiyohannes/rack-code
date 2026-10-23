// Package tailnet is the only place in this module that talks to Tailscale.
//
// It adapts tsnet.Server to the narrow sidecar.Tailnet interface, which keeps
// the forwarding and lifetime logic testable without a tailnet, and it holds
// the two Tailscale-specific safety rules: refusing to start when the node has
// neither an auth key nor a saved identity, and scrubbing anything that looks
// like an auth key out of the library's log output.
package tailnet

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"tailscale.com/tsnet"

	"github.com/rack/tsnet-sidecar/internal/config"
	"github.com/rack/tsnet-sidecar/internal/proxy"
	"github.com/rack/tsnet-sidecar/internal/sidecar"
)

// StateFileName is the file tsnet creates inside the state directory to hold
// the node's identity. Its presence is what lets the sidecar restart without
// an auth key.
const StateFileName = "tailscaled.state"

// StateDirMode keeps the node identity readable only by its owner. The file
// authenticates this node to the tailnet, so it is credential material.
const StateDirMode os.FileMode = 0o700

// Node is a tsnet node wired for the sidecar's use.
type Node struct {
	server *tsnet.Server
	logger *slog.Logger
}

// compile-time check that the adapter satisfies the interface Run expects.
var _ sidecar.Tailnet = (*Node)(nil)

// New prepares the state directory and builds the tsnet node.
//
// It does not contact the control plane; that happens in Start, so that the
// caller can set up signal handling first and so a registration failure is
// reported against a context it can cancel.
func New(cfg config.Config, logger *slog.Logger) (*Node, error) {
	if logger == nil {
		return nil, errors.New("tailnet: a logger is required")
	}

	if err := os.MkdirAll(cfg.StateDir, StateDirMode); err != nil {
		return nil, fmt.Errorf("preparing the state directory %s: %w", cfg.StateDir, err)
	}
	if err := VerifyIdentityAvailable(cfg.StateDir, cfg.AuthKey.IsSet()); err != nil {
		return nil, err
	}

	// scrub is applied to every line the library emits. tsnet is not
	// expected to print the auth key, but this process is given a
	// credential and writes logs that are usually shipped somewhere, so the
	// cost of a safety net is justified.
	scrub := newScrubber(cfg.AuthKey.Expose())

	server := &tsnet.Server{
		Hostname: cfg.Hostname,
		Dir:      cfg.StateDir,
		// AuthKey is only consulted when the state directory holds no
		// identity yet; later starts reuse the saved node key.
		AuthKey:       cfg.AuthKey.Expose(),
		Ephemeral:     cfg.Ephemeral,
		ControlURL:    cfg.ControlURL,
		AdvertiseTags: cfg.Tags,

		// Logf is tsnet's internal, high-volume log. It is useful when
		// diagnosing connectivity, so it is kept at debug level.
		Logf: func(format string, args ...any) {
			logger.Debug(scrub(fmt.Sprintf(format, args...)), slog.String("component", "tsnet"))
		},
		// UserLogf carries messages meant for a human operator, such as
		// the interactive login URL printed when no auth key is
		// available.
		UserLogf: func(format string, args ...any) {
			logger.Info(scrub(fmt.Sprintf(format, args...)), slog.String("component", "tsnet"))
		},
	}

	return &Node{server: server, logger: logger}, nil
}

// Start brings the node up and blocks until it has joined the tailnet.
//
// tsnet.Up performs registration (using the auth key on first run) and waits
// for the node to reach the running state, so a bad or expired key surfaces
// here rather than as a mysterious connection failure later.
func (n *Node) Start(ctx context.Context) (sidecar.Status, error) {
	status, err := n.server.Up(ctx)
	if err != nil {
		return sidecar.Status{}, err
	}

	result := sidecar.Status{}
	if status != nil {
		if status.Self != nil {
			// DNSName is an FQDN with a trailing dot; trim it so log
			// lines show the name an operator would type.
			result.NodeName = strings.TrimSuffix(status.Self.DNSName, ".")
		}
		for _, ip := range status.TailscaleIPs {
			result.IPs = append(result.IPs, ip.String())
		}
	}
	return result, nil
}

// Listen opens a plain listener inside the tailnet.
func (n *Node) Listen(network, addr string) (net.Listener, error) {
	return n.server.Listen(network, addr)
}

// ListenTLS opens a listener that terminates TLS with a Tailscale-issued
// certificate for this node's MagicDNS name. It requires HTTPS certificates to
// be enabled for the tailnet; otherwise the certificate request fails and the
// error is propagated rather than falling back to plaintext.
func (n *Node) ListenTLS(network, addr string) (net.Listener, error) {
	return n.server.ListenTLS(network, addr)
}

// IdentityResolver returns a resolver backed by Tailscale's WhoIs API.
func (n *Node) IdentityResolver() proxy.IdentityResolver {
	return &whoIs{server: n.server}
}

// Close shuts the node down and releases the userspace network stack.
func (n *Node) Close() error { return n.server.Close() }

// whoIs resolves a connection's remote address to the tailnet peer that owns
// it, using the node's own local API. The lookup is answered from the node's
// in-memory netmap, so it costs no network round trip.
type whoIs struct {
	server *tsnet.Server
}

// Identify implements proxy.IdentityResolver.
func (w *whoIs) Identify(ctx context.Context, remoteAddr string) (proxy.Identity, error) {
	client, err := w.server.LocalClient()
	if err != nil {
		return proxy.Identity{}, fmt.Errorf("tailnet local client: %w", err)
	}
	who, err := client.WhoIs(ctx, remoteAddr)
	if err != nil {
		return proxy.Identity{}, fmt.Errorf("whois %s: %w", remoteAddr, err)
	}

	identity := proxy.Identity{}
	if who.UserProfile != nil {
		identity.LoginName = who.UserProfile.LoginName
	}
	if who.Node != nil {
		identity.NodeName = strings.TrimSuffix(who.Node.Name, ".")
		identity.Tags = append(identity.Tags, who.Node.Tags...)
	}
	return identity, nil
}

// VerifyIdentityAvailable reports whether the node can authenticate at all.
//
// Without an auth key and without a saved identity, tsnet falls back to
// interactive login: it prints a URL and waits indefinitely for a human to
// visit it. For an unattended service that is indistinguishable from a hang,
// so the sidecar refuses to start instead.
func VerifyIdentityAvailable(stateDir string, hasAuthKey bool) error {
	if hasAuthKey {
		return nil
	}
	statePath := filepath.Join(stateDir, StateFileName)
	if _, err := os.Stat(statePath); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("checking the saved node identity at %s: %w", statePath, err)
	}
	return fmt.Errorf(
		"no tailnet auth key was supplied (%s, %s or %s) and %s holds no saved node identity; "+
			"the sidecar will not wait for an interactive login",
		config.EnvAuthKey, config.EnvAuthKeyFile, config.EnvAuthKeyFallback, stateDir,
	)
}

// authKeyPattern matches Tailscale key material by its documented prefixes.
// It is a defensive net for log output, not a validator.
var authKeyPattern = regexp.MustCompile(`tskey-[A-Za-z0-9-]+`)

// newScrubber returns a function that removes credential material from a log
// line: the exact configured key, plus anything shaped like a Tailscale key.
func newScrubber(authKey string) func(string) string {
	return func(line string) string {
		if authKey != "" {
			line = strings.ReplaceAll(line, authKey, config.Redacted)
		}
		return authKeyPattern.ReplaceAllString(line, config.Redacted)
	}
}
