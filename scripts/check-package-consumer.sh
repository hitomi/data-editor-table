#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
system_temp=$(cd -- "${TMPDIR:-/tmp}" && pwd -P)
case "$system_temp" in
  "$repo_root"|"$repo_root"/*)
    echo 'The package consumer must run outside the repository tree.' >&2
    exit 1
    ;;
esac
temp_root=$(mktemp -d "$system_temp/data-editor-table-package.XXXXXX")

cleanup() {
  if [[ "$(dirname -- "$temp_root")" == "$system_temp" && "$(basename -- "$temp_root")" == data-editor-table-package.* ]]; then
    rm -rf -- "$temp_root"
  else
    echo "Refusing to remove unexpected temporary path: $temp_root" >&2
  fi
}
trap cleanup EXIT

pnpm --dir "$repo_root" build
pnpm --dir "$repo_root" pack --pack-destination "$temp_root" >/dev/null

package_tgz=$(find "$temp_root" -maxdepth 1 -type f -name '*.tgz' -print -quit)
if [[ -z "$package_tgz" ]]; then
  echo 'pnpm pack did not produce a package archive.' >&2
  exit 1
fi

extract_package() {
  local destination=$1
  mkdir -p "$destination"
  tar -xzf "$package_tgz" -C "$destination" --strip-components=1
}

copy_dependency() {
  local source=$1
  local destination=$2
  mkdir -p "$(dirname -- "$destination")"
  cp -R "$(realpath -- "$source")" "$destination"
}

resolve_dependency_root() {
  local dependency=$1
  local from=$2
  node -e 'const path = require("node:path"); console.log(path.dirname(require.resolve(`${process.argv[1]}/package.json`, { paths: [process.argv[2]] })))' "$dependency" "$from"
}

engine_consumer="$temp_root/engine-consumer"
engine_package="$engine_consumer/node_modules/data-editor-table"
extract_package "$engine_package"
cp "$repo_root/tests/package-consumer/engine-only.ts" "$engine_consumer/engine-only.ts"
cp "$repo_root/tests/package-consumer/tsconfig.engine.json" "$engine_consumer/tsconfig.json"

react_consumer="$temp_root/react-consumer"
package_root="$react_consumer/node_modules/data-editor-table"
extract_package "$package_root"
cp "$repo_root/tests/package-consumer/index.ts" "$react_consumer/index.ts"
cp "$repo_root/tests/package-consumer/tsconfig.json" "$react_consumer/tsconfig.json"
mkdir -p "$react_consumer/browser"
cp -R "$repo_root/tests/package-consumer/browser/." "$react_consumer/browser/"

react_root=$(realpath -- "$repo_root/node_modules/react")
react_dom_root=$(realpath -- "$repo_root/node_modules/react-dom")
react_types_root=$(realpath -- "$repo_root/node_modules/@types/react")
react_dom_types_root=$(realpath -- "$repo_root/node_modules/@types/react-dom")
scheduler_root=$(resolve_dependency_root scheduler "$react_dom_root")
csstype_root=$(resolve_dependency_root csstype "$react_types_root")

copy_dependency "$react_root" "$react_consumer/node_modules/react"
copy_dependency "$react_dom_root" "$react_consumer/node_modules/react-dom"
copy_dependency "$scheduler_root" "$react_consumer/node_modules/scheduler"
copy_dependency "$react_types_root" "$react_consumer/node_modules/@types/react"
copy_dependency "$react_dom_types_root" "$react_consumer/node_modules/@types/react-dom"
copy_dependency "$csstype_root" "$react_consumer/node_modules/csstype"

test -f "$package_root/dist/index.d.ts"
test -f "$package_root/dist/index.js"
test -f "$package_root/dist/engine.d.ts"
test -f "$package_root/dist/engine.js"
test -f "$package_root/dist/locales/zh-cn.d.ts"
test -f "$package_root/dist/locales/zh-CN.js"
test -f "$package_root/dist/styles.css"
test -f "$package_root/dist/structure.css"
test -f "$package_root/dist/theme.css"
test -f "$package_root/dist/styles-entry.d.ts"

node "$repo_root/scripts/verify-headless-bundle.mjs" "$engine_package"
node --input-type=module -e 'import("node:url").then(({ pathToFileURL }) => import(pathToFileURL(process.argv[1]).href)).then((module) => { if (typeof module.createGridController !== "function") process.exit(1) })' "$engine_package/dist/engine.js"

if rg -q "react-data-grid" "$engine_package/dist/engine.js" "$engine_package/dist/engine.d.ts"; then
  echo 'The v2 engine bundle still references react-data-grid.' >&2
  exit 1
fi

"$repo_root/node_modules/.bin/tsc" -p "$engine_consumer/tsconfig.json" --noEmit
"$repo_root/node_modules/.bin/tsc" -p "$react_consumer/tsconfig.json" --noEmit

(
  cd -- "$react_consumer/browser"
  "$repo_root/node_modules/.bin/vite" build --outDir dist --emptyOutDir
)
node "$repo_root/scripts/verify-package-browser.mjs" "$react_consumer/browser/dist"
