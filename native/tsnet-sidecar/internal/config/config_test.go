package config

import (
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// envMap builds a LookupEnvFunc over a fixed map, so tests never mutate the
// real process environment and can run in parallel.
func envMap(values map[string]string) LookupEnvFunc {
	return func(name string) (string, bool) {
		v, ok := values[name]
		return v, ok
	}
}

// minimalArgs is the smallest valid command line: the three values that have
// no safe default.
func minimalArgs() []string {
	return []string{
		"-hostname", "rack-daemon",
		"-state-dir", "/var/lib/rack/tsnet",
		"-target", "127.0.0.1:7357",
	}
}

func TestLoadAppliesDocumentedDefaults(t *testing.T) {
	t.Parallel()

	cfg, err := Loader{LookupEnv: envMap(nil)}.Load(minimalArgs())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.ListenPort != DefaultListenPort {
		t.Errorf("ListenPort = %d, want %d", cfg.ListenPort, DefaultListenPort)
	}
	if cfg.ShutdownTimeout != DefaultShutdownTimeout {
		t.Errorf("ShutdownTimeout = %s, want %s", cfg.ShutdownTimeout, DefaultShutdownTimeout)
	}
	if cfg.LogLevel != slog.LevelInfo {
		t.Errorf("LogLevel = %s, want info", cfg.LogLevel)
	}
	if cfg.LogFormat != DefaultLogFormat {
		t.Errorf("LogFormat = %q, want %q", cfg.LogFormat, DefaultLogFormat)
	}
	if !cfg.IdentityHeaders {
		t.Error("IdentityHeaders = false, want true by default")
	}
	if cfg.TLS || cfg.Ephemeral || cfg.AllowRemoteTarget {
		t.Error("TLS, Ephemeral and AllowRemoteTarget must default to false")
	}
	if got, want := cfg.TargetURL().String(), "http://127.0.0.1:7357"; got != want {
		t.Errorf("TargetURL = %q, want %q", got, want)
	}
	if got, want := cfg.ListenAddr(), ":80"; got != want {
		t.Errorf("ListenAddr = %q, want %q", got, want)
	}
}

func TestLoadReadsEnvironmentAndFlagsWin(t *testing.T) {
	t.Parallel()

	env := envMap(map[string]string{
		EnvHostname:        "from-env",
		EnvStateDir:        "/var/lib/rack/tsnet",
		EnvTarget:          "127.0.0.1:7357",
		EnvListenPort:      "8443",
		EnvTLS:             "true",
		EnvEphemeral:       "1",
		EnvTags:            "tag:rack-daemon, tag:project-vm,",
		EnvShutdownTimeout: "5s",
		EnvLogLevel:        "debug",
		EnvLogFormat:       "text",
		EnvIdentityHeaders: "false",
		EnvControlURL:      "https://headscale.example.com",
	})

	cfg, err := Loader{LookupEnv: env}.Load([]string{"-hostname", "from-flag"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Hostname != "from-flag" {
		t.Errorf("Hostname = %q, want the flag to override the environment", cfg.Hostname)
	}
	if cfg.ListenPort != 8443 || !cfg.TLS || !cfg.Ephemeral {
		t.Errorf("environment values were not applied: %+v", cfg)
	}
	if cfg.ShutdownTimeout != 5*time.Second {
		t.Errorf("ShutdownTimeout = %s, want 5s", cfg.ShutdownTimeout)
	}
	if cfg.LogLevel != slog.LevelDebug || cfg.LogFormat != "text" {
		t.Errorf("logging options were not applied: %+v", cfg)
	}
	if cfg.IdentityHeaders {
		t.Error("IdentityHeaders = true, want the environment value false")
	}
	want := []string{"tag:rack-daemon", "tag:project-vm"}
	if len(cfg.Tags) != len(want) || cfg.Tags[0] != want[0] || cfg.Tags[1] != want[1] {
		t.Errorf("Tags = %v, want %v (trailing empty entry dropped)", cfg.Tags, want)
	}
}

func TestLoadRejectsMissingRequiredValues(t *testing.T) {
	t.Parallel()

	_, err := Loader{LookupEnv: envMap(nil)}.Load(nil)
	if err == nil {
		t.Fatal("Load succeeded without -hostname, -state-dir or -target")
	}
	for _, want := range []string{"-hostname", "-state-dir", "-target"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s; all problems should be reported at once", err, want)
		}
	}
}

func TestLoadValidationFailures(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "relative state directory",
			args: []string{"-hostname", "rack", "-state-dir", "state", "-target", "127.0.0.1:1"},
			want: "absolute path",
		},
		{
			name: "non-loopback target without opt-in",
			args: []string{"-hostname", "rack", "-state-dir", "/s", "-target", "10.0.0.5:7357"},
			want: "-allow-remote-target",
		},
		{
			name: "target without a port",
			args: []string{"-hostname", "rack", "-state-dir", "/s", "-target", "127.0.0.1"},
			want: "host:port",
		},
		{
			name: "uppercase hostname",
			args: []string{"-hostname", "Rack", "-state-dir", "/s", "-target", "127.0.0.1:1"},
			want: "lowercase",
		},
		{
			name: "listen port out of range",
			args: []string{"-hostname", "rack", "-state-dir", "/s", "-target", "127.0.0.1:1", "-listen-port", "70000"},
			want: "-listen-port",
		},
		{
			name: "unknown log format",
			args: []string{"-hostname", "rack", "-state-dir", "/s", "-target", "127.0.0.1:1", "-log-format", "logfmt"},
			want: "-log-format",
		},
		{
			name: "unknown log level",
			args: []string{"-hostname", "rack", "-state-dir", "/s", "-target", "127.0.0.1:1", "-log-level", "trace"},
			want: "-log-level",
		},
		{
			name: "tag without prefix",
			args: []string{"-hostname", "rack", "-state-dir", "/s", "-target", "127.0.0.1:1", "-tags", "rack"},
			want: "tag:",
		},
		{
			name: "non-positive shutdown timeout",
			args: []string{"-hostname", "rack", "-state-dir", "/s", "-target", "127.0.0.1:1", "-shutdown-timeout", "0s"},
			want: "-shutdown-timeout",
		},
		{
			name: "relative control URL",
			args: []string{"-hostname", "rack", "-state-dir", "/s", "-target", "127.0.0.1:1", "-control-url", "headscale"},
			want: "-control-url",
		},
		{
			name: "positional argument",
			args: append(minimalArgs(), "start"),
			want: "positional",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := Loader{LookupEnv: envMap(nil)}.Load(tc.args)
			if err == nil {
				t.Fatalf("Load(%v) succeeded, want an error mentioning %q", tc.args, tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

func TestLoadAcceptsRemoteTargetWhenRequested(t *testing.T) {
	t.Parallel()

	args := []string{"-hostname", "rack", "-state-dir", "/s", "-target", "10.0.0.5:7357", "-allow-remote-target"}
	cfg, err := Loader{LookupEnv: envMap(nil)}.Load(args)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.AllowRemoteTarget || cfg.Target != "10.0.0.5:7357" {
		t.Errorf("unexpected configuration: %+v", cfg)
	}
}

func TestLoadReportsMalformedEnvironmentValues(t *testing.T) {
	t.Parallel()

	env := envMap(map[string]string{
		EnvListenPort:      "http",
		EnvEphemeral:       "sometimes",
		EnvShutdownTimeout: "quickly",
	})

	_, err := Loader{LookupEnv: env}.Load(minimalArgs())
	if err == nil {
		t.Fatal("Load accepted malformed environment values")
	}
	for _, want := range []string{EnvListenPort, EnvEphemeral, EnvShutdownTimeout} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}

func TestAuthKeyPrecedence(t *testing.T) {
	t.Parallel()

	keyFile := filepath.Join(t.TempDir(), "authkey")
	if err := os.WriteFile(keyFile, []byte("tskey-auth-from-file\n"), 0o600); err != nil {
		t.Fatalf("writing key file: %v", err)
	}

	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{
			name: "sidecar variable wins",
			env: map[string]string{
				EnvAuthKey:         "tskey-auth-primary",
				EnvAuthKeyFile:     keyFile,
				EnvAuthKeyFallback: "tskey-auth-fallback",
			},
			want: "tskey-auth-primary",
		},
		{
			name: "file variant beats the Tailscale fallback",
			env: map[string]string{
				EnvAuthKeyFile:     keyFile,
				EnvAuthKeyFallback: "tskey-auth-fallback",
			},
			// Trailing whitespace is trimmed: key files usually end
			// with a newline.
			want: "tskey-auth-from-file",
		},
		{
			name: "Tailscale fallback is accepted",
			env:  map[string]string{EnvAuthKeyFallback: "tskey-auth-fallback"},
			want: "tskey-auth-fallback",
		},
		{
			name: "empty values are ignored",
			env:  map[string]string{EnvAuthKey: "", EnvAuthKeyFallback: ""},
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			loader := Loader{LookupEnv: envMap(tc.env), ReadFile: os.ReadFile}
			cfg, err := loader.Load(minimalArgs())
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if got := cfg.AuthKey.Expose(); got != tc.want {
				t.Errorf("AuthKey = %q, want %q", got, tc.want)
			}
			if cfg.AuthKey.IsSet() != (tc.want != "") {
				t.Errorf("IsSet = %v, want %v", cfg.AuthKey.IsSet(), tc.want != "")
			}
		})
	}
}

func TestAuthKeyFileFailuresAreReported(t *testing.T) {
	t.Parallel()

	missing := filepath.Join(t.TempDir(), "absent")
	loader := Loader{LookupEnv: envMap(map[string]string{EnvAuthKeyFile: missing}), ReadFile: os.ReadFile}
	if _, err := loader.Load(minimalArgs()); err == nil {
		t.Fatal("Load ignored an unreadable auth key file; it must fail loudly")
	}

	empty := filepath.Join(t.TempDir(), "empty")
	if err := os.WriteFile(empty, []byte("   \n"), 0o600); err != nil {
		t.Fatalf("writing key file: %v", err)
	}
	loader = Loader{LookupEnv: envMap(map[string]string{EnvAuthKeyFile: empty}), ReadFile: os.ReadFile}
	if _, err := loader.Load(minimalArgs()); err == nil {
		t.Fatal("Load accepted an empty auth key file")
	}
}

// TestNoAuthKeyFlagExists guards the rule that the credential is accepted only
// through the environment. A future flag named like an auth key would be
// visible in process listings.
func TestNoAuthKeyFlagExists(t *testing.T) {
	t.Parallel()

	args := []string{"-authkey", "tskey-auth-should-not-be-accepted"}
	if _, err := (Loader{LookupEnv: envMap(nil)}).Load(args); err == nil {
		t.Fatal("an -authkey flag exists; auth keys must come from the environment only")
	}
}

func TestLoadReturnsErrHelpForUsage(t *testing.T) {
	t.Parallel()

	_, err := Loader{LookupEnv: envMap(nil)}.Load([]string{"-h"})
	if !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("Load(-h) = %v, want flag.ErrHelp so the caller can exit successfully", err)
	}
}

// TestSecretNeverFormatsItsValue covers every formatting path that could leak
// the auth key into a log line or a crash dump.
func TestSecretNeverFormatsItsValue(t *testing.T) {
	t.Parallel()

	const key = "tskey-auth-super-secret"
	secret := Secret(key)

	for _, rendered := range []string{
		fmt.Sprintf("%v", secret),
		fmt.Sprintf("%s", secret),
		fmt.Sprintf("%#v", secret),
		fmt.Sprint(secret),
		fmt.Sprintf("%v", struct{ Key Secret }{secret}),
	} {
		if strings.Contains(rendered, key) {
			t.Errorf("formatted secret %q contains the credential", rendered)
		}
		if !strings.Contains(rendered, Redacted) {
			t.Errorf("formatted secret %q does not show the redaction marker", rendered)
		}
	}

	if got := secret.LogValue().String(); got != Redacted {
		t.Errorf("LogValue = %q, want %q", got, Redacted)
	}
	if secret.Expose() != key {
		t.Error("Expose must return the credential unchanged")
	}
}

// TestLogAttrsOmitsTheAuthKey asserts that the structured startup log line
// cannot carry the credential in any form.
func TestLogAttrsOmitsTheAuthKey(t *testing.T) {
	t.Parallel()

	cfg, err := Loader{
		LookupEnv: envMap(map[string]string{EnvAuthKey: "tskey-auth-super-secret"}),
	}.Load(minimalArgs())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	var rendered strings.Builder
	for _, attr := range cfg.LogAttrs() {
		fmt.Fprintf(&rendered, "%s=%v ", attr.Key, attr.Value)
	}
	if strings.Contains(rendered.String(), "tskey-auth") {
		t.Fatalf("LogAttrs leaked the auth key: %s", rendered.String())
	}
	if !strings.Contains(rendered.String(), "auth_key_supplied=true") {
		t.Errorf("LogAttrs should report whether a key was supplied: %s", rendered.String())
	}
}
