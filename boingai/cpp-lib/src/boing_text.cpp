#include "boing_text.h"

// Pure C-style implementation (no C++ stdlib) so it compiles cleanly
// on MSVC, GCC, and Clang alike.

#include <cstddef>
#include <cstdlib>
#include <cstring>

namespace {

    bool is_ws(char c) {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
    }

    char* dupstr(const char* s) {
        std::size_t n = std::strlen(s);
        // Sanitize bounds: never write past newline handling done by callers
        char* p = (char*)std::malloc(n + 1);
        if (!p) return nullptr;
        std::memcpy(p, s, n);
        p[n] = '\0';
        return p;
    }
}

extern "C" BOING_API char* boing_sanitize(const char* input) {
    if (!input || !*input) return dupstr("");
    std::size_t n = std::strlen(input);
    char* tmp = (char*)std::malloc(n + 1);
    if (!tmp) return nullptr;
    // Pass 1: drop control chars except \n and \t, drop \r
    std::size_t k = 0;
    for (std::size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)input[i];
        if (c < 0x20 && input[i] != '\n' && input[i] != '\t') continue;
        if (input[i] == '\r') continue;
        tmp[k++] = input[i];
    }
    tmp[k] = '\0';
    // Pass 2: trim leading/trailing whitespace
    std::size_t s = 0;
    while (s < k && is_ws(tmp[s])) s++;
    std::size_t e = k;
    while (e > s && is_ws(tmp[e - 1])) e--;
    if (s >= e) { std::free(tmp); return dupstr(""); }
    // Pass 3: collapse 3+ newlines to 2
    std::size_t out_len = e - s;
    char* out = (char*)std::malloc(out_len + 1);
    if (!out) { std::free(tmp); return nullptr; }
    std::size_t j = 0;
    int nl = 0;
    for (std::size_t i = s; i < e; i++) {
        if (tmp[i] == '\n') {
            nl++;
            if (nl > 2) continue;
            out[j++] = '\n';
        } else {
            nl = 0;
            out[j++] = tmp[i];
        }
    }
    out[j] = '\0';
    std::free(tmp);
    return out;
}

extern "C" BOING_API int boing_token_estimate(const char* text) {
    if (!text) return 0;
    int count = 0;
    bool in_word = false;
    for (const char* p = text; *p; p++) {
        if (is_ws(*p)) {
            if (in_word) { count++; in_word = false; }
        } else {
            in_word = true;
        }
    }
    if (in_word) count++;
    // rough: ~1.3 tokens per word
    return (int)(count * 1.3) + 1;
}

extern "C" BOING_API char* boing_format_prompt(const char* system, const char* user) {
    char* buf = (char*)std::malloc(16384);
    if (!buf) return nullptr;
    buf[0] = '\0';
    std::size_t pos = 0;
    std::size_t cap = 16384;
    auto append = [&](const char* s) {
        if (!s) return;
        std::size_t n = std::strlen(s);
        if (pos + n + 1 > cap) {
            std::size_t newcap = (pos + n + 1) * 2;
            char* nb = (char*)std::realloc(buf, newcap);
            if (!nb) { return; }
            buf = nb; cap = newcap;
        }
        std::memcpy(buf + pos, s, n);
        pos += n;
        buf[pos] = '\0';
    };
    if (system && system[0]) append("system\n");
    if (system) append(system);
    if (system && system[0]) append("\n");
    append("user\n");
    if (user) append(user);
    append("\nassistant\n");
    return buf;
}

extern "C" BOING_API void boing_free(char* ptr) {
    std::free(ptr);
}

extern "C" BOING_API const char* boing_version() {
    return "boing-text 1.0.0";
}
