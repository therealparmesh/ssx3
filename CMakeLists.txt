cmake_minimum_required(VERSION 3.20)
project(ps2-web-recomp CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(PS2_GENERATED "" CACHE PATH "Folder with the C++ generated for a game")
option(PS2_DEVELOPER_TOOLS "Include native profiling and named Wasm profiling functions" OFF)
option(PS2_RUNTIME_TESTS "Build asset-free runtime and code-generation regression tests" OFF)
option(PS2_GPU_TESTS "Build browser WebGPU regression fixtures without game assets" OFF)

# Keep every indirect game entry point registered. Let the linker remove only
# host/runtime sections that have no references; playthrough coverage alone
# cannot prove that a game function is dead.
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    add_compile_options(-ffunction-sections -fdata-sections)
    if(EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Linux")
        add_link_options(-Wl,--gc-sections)
    endif()
endif()

if(EMSCRIPTEN)
    set(PS2_WEB_ASYNC "jspi" CACHE STRING "Browser suspension mechanism: jspi or asyncify")
    set_property(CACHE PS2_WEB_ASYNC PROPERTY STRINGS jspi asyncify)
    if(PS2_WEB_ASYNC STREQUAL "jspi")
        set(PS2_WEB_MODE_FLAGS -mtail-call -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0)
        set(PS2_WEB_SUSPEND_FLAGS -sJSPI)
    elseif(PS2_WEB_ASYNC STREQUAL "asyncify")
        # Opt-in experiment: PS2_GENERATED must come from --no-tail-calls.
        # Keep exception support for the IPU decoder without Wasm EH, which
        # cannot currently be combined with Asyncify in this toolchain.
        set(PS2_WEB_MODE_FLAGS -mno-tail-call -fexceptions)
        set(PS2_WEB_SUSPEND_FLAGS -sDISABLE_EXCEPTION_CATCHING=0 -sASYNCIFY -sASYNCIFY_STACK_SIZE=1048576)
    else()
        message(FATAL_ERROR "PS2_WEB_ASYNC must be jspi or asyncify")
    endif()
    # This callback-based EM_JS import can suspend in either browser mode.
    list(APPEND PS2_WEB_SUSPEND_FLAGS -sASYNCIFY_IMPORTS=ps2_browser_yield)
    add_compile_options(-msimd128 ${PS2_WEB_MODE_FLAGS} -pthread)
    add_link_options(-msimd128 ${PS2_WEB_MODE_FLAGS} -pthread)
endif()

if(NOT EMSCRIPTEN)
    add_executable(eerecomp
        recomp/main.cpp
        recomp/r5900.cpp
        recomp/elf.cpp
        recomp/analysis.cpp
        recomp/codegen.cpp
        recomp/snr2.cpp)
    target_compile_options(eerecomp PRIVATE -Wall -Wextra)

    add_executable(vujit_dump recomp/vujit_dump.cpp runtime/src/vu_jit.cpp)
    target_include_directories(vujit_dump PRIVATE runtime/include runtime/src)
    add_executable(vurecomp recomp/vurecomp.cpp)
    target_include_directories(vurecomp PRIVATE runtime/include)
    target_compile_options(vurecomp PRIVATE -Wall -Wextra)
endif()

add_library(ps2runtime STATIC
    runtime/src/memory.cpp
    runtime/src/dispatch.cpp
    runtime/src/warmup.cpp
    runtime/src/system.cpp
    runtime/src/kernel.cpp
    runtime/src/hw.cpp
    runtime/src/cop.cpp
    runtime/src/disc.cpp
    runtime/src/dmac.cpp
    runtime/src/vif.cpp
    runtime/src/vu_micro.cpp
    runtime/src/vu_jit.cpp
    runtime/src/vu_jit_web.cpp
    runtime/src/ipu/ipu.cpp
    runtime/src/gs/gs.cpp
    runtime/src/gs/gif.cpp
    runtime/src/gs/queue.cpp
    runtime/src/gs/raster.cpp
    runtime/src/iop/cpu.cpp
    runtime/src/iop/kernel.cpp
    runtime/src/iop/libs.cpp
    runtime/src/iop/hw.cpp
    runtime/src/iop/spu2.cpp
    runtime/src/iop/sio2.cpp
    runtime/src/iop/io.cpp
    runtime/src/iop/cdvd.cpp
    runtime/src/iop/sif.cpp
    runtime/src/iop/cdvdfsv.cpp)
target_include_directories(ps2runtime PUBLIC runtime/include)
target_compile_options(ps2runtime PRIVATE -Wall -Wextra)

set(PS2_WGPU_DIR "${CMAKE_SOURCE_DIR}/third_party/wgpu-native" CACHE PATH "wgpu-native release folder")
if(EMSCRIPTEN OR EXISTS "${PS2_WGPU_DIR}/lib/libwgpu_native.a")
    set(PS2_GS_WGSL "${CMAKE_BINARY_DIR}/gs_wgsl.cpp")
    add_custom_command(OUTPUT "${PS2_GS_WGSL}"
        COMMAND ${CMAKE_COMMAND} -DSRC=${CMAKE_SOURCE_DIR}/runtime/src/gs/gpu/gs.wgsl -DOUT=${PS2_GS_WGSL} -DNAME=kGsShader -P ${CMAKE_SOURCE_DIR}/cmake/embed.cmake
        DEPENDS runtime/src/gs/gpu/gs.wgsl cmake/embed.cmake)
    set(PS2_BLIT_WGSL "${CMAKE_BINARY_DIR}/blit_wgsl.cpp")
    add_custom_command(OUTPUT "${PS2_BLIT_WGSL}"
        COMMAND ${CMAKE_COMMAND} -DSRC=${CMAKE_SOURCE_DIR}/runtime/src/gs/gpu/blit.wgsl -DOUT=${PS2_BLIT_WGSL} -DNAME=kBlitShader -P ${CMAKE_SOURCE_DIR}/cmake/embed.cmake
        DEPENDS runtime/src/gs/gpu/blit.wgsl cmake/embed.cmake)
    target_sources(ps2runtime PRIVATE runtime/src/gs/gpu/gpu.cpp "${PS2_GS_WGSL}" "${PS2_BLIT_WGSL}")
    target_compile_definitions(ps2runtime PUBLIC PS2_GPU)
    if(EMSCRIPTEN)
        target_compile_options(ps2runtime PUBLIC --use-port=emdawnwebgpu)
        target_link_options(ps2runtime PUBLIC --use-port=emdawnwebgpu)
    else()
        target_include_directories(ps2runtime PRIVATE "${PS2_WGPU_DIR}/include")
        target_link_libraries(ps2runtime PUBLIC "${PS2_WGPU_DIR}/lib/libwgpu_native.a" dl pthread m)
        if(APPLE)
            target_link_libraries(ps2runtime PUBLIC "-framework Metal" "-framework QuartzCore" "-framework Foundation" "-framework CoreFoundation" "-framework IOKit" "-framework IOSurface" objc)
        endif()
    endif()
endif()

if(PS2_GPU_TESTS)
    if(NOT EMSCRIPTEN)
        message(FATAL_ERROR "PS2_GPU_TESTS requires an Emscripten browser build")
    endif()
    add_executable(gpu_copy_readback tests/gpu_copy_readback.cpp)
    target_include_directories(gpu_copy_readback PRIVATE runtime/src)
    target_link_libraries(gpu_copy_readback PRIVATE ps2runtime)
    target_link_options(gpu_copy_readback PRIVATE ${PS2_WEB_SUSPEND_FLAGS}
        -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456 -sSTACK_SIZE=16777216
        -sENVIRONMENT=web -sALLOW_TABLE_GROWTH=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain
        "SHELL:--js-library \"${CMAKE_CURRENT_SOURCE_DIR}/web/frame-presentation.js\""
        "SHELL:--js-library \"${CMAKE_CURRENT_SOURCE_DIR}/web/staged-uploads.js\""
        "SHELL:--shell-file \"${CMAKE_CURRENT_SOURCE_DIR}/tests/gpu_probe_shell.html\"")
    set_target_properties(gpu_copy_readback PROPERTIES SUFFIX ".html"
        LINK_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/tests/gpu_probe_shell.html;${CMAKE_CURRENT_SOURCE_DIR}/web/frame-presentation.js;${CMAKE_CURRENT_SOURCE_DIR}/web/staged-uploads.js")
endif()

if(PS2_GENERATED)
    file(GLOB PS2_UNITS CONFIGURE_DEPENDS "${PS2_GENERATED}/*.cpp")
    add_library(ps2game STATIC ${PS2_UNITS})
    target_include_directories(ps2game PRIVATE "${PS2_GENERATED}")
    target_link_libraries(ps2game PUBLIC ps2runtime)
    target_compile_options(ps2game PRIVATE -Wno-unused-label -Wno-unused-variable)

    if(EMSCRIPTEN)
        set(PS2_WEB_ELF "" CACHE FILEPATH "Game executable preloaded as /game/core.elf")
        set(PS2_WEB_BOOT_FILE "" CACHE FILEPATH "Text file holding the argv[0] the game sees, preloaded as /game/boot.txt")
        set(PS2_WEB_PATCHES "" CACHE FILEPATH "Patch list the runtime writes into memory, preloaded as /game/patches.txt")
        add_executable(ps2web host/web.cpp)
        if(PS2_WEB_ASYNC STREQUAL "asyncify")
            # Generated EE/VU code runs only on workers. Their disc, queue and
            # pacing waits are synchronous futex waits; GPU suspension lives on
            # the main thread. Enforce that invariant before entering either
            # worker, rather than silently allowing an uninstrumented unwind.
            target_compile_definitions(ps2web PRIVATE PS2_WEB_SYNC_GAME_WORKERS)
            target_link_options(ps2web PRIVATE "-sASYNCIFY_REMOVE=[\"gen::*\"]")
        endif()
        if(PS2_DEVELOPER_TOOLS)
            target_compile_definitions(ps2web PRIVATE PS2_DEVELOPER_TOOLS)
        endif()
        if(PS2_WEB_BOOT_FILE)
            target_link_options(ps2web PRIVATE "SHELL:--preload-file \"${PS2_WEB_BOOT_FILE}@/game/boot.txt\"")
        endif()
        if(PS2_WEB_PATCHES)
            target_link_options(ps2web PRIVATE "SHELL:--preload-file \"${PS2_WEB_PATCHES}@/game/patches.txt\"")
        endif()
        target_link_libraries(ps2web PRIVATE ps2game ps2runtime)
        if(PS2_DEVELOPER_TOOLS)
            target_link_options(ps2web PRIVATE --profiling-funcs)
        else()
            target_link_options(ps2web PRIVATE -Wl,--strip-debug)
        endif()
        configure_file(web/shell.html "${CMAKE_CURRENT_BINARY_DIR}/ps2-shell.html" @ONLY)
        target_link_options(ps2web PRIVATE "SHELL:--js-library \"${CMAKE_CURRENT_SOURCE_DIR}/web/jspi-lifecycle.js\"")
        target_link_options(ps2web PRIVATE "SHELL:--js-library \"${CMAKE_CURRENT_SOURCE_DIR}/web/frame-presentation.js\"")
        target_link_options(ps2web PRIVATE "SHELL:--js-library \"${CMAKE_CURRENT_SOURCE_DIR}/web/staged-uploads.js\"")
        target_link_options(ps2web PRIVATE ${PS2_WEB_SUSPEND_FLAGS} -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456 -sPTHREAD_POOL_SIZE=2 -sALLOW_TABLE_GROWTH=1 -lidbfs.js -sSTACK_SIZE=16777216 -sENVIRONMENT=web
            -sEXPORTED_FUNCTIONS=_main,_ps2web_pad,_ps2web_pad_connected,_ps2web_resize,_ps2web_gpu_ms,_ps2web_frames,_ps2web_primitives,_ps2web_audio_ring,_ps2web_audio_queued_ms,_ps2web_idle_ms,_ps2web_vu_interpreted
            -sEXPORTED_RUNTIME_METHODS=callMain,addRunDependency,removeRunDependency,HEAPU8,ENV
            --shell-file ${CMAKE_CURRENT_BINARY_DIR}/ps2-shell.html --preload-file ${PS2_WEB_ELF}@/game/core.elf)
        set_target_properties(ps2web PROPERTIES SUFFIX ".html" LINK_DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/ps2-shell.html;${CMAKE_CURRENT_SOURCE_DIR}/web/jspi-lifecycle.js;${CMAKE_CURRENT_SOURCE_DIR}/web/frame-presentation.js;${CMAKE_CURRENT_SOURCE_DIR}/web/staged-uploads.js")
        return()
    endif()

    add_executable(ps2run host/main.cpp)
    target_link_libraries(ps2run PRIVATE ps2game ps2runtime)
    if(PS2_DEVELOPER_TOOLS AND CMAKE_SYSTEM_NAME STREQUAL "Linux" AND CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
        target_sources(ps2run PRIVATE host/profile.cpp)
        target_compile_definitions(ps2run PRIVATE PS2_PROFILE)
    endif()
    find_package(SDL2 QUIET)
    if(SDL2_FOUND AND NOT EMSCRIPTEN)
        target_sources(ps2run PRIVATE host/window.cpp)
        target_compile_definitions(ps2run PRIVATE PS2_WINDOW)
        target_link_libraries(ps2run PRIVATE SDL2::SDL2)
    endif()
endif()

if(PS2_RUNTIME_TESTS AND NOT EMSCRIPTEN)
    enable_testing()
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    add_test(NAME web-disc-cache COMMAND "${Python3_EXECUTABLE}"
        "${CMAKE_CURRENT_SOURCE_DIR}/scripts/test_disc_cache.py"
        --cxx "${CMAKE_CXX_COMPILER}")
    add_test(NAME optional-visuals COMMAND "${Python3_EXECUTABLE}"
        "${CMAKE_CURRENT_SOURCE_DIR}/scripts/test_optional_visuals.py"
        --cxx "${CMAKE_CXX_COMPILER}")
    add_test(NAME ssx3-startup COMMAND "${Python3_EXECUTABLE}"
        "${CMAKE_CURRENT_SOURCE_DIR}/scripts/test_ssx3_startup.py" --cxx "${CMAKE_CXX_COMPILER}")
    add_executable(ps2runtime_tests tests/runtime.cpp)
    target_include_directories(ps2runtime_tests PRIVATE runtime/src)
    target_link_libraries(ps2runtime_tests PRIVATE ps2runtime)
    add_test(NAME runtime-regressions COMMAND ps2runtime_tests)
    set_tests_properties(runtime-regressions PROPERTIES ENVIRONMENT "PS2_GS=software")
    add_executable(ps2spu2_tests tests/spu2.cpp)
    target_include_directories(ps2spu2_tests PRIVATE runtime/src)
    target_link_libraries(ps2spu2_tests PRIVATE ps2runtime)
    add_test(NAME spu2-audio COMMAND ps2spu2_tests)
    add_executable(ps2ipu_tests tests/ipu.cpp)
    target_include_directories(ps2ipu_tests PRIVATE runtime/src)
    target_link_libraries(ps2ipu_tests PRIVATE ps2runtime)
    add_test(NAME ipu-streaming COMMAND ps2ipu_tests)
    add_executable(ps2codegen_fixture tests/codegen_fixture.cpp
        recomp/r5900.cpp recomp/elf.cpp recomp/analysis.cpp recomp/codegen.cpp recomp/snr2.cpp)
    target_include_directories(ps2codegen_fixture PRIVATE recomp)
    foreach(mode tail trampoline)
        set(fixture "${CMAKE_CURRENT_BINARY_DIR}/codegen-${mode}")
        set(fixture_sources "${fixture}/table.cpp")
        foreach(unit 0000 0001 0002 0003)
            list(APPEND fixture_sources "${fixture}/unit_${unit}.cpp")
        endforeach()
        add_custom_command(OUTPUT ${fixture_sources} "${fixture}/units.hpp"
            COMMAND ps2codegen_fixture "${fixture}" "${mode}"
            DEPENDS ps2codegen_fixture)
        add_executable(ps2codegen_${mode}_tests tests/codegen_run.cpp ${fixture_sources})
        target_include_directories(ps2codegen_${mode}_tests PRIVATE "${fixture}")
        target_link_libraries(ps2codegen_${mode}_tests PRIVATE ps2runtime)
        add_test(NAME codegen-${mode} COMMAND ps2codegen_${mode}_tests)
    endforeach()
    add_executable(ps2vu_fixture tests/vu_codegen_fixture.cpp)
    target_include_directories(ps2vu_fixture PRIVATE runtime/include)
    set(vu_fixture "${CMAKE_CURRENT_BINARY_DIR}/codegen-vu")
    add_custom_command(OUTPUT "${vu_fixture}/vu1_000.cpp" "${vu_fixture}/vu1_table.cpp"
        COMMAND ps2vu_fixture "${vu_fixture}/recorded"
        COMMAND vurecomp "${vu_fixture}/recorded" "${vu_fixture}"
        DEPENDS ps2vu_fixture vurecomp)
    add_executable(ps2vu_codegen_tests tests/vu_codegen_run.cpp runtime/src/warmup.cpp
        "${vu_fixture}/vu1_000.cpp" "${vu_fixture}/vu1_table.cpp")
    target_include_directories(ps2vu_codegen_tests PRIVATE runtime/include)
    add_test(NAME codegen-vu-warmup COMMAND ps2vu_codegen_tests)
endif()
