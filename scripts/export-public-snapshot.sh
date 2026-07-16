#!/usr/bin/env bash

set -euo pipefail

script_path="${BASH_SOURCE[0]}"
script_dir="."
if [[ "${script_path}" == */* ]]; then
  script_dir="${script_path%/*}"
fi
repo_root="$(cd -P -- "${script_dir}/.." && pwd -P)"

fail() {
  printf 'Refusing to export: %s\n' "$1" >&2
  exit 1
}

sanitize_path() {
  local entry canonical
  local -a safe_entries=()
  local -a path_entries=()
  IFS=: read -r -a path_entries <<< "${PATH:-}"
  for entry in "${path_entries[@]}"; do
    if [[ -z "${entry}" || "${entry}" != /* || ! -d "${entry}" ]]; then
      continue
    fi
    canonical="$(cd -P -- "${entry}" 2>/dev/null && pwd -P)" || continue
    if [[ "${canonical}" == "${repo_root}" || "${canonical}" == "${repo_root}/"* ]]; then
      continue
    fi
    safe_entries+=("${canonical}")
  done
  if (( ${#safe_entries[@]} == 0 )); then
    fail "PATH contains no executable directories outside the repository."
  fi
  local IFS=:
  PATH="${safe_entries[*]}"
  export PATH
  hash -r
}

resolve_tool() {
  local resolved
  resolved="$(type -P -- "$1")" || fail "required tool is unavailable outside the repository: $1"
  printf '%s\n' "${resolved}"
}

sanitize_path
git_command="$(resolve_tool git)"
node_command="$(resolve_tool node)"
tar_command="$(resolve_tool tar)"
gzip_command="$(resolve_tool gzip)"
shasum_command="$(resolve_tool shasum)"
awk_command="$(resolve_tool awk)"
grep_command="$(resolve_tool grep)"
mkdir_command="$(resolve_tool mkdir)"
mktemp_command="$(resolve_tool mktemp)"
mv_command="$(resolve_tool mv)"
rm_command="$(resolve_tool rm)"
dirname_command="$(resolve_tool dirname)"
basename_command="$(resolve_tool basename)"

output="${1:-${repo_root}/dist/preflight-scout-public-snapshot.tar.gz}"
public_manifest="${repo_root}/scripts/public-snapshot-files.txt"
staging_manifest="${repo_root}/scripts/public-snapshot-staging-only-files.txt"
boundary_helper="${repo_root}/scripts/verify-public-snapshot-boundary.mjs"
package_names=(agent-exec browser-runner cli core github-action mcp)
package_assets=(LICENSE NOTICE OUTPUT-LICENSE.md THIRD_PARTY_NOTICES.md)

reject_symlink_components() {
  local candidate="$1" parent
  while [[ "${candidate}" != "/" && "${candidate}" != "." ]]; do
    if [[ -L "${candidate}" ]]; then
      fail "output path contains a symlink: ${candidate}"
    fi
    parent="$("${dirname_command}" "${candidate}")"
    if [[ "${parent}" == "${candidate}" ]]; then
      break
    fi
    candidate="${parent}"
  done
}

for package_name in "${package_names[@]}"; do
  for package_asset in "${package_assets[@]}"; do
    package_asset_path="packages/${package_name}/${package_asset}"
    if [[ ! -f "${repo_root}/${package_asset_path}" || -L "${repo_root}/${package_asset_path}" ]]; then
      fail "required package asset is missing or non-regular: ${package_asset_path}"
    fi
    if ! "${git_command}" -C "${repo_root}" -c core.fsmonitor=false \
      ls-files --error-unmatch -- "${package_asset_path}" >/dev/null 2>&1; then
      fail "required package asset is not tracked by Git: ${package_asset_path}"
    fi
    if ! "${grep_command}" -Fqx -- "${package_asset_path}" "${public_manifest}"; then
      fail "required package asset is not classified as public: ${package_asset_path}"
    fi
  done
done

if [[ -n "$("${git_command}" -C "${repo_root}" -c core.fsmonitor=false status --porcelain --untracked-files=normal)" ]]; then
  fail "commit or remove working-tree changes first."
fi

"${node_command}" "${boundary_helper}" worktree \
  "${repo_root}" "${git_command}" "${public_manifest}" "${staging_manifest}"

public_paths=()
public_pathspecs=()
while IFS= read -r public_path || [[ -n "${public_path}" ]]; do
  public_paths+=("${public_path}")
  public_pathspecs+=(":(literal)${public_path}")
done < "${public_manifest}"
if (( ${#public_paths[@]} == 0 )); then
  fail "public manifest is empty."
fi

output_dir="$("${dirname_command}" "${output}")"
output_name="$("${basename_command}" "${output}")"
reject_symlink_components "${output_dir}"
if [[ -e "${output_dir}" && ! -d "${output_dir}" ]]; then
  fail "output parent is not a directory: ${output_dir}"
fi
"${mkdir_command}" -p -- "${output_dir}"
reject_symlink_components "${output_dir}"
if [[ ! -d "${output_dir}" ]]; then
  fail "output parent is not a directory: ${output_dir}"
fi
output_dir="$(cd -P "${output_dir}" && pwd -P)"
output="${output_dir}/${output_name}"
if [[ -L "${output}" ]]; then
  fail "output file is a symlink: ${output}"
fi
if [[ -e "${output}" && ! -f "${output}" ]]; then
  fail "output path is not a regular file: ${output}"
fi

staging="$("${mktemp_command}" -d)"
temporary_output="$("${mktemp_command}" "${output_dir}/.preflight-scout-public-snapshot.XXXXXX")"
cleanup() {
  "${rm_command}" -rf -- "${staging}"
  if [[ -n "${temporary_output}" ]]; then
    "${rm_command}" -f -- "${temporary_output}"
  fi
}
trap cleanup EXIT

if [[ -L "${temporary_output}" || ! -f "${temporary_output}" ]]; then
  fail "could not create a regular temporary archive in ${output_dir}"
fi

commit="$("${git_command}" -C "${repo_root}" rev-parse HEAD)"
"${git_command}" -C "${repo_root}" archive \
  --format=tar \
  --prefix=preflight-scout/ \
  "${commit}" \
  -- "${public_pathspecs[@]}" > "${staging}/snapshot.tar"
"${gzip_command}" -n -9 < "${staging}/snapshot.tar" > "${temporary_output}"
"${tar_command}" -tzf "${temporary_output}" > "${staging}/contents.txt"
"${tar_command}" -tvzf "${temporary_output}" > "${staging}/metadata.txt"

"${node_command}" "${boundary_helper}" archive \
  "${public_manifest}" "${staging}/contents.txt" "${staging}/metadata.txt" "preflight-scout/"

"${mkdir_command}" "${staging}/extracted"
"${tar_command}" -xzf "${temporary_output}" -C "${staging}/extracted"
"${node_command}" "${boundary_helper}" tree \
  "${staging}/extracted/preflight-scout" \
  "${staging}/extracted/preflight-scout/scripts/public-snapshot-files.txt"

for package_name in "${package_names[@]}"; do
  for package_asset in "${package_assets[@]}"; do
    package_asset_path="packages/${package_name}/${package_asset}"
    if ! "${grep_command}" -Fqx -- "preflight-scout/${package_asset_path}" "${staging}/contents.txt"; then
      fail "archive is missing required package asset: ${package_asset_path}"
    fi
  done
done

if [[ -L "${output}" || ( -e "${output}" && ! -f "${output}" ) ]]; then
  fail "output path changed to an unsafe file before installation: ${output}"
fi
"${mv_command}" -f -- "${temporary_output}" "${output}"
temporary_output=""

# The $1 expression is evaluated by awk, not this shell.
# shellcheck disable=SC2016
checksum="$("${shasum_command}" -a 256 "${output}" | "${awk_command}" '{print $1}')"
printf 'Public snapshot: %s\n' "${output}"
printf 'Source commit: %s\n' "${commit}"
printf 'SHA-256: %s\n' "${checksum}"
