// textscan — print the text macOS Vision recognizes in each image.
// Usage: swift textscan.swift <image>...   →  one JSON line per image:
//   {"path": "...", "texts": [{"s": "WORLD SKI", "c": 0.92}, ...]}
import Foundation
import Vision

for path in CommandLine.arguments.dropFirst() {
  let url = URL(fileURLWithPath: path)
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  var texts: [[String: Any]] = []
  do {
    try VNImageRequestHandler(url: url).perform([req])
    for obs in req.results ?? [] {
      if let top = obs.topCandidates(1).first {
        texts.append(["s": top.string, "c": Double(top.confidence)])
      }
    }
  } catch {
    texts.append(["error": "\(error)"])
  }
  let line = try! JSONSerialization.data(withJSONObject: ["path": path, "texts": texts])
  print(String(data: line, encoding: .utf8)!)
}
