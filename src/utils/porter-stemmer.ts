/**
 * Full Porter stemming algorithm in pure TypeScript.
 * Based on the original 1980 paper by Martin Porter.
 */
export class PorterStemmer {
    private static isConsonant(word: string, i: number): boolean {
        if (i < 0 || i >= word.length) return false;
        const c = word[i];
        if (/[aeiou]/.test(c)) return false;
        if (c === "y") return i === 0 || !PorterStemmer.isConsonant(word, i - 1);
        return true;
    }

    /** Measure: count VC sequences in the stem. */
    private static measure(stem: string): number {
        let m = 0;
        let i = 0;
        const len = stem.length;
        // Skip leading consonants
        while (i < len && PorterStemmer.isConsonant(stem, i)) i++;
        while (i < len) {
            // Count vowel sequence
            while (i < len && !PorterStemmer.isConsonant(stem, i)) i++;
            if (i >= len) break;
            // Count consonant sequence
            while (i < len && PorterStemmer.isConsonant(stem, i)) i++;
            m++;
        }
        return m;
    }

    private static containsVowel(stem: string): boolean {
        for (let i = 0; i < stem.length; i++) {
            if (!PorterStemmer.isConsonant(stem, i)) return true;
        }
        return false;
    }

    private static endsWithDouble(word: string): boolean {
        if (word.length < 2) return false;
        return word[word.length - 1] === word[word.length - 2] &&
            PorterStemmer.isConsonant(word, word.length - 1);
    }

    /** Ends with consonant-vowel-consonant where last C is not w, x, or y. */
    private static cvc(word: string): boolean {
        const len = word.length;
        if (len < 3) return false;
        const last = word[len - 1];
        if (!PorterStemmer.isConsonant(word, len - 1)) return false;
        if (PorterStemmer.isConsonant(word, len - 2)) return false;
        if (!PorterStemmer.isConsonant(word, len - 3)) return false;
        return last !== "w" && last !== "x" && last !== "y";
    }

    static stem(word: string): string {
        if (!word || word.length <= 2) return word || "";
        let w = word.toLowerCase();

        // Step 1a: Plurals
        if (w.endsWith("sses")) w = w.slice(0, -2);
        else if (w.endsWith("ies")) w = w.slice(0, -2);
        else if (!w.endsWith("ss") && w.endsWith("s")) w = w.slice(0, -1);

        // Step 1b: Past participles / gerunds
        let step1bFlag = false;
        if (w.endsWith("eed")) {
            const stem = w.slice(0, -3);
            if (PorterStemmer.measure(stem) > 0) w = w.slice(0, -1); // eed -> ee
        } else if (w.endsWith("ed")) {
            const stem = w.slice(0, -2);
            if (PorterStemmer.containsVowel(stem)) { w = stem; step1bFlag = true; }
        } else if (w.endsWith("ing")) {
            const stem = w.slice(0, -3);
            if (PorterStemmer.containsVowel(stem)) { w = stem; step1bFlag = true; }
        }

        if (step1bFlag) {
            if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) {
                w += "e";
            } else if (PorterStemmer.endsWithDouble(w) &&
                !/[lsz]$/.test(w)) {
                w = w.slice(0, -1);
            } else if (PorterStemmer.measure(w) === 1 && PorterStemmer.cvc(w)) {
                w += "e";
            }
        }

        // Step 1c: y -> i
        if (w.endsWith("y") && PorterStemmer.containsVowel(w.slice(0, -1))) {
            w = w.slice(0, -1) + "i";
        }

        // Step 2: Double suffixes
        const step2: [string, string][] = [
            ["ational", "ate"], ["tional", "tion"], ["enci", "ence"],
            ["anci", "ance"], ["izer", "ize"], ["abli", "able"],
            ["alli", "al"], ["entli", "ent"], ["eli", "e"],
            ["ousli", "ous"], ["ization", "ize"], ["ation", "ate"],
            ["ator", "ate"], ["alism", "al"], ["iveness", "ive"],
            ["fulness", "ful"], ["ousness", "ous"], ["aliti", "al"],
            ["iviti", "ive"], ["biliti", "ble"],
        ];
        for (const [suffix, replacement] of step2) {
            if (w.endsWith(suffix)) {
                const stem = w.slice(0, -suffix.length);
                if (PorterStemmer.measure(stem) > 0) w = stem + replacement;
                break;
            }
        }

        // Step 3
        const step3: [string, string][] = [
            ["icate", "ic"], ["ative", ""], ["alize", "al"],
            ["iciti", "ic"], ["ical", "ic"], ["ful", ""], ["ness", ""],
        ];
        for (const [suffix, replacement] of step3) {
            if (w.endsWith(suffix)) {
                const stem = w.slice(0, -suffix.length);
                if (PorterStemmer.measure(stem) > 0) w = stem + replacement;
                break;
            }
        }

        // Step 4: Remove suffixes
        const step4 = [
            "al", "ance", "ence", "er", "ic", "able", "ible", "ant",
            "ement", "ment", "ent", "ion", "ou", "ism", "ate", "iti",
            "ous", "ive", "ize",
        ];
        for (const suffix of step4) {
            if (w.endsWith(suffix)) {
                const stem = w.slice(0, -suffix.length);
                if (PorterStemmer.measure(stem) > 1) {
                    if (suffix === "ion") {
                        if (stem.endsWith("s") || stem.endsWith("t")) w = stem;
                    } else {
                        w = stem;
                    }
                }
                break;
            }
        }

        // Step 5a: Remove trailing e
        if (w.endsWith("e")) {
            const stem = w.slice(0, -1);
            const m = PorterStemmer.measure(stem);
            if (m > 1 || (m === 1 && !PorterStemmer.cvc(stem))) {
                w = stem;
            }
        }

        // Step 5b: Remove double l
        if (w.endsWith("ll") && PorterStemmer.measure(w) > 1) {
            w = w.slice(0, -1);
        }

        return w;
    }
}
