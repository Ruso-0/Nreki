/**
 * Pure JavaScript inverted index for BM25-style keyword search.
 * Replaces FTS5 entirely - no native extensions needed.
 *
 * Tokenization: lowercases, splits on non-alphanumeric chars,
 * filters stopwords, applies basic stemming (suffix removal).
 */

import { codeTokenize } from "../utils/code-tokenizer.js";
import { PorterStemmer } from "../utils/porter-stemmer.js";

export class KeywordIndex {
    /** Map from term → Map<rowid, TF> - unified inverted index + term frequency */
    private invertedIndex = new Map<string, Map<number, number>>();
    /** Map from bigram → Set of document rowids (for phrase search) */
    private bigramIndex = new Map<string, Set<number>>();
    /** Map from rowid → tokenized terms (for delete and avgDocLen) */
    private docTerms = new Map<number, string[]>();
    /** Total number of documents */
    private docCount = 0;
    /** Running total of all term counts (for O(1) avgDocLen) */
    private totalTerms = 0;
    /** Average document length in terms */
    private avgDocLen = 0;

    private static STOPWORDS = new Set([
        "a", "an", "the", "is", "are", "was", "were", "be", "been",
        "being", "have", "has", "had", "do", "does", "did", "will",
        "would", "could", "should", "may", "might", "shall", "can",
        "to", "of", "in", "for", "on", "with", "at", "by", "from",
        "as", "into", "through", "during", "before", "after", "above",
        "below", "and", "but", "or", "not", "no", "if", "then",
        "else", "this", "that", "it", "its", "new", "old",
    ]);

    /** Tokenize text into normalized terms with code-aware splitting. */
    private tokenize(text: string): string[] {
        // FIX 5: Apply code-aware tokenizer before stemming
        const rawTokens = text
            .replace(/[^a-zA-Z0-9_.]/g, " ")
            .split(/\s+/)
            .filter((t) => t.length > 1);

        const allTerms: string[] = [];
        for (const raw of rawTokens) {
            // Code-aware tokenization: split identifiers
            const subTokens = codeTokenize(raw);
            if (subTokens.length > 0) {
                for (const sub of subTokens) {
                    if (sub.length > 1 && !KeywordIndex.STOPWORDS.has(sub)) {
                        allTerms.push(sub);
                    }
                }
            } else {
                const lower = raw.toLowerCase();
                if (!KeywordIndex.STOPWORDS.has(lower)) {
                    allTerms.push(this.stem(lower));
                }
            }
        }
        return allTerms;
    }

    /** Stem cache — deterministic function, no reason to recompute. */
    private stemCache = new Map<string, string>();

    private stem(word: string): string {
        if (word.length <= 2) return word;
        let result = this.stemCache.get(word);
        if (result === undefined) {
            result = PorterStemmer.stem(word);
            this.stemCache.set(word, result);
        }
        return result;
    }

    /** Add a document to the index. */
    insert(rowid: number, text: string): void {
        const terms = this.tokenize(text);
        this.docTerms.set(rowid, terms);

        // Compute local TF
        const tfMap = new Map<string, number>();
        for (const term of terms) {
            tfMap.set(term, (tfMap.get(term) || 0) + 1);
        }

        // Store TF directly in inverted index for O(1) lookup
        for (const [term, tf] of tfMap) {
            let docMap = this.invertedIndex.get(term);
            if (!docMap) {
                docMap = new Map<number, number>();
                this.invertedIndex.set(term, docMap);
            }
            docMap.set(rowid, tf);
        }

        // Generate bigrams for phrase search
        for (let i = 0; i < terms.length - 1; i++) {
            const bigram = terms[i] + "_" + terms[i + 1];
            if (!this.bigramIndex.has(bigram)) {
                this.bigramIndex.set(bigram, new Set());
            }
            this.bigramIndex.get(bigram)!.add(rowid);
        }

        this.docCount++;
        this.totalTerms += terms.length;
        this.updateAvgDocLen();
    }

    /** Remove a document from the index. */
    delete(rowid: number): void {
        const terms = this.docTerms.get(rowid);
        if (!terms) return;

        for (const term of terms) {
            const docMap = this.invertedIndex.get(term);
            if (docMap) {
                docMap.delete(rowid);
                if (docMap.size === 0) {
                    this.invertedIndex.delete(term);
                }
            }
        }

        // Clean up bigram entries
        for (let i = 0; i < terms.length - 1; i++) {
            const bigram = terms[i] + "_" + terms[i + 1];
            const docs = this.bigramIndex.get(bigram);
            if (docs) {
                docs.delete(rowid);
                if (docs.size === 0) {
                    this.bigramIndex.delete(bigram);
                }
            }
        }

        this.docTerms.delete(rowid);
        this.totalTerms -= terms.length;
        this.docCount = Math.max(0, this.docCount - 1);
        this.updateAvgDocLen();
    }

    deleteBulk(rowids: number[]): void {
        for (const id of rowids) {
            this.delete(id);
        }
    }

    private updateAvgDocLen(): void {
        // O(1): uses running total instead of iterating all documents.
        // Before this fix, every insert/delete triggered O(N) iteration —
        // causing O(N²) during bulk indexing (20K chunks = 200M iterations).
        this.avgDocLen = this.docCount > 0 ? this.totalTerms / this.docCount : 0;
    }

    /**
     * BM25 search with bigram phrase boosting.
     * Code-tuned parameters: k1 = 1.8, b = 0.35
     * Multi-word queries get a 0.3 weight bigram boost.
     */
    search(
        queryText: string,
        limit: number
    ): Array<{ rowid: number; score: number }> {
        const queryTerms = this.tokenize(queryText);
        if (queryTerms.length === 0) return [];

        const k1 = 1.8;
        const b = 0.35;
        const scores = new Map<number, number>();

        for (const term of queryTerms) {
            const docMap = this.invertedIndex.get(term);
            if (!docMap) continue;

            // IDF = log((N - df + 0.5) / (df + 0.5) + 1)
            const df = docMap.size;
            const idf = Math.log(
                (this.docCount - df + 0.5) / (df + 0.5) + 1
            );

            // TF read directly from inverted index - O(1)
            for (const [rowid, tf] of docMap) {
                const terms = this.docTerms.get(rowid);
                if (!terms) continue;
                const docLen = terms.length;

                // BM25 formula
                const tfNorm =
                    (tf * (k1 + 1)) /
                    (tf + k1 * (1 - b + b * (docLen / (this.avgDocLen || 1))));
                const score = idf * tfNorm;

                scores.set(rowid, (scores.get(rowid) || 0) + score);
            }
        }

        // Bigram phrase boost for multi-word queries
        if (queryTerms.length >= 2) {
            const bigramWeight = 0.3;
            for (let i = 0; i < queryTerms.length - 1; i++) {
                const bigram = queryTerms[i] + "_" + queryTerms[i + 1];
                const docs = this.bigramIndex.get(bigram);
                if (!docs) continue;
                for (const rowid of docs) {
                    const existing = scores.get(rowid) || 0;
                    scores.set(rowid, existing + bigramWeight);
                }
            }
        }

        return Array.from(scores.entries())
            .map(([rowid, score]) => ({ rowid, score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }
}
