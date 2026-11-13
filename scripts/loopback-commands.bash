# BASH_ENV of the worker's commands in loopback mode (set in loopback.config.toml), read by every bash they start.
# Codex points proxy variables at its managed proxy, which allows no domain and aborts the whole command when a
# request is refused there. Without them, an incidental lookup (update check, telemetry) fails fast in the
# command's own network namespace, which only has loopback, and the command goes on.
for __harness_name in $(compgen -e); do
  case "$__harness_name" in
    CODEX_*) ;;
    *[Pp][Rr][Oo][Xx][Yy]*) unset "$__harness_name" ;;
  esac
done
unset __harness_name
