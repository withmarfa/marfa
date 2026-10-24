# Sourced by the scripts that start a test run's processes. Takes the
# telemetry settings out of the environment and turns the SDK off, so a
# developer's own shell settings never reach the `marfa` binary or a server
# that a test run starts.
while IFS='=' read -r name _; do
  case "${name}" in
    OTEL_* | MARFA_POSTHOG_*) unset "${name}" ;;
  esac
done < <(env)
export OTEL_SDK_DISABLED=true
