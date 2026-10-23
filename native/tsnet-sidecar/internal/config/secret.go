package config

import (
	"fmt"
	"log/slog"
)

// Secret wraps a credential so that it cannot be printed by accident.
//
// The tailnet auth key is the only secret this program handles. It is accepted
// exclusively through the environment (never a command-line flag, which would
// expose it in `ps` output and shell history), and this type makes the usual
// accidental disclosure paths safe:
//
//   - fmt verbs that use Stringer (%v, %s) print the redaction marker,
//   - %#v prints the redaction marker through GoString,
//   - log/slog prints the redaction marker through LogValuer.
//
// Reading the real value requires the explicit Expose call, which is easy to
// grep for during review.
type Secret string

// Redacted is what every formatting path prints instead of the credential.
const Redacted = "[redacted]"

var (
	_ fmt.Stringer   = Secret("")
	_ fmt.GoStringer = Secret("")
	_ slog.LogValuer = Secret("")
)

// String implements fmt.Stringer with the redaction marker.
func (Secret) String() string { return Redacted }

// GoString implements fmt.GoStringer so %#v cannot leak the credential.
func (Secret) GoString() string { return Redacted }

// LogValue implements slog.LogValuer so structured logging cannot leak the
// credential, including when the whole Config value is logged as one attribute.
func (Secret) LogValue() slog.Value { return slog.StringValue(Redacted) }

// Expose returns the underlying credential. Call it only where the value is
// handed to the tailnet client.
func (s Secret) Expose() string { return string(s) }

// IsSet reports whether a credential was supplied.
func (s Secret) IsSet() bool { return s != "" }
