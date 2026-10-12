#!/usr/bin/env bash
#
# 打成 macOS 的 .dmg 安装镜像。
#
# 只做打包这一步的前置检查与收尾：bundle 与原生语音助手的编译在 `npm run build` 里，
# app 的内容、额外资源、Info.plist 用途说明在 package.json 的 build 段里，这里都不重复。
#
# 用法：
#   ./build_app.sh
#
# 产物：release/Amadeus-<版本>-<架构>.dmg
#       未签名；配好 Developer ID 证书后 electron-builder 会自行签名。

set -euo pipefail

cd "$(dirname "$0")"

# 原生语音助手用 swiftc 按本机架构编译，所以只能在 macOS 上出包（scripts/before-pack.mjs 会再挡一次，这里早退给个明白话）。
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "错误：只能在 macOS 上打包，原生语音助手按本机架构编译。" >&2
  exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "错误：找不到 swiftc，请先装 Xcode Command Line Tools：xcode-select --install" >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "==> 没有 node_modules，先装依赖"
  npm ci
fi

echo "==> 编译 bundle 与原生语音助手"
npm run build

# mac 的默认 target 是 dmg + zip，这里只要镜像。
echo "==> 打包 dmg"
npx electron-builder --mac dmg

shopt -s nullglob
images=(release/*.dmg)
shopt -u nullglob

if (( ${#images[@]} == 0 )); then
  echo "错误：打包结束了却没有生成 dmg。" >&2
  exit 1
fi

for image in "${images[@]}"; do
  echo "==> 校验 ${image}"
  hdiutil verify "$image"
done

echo "==> 完成"
ls -lh "${images[@]}"
