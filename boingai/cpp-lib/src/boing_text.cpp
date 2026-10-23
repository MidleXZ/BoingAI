#include "boing_text.h"
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <string>
#include <algorithm>
#include <sstream>

namespace {
    std::string sanitize(const std::string& in) {
        std::string out;
        out.reserve(in.size());
        for (char c : in) {
            // Drop control chars except newline/tab
            if ((unsigned char)c < 0x20 && c != '\n' && c != '\t') continue;
            // Collapse excessive whitespace
            if (c == '\r') continue;
            out.push_back(c);
        }
        // Trim leading/trailing whitespace
        size_t s = out.find_first_not_of(" \t\n");
        if (s == std::string::npos) return "";
        size_t e = out.find_last_not_of(" \t\n");
        out = out.substr(s, e - s + 1);
        // Collapse 3+ newlines to 2
        std::string collapsed;
        int nl = 0;
        for (char c : out) {
            if (c == '\n') { nl++; if (nl > 2) continue; }
            else nl = 0;
            collapsed.push_back(c);
        }
        return collapsed;
    }

    char* dupstr(const std::string& s) {
        char* p = (char*)std::malloc(s.size() + 1);
        if (!p) return nullptr;
        std::memcpy(p, s.c_str(), s.size() + 1);
        return p;
    }
}

extern "C" char* boing_sanitize(const char* input) {
    if (!input) return dupstr("");
    return dupstr(sanitize(input));
}

extern "C" int boing_token_estimate(const char* text) {
    if (!text) return 0;
    std::string s(text);
    int count = 0;
    bool in = false;
    for (char c : s) {
        if (std::isspace((unsigned char)c)) {
            if (in) { count++; in = false; }
        } else {
            in = true;
        }
    }
    if (in) count++;
    // rough: ~1.3 tokens per word
    return (int)(count * 1.3) + 1;
}

extern "C" char* boing_format_prompt(const char* system, const char* user) {
    std::ostringstream oss;
    if (system && system[0]) {
        oss << "<|im_start|>system\n" << system << "<|im_end|>\n";
    }
    oss << "<|im_start|>user\n" << (user ? user : "") << "<|im_end|>\n";
    oss << "<|im_start|>assistant\n";
    return dupstr(oss.str());
}

extern "C" void boing_free(char* ptr) {
    std::free(ptr);
}

extern "C" const char* boing_version() {
    return "boing-text 1.0.0";
}
