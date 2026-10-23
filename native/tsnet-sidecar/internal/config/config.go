// Package config owns the sidecar's configuration surface: the command-line
// flags, the environment variables that back them, and the validation rules
// that must hold before the process touches the network.
//
// The package deliberately depends on nothing but the standard library and
// takes its environment and filesystem access as injected functions, so the
// whole surface can be unit tested without a tailnet, without a daemon and
// without mutating the real process environment.
package config

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Environment variable names. Every flag can also be supplied through the
// environment, because the sidecar normally runs as a systemd service inside a
// VM image (see infra/images) where an EnvironmentFile is more convenient than
// a long command line.
const (
	EnvHostname          = "TSNET_SIDECAR_HOSTNAME"
	EnvStateDir          = "TSNET_SIDECAR_STATE_DIR"
	EnvTarget            = "TSNET_SIDECAR_TARGET"
	EnvAllowRemoteTarget = "TSNET_SIDECAR_ALLOW_REMOTE_TARGET"
	EnvListenPort        = "TSNET_SIDECAR_LISTEN_PORT"
	EnvTLS               = "TSNET_SIDECAR_TLS"
	EnvControlURL        = "TSNET_SIDECAR_CONTROL_URL"
	EnvEphemeral         = "TSNET_SIDECAR_EPHEMERAL"
	EnvTags              = "TSNET_SIDECAR_TAGS"
	EnvShutdownTimeout   = "TSNET_SIDECAR_SHUTDOWN_TIMEOUT"
	EnvLogLevel          = "TSNET_SIDECAR_LOG_LEVEL"
	EnvLogFormat         = "TSNET_SIDECAR_LOG_FORMAT"
	EnvIdentityHeaders   = "TSNET_SIDECAR_IDENTITY_HEADERS"

	// EnvAuthKey and EnvAuthKeyFile carry the tailnet auth key. There is
	// deliberately no corresponding flag: flags are visible in `ps` output
	// and in shell history.
	EnvAuthKey     = "TSNET_SIDECAR_AUTHKEY"
	EnvAuthKeyFile = "TSNET_SIDECAR_AUTHKEY_FILE"

	// EnvAuthKeyFallback is Tailscale's own conventional variable name. It is
	// accepted so that an operator who already exports TS_AUTHKEY for other
	// Tailscale tooling does not have to duplicate it, but the sidecar-specific
	// name wins when both are present.
	EnvAuthKeyFallback = "TS_AUTHKEY"
)

// Defaults that are safe to choose on the operator's behalf. The hostname,
// state directory and daemon address have no defaults on purpose: guessing any
// of them would either collide with another node, silently lose node identity
// across restarts, or forward traffic to whatever happens to listen on a port.
const (
	DefaultListenPort      = 80
	DefaultShutdownTimeout = 20 * time.Second
	DefaultLogLevel        = "info"
	DefaultLogFormat       = "json"
)

// Config is the validated configuration of one sidecar process.
//
// AuthKey is intentionally part of this struct rather than a separate return
// value so that it travels with the rest of the configuration; its Secret type
// keeps it out of logs. Config itself has no String method, because every
// field other than AuthKey is safe to print and AuthKey redacts itself.
type Config struct {
	// Hostname is the name the node claims on the tailnet. MagicDNS exposes
	// the daemon as https://<hostname>.<tailnet>.ts.net.
	Hostname string

	// StateDir holds the tsnet node identity (tailscaled.state) plus its
	// logs and certificate cache. Losing it means the node has to
	// re-authenticate and appears in the admin console as a new machine, so
	// it must be on persistent storage.
	StateDir string

	// Target is the host:port of the local Rack daemon's HTTP/WebSocket
	// listener. It is required rather than defaulted because the daemon's
	// port is owned by apps/daemon and is not fixed yet.
	Target string

	// AllowRemoteTarget permits a non-loopback target. The sidecar performs
	// no authentication of its own: everything that reaches the tailnet
	// listener is forwarded. Forwarding to a non-loopback address therefore
	// turns the sidecar into an open relay towards that address, so it has
	// to be requested explicitly.
	AllowRemoteTarget bool

	// ListenPort is the TCP port the node listens on inside the tailnet.
	// This port exists only in the tailnet address space; it does not bind
	// any port on the host's own interfaces.
	ListenPort int

	// TLS serves HTTPS using a Tailscale-issued MagicDNS certificate
	// instead of plain HTTP. Tailnet traffic is already encrypted by
	// WireGuard, but browsers only grant secure-context features (and
	// accept secure WebSockets from an HTTPS page) over TLS, so a
	// browser-based controller such as apps/web needs this.
	//
	// It requires HTTPS certificates to be enabled for the tailnet; when
	// they are not, obtaining the certificate fails loudly at startup.
	TLS bool

	// ControlURL optionally points at a non-Tailscale coordination server
	// (for example a self-hosted Headscale). Empty means Tailscale's.
	ControlURL string

	// Ephemeral registers an ephemeral node that the control plane removes
	// shortly after it disconnects. This suits disposable project VMs; it is
	// wrong for a long-lived workstation daemon, whose node should persist.
	Ephemeral bool

	// Tags are ACL tags (each "tag:something") to advertise at registration.
	// Tagged nodes are owned by the tailnet rather than by a user, which is
	// what lets an unattended daemon avoid key expiry.
	Tags []string

	// ShutdownTimeout bounds the graceful drain on SIGINT/SIGTERM.
	ShutdownTimeout time.Duration

	// LogLevel and LogFormat configure structured logging.
	LogLevel  slog.Level
	LogFormat string

	// IdentityHeaders adds the authenticated tailnet peer identity to each
	// forwarded request. The daemon can use it for authorization; see the
	// proxy package for the exact headers and the anti-spoofing rule.
	IdentityHeaders bool

	// AuthKey is the tailnet auth key used the first time this node
	// registers. It may be empty when StateDir already holds a registered
	// node identity.
	AuthKey Secret
}

// TargetURL returns the base URL that requests are forwarded to.
//
// The hop between the sidecar and the daemon is plain HTTP over loopback: it
// never leaves the machine, and adding TLS there would mean managing a second
// certificate for no gain in confidentiality.
func (c Config) TargetURL() *url.URL {
	return &url.URL{Scheme: "http", Host: c.Target}
}

// ListenAddr is the address passed to the tailnet listener.
func (c Config) ListenAddr() string {
	return ":" + strconv.Itoa(c.ListenPort)
}

// LogAttrs returns the configuration as structured log attributes. The auth key
// is excluded entirely rather than redacted, so that no code path can turn it
// back into a string by accident.
func (c Config) LogAttrs() []slog.Attr {
	return []slog.Attr{
		slog.String("hostname", c.Hostname),
		slog.String("state_dir", c.StateDir),
		slog.String("target", c.Target),
		slog.Bool("allow_remote_target", c.AllowRemoteTarget),
		slog.Int("listen_port", c.ListenPort),
		slog.Bool("tls", c.TLS),
		slog.String("control_url", c.ControlURL),
		slog.Bool("ephemeral", c.Ephemeral),
		slog.String("tags", strings.Join(c.Tags, ",")),
		slog.Duration("shutdown_timeout", c.ShutdownTimeout),
		slog.Bool("identity_headers", c.IdentityHeaders),
		slog.Bool("auth_key_supplied", c.AuthKey.IsSet()),
	}
}

// LookupEnvFunc matches os.LookupEnv.
type LookupEnvFunc func(string) (string, bool)

// ReadFileFunc matches os.ReadFile.
type ReadFileFunc func(string) ([]byte, error)

// Loader turns command-line arguments and the environment into a Config.
//
// Both external dependencies are injected so tests can exercise the real
// parsing and validation rules without touching the process environment or the
// filesystem.
type Loader struct {
	LookupEnv LookupEnvFunc
	ReadFile  ReadFileFunc

	// Output receives flag parsing errors and the usage text. nil means
	// io.Discard, which keeps test output clean.
	Output io.Writer
}

// Load parses args (without the program name) and returns a validated Config.
//
// It returns flag.ErrHelp when the user asked for usage, which the caller
// should treat as a successful exit rather than a failure.
func (l Loader) Load(args []string) (Config, error) {
	lookup := l.LookupEnv
	if lookup == nil {
		lookup = func(string) (string, bool) { return "", false }
	}
	out := l.Output
	if out == nil {
		out = io.Discard
	}

	// Environment parsing errors are collected rather than returned
	// immediately, so that one run reports every malformed value instead of
	// making the operator fix them one at a time.
	var envErrs []error
	envString := func(name, fallback string) string {
		if v, ok := lookup(name); ok {
			return v
		}
		return fallback
	}
	envBool := func(name string, fallback bool) bool {
		v, ok := lookup(name)
		if !ok || v == "" {
			return fallback
		}
		parsed, err := strconv.ParseBool(v)
		if err != nil {
			envErrs = append(envErrs, fmt.Errorf("%s: %q is not a boolean", name, v))
			return fallback
		}
		return parsed
	}
	envInt := func(name string, fallback int) int {
		v, ok := lookup(name)
		if !ok || v == "" {
			return fallback
		}
		parsed, err := strconv.Atoi(v)
		if err != nil {
			envErrs = append(envErrs, fmt.Errorf("%s: %q is not an integer", name, v))
			return fallback
		}
		return parsed
	}
	envDuration := func(name string, fallback time.Duration) time.Duration {
		v, ok := lookup(name)
		if !ok || v == "" {
			return fallback
		}
		parsed, err := time.ParseDuration(v)
		if err != nil {
			envErrs = append(envErrs, fmt.Errorf("%s: %q is not a duration such as 20s", name, v))
			return fallback
		}
		return parsed
	}

	fs := flag.NewFlagSet("tsnet-sidecar", flag.ContinueOnError)
	fs.SetOutput(out)
	fs.Usage = func() {
		fmt.Fprint(out, usage)
		fs.PrintDefaults()
		fmt.Fprint(out, authKeyUsage)
	}

	// Each flag defaults to its environment variable, so an explicit flag
	// always wins over the environment and `-h` shows the effective default.
	hostname := fs.String("hostname", envString(EnvHostname, ""), "Tailnet node name for this daemon (required; env "+EnvHostname+")")
	stateDir := fs.String("state-dir", envString(EnvStateDir, ""), "Absolute directory for persistent tsnet node state (required; env "+EnvStateDir+")")
	target := fs.String("target", envString(EnvTarget, ""), "host:port of the local Rack daemon listener (required; env "+EnvTarget+")")
	allowRemote := fs.Bool("allow-remote-target", envBool(EnvAllowRemoteTarget, false), "Permit a non-loopback -target; the sidecar does not authenticate requests (env "+EnvAllowRemoteTarget+")")
	listenPort := fs.Int("listen-port", envInt(EnvListenPort, DefaultListenPort), "TCP port to listen on inside the tailnet (env "+EnvListenPort+")")
	useTLS := fs.Bool("tls", envBool(EnvTLS, false), "Serve HTTPS with a Tailscale MagicDNS certificate; requires HTTPS certificates enabled for the tailnet (env "+EnvTLS+")")
	controlURL := fs.String("control-url", envString(EnvControlURL, ""), "Coordination server URL; empty means Tailscale's (env "+EnvControlURL+")")
	ephemeral := fs.Bool("ephemeral", envBool(EnvEphemeral, false), "Register as an ephemeral node, removed by the control plane after disconnect (env "+EnvEphemeral+")")
	tags := fs.String("tags", envString(EnvTags, ""), "Comma-separated ACL tags to advertise, each starting with tag: (env "+EnvTags+")")
	shutdownTimeout := fs.Duration("shutdown-timeout", envDuration(EnvShutdownTimeout, DefaultShutdownTimeout), "Maximum time to drain in-flight requests on SIGINT/SIGTERM (env "+EnvShutdownTimeout+")")
	logLevel := fs.String("log-level", envString(EnvLogLevel, DefaultLogLevel), "debug, info, warn or error (env "+EnvLogLevel+")")
	logFormat := fs.String("log-format", envString(EnvLogFormat, DefaultLogFormat), "json or text (env "+EnvLogFormat+")")
	identityHeaders := fs.Bool("identity-headers", envBool(EnvIdentityHeaders, true), "Forward the authenticated tailnet peer identity to the daemon (env "+EnvIdentityHeaders+")")

	if err := fs.Parse(args); err != nil {
		// flag.ErrHelp is passed through unwrapped so the caller can
		// distinguish "the user asked for help" from a real failure.
		return Config{}, err
	}
	if extra := fs.Args(); len(extra) > 0 {
		return Config{}, fmt.Errorf("unexpected positional arguments: %s", strings.Join(extra, " "))
	}

	authKey, err := l.authKey(lookup)
	if err != nil {
		envErrs = append(envErrs, err)
	}

	level, err := parseLevel(*logLevel)
	if err != nil {
		envErrs = append(envErrs, err)
	}

	cfg := Config{
		Hostname:          strings.TrimSpace(*hostname),
		StateDir:          strings.TrimSpace(*stateDir),
		Target:            strings.TrimSpace(*target),
		AllowRemoteTarget: *allowRemote,
		ListenPort:        *listenPort,
		TLS:               *useTLS,
		ControlURL:        strings.TrimSpace(*controlURL),
		Ephemeral:         *ephemeral,
		Tags:              splitTags(*tags),
		ShutdownTimeout:   *shutdownTimeout,
		LogLevel:          level,
		LogFormat:         strings.ToLower(strings.TrimSpace(*logFormat)),
		IdentityHeaders:   *identityHeaders,
		AuthKey:           authKey,
	}

	if err := cfg.Validate(); err != nil {
		envErrs = append(envErrs, err)
	}
	return cfg, errors.Join(envErrs...)
}

// authKey resolves the tailnet auth key from the environment.
//
// Precedence, most specific first: the sidecar's own variable, the file
// variant (which keeps the key out of the process environment, where systemd's
// LoadCredential or a mounted config disk can supply it), then Tailscale's
// conventional TS_AUTHKEY. An empty value is not an error here: a node whose
// state directory already holds an identity does not need a key, and the
// decision is made in the tailnet package where the state directory is known.
func (l Loader) authKey(lookup LookupEnvFunc) (Secret, error) {
	if v, ok := lookup(EnvAuthKey); ok && v != "" {
		return Secret(v), nil
	}
	if path, ok := lookup(EnvAuthKeyFile); ok && path != "" {
		read := l.ReadFile
		if read == nil {
			return "", fmt.Errorf("%s is set but this build cannot read files", EnvAuthKeyFile)
		}
		data, err := read(path)
		if err != nil {
			// The path is safe to report; the contents never are.
			return "", fmt.Errorf("%s: reading %s: %w", EnvAuthKeyFile, path, err)
		}
		key := strings.TrimSpace(string(data))
		if key == "" {
			return "", fmt.Errorf("%s: %s is empty", EnvAuthKeyFile, path)
		}
		return Secret(key), nil
	}
	if v, ok := lookup(EnvAuthKeyFallback); ok && v != "" {
		return Secret(v), nil
	}
	return "", nil
}

// Validate reports every configuration problem at once.
func (c Config) Validate() error {
	var errs []error

	if c.Hostname == "" {
		errs = append(errs, fmt.Errorf("-hostname is required (env %s)", EnvHostname))
	} else if err := validateHostname(c.Hostname); err != nil {
		errs = append(errs, err)
	}

	switch {
	case c.StateDir == "":
		errs = append(errs, fmt.Errorf("-state-dir is required (env %s); it holds the node identity and must survive restarts", EnvStateDir))
	case !filepath.IsAbs(c.StateDir):
		// A relative path would resolve against the service's working
		// directory, which differs between a shell and systemd.
		errs = append(errs, fmt.Errorf("-state-dir must be an absolute path, got %q", c.StateDir))
	}

	if c.Target == "" {
		errs = append(errs, fmt.Errorf("-target is required (env %s), for example 127.0.0.1:7357", EnvTarget))
	} else if err := c.validateTarget(); err != nil {
		errs = append(errs, err)
	}

	if c.ListenPort < 1 || c.ListenPort > 65535 {
		errs = append(errs, fmt.Errorf("-listen-port must be between 1 and 65535, got %d", c.ListenPort))
	}
	if c.ShutdownTimeout <= 0 {
		errs = append(errs, fmt.Errorf("-shutdown-timeout must be positive, got %s", c.ShutdownTimeout))
	}
	if c.LogFormat != "json" && c.LogFormat != "text" {
		errs = append(errs, fmt.Errorf("-log-format must be json or text, got %q", c.LogFormat))
	}
	if c.ControlURL != "" {
		if u, err := url.Parse(c.ControlURL); err != nil || u.Scheme == "" || u.Host == "" {
			errs = append(errs, fmt.Errorf("-control-url must be an absolute URL, got %q", c.ControlURL))
		}
	}
	for _, tag := range c.Tags {
		if !strings.HasPrefix(tag, "tag:") {
			errs = append(errs, fmt.Errorf("-tags entries must start with \"tag:\", got %q", tag))
		}
	}

	return errors.Join(errs...)
}

// validateTarget checks that the daemon address is well formed and, unless the
// operator opted out, on loopback.
func (c Config) validateTarget() error {
	host, port, err := net.SplitHostPort(c.Target)
	if err != nil {
		return fmt.Errorf("-target must be host:port, got %q: %w", c.Target, err)
	}
	if host == "" {
		return fmt.Errorf("-target must include a host, got %q", c.Target)
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return fmt.Errorf("-target port must be between 1 and 65535, got %q", port)
	}
	if c.AllowRemoteTarget {
		return nil
	}
	if isLoopbackHost(host) {
		return nil
	}
	return fmt.Errorf(
		"-target %q is not on loopback; the sidecar forwards every tailnet request without authenticating it, so pass -allow-remote-target to confirm this is intended",
		c.Target,
	)
}

// isLoopbackHost reports whether the host part of an address is certainly
// loopback. Only literal IPs and "localhost" qualify: a name that resolves to
// loopback today can resolve elsewhere later, and the check exists to make the
// operator's intent explicit rather than to be clever.
func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// validateHostname applies the DNS label rules that Tailscale's MagicDNS name
// must satisfy. Tailscale would otherwise silently rewrite the name, leaving
// the node reachable under an address the operator did not configure.
func validateHostname(name string) error {
	if len(name) > 63 {
		return fmt.Errorf("-hostname must be at most 63 characters, got %d", len(name))
	}
	if strings.HasPrefix(name, "-") || strings.HasSuffix(name, "-") {
		return fmt.Errorf("-hostname must not start or end with a hyphen, got %q", name)
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
		default:
			return fmt.Errorf("-hostname must contain only lowercase letters, digits and hyphens, got %q", name)
		}
	}
	return nil
}

// splitTags normalizes a comma-separated tag list, dropping empty entries so a
// trailing comma is not reported as an invalid tag.
func splitTags(raw string) []string {
	var tags []string
	for _, part := range strings.Split(raw, ",") {
		if t := strings.TrimSpace(part); t != "" {
			tags = append(tags, t)
		}
	}
	return tags
}

// parseLevel maps the log level name onto slog's levels.
func parseLevel(name string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "debug":
		return slog.LevelDebug, nil
	case "info", "":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return slog.LevelInfo, fmt.Errorf("-log-level must be debug, info, warn or error, got %q", name)
	}
}

const usage = `tsnet-sidecar joins a tailnet with tsnet and forwards inbound tailnet
traffic, including WebSocket upgrades, to a Rack daemon listening on loopback.

Usage: tsnet-sidecar [flags]

Flags:
`

const authKeyUsage = `
Environment only:
  ` + EnvAuthKey + `        Tailnet auth key, used on first registration.
  ` + EnvAuthKeyFile + `   Path to a file holding the auth key instead.
  ` + EnvAuthKeyFallback + `                   Fallback name, used if neither of the above is set.

The auth key is never accepted as a flag, because flags are visible in process
listings, and it is never written to the log.
`
