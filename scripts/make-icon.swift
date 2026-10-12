#!/usr/bin/env swift
//
// 由一张方形源图生成 macOS 的 .icns。
//
// 为什么不是一行 sips：macOS 从 Big Sur 起不再替应用加圆角，图标文件本身必须带着
// 圆角矩形与透明边距，否则在 Dock 里是满幅尖角方块（实测 /System/Applications/
// Calculator.app 的 AppIcon.icns：1024 画布、内容 824、四边各留 100、角半径约 185）。
// 十个尺寸都直接从源图绘一次，不做「先出 1024 再缩放」的中间重采样。
//
// 用法：
//   swift scripts/make-icon.swift build/logo.jpeg build/icon.icns

import AppKit
import Foundation

/// 内容区占画布、角半径占内容区，取自上面实测的系统图标值。
let contentRatio = 824.0 / 1024.0
let cornerRatio = 185.4 / 824.0

/// iconset 的十个槽位；同一像素尺寸会出现两次（16@2x 与 32），都要写。
let slots: [(name: String, pixels: Int)] = [
  ("icon_16x16", 16), ("icon_16x16@2x", 32),
  ("icon_32x32", 32), ("icon_32x32@2x", 64),
  ("icon_128x128", 128), ("icon_128x128@2x", 256),
  ("icon_256x256", 256), ("icon_256x256@2x", 512),
  ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("错误：\(message)\n".data(using: .utf8)!)
  exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else { fail("用法：swift make-icon.swift <源图> <输出.icns>") }
let sourcePath = arguments[1]

guard let source = NSImage(contentsOfFile: sourcePath),
      let sourceImage = source.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  fail("读不出源图：\(sourcePath)")
}

/// 画布是透明的，圆角之外留空，居中铺一张方形的内容区。
func render(pixels: Int) -> Data? {
  guard let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
  context.interpolationQuality = .high
  let side = CGFloat(pixels)
  let content = (side * contentRatio).rounded()
  let origin = ((side - content) / 2).rounded()
  let radius = (content * cornerRatio).rounded()
  let box = CGRect(x: origin, y: origin, width: content, height: content)
  context.addPath(CGPath(roundedRect: box, cornerWidth: radius, cornerHeight: radius, transform: nil))
  context.clip()
  context.draw(sourceImage, in: box)
  guard let image = context.makeImage() else { return nil }
  return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
}

let manager = FileManager.default
let iconset = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
  .appendingPathComponent("amadeus-icon-\(ProcessInfo.processInfo.processIdentifier).iconset", isDirectory: true)
try? manager.removeItem(at: iconset)
do { try manager.createDirectory(at: iconset, withIntermediateDirectories: true) }
catch { fail("建不了临时目录：\(error.localizedDescription)") }

for slot in slots {
  guard let data = render(pixels: slot.pixels) else { fail("绘制 \(slot.pixels)px 失败") }
  do { try data.write(to: iconset.appendingPathComponent("\(slot.name).png")) }
  catch { fail("写 \(slot.name).png 失败：\(error.localizedDescription)") }
}

let output = URL(fileURLWithPath: arguments[2])
do { try manager.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true) }
catch { fail("建不了输出目录：\(error.localizedDescription)") }

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["--convert", "icns", "--output", output.path, iconset.path]
do { try iconutil.run() } catch { fail("跑不了 iconutil：\(error.localizedDescription)") }
iconutil.waitUntilExit()
try? manager.removeItem(at: iconset)
guard iconutil.terminationStatus == 0 else { fail("iconutil 退出码 \(iconutil.terminationStatus)") }

print("已生成 \(output.path)")
