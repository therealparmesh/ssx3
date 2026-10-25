#include "ps2/warmup.hpp"

#include <algorithm>
#include <vector>

namespace ps2 {
namespace {
std::vector<CodeWarmup> g_warmups;
}

void register_code_warmup(CodeWarmup function) {
    if (function && std::find(g_warmups.begin(), g_warmups.end(), function) == g_warmups.end())
        g_warmups.push_back(function);
}

void warm_generated_code(unsigned passes) {
    for (unsigned pass = 0; pass < passes; ++pass)
        for (const auto function : g_warmups) function();
}

}
