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
    // Already in Latin letters (accents included): nothing to romanize.
    guard hasNonLatinLetters(line) else { return nil }
    // Word by word, so Hindi words can lose the "a" the transform writes after a final
    // consonant ("रब" is "rab", not "raba").
    let words = line.split(separator: " ", omittingEmptySubsequences: false)
    var out: [String] = []
    for word in words {
        // Punctuation around the word ("(दिल," ) is kept aside, so the rule sees the letters.
        let scalars = Array(String(word).unicodeScalars)
        let isLetter = { (s: Unicode.Scalar) in !CharacterSet.punctuationCharacters.contains(s) && !CharacterSet.symbols.contains(s) }
        guard let first = scalars.firstIndex(where: isLetter), let last = scalars.lastIndex(where: isLetter) else {
            out.append(String(word))
            continue
        }
        let lead = String(String.UnicodeScalarView(scalars[..<first]))
        let core = String(String.UnicodeScalarView(scalars[first...last]))
        let tail = String(String.UnicodeScalarView(scalars[(last + 1)...]))
        guard var latin = core.applyingTransform(.toLatin, reverse: false)?
            .applyingTransform(.stripDiacritics, reverse: false)
        else { return nil }
        if endsInDevanagariConsonant(core), latin.count > 2, latin.hasSuffix("a") {
            latin.removeLast()
        }
        out.append(lead + latin + tail)
    }
    return out.joined(separator: " ")
}

/// Whether the word's last letter is a bare Devanagari consonant (no vowel sign after it).
private func endsInDevanagariConsonant(_ word: String) -> Bool {
    guard let last = word.unicodeScalars.last else { return false }
    return (0x0915...0x0939).contains(last.value) || (0x0958...0x095F).contains(last.value)
}

/// Whether the text has letters outside the Latin script (Devanagari, Arabic, kana, Cyrillic…).
private func hasNonLatinLetters(_ text: String) -> Bool {
    text.unicodeScalars.contains { $0.properties.isAlphabetic && $0.value > 0x024F && !(0x1E00...0x1EFF).contains($0.value) }
}

/// Common words of Hindi and Urdu as they're written in English letters.
private let hinglishWords: Set<String> = [
    "hai", "hain", "main", "mein", "mai", "tu", "tum", "tera", "teri", "tere", "mera", "meri", "mere",
    "dil", "ka", "ki", "ke", "ko", "se", "na", "nahi", "nahin", "kya", "ho", "jo", "vo", "woh", "ye",
    "yeh", "hum", "aur", "bhi", "tujhe", "mujhe", "tujhse", "mujhse", "kabhi", "koi", "kuch", "raat",
    "yaar", "zindagi", "jaan", "dard", "saath", "liye", "hoon", "hu", "tha", "thi", "raha", "rahi",
    "pyaar", "pyar", "ishq", "sanam", "jaana", "jaaye", "kahoon", "kaha", "kahin", "phir", "abhi",
    "teri", "aankhon", "aankhein", "duniya", "khuda", "rab", "mohabbat", "chal", "lafz", "waqt",
]

private func hasHinglishWord(_ line: String) -> Bool {
    line.lowercased().split { !$0.isLetter }.contains { hinglishWords.contains(String($0)) }
}

/// Hindi or Urdu written in English letters (Hinglish). The language detector reads it as
/// Indonesian or Turkish; Apple's Hindi model translates it well, so it's treated as Hindi.
private func looksLikeRomanizedHindi(_ lines: [String]) -> Bool {
    let text = lines.joined(separator: " ")
    guard !hasNonLatinLetters(text) else { return false }
    let words = text.lowercased().split { !$0.isLetter }.map(String.init)
    guard words.count >= 8 else { return false }
    let hits = words.filter { hinglishWords.contains($0) }.count
    return hits >= 4 && Double(hits) / Double(words.count) >= 0.18
}

/// The language most of the lines are in, as a BCP-47 code ("hi", "ja"), when it's clear.
private func detectLanguage(_ lines: [String]) -> String? {
    if looksLikeRomanizedHindi(lines) { return "hi" }
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

    // Only lines in the song's language: an English "Yeah, hey" in a Hindi song stays as it is.
    // Repeated lines (choruses) are translated once.
    // In Hinglish, a single line easily reads as English ("Tujhe dekha to ye jaana sanam"), so
    // there a line only counts as already translated if it has no Hindi words in it.
    let hinglish = source == "hi" && !hasNonLatinLetters(lines.joined())
    var unique: [String] = []
    var seen = Set<String>()
    for line in lines {
        let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, seen.insert(text).inserted else { continue }
        let alreadyTarget = isInLanguage(text, baseCode(target)) && !(hinglish && hasHinglishWord(text))
        if !alreadyTarget { unique.append(text) }
    }
    if unique.isEmpty { return ["status": "sameLanguage", "source": source, "target": target] }

    do {
        let translated = try await translateInContext(unique, session: session)
        var out: [Any] = Array(repeating: NSNull(), count: lines.count)
        for (index, line) in lines.enumerated() {
            let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if let result = translated[text], result != text { out[index] = result }
        }
        return ["status": "translated", "source": source, "target": target, "lines": out]
    } catch {
        return ["status": "error", "message": error.localizedDescription]
    }
}

/// Whether a line on its own reads as `code` (short lines need a clear lead to count).
private func isInLanguage(_ line: String, _ code: String) -> Bool {
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(line)
    guard let (language, confidence) = recognizer.languageHypotheses(withMaximum: 1).first else { return false }
    return baseCode(language.rawValue) == code && confidence >= 0.6
}

/// Translates lines with their neighbours as context: the song goes in as one text, a verse
/// at a time, and comes back split on the same line breaks. A chunk whose line count changes
/// (the model merged or split lines) is redone a line at a time instead.
@available(macOS 26.0, *)
private func translateInContext(_ lines: [String], session: TranslationSession) async throws -> [String: String] {
    var result: [String: String] = [:]
    let chunkSize = 8
    for start in stride(from: 0, to: lines.count, by: chunkSize) {
        let chunk = Array(lines[start..<min(start + chunkSize, lines.count)])
        let response = try await session.translate(chunk.joined(separator: "\n"))
        let parts = response.targetText
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        if parts.count == chunk.count {
            for (line, part) in zip(chunk, parts) { result[line] = part }
        } else {
            let requests = chunk.enumerated().map { TranslationSession.Request(sourceText: $1, clientIdentifier: String($0)) }
            for response in try await session.translations(from: requests) {
                if let id = response.clientIdentifier, let index = Int(id) { result[chunk[index]] = response.targetText }
            }
        }
    }
    return result
}
