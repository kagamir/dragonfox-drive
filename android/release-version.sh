#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'Android release version: %s\n' "$1" >&2; exit 1; }

stable='[0-9]+(\.[0-9]+)*'

variant=release
if [[ $GITHUB_REF_TYPE == tag ]]; then
    tag=$GITHUB_REF_NAME
    case "$tag" in
        android-v*) version=${tag#android-v} ;;
        v*)         version=${tag#v} ;;
        *)          fail "expected a v or android-v release tag, got $tag" ;;
    esac
    if [[ $tag =~ ^android-v$stable-preview\.[0-9]+(\+.*)?$ ]]; then
        variant=preview
    fi
else
    variant=preview
    # A project tag only becomes the base for previews on branches containing it.
    tags=$(git tag --merged HEAD --list 'v[0-9]*' --sort=-version:refname)
    base=
    while IFS= read -r candidate; do
        if [[ $candidate =~ ^v$stable$ ]]; then
            base=${candidate#v}
            break
        fi
    done <<< "$tags"
    properties=android/version.properties
    if [[ -z $base ]]; then
        base=$(sed -n 's/^versionName=//p' "$properties")
    fi
    preview=$(sed -n 's/^preview=//p' "$properties")
    [[ $base =~ ^$stable$ && $preview =~ ^[0-9]+$ ]] || fail "invalid preview base or sequence: $base / $preview"
    version="$base-preview.$preview"
    tag="android-v$version"
fi

# Keep the tag's spelling, including short versions and build metadata.
[[ $version =~ ^[0-9][0-9A-Za-z.+_-]*$ ]] || fail "version in $tag cannot be reported by the device API"
# The device API accepts Android product versions up to 64 characters.
(( ${#version} <= 64 )) || fail "version exceeds the device API's 64-character limit"
printf 'tag=%s\nvariant=%s\nversion_name=%s\n' "$tag" "$variant" "$version"
