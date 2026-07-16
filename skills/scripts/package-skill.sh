#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
skill_root="${repo_root}/skills/preflight-scout"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
if (( $# > 1 )); then
  printf 'Usage: %s [output.zip]\n' "$0" >&2
  exit 2
fi
output="${1:-${repo_root}/dist/preflight-scout-skill.zip}"

if [[ ! -f "${skill_root}/SKILL.md" ]]; then
  printf 'Missing canonical skill: %s\n' "${skill_root}/SKILL.md" >&2
  exit 1
fi
if [[ ! -f "${repo_root}/LICENSE" ]]; then
  printf 'Missing repository license: %s\n' "${repo_root}/LICENSE" >&2
  exit 1
fi

python3 "${repo_root}/skills/scripts/validate-skill.py" "${skill_root}"

python3 "${repo_root}/skills/scripts/build-skill-archive.py" \
  "${skill_root}" \
  "${repo_root}/LICENSE" \
  "${output}"
python3 "${repo_root}/skills/scripts/verify-skill-package.py" "${output}"

printf 'Packaged skill: %s\n' "${output}"
