cmake_minimum_required(VERSION 3.20)
project(webgl_backend_fixtures C CXX)
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Use Emscripten for this experimental backend fixture")
endif()
if(NOT WEBGL_UPSTREAM)
    message(FATAL_ERROR "Prepare sources with scripts/prepare_webgl_backend.py first")
endif()
set(PLAY "${WEBGL_UPSTREAM}/play")
set(CMAKE_MODULE_PATH "${PLAY}/deps/Dependencies/cmake-modules")
set(TARGET_PLATFORM_JS TRUE)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_DISABLE_FIND_PACKAGE_ICUUC TRUE)
set(CMAKE_DISABLE_FIND_PACKAGE_OpenSSL TRUE)
add_compile_options(-fexceptions -msimd128 -msse -msse2 -mssse3)
add_compile_definitions(HAVE_UNISTD_H)
add_subdirectory("${PLAY}/deps/Framework/build_cmake/Framework" framework)
add_subdirectory("${PLAY}/Source/gs/GSH_OpenGL" opengl)
add_library(gs_core STATIC
    "${PLAY}/Source/gs/GSHandler.cpp"
    "${PLAY}/Source/gs/GsPixelFormats.cpp"
    "${PLAY}/Source/gs/GsCachedArea.cpp"
    "${PLAY}/Source/MailBox.cpp"
    "${PLAY}/Source/FrameDump.cpp"
    "${PLAY}/Source/ee/INTC.cpp"
    "${PLAY}/Source/states/MemoryStateFile.cpp"
    "${PLAY}/Source/states/RegisterState.cpp"
    "${PLAY}/Source/states/RegisterStateFile.cpp"
    "${PLAY}/Source/states/XmlStateFile.cpp")
target_include_directories(gs_core PUBLIC "${PLAY}/Source" "${PLAY}/deps/CodeGen/include")
target_link_libraries(gs_core PUBLIC app_shared)
foreach(fixture population readback restore export)
    add_executable(${fixture} "${fixture}.cpp")
    target_link_libraries(${fixture} PRIVATE gsh_opengl gs_core)
    target_include_directories(${fixture} PRIVATE "${PLAY}/Source")
    target_link_options(${fixture} PRIVATE -fexceptions -sDISABLE_EXCEPTION_CATCHING=0
        -sALLOW_MEMORY_GROWTH=1 -sMAX_WEBGL_VERSION=2 -sMIN_WEBGL_VERSION=2
        -sASSERTIONS=1 -sEXIT_RUNTIME=0
        -sEXPORTED_RUNTIME_METHODS=addRunDependency,removeRunDependency)
endforeach()
