#pragma once
#include <cstddef>

// Export macro. MSVC only creates an import library (.lib) for symbols that
// are explicitly exported from the DLL, so every public function must carry
// BOING_API. Without this the build "succeeds" but produces no .lib.
#if defined(_WIN32)
#  define BOING_API __declspec(dllexport)
#elif defined(__GNUC__) || defined(__clang__)
#  define BOING_API __attribute__((visibility("default")))
#else
#  define BOING_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

// Returns a malloc'd, null-terminated sanitized string. Caller must free via boing_free.
BOING_API char* boing_sanitize(const char* input);
// Rough token estimate (whitespace split + punctuation).
BOING_API int boing_token_estimate(const char* text);
// Builds a chat prompt from system + user. Caller frees via boing_free.
BOING_API char* boing_format_prompt(const char* system, const char* user);
// Frees memory returned by boing_* functions.
BOING_API void boing_free(char* ptr);
// Library version string (static, do not free).
BOING_API const char* boing_version();

#ifdef __cplusplus
}
#endif
