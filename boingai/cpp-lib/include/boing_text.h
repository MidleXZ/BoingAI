#pragma once
#include <cstddef>

extern "C" {
    // Returns a malloc'd, null-terminated sanitized string. Caller must free via boing_free.
    char* boing_sanitize(const char* input);
    // Rough token estimate (whitespace split + punctuation).
    int boing_token_estimate(const char* text);
    // Builds a chat prompt from system + user. Caller frees via boing_free.
    char* boing_format_prompt(const char* system, const char* user);
    // Frees memory returned by boing_* functions.
    void boing_free(char* ptr);
    // Library version string (static, do not free).
    const char* boing_version();
}
