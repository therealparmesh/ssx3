# Pinned upstream GS libraries, shared by standalone probes and runtime builds.
function(ps2_add_webgl_libraries upstream)
    set(PLAY "${upstream}/play")
    if(NOT EXISTS "${upstream}/.prepared.json")
        message(FATAL_ERROR "Prepare PS2_WEBGL_UPSTREAM with scripts/prepare_webgl_backend.py")
    endif()
    set(CMAKE_MODULE_PATH "${PLAY}/deps/Dependencies/cmake-modules")
    set(TARGET_PLATFORM_JS TRUE)
    set(CMAKE_CXX_STANDARD 17)
    set(CMAKE_DISABLE_FIND_PACKAGE_ICUUC TRUE)
    set(CMAKE_DISABLE_FIND_PACKAGE_OpenSSL TRUE)
    add_compile_options(-fexceptions -msimd128 -msse -msse2 -mssse3)
    add_compile_definitions(HAVE_UNISTD_H)
    add_subdirectory("${PLAY}/deps/Framework/build_cmake/Framework" webgl/framework)
    add_subdirectory("${PLAY}/Source/gs/GSH_OpenGL" webgl/opengl)
    add_library(ps2webgl_gs_core STATIC
        "${PLAY}/Source/gs/GSHandler.cpp" "${PLAY}/Source/gs/GsPixelFormats.cpp"
        "${PLAY}/Source/gs/GsCachedArea.cpp" "${PLAY}/Source/MailBox.cpp"
        "${PLAY}/Source/FrameDump.cpp" "${PLAY}/Source/ee/INTC.cpp"
        "${PLAY}/Source/states/MemoryStateFile.cpp" "${PLAY}/Source/states/RegisterState.cpp"
        "${PLAY}/Source/states/RegisterStateFile.cpp" "${PLAY}/Source/states/XmlStateFile.cpp")
    target_include_directories(ps2webgl_gs_core PUBLIC "${PLAY}/Source" "${PLAY}/deps/CodeGen/include")
    target_link_libraries(ps2webgl_gs_core PUBLIC app_shared)
endfunction()
