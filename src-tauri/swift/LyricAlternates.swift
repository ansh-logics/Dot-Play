// On-device romanization and translation of lyric lines, for src/lyrics/alternates.rs.
//
// Romanization uses Foundation's string transforms (ICU transliteration, offline, every macOS).
// Translation uses Apple's Translation framework with models already downloaded in System
// Settings (macOS 26+); nothing leaves the Mac. The song's language comes from NaturalLanguage.
//
// Each function takes a JSON request as a C string and returns a JSON reply that the caller
// frees with dot_alternates_free.

import Foundation
import NaturalLanguage
import Translation

private func reply(_ object: Any) -> UnsafeMutablePointer<CChar>? {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    return strdup(String(decoding: data, as: UTF8.self))
}

private func request(_ input: UnsafePointer<CChar>?) -> [String: Any] {
    guard let input, let data = String(cString: input).data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [:] }
    return object
}

@_cdecl("dot_alternates_free")
public func dotAlternatesFree(_ pointer: UnsafeMutablePointer<CChar>?) {
    free(pointer)
}

/// {"lines": [String]} → {"lines": [String | null]}: each line in Latin letters without accents,
/// or null where it was Latin already.
@_cdecl("dot_romanize")
public func dotRomanize(_ input: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    let lines = request(input)["lines"] as? [String] ?? []
    let out: [Any] = lines.map { line in
        let latin = romanize(line)
        return latin == nil || latin == line ? NSNull() : latin!
    }
    return reply(["lines": out])
}

func romanize(_ line: String) -> String? {
    // Word by word, so Hindi words can lose the "a" the transform writes after a final
    // consonant ("रब" is "rab", not "raba").
    let words = line.split(separator: " ", omittingEmptySubsequences: false)
    var out: [String] = []
    for word in words {
        guard var latin = String(word).applyingTransform(.toLatin, reverse: false)?
            .applyingTransform(.stripDiacritics, reverse: false)
        else { return nil }
        if endsInDevanagariConsonant(word), latin.count > 2, latin.hasSuffix("a") {
            latin.removeLast()
        }
        out.append(latin)
    }
    return out.joined(separator: " ")
}

/// Whether the word's last letter is a bare Devanagari consonant (no vowel sign after it).
private func endsInDevanagariConsonant<S: StringProtocol>(_ word: S) -> Bool {
    guard let last = word.unicodeScalars.last(where: { !CharacterSet.punctuationCharacters.contains($0) })
    else { return false }
    return (0x0915...0x0939).contains(last.value) || (0x0958...0x095F).contains(last.value)
}

/// The language most of the lines are in, as a BCP-47 code ("hi", "ja"), when it's clear.
private func detectLanguage(_ lines: [String]) -> String? {
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(lines.joined(separator: "\n"))
    guard let (language, confidence) = recognizer.languageHypotheses(withMaximum: 1).first,
          confidence >= 0.5, language != .undetermined
    else { return nil }
    return language.rawValue
}

private func baseCode(_ identifier: String) -> String {
    Locale.Language(identifier: identifier).languageCode?.identifier ?? identifier
}

/// Holds a result across the async boundary; written once before the semaphore is signalled.
private final class Box: @unchecked Sendable {
    var value: [String: Any] = ["status": "error", "message": "No result"]
}

/// {"lines": [String], "target": String?} →
///   {"status": "translated", "source", "target", "lines": [String | null]}
///   {"status": "sameLanguage" | "unknownLanguage" | "unsupported" | "unavailable", ...}
///   {"status": "notInstalled", "source", "target"}: the language pair needs downloading in
///   System Settings → General → Language & Region → Translation Languages.
/// Blocks the calling thread until done; call it off the main thread.
@_cdecl("dot_translate")
public func dotTranslate(_ input: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    let req = request(input)
    let lines = req["lines"] as? [String] ?? []
    let target = (req["target"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        ?? Locale.preferredLanguages.first ?? "en"

    guard #available(macOS 26.0, *) else { return reply(["status": "unavailable"]) }
    guard let source = detectLanguage(lines) else { return reply(["status": "unknownLanguage"]) }
    if baseCode(source) == baseCode(target) {
        return reply(["status": "sameLanguage", "source": source, "target": target])
    }

    let box = Box()
    let done = DispatchSemaphore(value: 0)
    Task.detached {
        box.value = await translate(lines: lines, source: source, target: target)
        done.signal()
    }
    done.wait()
    return reply(box.value)
}

@available(macOS 26.0, *)
private func translate(lines: [String], source: String, target: String) async -> [String: Any] {
    let from = Locale.Language(identifier: source)
    let to = Locale.Language(identifier: target)
    switch await LanguageAvailability().status(from: from, to: to) {
    case .unsupported:
        return ["status": "unsupported", "source": source, "target": target]
    case .supported:
        return ["status": "notInstalled", "source": source, "target": target]
    case .installed:
        break
    @unknown default:
        return ["status": "unsupported", "source": source, "target": target]
    }

    let session = TranslationSession(installedSource: from, target: to)
    let requests = lines.enumerated().compactMap { index, line -> TranslationSession.Request? in
        line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? nil
            : TranslationSession.Request(sourceText: line, clientIdentifier: String(index))
    }
    do {
        let responses = try await session.translations(from: requests)
        var out: [Any] = Array(repeating: NSNull(), count: lines.count)
        for response in responses {
            if let id = response.clientIdentifier, let index = Int(id), index < out.count {
                out[index] = response.targetText
            }
        }
        return ["status": "translated", "source": source, "target": target, "lines": out]
    } catch {
        return ["status": "error", "message": error.localizedDescription]
    }
}
