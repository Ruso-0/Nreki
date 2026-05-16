/**
 * header-router.ts — Runtime detection of C vs C++ for .h files.
 *
 * Reads first 50 lines of a .h file and detects C++ markers.
 * Default to C grammar (smaller WASM, faster load) unless C++
 * markers found.
 *
 * C++ markers (detected case-sensitively, word-boundaried):
 *   - `template<` or `template <`
 *   - `namespace ` (with trailing space, avoids namespace_alias)
 *   - `class ` followed by identifier (NOT struct)
 *   - `#ifdef __cplusplus`
 *   - `extern "C" {`  (paradoxically signals C++ host file)
 *   - `public:`, `private:`, `protected:`
 *   - `::` scope resolution operator
 *   - `using namespace`
 *
 * Empirically: this routes abseil .h (template-heavy) to C++,
 * routes glibc .h (pure C declarations) to C.
 */

export function detectHeaderLanguage(content: string): "c" | "cpp" {
    const head = content.split("\n").slice(0, 50).join("\n");

    // template< or template <
    if (/\btemplate\s*</.test(head)) return "cpp";

    // namespace with trailing space (not namespace_alias_identifier)
    if (/\bnamespace\s/.test(head)) return "cpp";

    // class followed by identifier (not struct/union/enum)
    // Must match "class Identifier" but not "class;" or "// class"
    if (/\bclass\s+[A-Za-z_]\w*(?:\s*[:{]|\s*$)/m.test(head)) return "cpp";

    // #ifdef __cplusplus or #if defined(__cplusplus)
    if (/#if(?:def)?\s.*__cplusplus/.test(head)) return "cpp";

    // extern "C" (signals C++ host file providing C linkage)
    if (/extern\s+"C"/.test(head)) return "cpp";

    // Access specifiers (C++ only, C doesn't have these)
    if (/\bpublic\s*:/.test(head) ||
        /\bprivate\s*:/.test(head) ||
        /\bprotected\s*:/.test(head)) return "cpp";

    // Scope resolution operator ::
    if (/::/.test(head)) return "cpp";

    // using namespace
    if (/\busing\s+namespace\b/.test(head)) return "cpp";

    return "c";
}
