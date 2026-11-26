#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/release-version.sh"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
cd "$fixture"
git init -qb main
git config user.name "Release test"
git config user.email "test@example.invalid"
mkdir android
printf 'versionName=0.1.0\npreview=8\n' > android/version.properties
git add android/version.properties
git commit -qm initial

check() {
    local actual expected
    actual=$(GITHUB_REF_TYPE="$1" GITHUB_REF_NAME="$2" bash "$script")
    expected=$(printf 'tag=%s\nvariant=%s\nversion_name=%s\n' "$3" "$4" "$5")
    [[ $actual == "$expected" ]] || { printf 'Expected:\n%s\nGot:\n%s\n' "$expected" "$actual" >&2; exit 1; }
}

check branch main android-v0.1.0-preview.8 preview 0.1.0-preview.8
git tag v1.9.0
git tag v1.10.0
git tag v2.0.0-rc.1
git tag android-v3.0.0
git checkout -qb unreleased
git commit --allow-empty -qm unreleased
git tag v9.0.0
git checkout -q main
check branch main android-v1.10.0-preview.8 preview 1.10.0-preview.8
check tag v2.0.0 v2.0.0 release 2.0.0
check tag v2.1 v2.1 release 2.1
check tag v2.0.0-rc.2+build.5 v2.0.0-rc.2+build.5 release 2.0.0-rc.2+build.5
check tag android-v1.12.0 android-v1.12.0 release 1.12.0
check tag android-v1.12.0-preview.3 android-v1.12.0-preview.3 preview 1.12.0-preview.3
for invalid in v vNext 'v1.0.0 bad' 'v1.2.3/test' other-1.0.0; do
    if GITHUB_REF_TYPE=tag GITHUB_REF_NAME="$invalid" bash "$script" >/dev/null 2>&1; then
        echo "Unexpectedly accepted $invalid" >&2
        exit 1
    fi
done
